// The companion's local control relay (plan 08 Task 6): the worker container posts its heartbeat here, the companion
// forwards it to the server with the PC's own device token, so the home network never accepts incoming connections.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import {
  HeartbeatReplySchema,
  HeartbeatSchema,
  SigninHeartbeatSchema,
  type ControlCommand,
  type Heartbeat,
  type HeartbeatReply,
  type SigninHeartbeat,
  type SigninReply
} from '@tm/core'

/** Largest heartbeat body the relay reads (the same cap as the server's control route). */
export const MAX_RELAY_BODY_BYTES = 1_000_000
/** Largest sign-in report the relay reads (the same cap as the server's sign-in route). */
export const MAX_RELAY_SIGNIN_BODY_BYTES = 16 * 1024
/** Largest reply the relay reads from the server (the same cap as the worker's own client). */
export const MAX_UPSTREAM_REPLY_BYTES = 64 * 1024
/** The worker waits 4 s for each heartbeat: the relay gives up on the server a little earlier. */
export const UPSTREAM_TIMEOUT_MS = 3500
/** A client that has not sent its whole body by then is cut off. */
export const BODY_TIMEOUT_MS = 10_000

/** What the relay needs from the server client (03 Task 11's `CompanionApi.heartbeat` satisfies it). */
export interface RelayApi {
  heartbeat(jobId: string, hb: Heartbeat): Promise<HeartbeatReply>
}

export interface Relay {
  port: number
  /** 32 random bytes, base64url, per run. Only the worker container is given it. */
  token: string
  /** What the container's `control.url` is: the origin only; the worker adds `/heartbeat` and `/signin`. */
  containerUrl: string
  firstHeartbeat(attempt: number): Promise<void>
  lastHeartbeatAt(): number | null // epoch ms
  inject(c: ControlCommand): void // delivered in the next reply, once
  synthetic(hb: Heartbeat): Promise<HeartbeatReply>
  close(): Promise<void>
}

export interface RelayDeps {
  api: RelayApi
  jobId: string
  occurrenceId: string
  /**
   * The address to listen on: loopback (the default) or the dedicated Docker bridge address, as an IP literal. The
   * wildcard addresses and any public address are refused.
   */
  bindHost?: string
  /** The sign-in container's report (08 Task 10). Without it, `/signin` is a 404. */
  onSignin?: (hb: SigninHeartbeat) => SigninReply | Promise<SigninReply>
  /** Progress lines. They never hold the token, a header or a body. */
  log?: (line: string) => void
  now?: () => number
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const
const FIXED = {
  400: '{"error":"invalid request"}',
  401: '{"error":"unauthorized"}',
  404: '{"error":"not found"}',
  408: '{"error":"request timeout"}',
  413: '{"error":"payload too large"}',
  502: '{"error":"bad gateway"}'
} as const

const digest = (s: string) => createHash('sha256').update(s).digest()

/** True when `host` is an IPv4/IPv6 loopback or a private IPv4 address (a Docker bridge), never a wildcard. */
export function isAllowedBindHost(host: string): boolean {
  const kind = isIP(host)
  if (kind === 6) return host === '::1'
  if (kind !== 4) return false
  const [a, b] = host.split('.').map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

class BodyTooLarge extends Error {}
class BodyTimeout extends Error {}

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > cap) return Promise.reject(new BodyTooLarge())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => finish(new BodyTimeout()), BODY_TIMEOUT_MS)
    const finish = (err?: Error) => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', finish)
      if (err) reject(err)
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (c: Buffer) => {
      size += c.length
      if (size > cap) return finish(new BodyTooLarge())
      chunks.push(c)
    }
    const onEnd = () => finish()
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', finish)
  })
}

/** After a refusal that left the body unread: drain it briefly (a reset would hide the answer), then drop the socket. */
function drainThenClose(req: IncomingMessage): void {
  req.resume()
  setTimeout(() => req.socket.destroy(), 1000).unref()
}

function send(res: ServerResponse, status: number, body: string, after?: () => void) {
  res.writeHead(status, status === 413 || status === 408 ? { ...JSON_HEADERS, Connection: 'close' } : JSON_HEADERS)
  if (after) res.once('finish', after)
  res.end(body)
}

export async function startRelay(d: RelayDeps): Promise<Relay> {
  const host = d.bindHost ?? '127.0.0.1'
  if (!isAllowedBindHost(host))
    throw new RangeError('The relay listens on loopback or a private Docker bridge address only')
  const now = d.now ?? Date.now
  const log = d.log ?? (() => {})
  const token = randomBytes(32).toString('base64url')
  const tokenDigest = digest(token)

  let pending: ControlCommand[] = []
  let lastAt: number | null = null
  const seenAttempts = new Set<number>()
  const waiters = new Map<number, Array<() => void>>()

  /** Forwards one heartbeat and adds the injected commands the reply lacks. Returns what was added, to clear later. */
  async function exchange(hb: Heartbeat): Promise<{ reply: HeartbeatReply; delivered: ControlCommand[] }> {
    const reply = await d.api.heartbeat(d.jobId, hb)
    const delivered = [...pending]
    const commands = [...reply.commands]
    for (const c of delivered) if (!commands.includes(c)) commands.push(c)
    return { reply: { ...reply, commands }, delivered }
  }
  const clearDelivered = (delivered: ControlCommand[]) => {
    pending = pending.filter((c) => !delivered.includes(c))
  }

  function noteHeartbeat(attempt: number) {
    lastAt = now()
    seenAttempts.add(attempt)
    for (const w of waiters.get(attempt) ?? []) w()
    waiters.delete(attempt)
  }

  const authorised = (req: IncomingMessage): boolean => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    // Hashing first gives both sides the same length, so the comparison leaks nothing about the token.
    return m !== null && timingSafeEqual(digest(m[1]), tokenDigest)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const isHeartbeat = req.method === 'POST' && req.url === '/heartbeat'
    const isSignin = req.method === 'POST' && req.url === '/signin' && d.onSignin !== undefined
    // Anything but the two documented requests gets the same answer, before the token is looked at.
    if (!isHeartbeat && !isSignin) {
      log(`relay: refused ${req.method} (not a relay path)`)
      return send(res, 404, FIXED[404])
    }
    if (!authorised(req)) {
      log('relay: refused a request with a wrong or missing token')
      return send(res, 401, FIXED[401])
    }
    let raw: string
    try {
      raw = await readBody(req, isHeartbeat ? MAX_RELAY_BODY_BYTES : MAX_RELAY_SIGNIN_BODY_BYTES)
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        log('relay: refused a body over the cap')
        return send(res, 413, FIXED[413], () => drainThenClose(req))
      }
      if (e instanceof BodyTimeout) {
        log('relay: cut off a slow body')
        return send(res, 408, FIXED[408], () => drainThenClose(req))
      }
      throw e
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return send(res, 400, FIXED[400])
    }
    if (isSignin) {
      const parsed = SigninHeartbeatSchema.safeParse(json)
      if (!parsed.success) return send(res, 400, FIXED[400])
      let reply: SigninReply
      try {
        reply = await d.onSignin!(parsed.data)
      } catch {
        log('relay: the sign-in handler failed')
        return send(res, 502, FIXED[502], () => req.socket.destroy())
      }
      return send(res, 200, JSON.stringify(reply))
    }
    const parsed = HeartbeatSchema.safeParse(json)
    if (!parsed.success || parsed.data.occurrenceId !== d.occurrenceId) return send(res, 400, FIXED[400])
    noteHeartbeat(parsed.data.attempt)
    let result: Awaited<ReturnType<typeof exchange>>
    try {
      result = await exchange(parsed.data)
    } catch {
      // The reason (network error, status, redirect) stays out of the answer; injected commands stay queued.
      log('relay: the server did not answer a heartbeat')
      return send(res, 502, FIXED[502])
    }
    send(res, 200, JSON.stringify(result.reply), () => clearDelivered(result.delivered))
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      log('relay: a request failed')
      if (!res.headersSent) send(res, 502, FIXED[502], () => req.socket.destroy())
      else res.destroy()
    })
  })
  server.headersTimeout = 5000
  server.requestTimeout = BODY_TIMEOUT_MS
  server.keepAliveTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The relay has no TCP address')

  return {
    port: address.port,
    token,
    containerUrl: `http://host.docker.internal:${address.port}`,
    firstHeartbeat(attempt) {
      if (seenAttempts.has(attempt)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiters.set(attempt, [...(waiters.get(attempt) ?? []), resolve])
      })
    },
    lastHeartbeatAt: () => lastAt,
    inject(c) {
      if (!pending.includes(c)) pending.push(c)
    },
    async synthetic(hb) {
      const { reply, delivered } = await exchange(hb)
      clearDelivered(delivered)
      return reply
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })
    }
  }
}

// --- The server side of the relay ---

export class UpstreamError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? 'The server did not answer' : `The server answered ${status}`)
    this.name = 'UpstreamError'
  }
}

export interface ServerApiOptions {
  /** The configured server origin, `https://…`. Plain `http` is accepted for a loopback host only (tests, local dev). */
  origin: string
  /** The PC's device token, read at each request so a re-pairing takes effect. It goes in `Authorization` only. */
  deviceToken: () => string
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * The relay's upstream: `POST <origin>/api/companion/jobs/<jobId>/heartbeat` with the device token. The body is rebuilt
 * from the parsed heartbeat and the headers are fixed here, so nothing the container sent (Host, Authorization,
 * hop-by-hop headers) reaches the server. A redirect is an error, so the token is never re-sent elsewhere.
 */
export function serverHeartbeatApi(o: ServerApiOptions): RelayApi {
  const url = new URL(o.origin)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('The server origin must be https')
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '')
    throw new Error('The server origin must be an origin only')
  const doFetch = o.fetch ?? fetch
  const timeoutMs = o.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  return {
    async heartbeat(jobId, hb) {
      const target = new URL(`/api/companion/jobs/${encodeURIComponent(jobId)}/heartbeat`, url.origin)
      let res: Response
      try {
        res = await doFetch(target, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${o.deviceToken()}`
          },
          body: JSON.stringify(hb)
        })
      } catch {
        throw new UpstreamError(null)
      }
      // A superseded run: the worker treats a 410 as "stop", so the relay says it the same way.
      if (res.status === 410) {
        await res.body?.cancel()
        return { ackedEvents: 0, commands: ['stop'], link: null }
      }
      if (res.status !== 200) {
        await res.body?.cancel()
        throw new UpstreamError(res.status)
      }
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > MAX_UPSTREAM_REPLY_BYTES) {
        await res.body?.cancel()
        throw new UpstreamError(null)
      }
      const text = await readCapped(res)
      const parsed = HeartbeatReplySchema.safeParse(safeJson(text))
      if (!parsed.success) throw new UpstreamError(null)
      return parsed.data
    }
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_UPSTREAM_REPLY_BYTES) {
        await reader.cancel()
        throw new UpstreamError(null)
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e
    throw new UpstreamError(null)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
