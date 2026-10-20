import { setTimeout as sleep } from 'node:timers/promises'
import type { ChatMessage, SenderRole } from '@tm/core'
import type { Page } from 'playwright'
import { extractLinks } from '../../forms/links'
import { navigationGuard } from '../zoom/root'
import type { ChatCursor } from '../types'
import { parseMeetMessages, type RawMeetMessage } from './chat-dom'
import { shown } from './join'
import { meetState } from './page-state'
import { readRolesNow, withMeetPanel } from './roles'
import type { MeetSelectors } from './selectors'

// A sweep stops after this long: a list that keeps growing, or a page that stalls, must not hold the meeting loop.
export const SWEEP_BUDGET_MS = 45_000

// Chat text is never logged here: a log line holds counts and px only.

export function meetMessageKey(raw: RawMeetMessage): string {
  return raw.id ?? `${raw.sender}|${raw.time}|${raw.text.slice(0, 200)}`
}

const roleKey = (sender: string) => sender.trim().toLowerCase()

// Roles come from `ctx.roles` (the People panel) and nowhere else: what a message says about its sender is never read.
// A sender missing from the map, or no map yet, is `unknown`.
export function toMeetChatMessages(
  raw: RawMeetMessage[],
  ctx: { roles: Map<string, SenderRole> | null; seenAt: string }
): ChatMessage[] {
  return raw.map((m) => ({
    key: meetMessageKey(m),
    sender: m.sender,
    senderRole: ctx.roles?.get(roleKey(m.sender)) ?? 'unknown',
    time: m.time,
    seenAt: ctx.seenAt,
    text: m.text,
    links: [...new Set([...m.hrefs.filter((href) => /^https?:/i.test(href)), ...extractLinks(m.text)])],
    // Meet chat has no threads.
    replyTo: null
  }))
}

const parse = (page: Page, sel: MeetSelectors) => page.evaluate(parseMeetMessages, sel)

async function pinToBottom(page: Page, scroller: string): Promise<void> {
  await page.evaluate((selector) => {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.checkVisibility())
    if (el) el.scrollTop = el.scrollHeight
  }, scroller)
  // The scroll event and a re-render of the list land a moment after scrollTop is set.
  await sleep(100)
}

// The messages whose keys the cursor has not seen, and a cursor that has seen them too. The caller adopts the cursor
// only after writing the messages (CHAT-03). With the chat panel closed it returns nothing and the same cursor: the
// layout pass reopens chat.
export async function readMeetChat(
  page: Page,
  sel: MeetSelectors,
  cursor: ChatCursor
): Promise<{ messages: ChatMessage[]; cursor: ChatCursor }> {
  const read = () =>
    withMeetPanel(page, async () => {
      const scroller = sel.selectors.chatScroller
      if (!(await shown(page, scroller).isVisible())) return null
      const seen = new Set(cursor.seenKeys)
      const fresh = async () => {
        await pinToBottom(page, scroller)
        return (await parse(page, sel)).filter((m) => !seen.has(meetMessageKey(m)))
      }
      let raw = await fresh()
      const roles = () => meetState(page).roles
      // A host who joined late, or a sender who changed role: the People panel is read once, and only for a link, the
      // one thing that makes the sender's role matter.
      const needsRoles = (m: RawMeetMessage) =>
        (m.hrefs.length > 0 || extractLinks(m.text).length > 0) && !roles()?.has(roleKey(m.sender))
      if (raw.some(needsRoles)) {
        await readRolesNow(page, sel)
        raw = await fresh()
      }
      return toMeetChatMessages(raw, { roles: roles(), seenAt: new Date().toISOString() })
    })
  // A page that navigates under the read yields nothing this time; the cursor stays where it was.
  const messages = await navigationGuard('readChat', 'meet').run(read)
  if (!messages || messages.length === 0) return { messages: [], cursor }
  return { messages, cursor: { seenKeys: [...cursor.seenKeys, ...messages.map((m) => m.key)] } }
}

// Reads the People panel, then scrolls the whole chat list top to bottom so every row renders once, and returns every
// message seen, in list order (not only new ones). Stops after `budgetMs`: the log then says how far it got, and the
// next sweep starts again from the top. Holds the side panel, so no read or layout pass moves the list meanwhile.
export function sweepMeetChat(page: Page, sel: MeetSelectors, budgetMs = SWEEP_BUDGET_MS): Promise<ChatMessage[]> {
  const sweep = async (): Promise<ChatMessage[]> => {
    const roles = await readRolesNow(page, sel)
    const scroller = sel.selectors.chatScroller
    const keys = new Set<string>()
    const rows: RawMeetMessage[] = []
    const take = async () => {
      for (const m of await parse(page, sel)) {
        const key = meetMessageKey(m)
        if (!keys.has(key)) {
          keys.add(key)
          rows.push(m)
        }
      }
    }
    const scrollTo = (y: number) =>
      page.evaluate(
        ({ selector, y }) => {
          const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.checkVisibility())
          if (!el) return null
          el.scrollTop = y
          return { height: el.scrollHeight, client: el.clientHeight }
        },
        { selector: scroller, y }
      )
    const started = Date.now()
    let complete = true
    let y = 0
    let height = 0
    for (;;) {
      if (Date.now() - started > budgetMs) {
        complete = false
        break
      }
      const at = await scrollTo(y)
      if (at === null) {
        complete = false
        break
      }
      height = at.height
      await sleep(300 + Math.random() * 50)
      await take()
      y += Math.max(200, at.client / 2)
      if (y > height) break
    }
    // Leave the list at the bottom, where the reads expect it; a sweep that finished also takes the last rows.
    await pinToBottom(page, scroller)
    if (complete) await take()
    else console.warn(`meet: chat sweep partial, reached ${Math.round(y)} of ${height} px in ${budgetMs} ms`)
    return toMeetChatMessages(rows, { roles, seenAt: new Date().toISOString() })
  }
  return withMeetPanel(page, async () => (await navigationGuard('sweepChat', 'meet').run(sweep)) ?? [])
}
