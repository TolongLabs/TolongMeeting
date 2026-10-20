import { MAX_LIST_ITEMS, type CompanionEvent } from '@tm/core'
import type { DeviceScope } from './scope'

// The command stream of one device. Wire format (what `packages/companion/src/sse.ts` reads): the event id in `id:`,
// the command as one line of JSON in `data:`, a comment line (`: keepalive`) at least every 30 seconds. The stream
// carries only the events `DeviceScope.listEvents` returns, which are this device's own and its member's broadcasts.

/** Most unread bytes one stream may hold. A client that stops reading is not fed further. */
export const MAX_QUEUED_BYTES = 64 * 1024
/** A stream whose client has not read for this long is closed; it reconnects with `Last-Event-ID`. */
export const STALL_CLOSE_MS = 60_000
export const DEFAULT_POLL_MS = 2000
export const DEFAULT_KEEP_ALIVE_MS = 25_000
/** How often the token is checked again. A revoke closes the stream within this time. */
export const DEFAULT_RECHECK_MS = 10_000
/** A healthy stream ends after this long; the client reconnects with `Last-Event-ID` and loses nothing. */
export const MAX_STREAM_LIFETIME_MS = 60 * 60_000

export interface EventStreamOptions {
  pollMs?: number
  keepAliveMs?: number
  recheckMs?: number
  maxLifetimeMs?: number
  /** The time in ms (`Date.now` by default); tests inject one. */
  clock?: () => number
  /** Called once when the stream ends for any reason: it ran out, was cancelled, aborted, revoked or failed. */
  onEnd?: () => void
}

const encoder = new TextEncoder()

/** One event as an SSE block. `JSON.stringify` writes no raw line break, so `data:` is always one line. */
export function formatSse(e: CompanionEvent): string {
  return `id: ${e.id}\nevent: ${e.command.type}\ndata: ${JSON.stringify(e.command)}\n\n`
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

/**
 * Events after `lastEventId` for the device, then new ones as they arrive (the database is polled every `pollMs`). A
 * keepalive comment goes out when nothing else was written for `keepAliveMs`. The device's token is checked every
 * `recheckMs` (which also marks the device as seen): when it was revoked the stream ends. The stream also ends when
 * `signal` aborts, when the client stops reading for `STALL_CLOSE_MS`, after `maxLifetimeMs`, and with an error when
 * the database fails. `onEnd` runs once whatever the reason.
 */
export function companionEventStream(
  scope: Pick<DeviceScope, 'listEvents' | 'touch'>,
  lastEventId: number,
  signal: AbortSignal,
  opts: EventStreamOptions = {}
): ReadableStream<Uint8Array> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS
  const recheckMs = opts.recheckMs ?? DEFAULT_RECHECK_MS
  const maxLifetimeMs = opts.maxLifetimeMs ?? MAX_STREAM_LIFETIME_MS
  const clock = opts.clock ?? Date.now
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    opts.onEnd?.()
  }
  const stop = new AbortController()
  const halt = AbortSignal.any([signal, stop.signal])

  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        let cursor = lastEventId
        const openedAt = clock()
        let lastWrite = openedAt
        let lastCheck = openedAt
        let blockedSince: number | null = null
        const write = (text: string) => {
          controller.enqueue(encoder.encode(text))
          lastWrite = clock()
        }
        try {
          write(': open\n\n')
          while (!halt.aborted) {
            const now = clock()
            if (now - openedAt >= maxLifetimeMs) break
            if ((controller.desiredSize ?? 0) <= 0) {
              blockedSince ??= now
              if (now - blockedSince >= STALL_CLOSE_MS) break
            } else {
              blockedSince = null
              if (now - lastCheck >= recheckMs) {
                lastCheck = now
                if (!(await scope.touch())) break
              }
              const events = await scope.listEvents(cursor)
              for (const e of events) {
                write(formatSse(e))
                cursor = e.id
              }
              if (clock() - lastWrite >= keepAliveMs) write(': keepalive\n\n')
              // A full page means more is waiting: read on at once.
              if (events.length >= MAX_LIST_ITEMS) continue
            }
            await sleep(pollMs, halt)
          }
          controller.close()
        } catch (e) {
          controller.error(e)
        } finally {
          end()
        }
      },
      cancel() {
        stop.abort()
        end()
      }
    },
    { highWaterMark: MAX_QUEUED_BYTES, size: (chunk) => chunk?.byteLength ?? 0 }
  )
}

// One stream per device: a new connection ends the device's previous one, so a looping client cannot pile up pollers.
// One map per process; Next.js reloads modules in development.
const globalForStreams = globalThis as typeof globalThis & { __tmEventStreams?: Map<string, AbortController> }
const open = (globalForStreams.__tmEventStreams ??= new Map<string, AbortController>())

/** Whether the device has a stream open (for tests). */
export const hasStreamSlot = (deviceId: string): boolean => open.has(deviceId)

/**
 * The slot for a device's new stream. `signal` aborts when `request` does, when the same device opens another stream,
 * or when `release` runs. `release` (call it when the stream ends, whatever the reason) frees the slot, unless a newer
 * stream has taken it.
 */
export function takeStreamSlot(deviceId: string, request: AbortSignal): { signal: AbortSignal; release: () => void } {
  open.get(deviceId)?.abort()
  const mine = new AbortController()
  open.set(deviceId, mine)
  const onRequestAbort = () => mine.abort()
  mine.signal.addEventListener('abort', () => {
    if (open.get(deviceId) === mine) open.delete(deviceId)
    request.removeEventListener('abort', onRequestAbort)
  })
  if (request.aborted) mine.abort()
  else request.addEventListener('abort', onRequestAbort, { once: true })
  return { signal: mine.signal, release: () => mine.abort() }
}

const fixed = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
const EVENT_ID = /^\d{1,15}$/

/** `GET /api/companion/events`: the event stream, resumed after the `Last-Event-ID` header (none means from the start). */
export function handleEventsRequest(request: Request, scope: DeviceScope, opts?: EventStreamOptions): Response {
  const header = request.headers.get('last-event-id')
  if (header !== null && !EVENT_ID.test(header)) return fixed('invalid_last_event_id', 400)
  const slot = takeStreamSlot(scope.device.deviceId, request.signal)
  const stream = companionEventStream(scope, header === null ? 0 : Number(header), slot.signal, {
    ...opts,
    onEnd: slot.release
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    }
  })
}
