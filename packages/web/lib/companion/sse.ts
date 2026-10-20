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

export interface EventStreamOptions {
  pollMs?: number
  keepAliveMs?: number
  recheckMs?: number
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
 * `signal` aborts, when the client stops reading for `STALL_CLOSE_MS`, and with an error when the database fails.
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
  const stop = new AbortController()
  const halt = AbortSignal.any([signal, stop.signal])

  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        let cursor = lastEventId
        let lastWrite = Date.now()
        let lastCheck = Date.now()
        let blockedSince: number | null = null
        const write = (text: string) => {
          controller.enqueue(encoder.encode(text))
          lastWrite = Date.now()
        }
        try {
          write(': open\n\n')
          while (!halt.aborted) {
            const now = Date.now()
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
              if (Date.now() - lastWrite >= keepAliveMs) write(': keepalive\n\n')
              // A full page means more is waiting: read on at once.
              if (events.length >= MAX_LIST_ITEMS) continue
            }
            await sleep(pollMs, halt)
          }
          controller.close()
        } catch (e) {
          controller.error(e)
        }
      },
      cancel() {
        stop.abort()
      }
    },
    { highWaterMark: MAX_QUEUED_BYTES, size: (chunk) => chunk?.byteLength ?? 0 }
  )
}

// One stream per device: a new connection ends the device's previous one, so a looping client cannot pile up pollers.
const open = new Map<string, AbortController>()

/** The signal for a device's new stream: it aborts when `request` does, or when the same device opens another stream. */
export function takeStreamSlot(deviceId: string, request: AbortSignal): AbortSignal {
  open.get(deviceId)?.abort()
  const mine = new AbortController()
  open.set(deviceId, mine)
  mine.signal.addEventListener('abort', () => {
    if (open.get(deviceId) === mine) open.delete(deviceId)
  })
  if (request.aborted) mine.abort()
  else request.addEventListener('abort', () => mine.abort(), { once: true })
  return mine.signal
}

const fixed = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
const EVENT_ID = /^\d{1,15}$/

/** `GET /api/companion/events`: the event stream, resumed after the `Last-Event-ID` header (none means from the start). */
export function handleEventsRequest(request: Request, scope: DeviceScope, opts?: EventStreamOptions): Response {
  const header = request.headers.get('last-event-id')
  if (header !== null && !EVENT_ID.test(header)) return fixed('invalid_last_event_id', 400)
  const signal = takeStreamSlot(scope.device.deviceId, request.signal)
  return new Response(companionEventStream(scope, header === null ? 0 : Number(header), signal, opts), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    }
  })
}
