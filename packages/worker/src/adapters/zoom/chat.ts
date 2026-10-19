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

interface ProbeConfig {
  mode: 'read' | 'sweep'
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
// First call per document installs the parser (a MutationObserver plus a 3 s timer) and a 1.5 s timer that keeps the
// chat list scrolled to the bottom; a later call finds `window.__tmChat` and reuses it. Zoom's list is virtualised:
// only the rows in view exist, so a list scrolled up never renders new messages. 'read' parses what is rendered now;
// 'sweep' scrolls the whole list so every row renders once. Both return every message parsed so far.
async function chatProbe(cfg: ProbeConfig): Promise<ParsedMessage[]> {
  interface Store {
    messages: ParsedMessage[]
    keys: Set<string>
    parse(): void
    pin(): void
    startPinning(): void
    stopPinning(): void
    scroller(): Element | null
  }
  const w = window as unknown as { __tmChat?: Store }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  if (!w.__tmChat) {
    const roleLabel = new RegExp(cfg.roleLabel, 'i')
    const messages: ParsedMessage[] = []
    const keys = new Set<string>()
    let pinTimer: number | null = null

    const list = () => document.querySelector(cfg.chatList)
    const scrollable = (el: Element) =>
      /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight
    const scroller = () => {
      const l = list()
      return l ? ([l, ...l.querySelectorAll('*')].find(scrollable) ?? null) : null
    }
    const pin = () => {
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

        // An id counts only when it belongs to this row: one on an ancestor shared by several rows would merge them.
        const ancestor = item.closest('[id]')
        let id = item.id || item.getAttribute('data-id') || ''
        if (
          !id &&
          ancestor &&
          ancestor !== l &&
          l.contains(ancestor) &&
          ancestor.querySelectorAll(cfg.chatItem).length === 1
        ) {
          id = ancestor.id
        }
        // The first row in view can be a follow-up whose sender row scrolled out: with no sender it cannot be
        // attributed, and when the same text is already stored it is that message, not a new one.
        if (!id && !sender && messages.some((m) => m.text === text)) continue
        const key = id ? `id:${id}` : `${sender}|${time}|${text.slice(0, 200)}`
        if (keys.has(key)) continue

        const quote = textOf(item, cfg.chatReplyQuote)
        const parent = quote ? messages.findLast((m) => m.text.startsWith(quote)) : undefined
        keys.add(key)
        messages.push({
          key,
          sender,
          senderRole: sender ? senderRole : 'unknown',
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
    new MutationObserver(parse).observe(document.body, { childList: true, subtree: true, characterData: true })
    window.setInterval(parse, 3000)
    startPinning()
    w.__tmChat = { messages, keys, parse, pin, startPinning, stopPinning, scroller }
  }

  const store = w.__tmChat
  if (cfg.mode === 'read') {
    store.pin()
    // The scroll event and the re-render of a virtualised list land a moment after scrollTop is set.
    await sleep(100)
    store.parse()
  } else {
    const sc = store.scroller()
    if (sc) {
      store.stopPinning()
      try {
        for (let y = 0; y <= sc.scrollHeight; y += Math.max(200, sc.clientHeight / 2)) {
          sc.scrollTop = y
          await sleep(300)
          store.parse()
        }
        store.pin()
        await sleep(300)
        store.parse()
      } finally {
        store.startPinning()
      }
    } else {
      store.parse()
    }
  }
  return store.messages
}

async function probe(page: Page, mode: ProbeConfig['mode']): Promise<ParsedMessage[]> {
  const { selectors: sel, texts } = await zoomSelectors()
  const root = await zoomRoot(page)
  return root.evaluate(chatProbe, {
    mode,
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
  const parsed = await duringNavigation(() => probe(page, 'read'))
  const seen = new Set(cursor.seenKeys)
  const messages = (parsed ?? []).filter((m) => !seen.has(m.key)).map(toChatMessage)
  return { messages, cursor: { seenKeys: [...cursor.seenKeys, ...messages.map((m) => m.key)] } }
}

// Scrolls the whole list so every row renders, and returns every message parsed so far (not only new ones).
export async function zoomSweepChat(page: Page): Promise<ChatMessage[]> {
  return (await probe(page, 'sweep')).map(toChatMessage)
}
