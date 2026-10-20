import { CompanionApi } from '../src/api'

// A stand-in for the website's local-run upload routes (08 Task 3): `HEAD` and `PUT` on `files/<path>`, `POST` on
// `complete`, `fail`, `heartbeat` and `release`. It keeps every byte it accepts, so a test can compare what arrived.

export const TOKEN = 'tmd_secret_device_token'

export interface FakeServer {
  url: string
  /** Bytes held per path. */
  files: Map<string, Buffer>
  /** Events in order: `upload <path>` (first HEAD of a path), `report <state>`, `complete`, `fail <reason>`, `release`. */
  log: string[]
  /** `Content-Range` of every accepted chunk. */
  ranges: string[]
  requests: { method: string; url: string; headers: Headers; body: Buffer }[]
  /** Answer the next N `complete` calls with 503. */
  completeFailures: number
  /** Answer the next N `release` calls with 404 (the website will not take the job back). */
  releaseRefusals: number
  /** Answer the next N `release` calls with 503. */
  releaseFailures: number
  /** Answer the next N `PUT` calls with 503, before looking at them. */
  putFailures: number
  stop(): void
  api(extra?: { fetch?: typeof fetch }): CompanionApi
}

export function fakeServer(): FakeServer {
  const files = new Map<string, Buffer>()
  const server: FakeServer = {
    url: '',
    files,
    log: [],
    ranges: [],
    requests: [],
    completeFailures: 0,
    putFailures: 0,
    releaseRefusals: 0,
    releaseFailures: 0,
    stop: () => {},
    api: (extra) =>
      new CompanionApi({ serverUrl: server.url, token: async () => TOKEN, onRevoked: () => {}, fetch: extra?.fetch })
  }
  const seen = new Set<string>()
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = Buffer.from(await req.arrayBuffer())
      server.requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ error: 'device_revoked_or_unknown' }, { status: 401 })
      }
      const url = new URL(req.url)
      const m = /^\/api\/companion\/jobs\/j1\/(files\/(.+)|complete|fail|heartbeat|release)$/.exec(url.pathname)
      if (!m) return new Response(null, { status: 404 })
      if (m[2] !== undefined) {
        const path = decodeURIComponent(m[2])
        const held = files.get(path) ?? Buffer.alloc(0)
        if (req.method === 'HEAD') {
          if (!seen.has(path)) server.log.push(`upload ${path}`)
          seen.add(path)
          return new Response(null, { status: 204, headers: { 'Upload-Offset': String(held.length) } })
        }
        if (server.putFailures > 0) {
          server.putFailures--
          return new Response(null, { status: 503 })
        }
        const range = req.headers.get('content-range') ?? ''
        // An empty file's one request, taken like the real server takes it: no body, a repeat still 204, a file the
        // server already holds (a `.part`, a bigger file) 409 with its offset.
        if (range === 'bytes */0') {
          if (body.length !== 0) return new Response(null, { status: 400 })
          if (held.length !== 0) {
            return new Response(null, { status: 409, headers: { 'Upload-Offset': String(held.length) } })
          }
          files.set(path, Buffer.alloc(0))
          server.ranges.push(range)
          return new Response(null, { status: 204 })
        }
        const r = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
        if (!r || Number(r[2]) - Number(r[1]) + 1 !== body.length) return new Response(null, { status: 400 })
        if (Number(r[1]) !== held.length) {
          return new Response(null, { status: 409, headers: { 'Upload-Offset': String(held.length) } })
        }
        files.set(path, Buffer.concat([held, body]))
        server.ranges.push(req.headers.get('content-range')!)
        return new Response(null, { status: 204 })
      }
      if (m[1] === 'complete') {
        if (server.completeFailures > 0) {
          server.completeFailures--
          return new Response(null, { status: 503 })
        }
        server.log.push('complete')
        return new Response(null, { status: 204 })
      }
      if (m[1] === 'release') {
        if (server.releaseFailures > 0) {
          server.releaseFailures--
          return new Response(null, { status: 503 })
        }
        if (server.releaseRefusals > 0) {
          server.releaseRefusals--
          return Response.json({ error: 'not_found' }, { status: 404 })
        }
        server.log.push('release')
        return new Response(null, { status: 204 })
      }
      if (m[1] === 'fail') {
        server.log.push(`fail ${(JSON.parse(body.toString()) as { error: string }).error}`)
        return new Response(null, { status: 204 })
      }
      server.log.push(`report ${(JSON.parse(body.toString()) as { state: string }).state}`)
      return Response.json({ ackedEvents: 0, commands: [], link: null })
    }
  })
  server.url = `http://127.0.0.1:${http.port}`
  server.stop = () => void http.stop(true)
  return server
}
