import { normaliseTeamsChatUrl, type ChatMessage, type FormCandidate, type LinkSource } from '@tm/core'
import { errors, type Page } from 'playwright'
import { toTeamsChatMessages } from '../adapters/teams/chat'
import { parseTeamsMessages, type RawTeamsMessage } from '../adapters/teams/chat-dom'
import { shown } from '../adapters/teams/join'
import { teamsSelectors, type TeamsSelectors } from '../adapters/teams/selectors'
import type { Stopper } from '../types'
import { runChatWatcher, WatcherChatError, WatcherSigninError, type ChatSourceReader } from './loop'

// Every selector is a starting value, unverified against a real Teams tenant (config/selectors/teams.json; plan 04 task
// 12 checks them). The chat is the same markup as a meeting's chat pane, so the meeting chat's parser reads it.
//
// This reader navigates, scrolls and reads. The one click it ever makes is the launcher's "Continue on this browser".
// It never types, sends, reacts, replies or marks anything as read, and it never logs a message's text or links.

const OPEN_TIMEOUT_MS = 60_000
const OPEN_POLL_MS = 250
const LAUNCHER_CLICK_MS = 10_000
const HISTORY_BUDGET_MS = 60_000
const HISTORY_MAX_STEPS = 300
const OLDER_WAIT_MS = 2_000
const SCROLL_SETTLE_MS = 150

type Sel = TeamsSelectors['selectors']

const sleepMs = () => 300 + Math.random() * 50

const keyOf = (m: RawTeamsMessage) => m.id ?? `${m.sender}|${m.datetime}|${m.text.slice(0, 200)}`

const sentAt = (m: RawTeamsMessage) => (m.datetime === null ? Number.NaN : Date.parse(m.datetime))

// Throws for a page on a sign-in host.
function assertSignedIn(desk: Page, sel: TeamsSelectors): void {
  const { hostname } = new URL(desk.url())
  if (sel.signInHosts.includes(hostname)) throw new WatcherSigninError(hostname)
}

// Runs in the page. Where `to` is 'bottom' the list goes to its end, else up by a step. Null when the list is gone.
function moveList(desk: Page, sel: Sel, to: 'up' | 'bottom'): Promise<{ top: number; height: number } | null> {
  return desk.evaluate(
    ({ scroller, to }) => {
      const el = document.querySelector<HTMLElement>(scroller)
      if (el === null) return null
      el.scrollTop = to === 'bottom' ? el.scrollHeight : Math.max(0, el.scrollTop - Math.max(200, el.clientHeight / 2))
      return { top: el.scrollTop, height: el.scrollHeight }
    },
    { scroller: sel.chatScroller, to }
  )
}

// Rows with no readable time are skipped: they cannot be placed in the 24 hours. A message's `time` is its ISO
// `datetime`, not the clock text beside it.
function toMessages(raw: RawTeamsMessage[], cutoffMs: number | null): ChatMessage[] {
  const timed = raw
    .filter((m) => !Number.isNaN(sentAt(m)))
    .sort((a, b) => sentAt(a) - sentAt(b))
    .map((m) => ({ ...m, time: m.datetime ?? m.time }))
  return toTeamsChatMessages(timed, { roles: null, cutoffMs, seenAt: new Date().toISOString() })
}

/** Reads one Teams chat or group chat in the member's own session. `chatUrl` is normalised already. */
export function teamsChatReader(
  chatUrl: string,
  sel: TeamsSelectors,
  historyBudgetMs = HISTORY_BUDGET_MS
): ChatSourceReader {
  const wanted = new URL(chatUrl)
  const s = sel.selectors
  const onChat = (desk: Page) => {
    const here = new URL(desk.url())
    return here.origin === wanted.origin && here.pathname === wanted.pathname
  }
  const read = (desk: Page) => desk.evaluate(parseTeamsMessages, s)
  // Where the last history scan stopped. The scan leaves the older rows it loaded in the list, and `latest` must not
  // report them again as new: nothing a poll can find is older than the scan's start.
  let floorMs: number | null = null

  return {
    async open(desk) {
      if (!onChat(desk)) await desk.goto(chatUrl, { waitUntil: 'domcontentloaded' })
      const deadline = Date.now() + OPEN_TIMEOUT_MS
      for (;;) {
        assertSignedIn(desk, sel)
        const launcher = shown(desk, s.launcherWebJoin)
        if (await launcher.isVisible()) await launcher.click({ timeout: LAUNCHER_CLICK_MS })
        else if ((await desk.locator(s.chatScroller).count()) > 0) return
        if (Date.now() >= deadline) throw new WatcherChatError('not_loaded')
        await desk.waitForTimeout(OPEN_POLL_MS)
      }
    },

    // One scroll step per desk step: a desk pause waits for one step, never for the whole scan. The scan stops at the
    // budget, like the Discord and WhatsApp scans.
    async history(desk, since, step) {
      const collected = new Map<string, RawTeamsMessage>()
      const collect = async () => {
        for (const m of await read(desk)) if (!Number.isNaN(sentAt(m))) collected.set(keyOf(m), m)
      }
      const oldest = () => Math.min(...Array.from(collected.values(), sentAt))

      // One scroll up, then a read. True when the list has no older rows to load: this is the chat's start.
      const scrollOnce = async (): Promise<boolean> => {
        const moved = await moveList(desk, s, 'up')
        if (moved === null) throw new WatcherChatError('lost')
        await desk.waitForTimeout(sleepMs())
        let atStart = false
        // At the top the list loads older rows lazily. None within the wait means this is the chat's start.
        if (moved.top === 0) {
          try {
            await desk.waitForFunction(
              ({ scroller, height }) => (document.querySelector(scroller)?.scrollHeight ?? 0) > height,
              { scroller: s.chatScroller, height: moved.height },
              // A timer, not the default animation frame: a tab in the background gets no frames.
              { timeout: OLDER_WAIT_MS, polling: 100 }
            )
          } catch (error) {
            if (!(error instanceof errors.TimeoutError)) throw error
            atStart = true
          }
        }
        await collect()
        return atStart
      }

      await step(collect)
      const deadline = Date.now() + historyBudgetMs
      for (let n = 0; n < HISTORY_MAX_STEPS && Date.now() < deadline; n++) {
        if (collected.size > 0 && oldest() < since.getTime()) break
        if (await step(scrollOnce)) break
      }

      await step(async () => {
        if ((await moveList(desk, s, 'bottom')) === null) throw new WatcherChatError('lost')
      })
      floorMs = since.getTime()
      return toMessages(Array.from(collected.values()), floorMs)
    },

    async latest(desk) {
      assertSignedIn(desk, sel)
      if ((await moveList(desk, s, 'bottom')) === null) throw new WatcherChatError('lost')
      await desk.waitForTimeout(SCROLL_SETTLE_MS)
      return toMessages(await read(desk), floorMs)
    }
  }
}

/** Starts watching the Teams chat `src.chat` names. Only a Teams chat source is accepted. */
export async function startWatcher(
  desk: Page,
  src: LinkSource,
  onLink: (c: FormCandidate | { meetingUrl: string }) => void
): Promise<Stopper> {
  if (src.kind !== 'chat' || src.app !== 'teams') throw new TypeError('the Teams watcher reads Teams chats only')
  const url = normaliseTeamsChatUrl(src.chat)
  if (url === null) throw new WatcherChatError('not_found')
  return runChatWatcher(desk, teamsChatReader(url, await teamsSelectors()), onLink)
}
