import type { TeamsSelectors } from './selectors'

// Both functions in this file are serialised by Playwright and evaluated in the Teams page, so each is self-contained:
// no imports at run time, no closures over this module, every helper declared in the body. Do not bundle or transform
// them with a tool that injects helpers (`--minify`, `--keep-names` and the like add `__name(...)` calls, which do not
// exist in the page). Pass only the `selectors` strings (page.evaluate(fn, sel.selectors)), never the whole map.
// Nothing here logs: chat text can hold names and form links.

type Sel = TeamsSelectors['selectors']

// A chat row as the page shows it. `sender` is always resolved: a row whose sender cannot be told is left out (see
// below), never reported as a message from nobody.
export interface RawTeamsMessage {
  // The row's own message id; null when the row has none (the caller then keys it by its text).
  id: string | null
  sender: string
  time: string
  datetime: string | null
  text: string
  hrefs: string[]
}

// Parses the rendered chat rows once and keeps nothing. Rows that are system events (no chat message in them) are
// skipped. A grouped follow-up has no author of its own: it takes the sender of the row before it in the same render,
// and when no row before it names a sender (the first row in view) it cannot be attributed and is left out.
export function parseTeamsMessages(sel: Sel): RawTeamsMessage[] {
  const out: RawTeamsMessage[] = []
  const scroller = document.querySelector(sel.chatScroller)
  if (!scroller) return out
  let sender = ''
  for (const item of scroller.querySelectorAll<HTMLElement>(sel.chatItem)) {
    const message = item.querySelector<HTMLElement>(sel.chatMessage)
    if (!message) continue
    const author = message.querySelector<HTMLElement>(sel.chatAuthor)?.innerText.trim() ?? ''
    if (author) sender = author
    const body = message.querySelector<HTMLElement>(sel.chatBody)
    const text = body?.innerText.trim() ?? ''
    if (!body || !text || !sender) continue
    const when = message.querySelector<HTMLElement>(sel.chatTime)
    // Only the row's own ids count; an ancestor's id can belong to the whole list.
    const id = message.getAttribute('data-mid') || body.id.replace(/^content-/, '') || item.id || null
    out.push({
      id,
      sender,
      time: when?.innerText.trim() ?? '',
      datetime: when?.getAttribute('datetime') ?? null,
      text,
      hrefs: [...body.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.href)
    })
  }
  return out
}

export interface TeamsProbeConfig {
  sel: Sel
  // 'read' returns what the page has shown since the probe was installed; 'sweep' scrolls the list top to bottom first.
  mode: 'read' | 'sweep'
  sweepBudgetMs: number
}

// What the probe reports. A sweep lists the rows it met in list order; a read lists everything stored so far.
export interface TeamsProbeResult {
  messages: RawTeamsMessage[]
  // False when a sweep ran out of time before the bottom of the list.
  complete: boolean
  // Scroll position reached and list height, in px, for the log.
  reached: number
  total: number
}

// The live reader. The first call per document installs a MutationObserver (rows that are added are parsed at once,
// even when a burst has already scrolled them out of the virtualised list again), a 3 s timer and a 1.5 s timer that
// keeps the list at the bottom; a later call reuses them through `window.__tmTeamsChat`.
//
// The same row-reading rules as parseTeamsMessages, plus one source of senders for grouped follow-ups: a row whose id
// was stored with a sender keeps that sender, and a lone new row takes the sender of the row before it.
export async function teamsChatProbe(cfg: TeamsProbeConfig): Promise<TeamsProbeResult> {
  interface Stored extends RawTeamsMessage {
    key: string
  }
  interface Outcome {
    messages: Stored[]
    complete: boolean
    reached: number
    total: number
  }
  interface Store {
    messages: Stored[]
    pin(force?: boolean): void
    parseLive(): void
    sweep(budgetMs: number): Promise<Outcome>
  }
  const w = window as unknown as { __tmTeamsChat?: Store }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  if (!w.__tmTeamsChat) {
    const sel = cfg.sel
    const messages: Stored[] = []
    const keys = new Set<string>()
    const senderById = new Map<string, string>()
    let pinTimer: number | null = null
    let parseTimer: number | null = null
    let sweepRun: Promise<Outcome> | null = null

    const scroller = () => document.querySelector<HTMLElement>(sel.chatScroller)
    // Jumping to the bottom moves the list out from under a sweep, so nothing but the sweep itself pins during one.
    const pin = (force = false) => {
      if (sweepRun && !force) return
      const s = scroller()
      if (s) s.scrollTop = s.scrollHeight
    }
    // innerText needs layout; a row that a burst already detached has none, so its textContent is read instead.
    const textOf = (el: Element | null) =>
      el === null ? '' : ((el instanceof HTMLElement && el.isConnected ? el.innerText : el.textContent) ?? '').trim()
    const idOf = (item: Element): string | null => {
      const message = item.querySelector(sel.chatMessage)
      const body = message?.querySelector(sel.chatBody)
      return message?.getAttribute('data-mid') || body?.id.replace(/^content-/, '') || item.id || null
    }

    // Reads rows in the order given. Returns every row it could attribute, new or not.
    const readItems = (items: Element[]): Stored[] => {
      const out: Stored[] = []
      let carry = ''
      for (const item of items) {
        const message = item.querySelector(sel.chatMessage)
        if (!message) continue
        const id = idOf(item)
        const author = textOf(message.querySelector(sel.chatAuthor))
        const before = item.previousElementSibling
        const beforeId = before?.matches(sel.chatItem) ? idOf(before) : null
        const sender =
          author ||
          (id ? senderById.get(id) : undefined) ||
          carry ||
          (beforeId ? senderById.get(beforeId) : undefined) ||
          ''
        carry = sender
        const body = message.querySelector(sel.chatBody)
        const text = textOf(body)
        // Never store an unattributed row: it would read as a message from nobody and, once its sender is known,
        // as a second copy. A sweep, which scrolls from the top, attributes it.
        if (!body || !text || !sender) continue
        const when = message.querySelector(sel.chatTime)
        const time = textOf(when)
        out.push({
          key: id ?? `${sender}|${time}|${text.slice(0, 200)}`,
          id,
          sender,
          time,
          datetime: when?.getAttribute('datetime') ?? null,
          text,
          hrefs: [...body.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.href)
        })
      }
      return out
    }
    const remember = (found: Stored[]) => {
      for (const m of found) {
        if (m.id) senderById.set(m.id, m.sender)
        if (keys.has(m.key)) continue
        keys.add(m.key)
        messages.push(m)
      }
    }
    const liveItems = () => [...(scroller()?.querySelectorAll(sel.chatItem) ?? [])]
    const parseLive = () => {
      const found = readItems(liveItems())
      remember(found)
      return found
    }

    const startPinning = () => {
      pinTimer ??= window.setInterval(pin, 1500)
    }
    const stopPinning = () => {
      if (pinTimer !== null) window.clearInterval(pinTimer)
      pinTimer = null
    }

    // Scrolls the list top to bottom so every row renders once, at most `budgetMs` long.
    const runSweep = async (budgetMs: number): Promise<Outcome> => {
      const first = scroller()
      if (!first) return { messages: [], complete: true, reached: 0, total: 0 }
      const ordered = new Map<string, Stored>()
      const take = () => {
        for (const m of parseLive()) if (!ordered.has(m.key)) ordered.set(m.key, m)
      }
      const started = Date.now()
      let complete = true
      let y = 0
      let total = first.scrollHeight
      stopPinning()
      try {
        for (;;) {
          // The list element can be replaced mid-sweep (the pane closing and opening again).
          const sc = scroller()
          if (!sc) break
          total = sc.scrollHeight
          if (y > total) break
          if (Date.now() - started > budgetMs) {
            complete = false
            break
          }
          sc.scrollTop = y
          await sleep(300 + Math.random() * 50)
          take()
          y += Math.max(200, sc.clientHeight / 2)
        }
        pin(true)
        await sleep(300)
        take()
      } finally {
        startPinning()
      }
      return { messages: [...ordered.values()], complete, reached: y, total }
    }
    // One sweep at a time: a caller that arrives during one gets that sweep's result.
    const sweep = (budgetMs: number) => {
      sweepRun ??= runSweep(budgetMs).finally(() => {
        sweepRun = null
      })
      return sweepRun
    }

    // Rows added in a batch are read from the records, in order: a burst scrolls early rows out of the list (and out of
    // the DOM) before this callback runs. Any other change (text edits, removals) is debounced, 250 ms after the first.
    const scheduleParse = () => {
      parseTimer ??= window.setTimeout(() => {
        parseTimer = null
        parseLive()
      }, 250)
    }
    new MutationObserver((records) => {
      let grew = false
      for (const r of records) {
        // One record adds consecutive siblings, so each is read as its own sequence (a follow-up may take the sender of
        // the row before it in the record), and stored before the next record is read.
        const group = new Set<Element>()
        for (const node of r.addedNodes) {
          if (!(node instanceof Element)) continue
          const own = node.closest(sel.chatItem)
          if (own) group.add(own)
          for (const item of node.querySelectorAll(sel.chatItem)) group.add(item)
        }
        if (group.size === 0) continue
        grew = true
        remember(readItems([...group]))
      }
      if (!grew) {
        scheduleParse()
        return
      }
      if (parseTimer !== null) window.clearTimeout(parseTimer)
      parseTimer = null
      parseLive()
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
    window.setInterval(parseLive, 3000)
    startPinning()
    w.__tmTeamsChat = { messages, pin, parseLive, sweep }
  }

  const store = w.__tmTeamsChat
  const strip = ({ key: _key, ...raw }: Stored): RawTeamsMessage => raw
  if (cfg.mode === 'read') {
    store.pin()
    // The scroll event and the re-render of a virtualised list land a moment after scrollTop is set.
    await sleep(100)
    store.parseLive()
    return { messages: store.messages.map(strip), complete: true, reached: 0, total: 0 }
  }
  const outcome = await store.sweep(cfg.sweepBudgetMs)
  return { ...outcome, messages: outcome.messages.map(strip) }
}
