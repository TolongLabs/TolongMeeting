import type { ChatMessage, FormCandidate, LinkSource } from '@tm/core'
import { errors, type Page } from 'playwright'
import type { Stopper } from '../types'
import { runChatWatcher, WatcherChatError, WatcherSigninError, type ChatSourceReader } from './loop'
import { whatsappSelectors, type WhatsAppSelectors } from './selectors'
import { parseWhatsAppPrePlain, type DateOrder } from './whatsapp-time'

// Every selector is a starting value, unverified against the live WhatsApp Web app (plan 02 task 9 checks them).
//
// WhatsApp Web allows one live window per profile: this reader works in the one tab it is given and never opens
// another. It searches for the chat, opens it, then only scrolls and reads. It never types in the message box, sends,
// reacts, replies or marks anything as read, and it never logs a message's text or links.

const HOST = 'web.whatsapp.com'
const HOME = `https://${HOST}/`
const OPEN_TIMEOUT_MS = 60_000
const OPEN_POLL_MS = 250
const SEARCH_WAIT_MS = 3_000
const HEADER_TIMEOUT_MS = 10_000
const HISTORY_BUDGET_MS = 60_000
const HISTORY_MAX_STEPS = 40
const OLDER_WAIT_MS = 3_000
// Scroll steps in a row that bring nothing older before the reader decides it has reached the chat's start.
const NO_OLDER_LIMIT = 2
const SCROLL_SETTLE_MS = 150

const canon = (s: string) => s.normalize('NFC').trim()

// A message as the page reports it.
interface RawRow {
  key: string
  prePlain: string
  text: string
  hrefs: string[]
}

interface Row {
  message: ChatMessage
  sentAt: number
}

interface PageProbe {
  qrVisible: boolean
  hasChatList: boolean
  hasScroller: boolean
  header: string | null
}

interface TimeFormat {
  order: DateOrder
  offsetMinutes: number
}

async function probe(desk: Page, sel: WhatsAppSelectors): Promise<PageProbe> {
  return desk.evaluate(
    ({ linkQr, chatList, scroller, headerTitle }) => {
      const visible = (el: Element | null) => el !== null && el.getClientRects().length > 0
      return {
        qrVisible: visible(document.querySelector(linkQr)),
        hasChatList: document.querySelector(chatList) !== null,
        hasScroller: document.querySelector(scroller) !== null,
        header: document.querySelector(headerTitle)?.textContent?.normalize('NFC').trim() ?? null
      }
    },
    { linkQr: sel.linkQr, chatList: sel.chatList, scroller: sel.scroller, headerTitle: sel.headerTitle }
  )
}

// The page's date order and its offset east of UTC.
function readTimeFormat(desk: Page): Promise<TimeFormat> {
  return desk.evaluate(() => {
    const parts = new Intl.DateTimeFormat().formatToParts(new Date(2001, 10, 22))
    const day = parts.findIndex((p) => p.type === 'day')
    const month = parts.findIndex((p) => p.type === 'month')
    return {
      order: day < month ? ('dmy' as const) : ('mdy' as const),
      offsetMinutes: 0 - new Date().getTimezoneOffset()
    }
  })
}

// Runs in the page: one call reads every rendered message row that has a `data-pre-plain-text`. Rows without one
// (system notices, deleted messages) are skipped here.
async function readRendered(desk: Page, sel: WhatsAppSelectors): Promise<RawRow[]> {
  return desk.evaluate(
    ({ messageRow, prePlain, messageText }) => {
      const out: { key: string; prePlain: string; text: string; hrefs: string[] }[] = []
      for (const row of document.querySelectorAll(messageRow)) {
        const pre = row.querySelector(prePlain)?.getAttribute('data-pre-plain-text')
        const key = row.getAttribute('data-id')
        if (!pre || !key) continue
        out.push({
          key,
          prePlain: pre,
          text: row.querySelector(messageText)?.textContent?.trim() ?? '',
          hrefs: Array.from(row.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href)
        })
      }
      return out
    },
    { messageRow: sel.messageRow, prePlain: sel.prePlain, messageText: sel.messageText }
  )
}

// Sets the scroller's scrollTop to the top (0) or the bottom. False when the scroller is gone.
function scrollTo(desk: Page, sel: WhatsAppSelectors, where: 'top' | 'bottom'): Promise<boolean> {
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

function firstRowId(desk: Page, sel: WhatsAppSelectors): Promise<string | null> {
  return desk.evaluate((row) => document.querySelector(row)?.getAttribute('data-id') ?? null, sel.messageRow)
}

// Absolute `https?://` URLs in the text, without the punctuation that ends a sentence.
function textUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, ''))
}

function toRow(raw: RawRow, format: TimeFormat, seenAt: string): Row | null {
  const parsed = parseWhatsAppPrePlain(raw.prePlain, format.order, format.offsetMinutes)
  if (parsed === null) return null
  return {
    sentAt: Date.parse(parsed.sentAt),
    message: {
      key: raw.key,
      sender: parsed.sender,
      senderRole: 'unknown',
      time: parsed.shown,
      seenAt,
      text: raw.text,
      links: Array.from(new Set([...raw.hrefs, ...textUrls(raw.text)])),
      replyTo: null
    }
  }
}

function toRows(raw: RawRow[], format: TimeFormat): Row[] {
  const seenAt = new Date().toISOString()
  return raw.flatMap((r) => toRow(r, format, seenAt) ?? [])
}

// Adds the rows of one page read (oldest first) to `order`, keeping the chat's own order. WhatsApp shows only the
// minute, so rows cannot be sorted by time alone: a new row goes right after the row before it on the page, and one
// before the first known row goes right before that row.
function merge(order: Row[], batch: Row[]): void {
  const at = (key: string) => order.findIndex((r) => r.message.key === key)
  const firstKnown = batch.findIndex((r) => at(r.message.key) >= 0)
  batch.forEach((row, i) => {
    if (at(row.message.key) >= 0) return
    if (i > 0) order.splice(at(batch[i - 1]!.message.key) + 1, 0, row)
    else if (firstKnown >= 0) order.splice(at(batch[firstKnown]!.message.key), 0, row)
    else {
      // Nothing on the page is known yet: place the row by time.
      const later = order.findIndex((r) => r.sentAt > row.sentAt)
      order.splice(later < 0 ? order.length : later, 0, row)
    }
  })
}

/** Reads one WhatsApp Web chat, found by its exact name, in the member's own session. */
export function whatsappReader(chatName: string, sel: WhatsAppSelectors): ChatSourceReader {
  const name = canon(chatName)
  let format: TimeFormat | null = null

  const timeFormat = (): TimeFormat => {
    if (format === null) throw new Error('the WhatsApp reader was used before open()')
    return format
  }

  // Waits until the header shows the chat's name. False on a timeout.
  async function headerShows(desk: Page): Promise<boolean> {
    try {
      await desk.waitForFunction(
        ({ headerTitle, name }) => document.querySelector(headerTitle)?.textContent?.normalize('NFC').trim() === name,
        { headerTitle: sel.headerTitle, name },
        // A timer, not the default animation frame: a tab in the background gets no frames.
        { timeout: HEADER_TIMEOUT_MS, polling: 100 }
      )
      return true
    } catch (error) {
      if (error instanceof errors.TimeoutError) return false
      throw error
    }
  }

  return {
    async open(desk) {
      if (new URL(desk.url()).host !== HOST) await desk.goto(HOME, { waitUntil: 'domcontentloaded' })
      const deadline = Date.now() + OPEN_TIMEOUT_MS
      for (;;) {
        const state = await probe(desk, sel)
        if (state.qrVisible) throw new WatcherSigninError(HOST)
        if (state.hasChatList) break
        if (Date.now() >= deadline) throw new WatcherChatError('not_loaded')
        await desk.waitForTimeout(OPEN_POLL_MS)
      }

      // The search box is the only thing typed into, and it is outside the chat.
      await desk.fill(sel.searchBox, name)
      await desk.waitForTimeout(SEARCH_WAIT_MS)
      const titles = await desk.evaluate(
        (resultTitle) =>
          Array.from(document.querySelectorAll(resultTitle), (el) => el.getAttribute('title')?.normalize('NFC').trim()),
        sel.searchResultTitle
      )
      const hits = titles.flatMap((title, i) => (title === name ? [i] : []))
      if (hits.length === 1) await desk.locator(sel.searchResultTitle).nth(hits[0]!).click()
      await desk.fill(sel.searchBox, '')
      if (hits.length === 0) throw new WatcherChatError('not_found')
      if (hits.length > 1) throw new WatcherChatError('ambiguous')

      if (!(await headerShows(desk))) throw new WatcherChatError('not_found')
      format = await readTimeFormat(desk)
    },

    async history(desk, since) {
      const order: Row[] = []
      const collect = async () => merge(order, toRows(await readRendered(desk, sel), timeFormat()))
      const oldest = () => Math.min(...order.map((r) => r.sentAt))

      await collect()
      const deadline = Date.now() + HISTORY_BUDGET_MS
      let misses = 0
      for (let step = 0; step < HISTORY_MAX_STEPS && Date.now() < deadline; step++) {
        if (order.length > 0 && oldest() < since.getTime()) break
        const first = await firstRowId(desk, sel)
        if (!(await scrollTo(desk, sel, 'top'))) throw new WatcherChatError('lost')
        try {
          await desk.waitForFunction(
            ({ messageRow, first }) => document.querySelector(messageRow)?.getAttribute('data-id') !== first,
            { messageRow: sel.messageRow, first },
            { timeout: OLDER_WAIT_MS, polling: 100 }
          )
          misses = 0
        } catch (error) {
          // Nothing older arrived within the wait: after enough of these the chat's start has been reached.
          if (!(error instanceof errors.TimeoutError)) throw error
          if (++misses >= NO_OLDER_LIMIT) break
        }
        await collect()
      }
      await collect()

      if (!(await scrollTo(desk, sel, 'bottom'))) throw new WatcherChatError('lost')
      return order.filter((r) => r.sentAt >= since.getTime()).map((r) => r.message)
    },

    async latest(desk) {
      const state = await probe(desk, sel)
      if (state.qrVisible) throw new WatcherSigninError(HOST)
      if (state.header !== name) throw new WatcherChatError('lost')
      if (!state.hasScroller) throw new WatcherChatError('not_loaded')
      await scrollTo(desk, sel, 'bottom')
      await desk.waitForTimeout(SCROLL_SETTLE_MS)
      return toRows(await readRendered(desk, sel), timeFormat()).map((r) => r.message)
    }
  }
}

/** Starts watching the WhatsApp chat named `src.chat`. Only a WhatsApp chat source is accepted. */
export async function startWatcher(
  desk: Page,
  src: LinkSource,
  onLink: (c: FormCandidate | { meetingUrl: string }) => void
): Promise<Stopper> {
  if (src.kind !== 'chat' || src.app !== 'whatsapp')
    throw new TypeError('the WhatsApp watcher reads WhatsApp chats only')
  const name = canon(src.chat)
  if (name === '') throw new WatcherChatError('not_found')
  return runChatWatcher(desk, whatsappReader(name, await whatsappSelectors()), onLink)
}
