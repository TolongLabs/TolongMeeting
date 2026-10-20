import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionEvent } from '@tm/core'
import { CompanionApi, DeviceRevokedError } from '../src/api'
import { parseSse, startCommandStream, type CommandStreamDeps } from '../src/sse'
import { StateStore } from '../src/state'

const enc = new TextEncoder()
async function* chunksOf(parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p
}
const job = (n: number) => `id: ${n}\nevent: job_available\ndata: {"type":"job_available","jobId":"j${n}"}\n\n`

const dirs: string[] = []
async function newState(lastEventId = 0): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-sse-'))
  dirs.push(dir)
  const store = new StateStore(join(dir, 'state.json'))
  if (lastEventId > 0) await store.update({ lastEventId })
  return store
}
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(2)
  }
}

describe('parseSse', () => {
  test('joins fields split across chunks and skips comments', async () => {
    const out = await Array.fromAsync(
      parseSse(
        chunksOf(['id: 7\nevent: job_av', 'ailable\ndata: {"type":"job_available","jobId":"j1"}\n\n: keepalive\n\n'])
      )
    )
    expect(out).toEqual([{ id: '7', event: 'job_available', data: '{"type":"job_available","jobId":"j1"}' }])
  })

  test('handles CRLF, a lone CR, a CR at a chunk end, a BOM, multi-line data and a multi-byte character split in two', async () => {
    const yen = enc.encode('data: ¥\n\n')
    const out = await Array.fromAsync(
      parseSse(
        chunksOf([
          '﻿id:1\r\ndata:a\r\ndata: b\r\n\r\nid: 2\rdata: c\r\r',
          'id: 3\r',
          '\ndata: d\n\n',
          yen.slice(0, 7),
          yen.slice(7)
        ])
      )
    )
    expect(out).toEqual([
      { id: '1', event: null, data: 'a\nb' },
      { id: '2', event: null, data: 'c' },
      { id: '3', event: null, data: 'd' },
      { id: null, event: null, data: '¥' }
    ])
  })

  test('drops an event with no data, retry lines and an event cut off by the end of the stream', async () => {
    const out = await Array.fromAsync(
      parseSse(chunksOf(['id: 1\n\nretry: 5000\n\nid: 2\ndata: x\n\nid: 3\ndata: cut']))
    )
    expect(out).toEqual([{ id: '2', event: null, data: 'x' }])
  })

  test('drops an event over the cap, even one with no line end, and carries on with the next', async () => {
    let dropped = 0
    const big = 'x'.repeat(400)
    const out = await Array.fromAsync(
      parseSse(chunksOf([`id: 1\ndata: ${big}\n\n`, 'id: 2\ndata: ', big, big, '\n\n', 'id: 3\ndata: ok\n\n']), {
        maxEventBytes: 300,
        onOversize: () => dropped++
      })
    )
    expect(out).toEqual([{ id: '3', event: null, data: 'ok' }])
    expect(dropped).toBe(2)
  })
})

// --- A fake network ---

interface Conn {
  request: Request
  push(text: string): void
  end(): void
  aborted: boolean
}

/** Each fetch becomes a `Conn` the test feeds by hand. A `script` entry answers a connection by itself instead. */
function fakeNet(script: ((n: number) => Response | null)[] = []) {
  const conns: Conn[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const scripted = script[conns.length]?.(conns.length)
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
      const conn: Conn = {
        request,
        push: (t) => controller.enqueue(enc.encode(t)),
        end: () => controller.close(),
        aborted: false
      }
      conns.push(conn)
      request.signal.addEventListener('abort', () => {
        conn.aborted = true
        // A real fetch fails a pending read when its request is aborted.
        if (!scripted) controller.error(new DOMException('aborted', 'AbortError'))
      })
      return scripted ?? new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
    { preconnect: () => {} }
  )
  return { conns, fetch }
}

function apiFor(f: typeof fetch, over: { onRevoked?: () => void } = {}) {
  return new CompanionApi({
    serverUrl: 'https://tm.example',
    token: async () => 'tmd_secret',
    onRevoked: over.onRevoked ?? (() => {}),
    fetch: f
  })
}

function start(net: ReturnType<typeof fakeNet>, state: StateStore, extra: Partial<CommandStreamDeps> = {}) {
  const events: CompanionEvent[] = []
  const status: boolean[] = []
  const errors: Error[] = []
  const revoked: Error[] = []
  const stream = startCommandStream({
    api: apiFor(net.fetch),
    state,
    onEvent: (e) => void events.push(e),
    onStatus: (open) => void status.push(open),
    onError: (e) => void errors.push(e),
    onRevoked: (e) => void revoked.push(e),
    delayMs: () => 5,
    ...extra
  })
  return { stream, events, status, errors, revoked }
}

describe('startCommandStream', () => {
  test('resumes with the last event id, delivers events in order and stores the id after each', async () => {
    const net = fakeNet()
    const state = await newState(6)
    const s = start(net, state)
    await until(() => net.conns.length === 1)
    net.conns[0].push(job(7) + job(8).slice(0, 20))
    await until(() => s.events.length === 1)
    net.conns[0].push(job(8).slice(20))
    await until(() => state.get().lastEventId === 8)
    s.stream.stop()
    expect(net.conns[0].request.headers.get('last-event-id')).toBe('6')
    expect(s.events).toEqual([
      { id: 7, command: { type: 'job_available', jobId: 'j7' } },
      { id: 8, command: { type: 'job_available', jobId: 'j8' } }
    ])
    expect(state.get().lastEventId).toBe(8)
    expect(s.status[0]).toBe(true)
  })

  test('the token is a header only, the request refuses redirects, and no error repeats it', async () => {
    const net = fakeNet([() => new Response('<html>boom</html>', { status: 502 })])
    const s = start(net, await newState())
    await until(() => net.conns.length === 2)
    s.stream.stop()
    const req = net.conns[0].request
    expect(req.headers.get('authorization')).toBe('Bearer tmd_secret')
    expect(req.url).toBe('https://tm.example/api/companion/events')
    expect(req.redirect).toBe('error')
    expect(req.headers.has('last-event-id')).toBe(false)
    expect(s.errors.map((e) => e.message)).toEqual(['The website answered with HTTP 502'])
    for (const e of s.errors) expect(`${e.message} ${String(e.cause)}`).not.toContain('tmd_secret')
  })

  test('reconnects with the saved id and skips events it already handled', async () => {
    const net = fakeNet()
    const state = await newState()
    const s = start(net, state)
    await until(() => net.conns.length === 1)
    net.conns[0].push(job(1) + job(2))
    await until(() => s.events.length === 2)
    net.conns[0].end()
    await until(() => net.conns.length === 2)
    expect(net.conns[1].request.headers.get('last-event-id')).toBe('2')
    // The website replays 2 and sends 3: the handler sees 3 only.
    net.conns[1].push(job(2) + job(3))
    await until(() => s.events.length === 3)
    s.stream.stop()
    expect(s.events.map((e) => e.id)).toEqual([1, 2, 3])
    expect(s.status).toEqual([true, false, true, false])
  })

  test('an unknown command type is ignored but its id counts; an invalid event is dropped and reported', async () => {
    const net = fakeNet()
    const state = await newState()
    const s = start(net, state)
    await until(() => net.conns.length === 1)
    const c = net.conns[0]
    c.push('id: 1\ndata: {"type":"reboot_pc"}\n\n')
    c.push('id: 2\ndata: {"type":"job_available","jobId":"j2","extra":1}\n\n')
    c.push('id: 3\ndata: not json\n\n')
    c.push('id: x\ndata: {"type":"local_identities_changed"}\n\n')
    c.push('data: {"type":"local_identities_changed"}\n\n')
    c.push('id: 4\ndata: {"type":"local_identities_changed"}\n\n')
    await until(() => s.events.length === 1)
    await until(() => state.get().lastEventId === 4)
    s.stream.stop()
    expect(s.events).toEqual([{ id: 4, command: { type: 'local_identities_changed' } }])
    expect(s.errors.map((e) => e.message)).toEqual([
      'dropped a command event: it did not match the command schema',
      'dropped a command event: it did not match the event schema',
      'dropped a command event: no valid id',
      'dropped a command event: no valid id'
    ])
  })

  test('an oversized event is dropped without ending the stream', async () => {
    const net = fakeNet()
    const s = start(net, await newState())
    await until(() => net.conns.length === 1)
    net.conns[0].push(`id: 1\ndata: ${'x'.repeat(40_000)}\n\n`)
    net.conns[0].push(job(2))
    await until(() => s.events.length === 1)
    s.stream.stop()
    expect(s.events[0].id).toBe(2)
    expect(s.errors.map((e) => e.message)).toEqual(['dropped a command event: too large'])
  })

  test('a handler that throws is reported and the id still advances', async () => {
    const net = fakeNet()
    const state = await newState()
    const s = start(net, state, {
      onEvent: () => {
        throw new Error('handler broke')
      }
    })
    await until(() => net.conns.length === 1)
    net.conns[0].push(job(1))
    await until(() => state.get().lastEventId === 1)
    s.stream.stop()
    expect(s.errors.map((e) => e.message)).toEqual(['the command handler failed: handler broke'])
  })

  test('a stream that goes silent is dropped and reconnected', async () => {
    const net = fakeNet()
    const s = start(net, await newState(), { stallMs: 40 })
    await until(() => net.conns.length === 1)
    // Keepalive comments keep it alive...
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(20)
      net.conns[0].push(': keepalive\n\n')
    }
    expect(net.conns.length).toBe(1)
    // ...silence does not.
    await until(() => net.conns.length === 2)
    s.stream.stop()
    expect(net.conns[0].aborted).toBe(true)
    expect(s.errors.map((e) => e.message)).toEqual(['the command stream went silent'])
  })

  test('a reply that is not an event stream is refused and retried', async () => {
    const net = fakeNet([() => new Response('hello', { headers: { 'content-type': 'text/html' } })])
    const s = start(net, await newState())
    await until(() => net.conns.length === 2)
    s.stream.stop()
    expect(s.errors[0].message).toBe('the command stream is not an event stream')
  })

  test('failures back off by the T12 ladder and reset once a connection stays up', async () => {
    const net = fakeNet([
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 500 })
    ])
    const delays: number[] = []
    let t = 0
    const s = start(net, await newState(), {
      delayMs: (attempt) => (delays.push(attempt), 3),
      stableMs: 100,
      now: () => t
    })
    await until(() => net.conns.length === 4)
    expect(delays).toEqual([0, 1, 2])
    t = 1000 // the fourth connection has been up long enough
    net.conns[3].end()
    await until(() => net.conns.length === 5)
    s.stream.stop()
    expect(delays).toEqual([0, 1, 2, 0])
  })

  test('401 device_revoked_or_unknown stops the stream and reports "PC was unpaired"', async () => {
    const net = fakeNet([() => Response.json({ error: 'device_revoked_or_unknown' }, { status: 401 })])
    let cleared = 0
    const s = start(net, await newState(), { api: apiFor(net.fetch, { onRevoked: () => cleared++ }) })
    await until(() => s.revoked.length === 1)
    await Bun.sleep(40)
    expect(s.revoked[0]).toBeInstanceOf(DeviceRevokedError)
    expect(s.revoked[0].message).toBe('PC was unpaired')
    expect(cleared).toBe(1)
    expect(net.conns.length).toBe(1)
    expect(s.errors).toEqual([])
  })

  test('any other 401 is a failure to back off from, not an unpairing', async () => {
    const net = fakeNet([() => new Response('proxy says no', { status: 401 })])
    const s = start(net, await newState())
    await until(() => net.conns.length === 2)
    s.stream.stop()
    expect(s.revoked).toEqual([])
    expect(s.errors[0].message).toBe('The website answered with HTTP 401')
  })

  test('stop() cancels the request, closes the status, and nothing reconnects', async () => {
    const net = fakeNet()
    const s = start(net, await newState())
    await until(() => net.conns.length === 1)
    net.conns[0].push(job(1))
    await until(() => s.events.length === 1)
    s.stream.stop()
    expect(net.conns[0].aborted).toBe(true)
    expect(s.status).toEqual([true, false])
    await Bun.sleep(40)
    expect(net.conns.length).toBe(1)
    expect(s.errors).toEqual([])
  })

  test('stop() during the wait before a reconnect cancels it', async () => {
    const net = fakeNet([() => new Response(null, { status: 500 })])
    const s = start(net, await newState(), { delayMs: () => 60_000 })
    await until(() => s.errors.length === 1)
    s.stream.stop()
    await Bun.sleep(30)
    expect(net.conns.length).toBe(1)
  })
})

describe('command stream over real HTTP', () => {
  test('follows a Bun.serve event stream, sends the headers, resumes after a drop and stops cleanly', async () => {
    const seen: { auth: string | null; last: string | null; path: string }[] = []
    let closed = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const n = seen.push({
          auth: req.headers.get('authorization'),
          last: req.headers.get('last-event-id'),
          path: new URL(req.url).pathname
        })
        req.signal.addEventListener('abort', () => closed++)
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(': hello\n\n'))
            c.enqueue(enc.encode(n === 1 ? job(1) + 'id: 2\nevent: job_av' : job(3)))
            if (n === 1)
              setTimeout(() => c.enqueue(enc.encode('ailable\ndata: {"type":"job_available","jobId":"j2"}\n\n')), 20)
            if (n === 1) setTimeout(() => c.close(), 60)
          }
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
      }
    })
    try {
      const state = await newState()
      const events: CompanionEvent[] = []
      const api = new CompanionApi({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: async () => 'tmd_real',
        onRevoked: () => {}
      })
      const s = startCommandStream({
        api,
        state,
        onEvent: (e) => void events.push(e),
        onStatus: () => {},
        onError: () => {},
        delayMs: () => 5
      })
      await until(() => state.get().lastEventId === 3, 4000)
      s.stop()
      expect(events.map((e) => e.id)).toEqual([1, 2, 3])
      expect(state.get().lastEventId).toBe(3)
      expect(seen.slice(0, 2)).toEqual([
        { auth: 'Bearer tmd_real', last: null, path: '/api/companion/events' },
        { auth: 'Bearer tmd_real', last: '2', path: '/api/companion/events' }
      ])
      await until(() => closed >= 1)
      await Bun.sleep(40)
      expect(seen.length).toBe(2)
    } finally {
      await server.stop(true)
    }
  })
})
