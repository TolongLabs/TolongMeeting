import { z } from 'zod'
import type { NtfyConfig } from '@tm/core'
import { reconnectDelayMs, STABLE_CONNECTION_MS } from './backoff'
import type { StateStore } from './state'

// The ntfy stream is untrusted input: anyone who can publish to the topic, or a hijacked server, controls every byte.
// Each line is size-capped and parsed with a strict schema, and nothing in a message is ever run, opened or fetched
// without the member's click. The only command a message can give is the fixed `tm_summary` tag.

// --- Caps and names ---

/** ntfy sends a keepalive every 45 s by default; two missed ones mean the connection is dead. */
export const STALL_MS = 90_000
/** Longest stream line we parse. ntfy caps a message at 4 KiB, so a bigger line is not a TolongMeeting ping. */
export const MAX_LINE_BYTES = 32 * 1024
/** Messages older than this are not shown (the PC was off); summary syncs ignore the age. */
export const MAX_AGE_MS = 30 * 60_000
export const SUMMARY_TAG = 'tm_summary'
const DEFAULT_TITLE = 'TolongMeeting'
const MAX_BUTTONS = 3
const MAX_SEEN_IDS = 256
const MAX_TITLE_CHARS = 120
const MAX_BODY_CHARS = 600
const MAX_URL_CHARS = 2048

// --- Parsing ---

export interface NtfyMessage {
  id: string
  time: number
  title?: string
  message?: string
  priority?: number
  tags?: string[]
  click?: string
  actions?: { action: string; label: string; url?: string }[]
}

const ActionSchema = z.object({
  action: z.string().max(32),
  label: z.string().max(256),
  url: z.string().max(MAX_URL_CHARS).optional()
})

// Every field ntfy 2.32 puts on a `message` event. Unknown keys fail: a server that drifts is noticed, not trusted.
const NtfyEventSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  time: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  expires: z.int().min(0).optional(),
  event: z.literal('message'),
  topic: z.string().max(256).optional(),
  title: z.string().max(512).optional(),
  message: z.string().max(8192).optional(),
  priority: z.int().min(1).max(5).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  click: z.string().max(MAX_URL_CHARS).optional(),
  actions: z.array(ActionSchema).max(MAX_BUTTONS).optional(),
  icon: z.string().max(MAX_URL_CHARS).optional(),
  attachment: z.looseObject({}).optional(),
  content_type: z.string().max(64).optional(),
  encoding: z.string().max(32).optional()
})

type LineResult = { kind: 'message'; message: NtfyMessage } | { kind: 'other' } | { kind: 'invalid'; reason: string }

function classifyLine(line: string): LineResult {
  if (line.length > MAX_LINE_BYTES) return { kind: 'invalid', reason: 'line too long' }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (e) {
    if (e instanceof SyntaxError) return { kind: 'invalid', reason: 'not JSON' }
    throw e
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return { kind: 'invalid', reason: 'not an object' }
  // `open`, `keepalive` and `poll_request` carry nothing for us.
  if ('event' in json && json.event !== 'message') return { kind: 'other' }
  const parsed = NtfyEventSchema.safeParse(json)
  if (!parsed.success) return { kind: 'invalid', reason: 'did not match the message schema' }
  const { id, time, title, message, priority, tags, click, actions } = parsed.data
  return {
    kind: 'message',
    message: {
      id,
      time,
      ...(title !== undefined && { title }),
      ...(message !== undefined && { message }),
      ...(priority !== undefined && { priority }),
      ...(tags !== undefined && { tags }),
      ...(click !== undefined && { click }),
      ...(actions !== undefined && { actions })
    }
  }
}

/** Returns the message of a `message` event; null for keepalives, other events and anything that fails the schema. */
export function parseNtfyLine(line: string): NtfyMessage | null {
  const result = classifyLine(line)
  return result.kind === 'message' ? result.message : null
}

// --- Display ---

export type NtfyDisplay =
  | {
      kind: 'show'
      title: string
      body: string
      sticky: boolean
      buttons: { label: string; url: string }[]
      clickUrl: string | null
    }
  | { kind: 'sync_summaries' }
  | { kind: 'ignore' }

/** Plain text for a toast: control characters out, length capped. */
function plain(text: string, max: number): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim()
  return [...clean].length > max ? `${[...clean].slice(0, max - 1).join('')}…` : clean
}

/** Only a plain https URL may reach a click or a button. `file:`, `javascript:`, app links and logins in the URL do not. */
function httpsUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.length > MAX_URL_CHARS) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch (e) {
    if (e instanceof TypeError) return null
    throw e
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' ? raw : null
}

export function toDisplay(m: NtfyMessage, now: Date): NtfyDisplay {
  if (m.tags?.includes(SUMMARY_TAG)) return { kind: 'sync_summaries' }
  if (now.getTime() - m.time * 1000 > MAX_AGE_MS) return { kind: 'ignore' }
  const buttons = (m.actions ?? []).flatMap((a) => {
    const url = a.action === 'view' ? httpsUrl(a.url) : null
    return url === null ? [] : [{ label: plain(a.label, 40), url }]
  })
  return {
    kind: 'show',
    title: plain(m.title ?? '', MAX_TITLE_CHARS) || DEFAULT_TITLE,
    body: plain(m.message ?? '', MAX_BODY_CHARS),
    sticky: (m.priority ?? 3) >= 4,
    buttons,
    clickUrl: httpsUrl(m.click) ?? buttons[0]?.url ?? null
  }
}

// --- Subscriber ---

export interface NtfySubscriberDeps {
  cfg: NtfyConfig
  state: Pick<StateStore, 'get' | 'update'>
  onMessage(m: NtfyMessage): void
  /** Connection failures, dropped lines and handler errors. Never carries the token or a message's text. */
  onError?(error: Error): void
  fetch?: typeof fetch
  /** Test seams. */
  stallMs?: number
  stableMs?: number
  delayMs?: (attempt: number) => number
  now?: () => number
}

/** The stream URL. The token is not in it: it goes in the `Authorization` header only. */
function streamUrl(cfg: NtfyConfig, since: string): string {
  const base = new URL(cfg.url)
  const localTest = base.protocol === 'http:' && base.hostname === '127.0.0.1'
  if (base.protocol !== 'https:' && !localTest) throw new Error('the ntfy URL must use https')
  if (base.username !== '' || base.password !== '') throw new Error('the ntfy URL must not carry a login')
  if (base.search !== '' || base.hash !== '') throw new Error('the ntfy URL must not carry a query or fragment')
  const path = base.pathname.replace(/\/+$/, '')
  return `${base.origin}${path}/${encodeURIComponent(cfg.topic)}/json?since=${encodeURIComponent(since)}`
}

/**
 * Follows the member's topic and hands each valid `message` event to `onMessage`, resuming after the last seen id.
 * It reconnects for as long as it runs, with capped backoff and jitter; a silent stream (no keepalive) counts as dead.
 * Throws at once if the URL is not https (http is allowed for 127.0.0.1 only, for tests).
 */
export function startNtfySubscriber(d: NtfySubscriberDeps): { stop(): void } {
  const doFetch = d.fetch ?? fetch
  const stallMs = d.stallMs ?? STALL_MS
  const stableMs = d.stableMs ?? STABLE_CONNECTION_MS
  const delayMs = d.delayMs ?? ((attempt: number) => reconnectDelayMs(attempt))
  const now = d.now ?? Date.now
  const report = (e: Error) => d.onError?.(e)

  // Validate before anything starts, so a bad URL fails the caller, not a background loop.
  const startedAtSec = String(Math.floor(now() / 1000))
  streamUrl(d.cfg, startedAtSec)

  let stopped = false
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let wake: (() => void) | null = null

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, ms)
    })

  // ntfy 2.32 replays the message named by `since` when it is the newest one on a streaming request, so remember the
  // ids we handled (and the saved one) and skip a repeat.
  const seen = new Set<string>()
  const remember = (id: string) => {
    seen.add(id)
    if (seen.size > MAX_SEEN_IDS) seen.delete(seen.values().next().value as string)
  }

  async function deliver(m: NtfyMessage): Promise<void> {
    if (seen.has(m.id) || m.id === d.state.get().ntfyLastId) return
    remember(m.id)
    try {
      d.onMessage(m)
    } catch (e) {
      // A failing handler must not make the same message come back on every reconnect.
      report(new Error(`the ntfy message handler failed: ${e instanceof Error ? e.message : String(e)}`))
    }
    try {
      await d.state.update({ ntfyLastId: m.id })
    } catch (e) {
      report(new Error(`could not save the last ntfy id: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

  async function handleLine(raw: string): Promise<void> {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') return
    const result = classifyLine(line)
    if (result.kind === 'message') await deliver(result.message)
    else if (result.kind === 'invalid') report(new Error(`dropped an ntfy line: ${result.reason}`))
  }

  /** One connection. Resolves with when it opened (or null) after the stream ends; throws on failure. */
  async function connect(onOpen: () => void): Promise<void> {
    // Resume after the last id we saw; before the first message, after the moment we started, so a drop loses nothing.
    const since = d.state.get().ntfyLastId ?? startedAtSec
    const ctl = new AbortController()
    controller = ctl
    let stalled = false
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      if (stallTimer !== null) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        ctl.abort()
      }, stallMs)
    }
    arm()
    try {
      const res = await doFetch(streamUrl(d.cfg, since), {
        headers: { Authorization: `Bearer ${d.cfg.token}`, Accept: 'application/x-ndjson' },
        redirect: 'error',
        signal: ctl.signal
      })
      if (res.status !== 200) {
        await res.body?.cancel()
        throw new Error(`ntfy answered ${res.status}`)
      }
      if (res.body === null) throw new Error('ntfy sent no body')
      onOpen()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let discarding = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        buffer += decoder.decode(value, { stream: true })
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (discarding) discarding = false
          else await handleLine(line)
        }
        if (buffer.length > MAX_LINE_BYTES) {
          // No newline in sight: drop what we hold and everything up to the next newline.
          if (!discarding) report(new Error('dropped an ntfy line: line too long'))
          discarding = true
          buffer = ''
        }
      }
      throw new Error('the ntfy stream ended')
    } catch (e) {
      if (stalled) throw new Error('the ntfy stream went silent', { cause: e })
      throw e
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer)
      ctl.abort()
    }
  }

  async function run(): Promise<void> {
    let attempt = 0
    while (!stopped) {
      let openedAt: number | null = null
      try {
        await connect(() => {
          openedAt = now()
        })
      } catch (e) {
        if (stopped) return
        report(e instanceof Error ? e : new Error(String(e)))
      }
      if (stopped) return
      if (openedAt !== null && now() - openedAt >= stableMs) attempt = 0
      await sleep(delayMs(attempt))
      attempt++
    }
  }

  void run()

  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      wake?.()
      controller?.abort()
    }
  }
}
