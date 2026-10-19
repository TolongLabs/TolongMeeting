import {
  ControlCommandSchema,
  HeartbeatReplyShapeSchema,
  MAX_HEARTBEAT_EVENTS,
  type Heartbeat,
  type HeartbeatReply,
  type JobConfig,
  type MeetingEvent
} from '@tm/core'
import type { Stopper } from '../types'

const INTERVAL_MS = 5_000
const TIMEOUT_MS = 4_000
const BACKOFF_FIRST_MS = 1_000
const BACKOFF_MAX_MS = 10_000
/** A reply body larger than this is refused unread (a real reply is a few hundred bytes). */
const MAX_REPLY_BYTES = 64 * 1024
/** Most heartbeats one `flush` sends: 500 events each, so this is far more than an outbox ever holds. */
const MAX_FLUSH_BEATS = 40

/**
 * The wait before the next heartbeat after `failures` failures in a row: 1 s, doubling to the cap. The cap (10 s) stays
 * well under the monitor's 30 s window, so one good heartbeat gets through between two checks of an outage that ends.
 */
export function backoffDelayMs(
  failures: number,
  backoff = { firstMs: BACKOFF_FIRST_MS, maxMs: BACKOFF_MAX_MS }
): number {
  return Math.min(backoff.maxMs, backoff.firstMs * 2 ** (failures - 1))
}

export interface HeartbeatOptions {
  intervalMs?: number
  timeoutMs?: number
  backoff?: { firstMs: number; maxMs: number }
  fetchFn?: typeof fetch
  /** The server replaced this worker (410): the reply handed to `onReply` is a `stop`, and nothing more is sent. */
  onSuperseded?: () => void
  /** The server refused the token (401): nothing more is sent. Called once. */
  onRefused?: () => void
  /** Called with a short text, never with a token or a URL, for a failure worth reporting (once per kind and run). */
  onProblem?: (problem: string) => void
  /** An event the server refuses on its own (a 400 that is gone once the event is left out): drop it from the outbox. */
  onRejectedEvent?: (event: MeetingEvent) => void
}

export interface HeartbeatLoop extends Stopper {
  /**
   * Sends heartbeats now until the status holds no events, and says whether the server took them all. A failure
   * leaves the events where they are for the next attempt.
   */
  flush(): Promise<boolean>
}

/** The control URL: https, or http for 127.0.0.1 (tests). Anything else is refused before a token is sent. */
export function heartbeatUrl(base: string): string {
  if (!URL.canParse(base)) throw new Error('the control URL is not a URL')
  const u = new URL(base)
  const local = u.protocol === 'http:' && u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !local) throw new Error('the control URL must be https (http only for 127.0.0.1)')
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw new Error('the control URL must not hold credentials, a query or a fragment')
  }
  return `${base.replace(/\/+$/, '')}/heartbeat`
}

const NOOP: HeartbeatLoop = { stop: async () => undefined, flush: async () => true }

/** `retry`: the next heartbeat goes at once (a 400 that is being narrowed down); `failed` waits, with backoff. */
type Beat = 'ok' | 'failed' | 'retry' | 'stopped'

/**
 * Posts `getStatus()` to `<control.url>/heartbeat` every 5 s with `Authorization: Bearer <control.token>`, one request at
 * a time, each with a 4 s timeout, and hands every good reply to `onReply`. The token goes only in that header. A network
 * error, a 5xx or a 400 keeps the events and backs the next send off (1 s, doubling to 30 s). A 400 halves the batch
 * (too big, or one bad event inside); a lone event that the server refuses while an empty heartbeat passes is dropped
 * through `onRejectedEvent`. A 410 is passed on as a `stop` and ends the sending; a 401 ends it too. Returns a no-op loop
 * when `cfg.control` is null.
 */
export function startHeartbeat(
  cfg: JobConfig,
  getStatus: () => Heartbeat,
  onReply: (reply: HeartbeatReply) => void,
  opts: HeartbeatOptions = {}
): HeartbeatLoop {
  if (cfg.control === null) return NOOP
  const { token } = cfg.control
  const url = heartbeatUrl(cfg.control.url)
  const fetchFn = opts.fetchFn ?? fetch
  const intervalMs = opts.intervalMs ?? INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const backoff = opts.backoff ?? { firstMs: BACKOFF_FIRST_MS, maxMs: BACKOFF_MAX_MS }

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<Beat> | null = null
  const cancel = new AbortController()
  let failures = 0
  let batchLimit = MAX_HEARTBEAT_EVENTS
  /** After a 400 for a lone event: the next heartbeat carries none, to tell a bad event from a bad heartbeat. */
  let probing = false
  const told = new Set<string>()
  const problem = (text: string): void => {
    // A request cut short by `stop` is not news.
    if (stopped || told.has(text)) return
    told.add(text)
    opts.onProblem?.(text)
  }

  async function send(): Promise<Beat> {
    const status = getStatus()
    const queued = status.events
    const events = probing ? [] : queued.slice(0, batchLimit)
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...status, events }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel.signal]),
        redirect: 'error'
      })
    } catch (error) {
      // Only the kind of failure is kept: a message can carry the URL.
      problem(`heartbeat not delivered (${error instanceof Error ? error.name : 'error'})`)
      return 'failed'
    }
    if (response.status === 410) {
      stopped = true
      opts.onSuperseded?.()
      onReply({ ackedEvents: 0, commands: ['stop'], link: null })
      return 'stopped'
    }
    if (response.status === 401) {
      stopped = true
      console.error('heartbeat refused')
      opts.onRefused?.()
      return 'stopped'
    }
    if (response.status === 400) {
      if (probing) {
        // Even an empty heartbeat is refused: not the events' fault, so none is dropped.
        probing = false
        problem('heartbeat refused as invalid (400) even without events')
      } else if (events.length > 1) {
        batchLimit = Math.ceil(events.length / 2)
        return 'retry'
      } else if (events.length === 1) {
        probing = true
        return 'retry'
      } else {
        problem('heartbeat refused as invalid (400)')
      }
      return 'failed'
    }
    if (!response.ok) {
      problem(`heartbeat answered ${response.status}`)
      return 'failed'
    }
    const parsed = HeartbeatReplyShapeSchema.safeParse(await readJson(response))
    if (!parsed.success || parsed.data.ackedEvents > events.length) {
      problem('heartbeat reply is not valid')
      return 'failed'
    }
    if (probing) {
      // The empty heartbeat passed, so the lone event ahead of it was the problem.
      probing = false
      opts.onRejectedEvent?.(queued[0]!)
    } else {
      batchLimit = Math.min(MAX_HEARTBEAT_EVENTS, batchLimit * 2)
    }
    // A command this worker does not know is ignored, and reported once.
    const commands: HeartbeatReply['commands'] = []
    for (const command of parsed.data.commands) {
      const known = ControlCommandSchema.safeParse(command)
      if (known.success) commands.push(known.data)
      else problem('heartbeat reply held a command this worker does not know; it was ignored')
    }
    onReply({ ackedEvents: parsed.data.ackedEvents, commands, link: parsed.data.link })
    return 'ok'
  }

  // The reply body as JSON, or null when it is too big (read no further than the cap) or is not JSON.
  async function readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader()
    if (reader === undefined) return null
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REPLY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      if (error instanceof SyntaxError) return null
      throw error
    }
  }

  // One request at a time: a beat that is already running is the beat.
  function beat(): Promise<Beat> {
    if (stopped) return Promise.resolve('stopped')
    inFlight ??= send()
      .catch((error: unknown) => {
        // A failed reply handler or reader must not end the loop (the heartbeat is an extra); it is reported by kind.
        problem(`heartbeat step failed (${error instanceof Error ? error.name : 'error'})`)
        return 'failed' as const
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  // One beat now, and the next after the interval (or the backoff, after a failure).
  function cycle(): void {
    void beat().then((result) => {
      if (result === 'failed') failures += 1
      else if (result !== 'retry') failures = 0
      if (stopped) return
      const delay = result === 'retry' ? 0 : failures === 0 ? intervalMs : backoffDelayMs(failures, backoff)
      timer = setTimeout(cycle, delay)
      timer.unref()
    })
  }
  // The first heartbeat goes at once, so the server hears from a worker that is still starting.
  cycle()

  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      cancel.abort()
      await inFlight
    },
    async flush() {
      for (let i = 0; i < MAX_FLUSH_BEATS; i++) {
        const result = await beat()
        if (result === 'retry') continue
        if (result !== 'ok') return false
        if (getStatus().events.length === 0) return true
      }
      return false
    }
  }
}
