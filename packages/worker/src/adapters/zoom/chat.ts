import type { Page } from 'playwright'
import type { ChatMessage, SenderRole } from '@tm/core'
import { extractLinks } from '../../forms/links'
import type { ChatCursor } from '../types'
import { duringNavigation, zoomRoot } from './root'
import { zoomSelectors } from './selectors'

// A message as the in-page parser stores it: the links it found as anchors are merged with the text's links here.
interface ParsedMessage {
  key: string
  sender: string
  senderRole: SenderRole
  time: string
  seenAt: string
  text: string
  hrefs: string[]
  replyTo: string | null
}

// What a sweep reports: every message parsed so far, and whether it scrolled the whole list before its time ran out.
interface ProbeResult {
  messages: ParsedMessage[]
  complete: boolean
  // Scroll position reached and list height, in px, for the log.
  reached: number
  total: number
}

// A sweep stops after this long: a list that keeps growing, or a page that stalls, must not hold the meeting loop.
export const SWEEP_BUDGET_MS = 45_000

interface ProbeConfig {
  mode: 'read' | 'sweep'
  sweepBudgetMs: number
  chatList: string
  chatItem: string
  chatSender: string
  chatTime: string
  chatText: string
  chatReplyQuote: string
  roleLabel: string
}

// Runs inside the Zoom document (the iframe or the top page), so it shares nothing with this module: every helper is
// declared in the function. Modelled on docs/reference-scripts/browser/zoom-chat-capture.js.
//
// This function is serialised by Playwright and evaluated in the page. Do not bundle or transform it with a tool that
// injects helpers (`--minify`, `--keep-names` and the like add `__name(...)` calls, which do not exist in the page).
//
// First call per document installs the parser (a MutationObserver plus a 3 s timer) and a 1.5 s timer that keeps the
// chat list scrolled to the bottom; a later call finds `window.__tmChat` and reuses it. Zoom's list is virtualised:
// only the rows in view exist, so a list scrolled up never renders new messages. 'read' parses what is rendered now;
// 'sweep' scrolls the whole list so every row renders once. Both return every message parsed so far.
//
// A row that is a grouped follow-up (no sender or time of its own) takes the sender of the row before it in the same
// render. When no earlier row of the render has a sender (the first row in view), the row cannot be attributed and is
// left out: a sweep, which scrolls from the top, picks it up with its sender.
async function chatProbe(cfg: ProbeConfig): Promise<ProbeResult> {
  interface Store {
    messages: ParsedMessage[]
    keys: Set<string>
    parse(): void
    pin(force?: boolean): void
    sweeping(): boolean
    sweep(budgetMs: number): Promise<{ complete: boolean; reached: number; total: number }>
  }
  const w = window as unknown as { __tmChat?: Store }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  if (!w.__tmChat) {
    const roleLabel = new RegExp(cfg.roleLabel, 'i')
    const messages: ParsedMessage[] = []
    const keys = new Set<string>()
    let pinTimer: number | null = null
    let parseTimer: number | null = null
    let sweepRun: Promise<{ complete: boolean; reached: number; total: number }> | null = null

    const list = () => document.querySelector(cfg.chatList)
    const scrollable = (el: Element) =>
      /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight
    const scroller = () => {
      const l = list()
      return l ? ([l, ...l.querySelectorAll('*')].find(scrollable) ?? null) : null
    }
    // Jumping to the bottom moves the list out from under a sweep, so nothing but the sweep itself pins during one.
    const pin = (force = false) => {
      if (sweepRun && !force) return
      const s = scroller()
      if (s) s.scrollTop = s.scrollHeight
    }
    const textOf = (root: Element, selector: string) =>
      root.querySelector<HTMLElement>(selector)?.innerText.trim() ?? ''

    const parse = () => {
      const l = list()
      if (!l) return
      let lastSender = ''
      let lastRole: SenderRole = 'unknown'
      let lastTime = ''
      for (const item of l.querySelectorAll<HTMLElement>(cfg.chatItem)) {
        // A grouped follow-up has no sender or time of its own: it takes the previous item's.
        const rawSender = textOf(item, cfg.chatSender)
        let sender = lastSender
        let senderRole: SenderRole = lastRole
        if (rawSender) {
          const label = roleLabel.exec(rawSender)
          sender = rawSender.replace(roleLabel, '').trim()
          if (!sender) senderRole = 'unknown'
          else if (!label) senderRole = 'participant'
          else senderRole = /co.?host/i.test(label[1] ?? label[0]) ? 'co_host' : 'host'
        }
        const time = textOf(item, cfg.chatTime) || lastTime
        lastSender = sender
        lastRole = senderRole
        lastTime = time

        // The text element is the innermost match: the selector lists outer wrappers as well.
        const textEl = [...item.querySelectorAll<HTMLElement>(cfg.chatText)].find((e) => !e.querySelector(cfg.chatText))
        const text = textEl?.innerText.trim() ?? ''
        if (!text) continue
        // Never store an unattributed row: it would read as a message from nobody and, once its sender is known,
        // as a second copy. The next sweep attributes it.
        if (!sender) continue

        // Only the row's own id counts. An ancestor's id can be the list's wrapper: it holds one row while the list has
        // one, so a key taken from it would change once a second row arrived and store the row twice.
        const id = item.id || item.getAttribute('data-id') || ''
        const key = id ? `id:${id}` : `${sender}|${time}|${text.slice(0, 200)}`
        if (keys.has(key)) continue

        const quote = textOf(item, cfg.chatReplyQuote)
        const parent = quote ? messages.findLast((m) => m.text.startsWith(quote)) : undefined
        keys.add(key)
        messages.push({
          key,
          sender,
          senderRole,
          time,
          seenAt: new Date().toISOString(),
          text,
          hrefs: [...textEl!.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.href),
          replyTo: parent?.key ?? null
        })
      }
    }

    const startPinning = () => {
      pinTimer ??= window.setInterval(pin, 1500)
    }
    const stopPinning = () => {
      if (pinTimer !== null) window.clearInterval(pinTimer)
      pinTimer = null
    }

    // Scrolls the list top to bottom so every row renders once, at most `budgetMs` long.
    const runSweep = async (budgetMs: number) => {
      const sc = scroller()
      if (!sc) {
        parse()
        return { complete: true, reached: 0, total: 0 }
      }
      const started = Date.now()
      let complete = true
      let y = 0
      stopPinning()
      try {
        for (; y <= sc.scrollHeight; y += Math.max(200, sc.clientHeight / 2)) {
          if (Date.now() - started > budgetMs) {
            complete = false
            break
          }
          sc.scrollTop = y
          await sleep(300)
          parse()
        }
        pin(true)
        await sleep(300)
        parse()
      } finally {
        startPinning()
      }
      return { complete, reached: y, total: sc.scrollHeight }
    }
    // One sweep at a time: a caller that arrives during one gets that sweep's result.
    const sweep = (budgetMs: number) => {
      sweepRun ??= runSweep(budgetMs).finally(() => {
        sweepRun = null
      })
      return sweepRun
    }

    // A batch that adds rows is parsed at once: the list can scroll a row out before a delayed parse would see it. Any
    // other change (text edits, removals) is debounced, 250 ms after the first.
    const scheduleParse = () => {
      parseTimer ??= window.setTimeout(() => {
        parseTimer = null
        parse()
      }, 250)
    }
    new MutationObserver((records) => {
      if (records.some((r) => r.addedNodes.length > 0)) {
        if (parseTimer !== null) window.clearTimeout(parseTimer)
        parseTimer = null
        parse()
      } else {
        scheduleParse()
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
    window.setInterval(parse, 3000)
    startPinning()
    w.__tmChat = { messages, keys, parse, pin, sweeping: () => sweepRun !== null, sweep }
  }

  const store = w.__tmChat
  if (cfg.mode === 'read') {
    store.pin()
    // The scroll event and the re-render of a virtualised list land a moment after scrollTop is set.
    await sleep(100)
    store.parse()
    return { messages: store.messages, complete: true, reached: 0, total: 0 }
  }
  const outcome = await store.sweep(cfg.sweepBudgetMs)
  return { messages: store.messages, ...outcome }
}

async function probe(page: Page, mode: ProbeConfig['mode'], sweepBudgetMs = SWEEP_BUDGET_MS): Promise<ProbeResult> {
  const { selectors: sel, texts } = await zoomSelectors()
  const root = await zoomRoot(page)
  return root.evaluate(chatProbe, {
    mode,
    sweepBudgetMs,
    chatList: sel.chatList,
    chatItem: sel.chatItem,
    chatSender: sel.chatSender,
    chatTime: sel.chatTime,
    chatText: sel.chatText,
    chatReplyQuote: sel.chatReplyQuote,
    roleLabel: texts.roleLabel
  })
}

function toChatMessage({ hrefs, ...message }: ParsedMessage): ChatMessage {
  const links = [...new Set([...extractLinks(message.text), ...hrefs.filter((href) => /^https?:/i.test(href))])]
  return { ...message, links }
}

// The messages parsed so far whose keys the cursor has not seen, and a cursor that has seen them too. It advances
// nothing itself: the caller adopts the new cursor only after the messages are durably written.
export async function zoomReadChat(
  page: Page,
  cursor: ChatCursor
): Promise<{ messages: ChatMessage[]; cursor: ChatCursor }> {
  // A page that navigates under the read yields nothing this time; the cursor stays where it was.
  const parsed = await duringNavigation('readChat', () => probe(page, 'read'))
  const seen = new Set(cursor.seenKeys)
  const messages = (parsed?.messages ?? []).filter((m) => !seen.has(m.key)).map(toChatMessage)
  return { messages, cursor: { seenKeys: [...cursor.seenKeys, ...messages.map((m) => m.key)] } }
}

// Scrolls the whole list so every row renders, and returns every message parsed so far (not only new ones). Stops after
// `budgetMs`: the log then says how far it got, and the next sweep starts again from the top. A page that navigates
// under the sweep yields nothing this time.
export async function zoomSweepChat(page: Page, budgetMs: number = SWEEP_BUDGET_MS): Promise<ChatMessage[]> {
  const result = await duringNavigation('sweepChat', () => probe(page, 'sweep', budgetMs))
  if (!result) return []
  if (!result.complete) {
    console.warn(`zoom: chat sweep partial, reached ${result.reached} of ${result.total} px in ${budgetMs} ms`)
  }
  return result.messages.map(toChatMessage)
}
