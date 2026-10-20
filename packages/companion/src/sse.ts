import {
  CompanionCommandSchema,
  CompanionEventEnvelopeSchema,
  CompanionEventSchema,
  type CompanionEvent
} from '@tm/core'
import { DeviceRevokedError, type CompanionApi } from './api'
import { reconnectDelayMs, STABLE_CONNECTION_MS } from './backoff'
import type { StateStore } from './state'

// The command stream comes from our own website, over the same bearer token as every other call (`CompanionApi`
// sets the header, refuses redirects and allows https only, plus http for localhost). Even so, each event is size
// capped and parsed with the strict core schema. A command type this app does not know is skipped, not an error: a
// newer website may send it. Nothing in an event is run, opened or fetched.
//
// Wire format assumed (the website's route is not built yet): an SSE `id:` line holds the event id (a positive
// integer, one global sequence), and the `data:` lines hold the command as JSON, e.g.
// `{"type":"job_available","jobId":"..."}`. The `event:` name is not used. The website sends a comment line
// (`: keepalive`) at least every 30 seconds, so a silent stream is a dead one.

/** Two missed 30-second keepalives mean the connection is dead. */
export const SSE_STALL_MS = 90_000
/** Largest event (all fields) the parser hands on. A command is a few hundred bytes. */
export const MAX_SSE_EVENT_BYTES = 16 * 1024

export interface SseMessage {
  id: string | null
  event: string | null
  data: string
}

export interface ParseSseOptions {
  maxEventBytes?: number
  /** Called once for each event dropped for being too large. */
  onOversize?(): void
}

/**
 * Reads a server-sent-events byte stream. A comment, a `retry:` line or an event without data yields nothing; an event
 * cut off by the end of the stream is dropped. `\n`, `\r\n` and `\r` all end a line. An event larger than the cap is
 * dropped whole, and the parser carries on with the next one.
 */
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array>,
  opts: ParseSseOptions = {}
): AsyncGenerator<SseMessage> {
  const max = opts.maxEventBytes ?? MAX_SSE_EVENT_BYTES
  const decoder = new TextDecoder('utf-8')
  let pending = ''
  let skipLf = false
  let discardLine = false
  let first = true
  let id: string | null = null
  let event: string | null = null
  let data: string[] = []
  let size = 0
  let oversize = false

  const reset = () => {
    id = null
    event = null
    data = []
    size = 0
    oversize = false
  }
  const tooBig = () => {
    oversize = true
    data = []
  }
  /** Returns the finished event on a blank line. */
  const onLine = (line: string): SseMessage | null => {
    if (line === '') {
      const out = !oversize && data.length > 0 ? { id, event, data: data.join('\n') } : null
      if (oversize) opts.onOversize?.()
      reset()
      return out
    }
    if (line.startsWith(':') || oversize) return null
    size += Buffer.byteLength(line)
    if (size > max) {
      tooBig()
      return null
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id' && !value.includes('\0')) id = value
    return null
  }

  for await (const chunk of chunks) {
    let text = decoder.decode(chunk, { stream: true })
    if (first && text.length > 0) {
      first = false
      if (text.startsWith('﻿')) text = text.slice(1)
    }
    text = pending + text
    pending = ''
    let pos = 0
    for (;;) {
      if (skipLf) {
        if (pos >= text.length) break
        if (text[pos] === '\n') pos++
        skipLf = false
      }
      let end = pos
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++
      if (end === text.length) {
        // No line end yet. A line that is already too long is dropped up to its end.
        const rest = text.slice(pos)
        if (discardLine || Buffer.byteLength(rest) > max) {
          discardLine = true
          if (!oversize) tooBig()
        } else pending = rest
        break
      }
      const line = text.slice(pos, end)
      if (text[end] === '\r') {
        if (end + 1 < text.length) pos = text[end + 1] === '\n' ? end + 2 : end + 1
        else {
          pos = end + 1
          skipLf = true
        }
      } else pos = end + 1
      if (discardLine) {
        discardLine = false
        continue
      }
      const message = onLine(line)
      if (message !== null) yield message
    }
  }
}

/** Reads a response body chunk by chunk, calling `onChunk` for each (a keepalive comment is a chunk too). */
async function* bodyChunks(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<Uint8Array> {
  // The caller aborts the request when it is done, which cancels the body.
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    onChunk()
    yield value
  }
}

const KNOWN_TYPES = new Set<string>(CompanionCommandSchema.options.map((o) => o.shape.type.value))
const EVENT_ID = /^[1-9]\d{0,15}$/

export interface CommandStreamDeps {
  api: Pick<CompanionApi, 'events'>
  state: Pick<StateStore, 'get' | 'update'>
  /** Gets each new, valid event once, in order. The id is saved after this returns (or its promise settles). */
  onEvent(e: CompanionEvent): void | Promise<void>
  /** `true` when the stream opened, `false` when it closed or the loop stopped. */
  onStatus(open: boolean): void
  /** Connection failures, dropped events and handler errors. Never carries the token or an event's text. */
  onError?(error: Error): void
  /** The website said this PC is unpaired (the API already cleared the secrets). The stream stops for good. */
  onRevoked?(error: DeviceRevokedError): void
  /** Test seams. */
  stallMs?: number
  stableMs?: number
  delayMs?: (attempt: number) => number
  now?: () => number
}

/**
 * Follows the website's command stream and hands each new valid event to `onEvent`, resuming after the last seen id
 * (`Last-Event-ID`). It reconnects for as long as it runs, with the capped backoff of the ntfy stream; a stream that
 * says nothing (not even a keepalive) for `stallMs` counts as dead. An event with an id at or below the last seen one
 * is a replay and is skipped. A 401 that means "unpaired" ends the loop; every other failure retries.
 */
export function startCommandStream(d: CommandStreamDeps): { stop(): void } {
  const stallMs = d.stallMs ?? SSE_STALL_MS
  const stableMs = d.stableMs ?? STABLE_CONNECTION_MS
  const delayMs = d.delayMs ?? ((attempt: number) => reconnectDelayMs(attempt))
  const now = d.now ?? Date.now
  const report = (e: Error) => d.onError?.(e)
  const fixed = (e: unknown, what: string) => new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`)

  let stopped = false
  let open = false
  let seen = d.state.get().lastEventId
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let wake: (() => void) | null = null

  const setOpen = (value: boolean) => {
    if (open === value) return
    open = value
    d.onStatus(value)
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, ms)
    })

  async function handle(m: SseMessage): Promise<void> {
    if (m.id === null || !EVENT_ID.test(m.id) || !Number.isSafeInteger(Number(m.id))) {
      return report(new Error('dropped a command event: no valid id'))
    }
    const id = Number(m.id)
    if (id <= seen) return // a replay after a reconnect
    seen = id
    let command: unknown
    try {
      command = JSON.parse(m.data)
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      command = undefined
    }
    const envelope = CompanionEventEnvelopeSchema.safeParse({ id, command })
    if (!envelope.success) report(new Error('dropped a command event: it did not match the event schema'))
    else if (KNOWN_TYPES.has(envelope.data.command.type)) {
      const event = CompanionEventSchema.safeParse({ id, command })
      if (!event.success) report(new Error('dropped a command event: it did not match the command schema'))
      else {
        try {
          await d.onEvent(event.data)
        } catch (e) {
          // A failing handler must not make the same event come back on every reconnect.
          report(fixed(e, 'the command handler failed'))
        }
      }
    } // else: a command from a newer website; skipped, but its id still counts.
    try {
      await d.state.update({ lastEventId: id })
    } catch (e) {
      report(fixed(e, 'could not save the last event id'))
    }
  }

  /** One connection. Throws when it ends or fails. */
  async function connect(onOpen: () => void): Promise<void> {
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
      const res = await d.api.events(seen, ctl.signal)
      if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream') || res.body === null) {
        await res.body?.cancel()
        throw new Error('the command stream is not an event stream')
      }
      onOpen()
      setOpen(true)
      const messages = parseSse(bodyChunks(res.body, arm), {
        onOversize: () => report(new Error('dropped a command event: too large'))
      })
      for await (const m of messages) await handle(m)
      throw new Error('the command stream ended')
    } catch (e) {
      if (stalled) throw new Error('the command stream went silent', { cause: e })
      throw e
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer)
      ctl.abort()
      setOpen(false)
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
        if (e instanceof DeviceRevokedError) {
          stopped = true
          d.onRevoked?.(e)
          return
        }
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
      setOpen(false)
    }
  }
}
