import { normaliseDiscordChannelUrl, type ChatMessage, type FormCandidate, type LinkSource } from '@tm/core'
import { errors, type Page } from 'playwright'
import type { Stopper } from '../types'
import { runChatWatcher, WatcherChatError, WatcherSigninError, type ChatSourceReader } from './loop'
import { discordSelectors, type DiscordSelectors } from './selectors'

// Every selector is a starting value, unverified against the live Discord web app (plan 02 task 9 checks them).
//
// This reader only navigates, scrolls and reads. It never clicks, types, reacts, replies or marks anything as read, and
// it never logs a message's text or links.

const HOST = 'discord.com'
const OPEN_TIMEOUT_MS = 60_000
const OPEN_POLL_MS = 250
const HISTORY_BUDGET_MS = 60_000
const HISTORY_MAX_STEPS = 40
const OLDER_WAIT_MS = 3_000
const SCROLL_SETTLE_MS = 150

// A message as the page reports it. `sender` is null when neither the item nor the item before it shows a name.
interface RawMessage {
  key: string
  sender: string | null
  time: string
  text: string
  links: string[]
}

interface PageProbe {
  path: string
  loginVisible: boolean
  hasScroller: boolean
}

const channelPath = (url: string) => new URL(url).pathname.replace(/\/+$/, '')

const timeOf = (m: RawMessage) => Date.parse(m.time)

// Discord message ids are snowflakes: a longer id is newer, then compare as text.
const byTime = (a: RawMessage, b: RawMessage) =>
  timeOf(a) - timeOf(b) || a.key.length - b.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

async function probe(desk: Page, sel: DiscordSelectors): Promise<PageProbe> {
  return desk.evaluate(
    ({ scroller, loginForm }) => {
      const visible = (el: Element | null) => el !== null && el.getClientRects().length > 0
      return {
        path: location.pathname.replace(/\/+$/, ''),
        loginVisible: visible(document.querySelector(loginForm)),
        hasScroller: document.querySelector(scroller) !== null
      }
    },
    { scroller: sel.scroller, loginForm: sel.loginForm }
  )
}

// Runs in the page: one call reads every rendered message. Items without a datetime (a message still sending) are
// skipped. A follow-up message has no name, so it takes the name of the item before it.
async function readRendered(desk: Page, sel: DiscordSelectors): Promise<RawMessage[]> {
  return desk.evaluate(
    ({ message, content, username, time }) => {
      const out: { key: string; sender: string | null; time: string; text: string; links: string[] }[] = []
      let previous: string | null = null
      for (const el of document.querySelectorAll(message)) {
        const name = el.querySelector(username)?.textContent?.trim() || null
        const sender: string | null = name ?? previous
        previous = sender
        const datetime = el.querySelector(time)?.getAttribute('datetime') ?? ''
        if (Number.isNaN(Date.parse(datetime))) continue
        const body = el.querySelector(content)
        out.push({
          key: el.id.split('-').pop() ?? el.id,
          sender,
          time: datetime,
          text: body?.textContent?.trim() ?? '',
          links: body ? Array.from(body.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href) : []
        })
      }
      return out
    },
    { message: sel.message, content: sel.content, username: sel.username, time: sel.time }
  )
}

// Sets the scroller's scrollTop to the top (0) or the bottom. False when the scroller is gone.
function scrollTo(desk: Page, sel: DiscordSelectors, where: 'top' | 'bottom'): Promise<boolean> {
  return desk.evaluate(
    ({ scroller, where }) => {
      const el = document.querySelector(scroller)
      if (el === null) return false
      el.scrollTop = where === 'top' ? 0 : el.scrollHeight
      return true
    },
    { scroller: sel.scroller, where }
  )
}

function firstMessageId(desk: Page, sel: DiscordSelectors): Promise<string | null> {
  return desk.evaluate((message) => document.querySelector(message)?.id ?? null, sel.message)
}

function channelStartVisible(desk: Page, sel: DiscordSelectors): Promise<boolean> {
  return desk.evaluate((channelStart) => {
    const el = document.querySelector(channelStart)
    return el !== null && el.getClientRects().length > 0
  }, sel.channelStart)
}

function toChatMessage(m: RawMessage, sender: string, seenAt: string): ChatMessage {
  return {
    key: m.key,
    sender,
    senderRole: 'unknown',
    time: m.time,
    seenAt,
    text: m.text,
    links: m.links,
    replyTo: null
  }
}

// Sorts by time and gives a message with no name the sender of the one before it.
function finish(raw: RawMessage[]): ChatMessage[] {
  const seenAt = new Date().toISOString()
  let sender = ''
  return [...raw].sort(byTime).map((m) => {
    sender = m.sender ?? sender
    return toChatMessage(m, sender, seenAt)
  })
}

/** Reads one Discord channel on discord.com in the member's own session. `channelUrl` is normalised already. */
export function discordReader(channelUrl: string, sel: DiscordSelectors): ChatSourceReader {
  const wantedPath = channelPath(channelUrl)

  // Throws for a signed-out page. Returns the probe for a page that is signed in.
  async function signedInProbe(desk: Page): Promise<PageProbe> {
    const state = await probe(desk, sel)
    if (state.path === '/login' || state.loginVisible) throw new WatcherSigninError(HOST)
    return state
  }

  return {
    async open(desk) {
      if (channelPath(desk.url()) !== wantedPath) await desk.goto(channelUrl, { waitUntil: 'domcontentloaded' })
      const deadline = Date.now() + OPEN_TIMEOUT_MS
      for (;;) {
        const state = await signedInProbe(desk)
        if (state.path !== wantedPath) throw new WatcherChatError('not_found')
        if (state.hasScroller) return
        if (Date.now() >= deadline) throw new WatcherChatError('not_loaded')
        await desk.waitForTimeout(OPEN_POLL_MS)
      }
    },

    async history(desk, since) {
      const collected = new Map<string, RawMessage>()
      const collect = async () => {
        for (const m of await readRendered(desk, sel)) {
          const have = collected.get(m.key)
          if (have === undefined || (have.sender === null && m.sender !== null)) collected.set(m.key, m)
        }
      }
      const oldest = () => Math.min(...Array.from(collected.values(), timeOf))

      await collect()
      const deadline = Date.now() + HISTORY_BUDGET_MS
      for (let step = 0; step < HISTORY_MAX_STEPS && Date.now() < deadline; step++) {
        if (collected.size > 0 && oldest() < since.getTime()) break
        if (await channelStartVisible(desk, sel)) break
        const first = await firstMessageId(desk, sel)
        if (!(await scrollTo(desk, sel, 'top'))) throw new WatcherChatError('lost')
        try {
          await desk.waitForFunction(
            ({ message, first }) => document.querySelector(message)?.id !== first,
            { message: sel.message, first },
            // A timer, not the default animation frame: a tab in the background gets no frames.
            { timeout: OLDER_WAIT_MS, polling: 100 }
          )
        } catch (error) {
          // Nothing older arrived within the wait; the next step tries again.
          if (!(error instanceof errors.TimeoutError)) throw error
        }
        await collect()
      }

      if (!(await scrollTo(desk, sel, 'bottom'))) throw new WatcherChatError('lost')
      return finish(Array.from(collected.values())).filter((m) => Date.parse(m.time) >= since.getTime())
    },

    async latest(desk) {
      const state = await signedInProbe(desk)
      if (state.path !== wantedPath) throw new WatcherChatError('lost')
      if (!state.hasScroller) throw new WatcherChatError('not_loaded')
      await scrollTo(desk, sel, 'bottom')
      await desk.waitForTimeout(SCROLL_SETTLE_MS)
      return finish(await readRendered(desk, sel))
    }
  }
}

/** Starts watching the Discord channel `src.chat` names. Only a Discord chat source is accepted. */
export async function startWatcher(
  desk: Page,
  src: LinkSource,
  onLink: (c: FormCandidate | { meetingUrl: string }) => void
): Promise<Stopper> {
  if (src.kind !== 'chat' || src.app !== 'discord') throw new TypeError('the Discord watcher reads Discord chats only')
  const url = normaliseDiscordChannelUrl(src.chat)
  if (url === null) throw new WatcherChatError('not_found')
  return runChatWatcher(desk, discordReader(url, await discordSelectors()), onLink)
}
