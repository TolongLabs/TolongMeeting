import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { request, createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ControlCommand, Heartbeat, HeartbeatReply } from '@tm/core'
import {
  isAllowedBindHost,
  MAX_RELAY_BODY_BYTES,
  MAX_RELAY_SIGNIN_BODY_BYTES,
  startRelay,
  serverHeartbeatApi,
  type Relay,
  type RelayApi
} from '../src/local/relay'

const OCC = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'

const hb = (occurrenceId = OCC, attempt = 1): Heartbeat => ({
  occurrenceId,
  attempt,
  state: 'in_meeting',
  recording: true,
  participants: 3,
  events: []
})

function replying(commands: ControlCommand[]) {
  const sent: Heartbeat[] = []
  const api: RelayApi & { sent: Heartbeat[] } = {
    sent,
    async heartbeat(_jobId, h): Promise<HeartbeatReply> {
      sent.push(h)
      return { ackedEvents: 0, commands: [...commands], link: null }
    }
  }
  return api
}

type Raw = { status: number; body: string }
function raw(
  port: number,
  o: { method?: string; path?: string; token?: string | null; body?: string | Buffer; headers?: Record<string, string> }
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...o.headers }
    if (o.token !== null && o.token !== undefined) headers.Authorization = `Bearer ${o.token}`
    const req = request(
      { host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/heartbeat', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end(o.body)
  })
}
const post = (r: Relay, token: string | null, body: unknown, path = '/heartbeat') =>
  raw(r.port, { token, path, body: JSON.stringify(body) })

const relays: Relay[] = []
const servers: Server[] = []
async function start(api: RelayApi, extra: Partial<Parameters<typeof startRelay>[0]> = {}) {
  const r = await startRelay({ api, jobId: 'job-1', occurrenceId: OCC, ...extra })
  relays.push(r)
  return r
}
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close().catch(() => {})
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise((res) => s.close(res))
  }
})

describe('binding', () => {
  test('listens on loopback and gives the container the origin', async () => {
    const r = await start(replying([]))
    expect(r.containerUrl).toBe(`http://host.docker.internal:${r.port}`)
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await post(r, r.token, hb())).status).toBe(200)
  })
  test.each(['0.0.0.0', '::', '', '8.8.8.8', 'example.com', '::ffff:0.0.0.0'])('refuses to bind %p', async (host) => {
    await expect(startRelay({ api: replying([]), jobId: 'j', occurrenceId: OCC, bindHost: host })).rejects.toThrow(
      /loopback/
    )
  })
  test('the bind host check allows loopback and the Docker bridge gateway only', () => {
    for (const h of ['127.0.0.1', '127.0.0.5', '::1', '172.17.0.1']) expect(isAllowedBindHost(h)).toBe(true)
    for (const h of [
      '0.0.0.0',
      '::',
      '172.32.0.1',
      '172.15.0.1',
      '8.8.8.8',
      '169.254.169.254',
      'localhost',
      'fe80::1',
      // Any other private address is the home network, which must not reach the relay.
      '172.31.255.1',
      '172.17.0.2',
      '10.0.0.2',
      '192.168.1.20',
      '192.168.65.1'
    ])
      expect(isAllowedBindHost(h)).toBe(false)
  })
  test('another bridge gateway can be named, but only a private address', () => {
    expect(isAllowedBindHost('172.20.0.1', '172.20.0.1')).toBe(true)
    expect(isAllowedBindHost('172.17.0.1', '172.20.0.1')).toBe(false)
    expect(isAllowedBindHost('8.8.8.8', '8.8.8.8')).toBe(false)
    expect(isAllowedBindHost('0.0.0.0', '0.0.0.0')).toBe(false)
  })
  test('each run gets its own token', async () => {
    const [a, b] = [await start(replying([])), await start(replying([]))]
    expect(a.token).not.toBe(b.token)
  })
})

describe('authentication and routing', () => {
  test('a wrong, missing or malformed token is a fixed 401 and nothing is forwarded', async () => {
    const api = replying([])
    const r = await start(api)
    for (const token of ['nope', r.token + 'x', r.token.slice(1), '']) {
      const res = await post(r, token, hb())
      expect(res).toEqual({ status: 401, body: '{"error":"unauthorized"}' })
    }
    expect(await post(r, null, hb())).toEqual({ status: 401, body: '{"error":"unauthorized"}' })
    expect(
      (await raw(r.port, { body: JSON.stringify(hb()), headers: { Authorization: `Basic ${r.token}` } })).status
    ).toBe(401)
    expect(api.sent).toEqual([])
  })
  test('the token in the query string or a header other than Authorization does not authenticate', async () => {
    const r = await start(replying([]))
    expect(
      (await raw(r.port, { path: `/heartbeat?token=${r.token}`, token: null, body: JSON.stringify(hb()) })).status
    ).toBe(404)
    expect(
      (await raw(r.port, { token: null, body: JSON.stringify(hb()), headers: { 'X-Token': r.token } })).status
    ).toBe(401)
  })
  test('every other path or method is the same fixed 404, with or without the token', async () => {
    const api = replying([])
    const r = await start(api)
    const fixed = { status: 404, body: '{"error":"not found"}' }
    for (const token of [r.token, 'nope', null]) {
      for (const [method, path] of [
        ['GET', '/heartbeat'],
        ['PUT', '/heartbeat'],
        ['DELETE', '/heartbeat'],
        ['POST', '/'],
        ['POST', '/heartbeat/'],
        ['POST', '/heartbeat/heartbeat'],
        ['POST', '/api/control/heartbeat'],
        ['POST', '/signin'], // no sign-in handler in this relay
        ['POST', '/heartbeat?x=1'],
        ['POST', '//heartbeat'],
        ['POST', '/%68eartbeat'],
        ['GET', '/signin']
      ] as const) {
        expect(await raw(r.port, { method, path, token, body: '{}' })).toEqual(fixed)
      }
    }
    expect(api.sent).toEqual([])
  })
})

describe('body handling', () => {
  test('a body over 1 MB is a 413 and is not forwarded', async () => {
    const api = replying([])
    const r = await start(api)
    const res = await raw(r.port, { token: r.token, body: Buffer.alloc(MAX_RELAY_BODY_BYTES + 1, 0x61) })
    expect(res).toEqual({ status: 413, body: '{"error":"payload too large"}' })
    expect(api.sent).toEqual([])
  })
  test('an oversize body without a Content-Length is a 413 too', async () => {
    const r = await start(replying([]))
    const res = await new Promise<Raw>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: r.port,
          method: 'POST',
          path: '/heartbeat',
          headers: { Authorization: `Bearer ${r.token}`, 'Transfer-Encoding': 'chunked' }
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (c: Buffer) => chunks.push(c))
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )
      req.on('error', reject)
      req.write(Buffer.alloc(MAX_RELAY_BODY_BYTES / 2, 0x61))
      req.write(Buffer.alloc(MAX_RELAY_BODY_BYTES / 2 + 1, 0x61))
      req.end()
    })
    expect(res.status).toBe(413)
  })
  test('the token is checked before the body is read', async () => {
    const r = await start(replying([]))
    const res = await raw(r.port, { token: 'nope', body: Buffer.alloc(MAX_RELAY_BODY_BYTES + 1, 0x61) })
    expect(res.status).toBe(401)
  })
  test('malformed JSON, a bad heartbeat and a heartbeat for another occurrence are a fixed 400', async () => {
    const api = replying([])
    const r = await start(api)
    const fixed = { status: 400, body: '{"error":"invalid request"}' }
    expect(await raw(r.port, { token: r.token, body: '{nope' })).toEqual(fixed)
    expect(await post(r, r.token, { ...hb(), state: 'not_a_state' })).toEqual(fixed)
    expect(await post(r, r.token, hb(OTHER))).toEqual(fixed)
    expect(api.sent).toEqual([])
  })
})

describe('forwarding', () => {
  test('heartbeats are forwarded and injected commands are added once', async () => {
    const api = replying(['leave_now'])
    const r = await start(api)
    r.inject('pause_for_signin')
    r.inject('pause_for_signin')
    expect(JSON.parse((await post(r, r.token, hb())).body)).toEqual({
      ackedEvents: 0,
      commands: ['leave_now', 'pause_for_signin'],
      link: null
    })
    expect(JSON.parse((await post(r, r.token, hb())).body).commands).toEqual(['leave_now'])
    expect(api.sent).toHaveLength(2)
  })
  test('a command the server also sent is not repeated', async () => {
    const r = await start(replying(['stop']))
    r.inject('stop')
    expect(JSON.parse((await post(r, r.token, hb())).body).commands).toEqual(['stop'])
    expect(JSON.parse((await post(r, r.token, hb())).body).commands).toEqual(['stop'])
  })
  test('when the server fails the relay answers a fixed 502 and keeps injected commands', async () => {
    let fail = true
    const api: RelayApi = {
      async heartbeat() {
        if (fail) throw new Error('connect ECONNREFUSED https://secret.example/?t=abc')
        return { ackedEvents: 0, commands: [], link: null }
      }
    }
    const r = await start(api)
    r.inject('resume_after_signin')
    expect(await post(r, r.token, hb())).toEqual({ status: 502, body: '{"error":"bad gateway"}' })
    fail = false
    expect(JSON.parse((await post(r, r.token, hb())).body).commands).toEqual(['resume_after_signin'])
  })
  test('synthetic forwards a companion-made heartbeat and delivers injected commands', async () => {
    const api = replying([])
    const r = await start(api)
    r.inject('stop')
    const reply = await r.synthetic({ ...hb(), state: 'transcribing' })
    expect(reply.commands).toEqual(['stop'])
    expect(api.sent[0].state).toBe('transcribing')
    expect((await r.synthetic(hb())).commands).toEqual([])
    expect(r.lastHeartbeatAt()).toBeNull() // only the worker's own heartbeats count
  })
  test("firstHeartbeat(attempt) resolves on that attempt's first heartbeat", async () => {
    let t = 1000
    const r = await start(replying([]), { now: () => t })
    expect(r.lastHeartbeatAt()).toBeNull()
    let settled = false
    const second = r.firstHeartbeat(2).then(() => (settled = true))
    await post(r, r.token, hb(OCC, 1))
    await Bun.sleep(10)
    expect(settled).toBe(false)
    t = 2000
    await post(r, r.token, hb(OCC, 2))
    await second
    expect(r.lastHeartbeatAt()).toBe(2000)
    await r.firstHeartbeat(1) // an attempt seen already resolves at once
  })
  test('the sign-in report goes to the handler, capped at 16 KB', async () => {
    const seen: unknown[] = []
    const r = await start(replying([]), {
      onSignin: (s) => {
        seen.push(s)
        return { commands: ['stop'] }
      }
    })
    const body = { sessionId: SESSION, idleMs: 5, ended: false }
    expect(await post(r, r.token, body, '/signin')).toEqual({ status: 200, body: '{"commands":["stop"]}' })
    expect(seen).toEqual([body])
    expect((await post(r, 'nope', body, '/signin')).status).toBe(401)
    expect((await post(r, r.token, { ...body, idleMs: -1 }, '/signin')).status).toBe(400)
    const big = await raw(r.port, {
      path: '/signin',
      token: r.token,
      body: Buffer.alloc(MAX_RELAY_SIGNIN_BODY_BYTES + 1, 0x61)
    })
    expect(big.status).toBe(413)
    expect(seen).toHaveLength(1)
  })
})

describe('the server side', () => {
  type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
  async function upstream(handler: (seen: Seen, res: import('node:http').ServerResponse) => void) {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const s = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }
        seen.push(s)
        handler(s, res)
      })
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  }
  const ok = (
    res: import('node:http').ServerResponse,
    body: unknown = { ackedEvents: 0, commands: ['leave_now'], link: null }
  ) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  test('a heartbeat reaches the server with the device token, not the container headers', async () => {
    const up = await upstream((_s, res) => ok(res))
    const r = await start(serverHeartbeatApi({ origin: up.origin, deviceToken: () => 'device-token' }))
    const res = await raw(r.port, {
      token: r.token,
      body: JSON.stringify(hb()),
      headers: {
        Host: 'evil.example',
        Cookie: 'a=b',
        'X-Forwarded-For': '1.2.3.4',
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=5',
        TE: 'trailers'
      }
    })
    expect(JSON.parse(res.body).commands).toEqual(['leave_now'])
    expect(up.seen).toHaveLength(1)
    const s = up.seen[0]
    expect(s.method).toBe('POST')
    expect(s.url).toBe('/api/companion/jobs/job-1/heartbeat')
    expect(s.headers.authorization).toBe('Bearer device-token')
    expect(s.headers.host).toBe(new URL(up.origin).host)
    expect(s.headers.cookie).toBeUndefined()
    expect(s.headers['x-forwarded-for']).toBeUndefined()
    expect(s.headers['keep-alive']).toBeUndefined()
    expect(s.headers.te).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain(r.token)
    expect(JSON.parse(s.body)).toEqual(hb())
  })
  test('a redirect is refused: the relay answers 502 and the target is never called', async () => {
    const target = await upstream((_s, res) => ok(res))
    const up = await upstream((_s, res) => {
      res.writeHead(307, { Location: `${target.origin}/steal` })
      res.end()
    })
    const r = await start(serverHeartbeatApi({ origin: up.origin, deviceToken: () => 'device-token' }))
    expect(await post(r, r.token, hb())).toEqual({ status: 502, body: '{"error":"bad gateway"}' })
    expect(up.seen).toHaveLength(1)
    expect(target.seen).toEqual([])
  })
  test('a server that is down is a fixed 502', async () => {
    const up = await upstream((_s, res) => ok(res))
    const origin = up.origin
    servers.pop()!.close()
    await Bun.sleep(20)
    const r = await start(serverHeartbeatApi({ origin, deviceToken: () => 'device-token' }))
    expect(await post(r, r.token, hb())).toEqual({ status: 502, body: '{"error":"bad gateway"}' })
  })
  test('a slow server times out as a 502', async () => {
    const up = await upstream(() => {})
    const r = await start(serverHeartbeatApi({ origin: up.origin, deviceToken: () => 't', timeoutMs: 100 }))
    expect((await post(r, r.token, hb())).status).toBe(502)
  })
  test.each([401, 404, 500, 503])('a %i from the server is a fixed 502', async (status) => {
    const up = await upstream((_s, res) => {
      res.writeHead(status)
      res.end('{"error":"secret detail"}')
    })
    const r = await start(serverHeartbeatApi({ origin: up.origin, deviceToken: () => 't' }))
    expect(await post(r, r.token, hb())).toEqual({ status: 502, body: '{"error":"bad gateway"}' })
  })
  test('a 410 becomes a stop command, as the worker would read it', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(410)
      res.end()
    })
    const r = await start(serverHeartbeatApi({ origin: up.origin, deviceToken: () => 't' }))
    expect(JSON.parse((await post(r, r.token, hb())).body)).toEqual({ ackedEvents: 0, commands: ['stop'], link: null })
  })
  test('a reply over 64 KB, or one that is not a heartbeat reply, is a 502', async () => {
    const big = await upstream((_s, res) => ok(res, { ackedEvents: 0, commands: [], link: 'x'.repeat(70_000) }))
    const bad = await upstream((_s, res) => ok(res, { ackedEvents: 0, commands: ['self_destruct'], link: null }))
    for (const up of [big, bad]) {
      const r = await start(serverHeartbeatApi({ origin: up.origin, deviceToken: () => 't' }))
      expect((await post(r, r.token, hb())).status).toBe(502)
    }
  })
  test('only an https origin is accepted, plain http for loopback only', () => {
    const t = () => 't'
    expect(() => serverHeartbeatApi({ origin: 'https://tolong.example', deviceToken: t })).not.toThrow()
    expect(() => serverHeartbeatApi({ origin: 'http://tolong.example', deviceToken: t })).toThrow(/https/)
    expect(() => serverHeartbeatApi({ origin: 'http://10.0.0.5', deviceToken: t })).toThrow(/https/)
    expect(() => serverHeartbeatApi({ origin: 'ftp://tolong.example', deviceToken: t })).toThrow(/https/)
    expect(() => serverHeartbeatApi({ origin: 'https://tolong.example/api', deviceToken: t })).toThrow(/origin only/)
    expect(() => serverHeartbeatApi({ origin: 'https://u:p@tolong.example', deviceToken: t })).toThrow(/origin only/)
  })
  test('fetch is called with redirect: error and the device token only in Authorization', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const api = serverHeartbeatApi({
      origin: 'https://tolong.example',
      deviceToken: () => 'device-token',
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), init })
        return Response.json({ ackedEvents: 0, commands: [], link: null })
      }) as unknown as typeof fetch
    })
    await api.heartbeat('job 1/../x', hb())
    expect(calls[0].url).toBe('https://tolong.example/api/companion/jobs/job%201%2F..%2Fx/heartbeat')
    expect(calls[0].init.redirect).toBe('error')
    expect(Object.keys(calls[0].init.headers as object).sort()).toEqual(['Accept', 'Authorization', 'Content-Type'])
  })
})

describe('logging', () => {
  test('the token appears in no log line and no console output, whatever the request', async () => {
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {})
    )
    try {
      const failing: RelayApi = {
        async heartbeat() {
          throw new Error('boom')
        }
      }
      const r = await start(failing, { log: (l) => lines.push(l), onSignin: () => ({ commands: [] }) })
      await post(r, r.token, hb())
      await post(r, 'nope', hb())
      await post(r, r.token, hb(OTHER))
      await raw(r.port, { token: r.token, path: `/x?t=${r.token}` })
      await raw(r.port, { token: r.token, body: Buffer.alloc(MAX_RELAY_BODY_BYTES + 1, 0x61) })
      await post(r, r.token, { sessionId: SESSION, idleMs: 0, ended: false }, '/signin')
      expect(lines.length).toBeGreaterThan(0)
      const everything = JSON.stringify([lines, ...spies.map((s) => s.mock.calls)])
      expect(everything).not.toContain(r.token)
      expect(everything).not.toContain('Bearer')
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})
