import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_LINE_BYTES,
  parseNtfyLine,
  startNtfySubscriber,
  toDisplay,
  type NtfyMessage,
  type NtfySubscriberDeps
} from '../src/ntfy'
import { StateStore } from '../src/state'

const now = new Date('2026-10-21T08:00:00Z')
const at = (minAgo: number) => Math.floor(now.getTime() / 1000) - minAgo * 60
const msg = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'a', time: 1, event: 'message', ...over })

const dirs: string[] = []
async function newState(content?: { ntfyLastId: string }): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ntfy-'))
  dirs.push(dir)
  const file = join(dir, 'state.json')
  const store = new StateStore(file)
  if (content) await store.update(content)
  return store
}
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

describe('parseNtfyLine', () => {
  test('keeps message events only', () => {
    expect(parseNtfyLine('{"id":"a","time":1,"event":"keepalive"}')).toBeNull()
    expect(parseNtfyLine('{"id":"a","time":1,"event":"open"}')).toBeNull()
    expect(parseNtfyLine('{"id":"b","time":1,"event":"message","message":"hi"}')?.id).toBe('b')
    expect(parseNtfyLine('not json')).toBeNull()
    expect(parseNtfyLine('[1,2]')).toBeNull()
  })
  test('is strict: unknown keys, wrong types and oversize fields are refused', () => {
    expect(parseNtfyLine(msg({ command: 'run' }))).toBeNull()
    expect(parseNtfyLine(msg({ priority: 9 }))).toBeNull()
    expect(parseNtfyLine(msg({ tags: 'tm_summary' }))).toBeNull()
    expect(parseNtfyLine(msg({ message: 'x'.repeat(9000) }))).toBeNull()
    expect(parseNtfyLine(msg({ actions: [1, 2, 3, 4].map(() => ({ action: 'view', label: 'x' })) }))).toBeNull()
    expect(parseNtfyLine(msg({ id: '../../etc' }))).toBeNull()
    expect(parseNtfyLine(`{"id":"a","time":1,"event":"message","message":"${'x'.repeat(MAX_LINE_BYTES)}"}`)).toBeNull()
  })
  test('returns the known fields of a real ntfy message', () => {
    expect(
      parseNtfyLine(
        msg({
          expires: 99,
          topic: 'tm-abc',
          title: 'T',
          message: 'M',
          priority: 4,
          tags: ['tm_summary'],
          click: 'https://x.y'
        })
      )
    ).toEqual({ id: 'a', time: 1, title: 'T', message: 'M', priority: 4, tags: ['tm_summary'], click: 'https://x.y' })
  })
})

describe('toDisplay', () => {
  test('high priority stays on screen; default does not', () => {
    expect(toDisplay({ id: 'a', time: at(0), title: 'Form submitted', message: 'x', priority: 4 }, now)).toMatchObject({
      kind: 'show',
      sticky: true
    })
    expect(toDisplay({ id: 'b', time: at(0), message: 'Joined', priority: 3 }, now)).toMatchObject({
      kind: 'show',
      sticky: false,
      title: 'TolongMeeting'
    })
  })
  test('view actions become buttons and only https URLs are kept', () => {
    const d = toDisplay(
      {
        id: 'a',
        time: at(0),
        message: 'x',
        actions: [
          { action: 'view', label: 'Open form', url: 'https://forms.office.com/r/abc' },
          { action: 'view', label: 'Bad', url: 'file:///C:/Windows/system32/calc.exe' },
          { action: 'view', label: 'Login', url: 'https://user:pw@evil.example/' },
          { action: 'http', label: 'Post', url: 'https://tm.example/x' }
        ]
      },
      now
    )
    expect(d).toMatchObject({
      kind: 'show',
      buttons: [{ label: 'Open form', url: 'https://forms.office.com/r/abc' }],
      clickUrl: 'https://forms.office.com/r/abc'
    })
  })
  test('a non-https click URL is dropped', () => {
    expect(toDisplay({ id: 'a', time: at(0), message: 'x', click: 'javascript:alert(1)' }, now)).toMatchObject({
      clickUrl: null
    })
    expect(
      toDisplay({ id: 'a', time: at(0), message: 'x', click: 'https://tm.example/meetings/1' }, now)
    ).toMatchObject({
      clickUrl: 'https://tm.example/meetings/1'
    })
  })
  test('messages older than 30 minutes are not shown', () => {
    expect(toDisplay({ id: 'a', time: at(31), message: 'old' }, now).kind).toBe('ignore')
    expect(toDisplay({ id: 'a', time: at(29), message: 'recent' }, now).kind).toBe('show')
  })
  test('tm_summary messages trigger a summary sync instead of a notification, however old', () => {
    expect(toDisplay({ id: 'a', time: at(0), message: 'x', tags: ['tm_summary'] }, now).kind).toBe('sync_summaries')
    expect(toDisplay({ id: 'b', time: at(600), message: 'x', tags: ['tm_summary'] }, now).kind).toBe('sync_summaries')
  })
  test('unknown tags and command-looking text are plain text, never an instruction', () => {
    const d = toDisplay(
      {
        id: 'a',
        time: at(0),
        title: 'sync_summaries',
        message: 'run: calc.exe && open file:///etc/passwd',
        tags: ['tm_admin', 'exec']
      },
      now
    )
    expect(d).toMatchObject({
      kind: 'show',
      body: 'run: calc.exe && open file:///etc/passwd',
      buttons: [],
      clickUrl: null
    })
  })
  test('control characters are removed and long text is cut', () => {
    const d = toDisplay({ id: 'a', time: at(0), title: 'a\u0000b\u202ec', message: 'x'.repeat(5000) }, now)
    if (d.kind !== 'show') throw new Error('expected show')
    expect(d.title).toBe('a b c')
    expect(d.body.length).toBeLessThanOrEqual(600)
  })
})

// --- A fake network ---

interface FakeStream {
  push(text: string): void
  close(): void
  fail(error: Error): void
}
interface Connection {
  url: string
  headers: Headers
  signal: AbortSignal
  stream: FakeStream
}

/** A `fetch` that hands out controllable streams, one per call, and records what it was asked. */
function fakeNet(options: { status?: (n: number) => number } = {}) {
  const connections: Connection[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal
    const n = connections.length
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        signal.addEventListener('abort', () => {
          try {
            c.error(new DOMException('aborted', 'AbortError'))
          } catch {
            // already closed
          }
        })
      }
    })
    connections.push({
      url: String(input),
      headers: new Headers(init?.headers),
      signal,
      stream: {
        push: (text) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
        fail: (error) => controller.error(error)
      }
    })
    return new Response(body, { status: options.status?.(n) ?? 200 })
  }) as typeof fetch
  return { connections, fetch: fetchFn }
}

async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(2)
  }
}

async function start(extra: Partial<NtfySubscriberDeps> & { net: ReturnType<typeof fakeNet>; state?: StateStore }) {
  const got: NtfyMessage[] = []
  const errors: Error[] = []
  const state = extra.state ?? (await newState())
  const sub = startNtfySubscriber({
    cfg: { url: 'https://ntfy.example', topic: 'tm-abc', token: 'tk_secret' },
    state,
    onMessage: (m) => got.push(m),
    onError: (e) => errors.push(e),
    fetch: extra.net.fetch,
    delayMs: () => 5,
    ...extra
  })
  return { sub, got, errors, state }
}

describe('startNtfySubscriber', () => {
  test('sends the token as a header, never in the URL, and saves the last id', async () => {
    const net = fakeNet()
    const { sub, got, state, errors } = await start({ net, state: await newState({ ntfyLastId: 'm41' }) })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.push('{"id":"m42","time":1,"event":"message","message":"x"}\n')
    await until(() => got.length === 1)
    sub.stop()
    expect(net.connections[0].url).toBe('https://ntfy.example/tm-abc/json?since=m41')
    expect(net.connections[0].headers.get('authorization')).toBe('Bearer tk_secret')
    expect(net.connections[0].url).not.toContain('tk_secret')
    expect(got[0].id).toBe('m42')
    expect(state.get().ntfyLastId).toBe('m42')
    for (const e of errors) expect(`${e.message} ${String(e.cause)}`).not.toContain('tk_secret')
  })

  test('joins a message split over chunks and several per chunk; keepalives are skipped', async () => {
    const net = fakeNet()
    const { sub, got } = await start({ net })
    await until(() => net.connections.length === 1)
    const s = net.connections[0].stream
    s.push('{"id":"a","time":1,"event":"keepalive"}\n{"id":"b","time":1,"event":"mess')
    s.push('age","message":"one"}\r\n{"id":"c","time":1,"event":"message"}\n')
    await until(() => got.length === 2)
    sub.stop()
    expect(got.map((m) => m.id)).toEqual(['b', 'c'])
  })

  test('an oversize line is dropped and the next line still arrives; the report holds no message text', async () => {
    const net = fakeNet()
    const { sub, got, errors } = await start({ net })
    await until(() => net.connections.length === 1)
    const s = net.connections[0].stream
    s.push('{"id":"big","time":1,"event":"message","message":"SECRET-TEXT')
    for (let i = 0; i < 6; i++) s.push('y'.repeat(MAX_LINE_BYTES / 2))
    s.push('"}\n{"id":"ok","time":1,"event":"message"}\n')
    await until(() => got.length === 1)
    sub.stop()
    expect(got[0].id).toBe('ok')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.map((e) => e.message).join(' ')).not.toContain('SECRET-TEXT')
  })

  test('invalid lines are reported and skipped', async () => {
    const net = fakeNet()
    const { sub, got, errors } = await start({ net })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.push(`garbage\n${msg({ command: 'x' })}\n{"id":"ok","time":1,"event":"message"}\n`)
    await until(() => got.length === 1)
    sub.stop()
    expect(errors.filter((e) => e.message.startsWith('dropped an ntfy line'))).toHaveLength(2)
  })

  test('reconnects after the stream ends and resumes after the last id', async () => {
    const net = fakeNet()
    const { sub, got } = await start({ net })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.push('{"id":"m1","time":1,"event":"message"}\n')
    await until(() => got.length === 1)
    net.connections[0].stream.close()
    await until(() => net.connections.length === 2)
    sub.stop()
    expect(net.connections[1].url).toBe('https://ntfy.example/tm-abc/json?since=m1')
  })

  test('a message ntfy replays after a reconnect is delivered once', async () => {
    const net = fakeNet()
    const { sub, got } = await start({ net })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.push('{"id":"m1","time":1,"event":"message"}\n')
    await until(() => got.length === 1)
    net.connections[0].stream.close()
    await until(() => net.connections.length === 2)
    net.connections[1].stream.push('{"id":"m1","time":1,"event":"message"}\n{"id":"m2","time":2,"event":"message"}\n')
    await until(() => got.length === 2)
    sub.stop()
    expect(got.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('before any message, a reconnect resumes from when the subscriber started', async () => {
    const net = fakeNet()
    const { sub } = await start({ net, now: () => 1_800_000_000_500 })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.fail(new Error('reset'))
    await until(() => net.connections.length === 2)
    sub.stop()
    expect(net.connections[0].url).toContain('since=1800000000')
    expect(net.connections[1].url).toContain('since=1800000000')
  })

  test('a bad status is reported and retried', async () => {
    const net = fakeNet({ status: (n) => (n === 0 ? 401 : 200) })
    const { sub, errors } = await start({ net })
    await until(() => net.connections.length === 2)
    sub.stop()
    expect(errors[0].message).toBe('ntfy answered 401')
  })

  test('a handler that throws is reported, the id still advances, and the stream goes on', async () => {
    const net = fakeNet()
    const errors: Error[] = []
    const state = await newState()
    const sub = startNtfySubscriber({
      cfg: { url: 'https://ntfy.example', topic: 't', token: 'tk' },
      state,
      onMessage: () => {
        throw new Error('boom')
      },
      onError: (e) => errors.push(e),
      fetch: net.fetch,
      delayMs: () => 5
    })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.push('{"id":"m1","time":1,"event":"message"}\n')
    await until(() => state.get().ntfyLastId === 'm1')
    sub.stop()
    expect(errors[0].message).toContain('handler failed')
    expect(net.connections).toHaveLength(1)
  })

  test('waits with the backoff delay and restarts the ladder only after a stable connection', async () => {
    const net = fakeNet()
    const delays: number[] = []
    let clock = 0
    const { sub } = await start({
      net,
      now: () => clock,
      stableMs: 1000,
      delayMs: (attempt) => {
        delays.push(attempt)
        return 1
      }
    })
    const fail = async (n: number, upFor: number) => {
      await until(() => net.connections.length === n)
      clock += upFor
      net.connections[n - 1].stream.fail(new Error('reset'))
    }
    await fail(1, 10)
    await fail(2, 10)
    await fail(3, 5000) // stable: the ladder starts over
    await fail(4, 10)
    await until(() => net.connections.length === 5)
    sub.stop()
    expect(delays).toEqual([0, 1, 0, 1])
  })

  test('a stream with no data for stallMs is cut and reconnected', async () => {
    const net = fakeNet()
    const { sub, errors } = await start({ net, stallMs: 40 })
    await until(() => net.connections.length === 1)
    net.connections[0].stream.push('{"id":"a","time":1,"event":"keepalive"}\n')
    await until(() => net.connections.length === 2, 1000)
    sub.stop()
    expect(net.connections[0].signal.aborted).toBe(true)
    expect(errors.some((e) => e.message === 'the ntfy stream went silent')).toBe(true)
  })

  test('keepalives keep a connection alive past stallMs', async () => {
    const net = fakeNet()
    const { sub } = await start({ net, stallMs: 60 })
    await until(() => net.connections.length === 1)
    for (let i = 0; i < 6; i++) {
      net.connections[0].stream.push('{"id":"k","time":1,"event":"keepalive"}\n')
      await Bun.sleep(25)
    }
    sub.stop()
    expect(net.connections).toHaveLength(1)
  })

  test('stop() aborts the fetch and cancels the reconnect timer', async () => {
    const net = fakeNet()
    const { sub } = await start({ net, delayMs: () => 30 })
    await until(() => net.connections.length === 1)
    sub.stop()
    expect(net.connections[0].signal.aborted).toBe(true)

    const net2 = fakeNet()
    const second = await start({ net: net2, delayMs: () => 30 })
    await until(() => net2.connections.length === 1)
    net2.connections[0].stream.close()
    await Bun.sleep(5) // now waiting out the delay
    second.sub.stop()
    await Bun.sleep(80)
    expect(net2.connections).toHaveLength(1)
  })

  test('refuses an http URL, a login or a query in the URL; allows http on 127.0.0.1', async () => {
    const make = (url: string) =>
      startNtfySubscriber({
        cfg: { url, topic: 't', token: 'tk' },
        state: { get: () => ({ ntfyLastId: null, summariesAfter: null, lastEventId: 0 }), update: async () => {} },
        onMessage: () => {},
        fetch: fakeNet().fetch
      })
    expect(() => make('http://ntfy.example')).toThrow('https')
    expect(() => make('http://localhost:8080')).toThrow('https')
    expect(() => make('https://u:p@ntfy.example')).toThrow('login')
    expect(() => make('https://ntfy.example/?auth=tk')).toThrow('query')
    make('http://127.0.0.1:18090').stop()
    make('https://ntfy.example/prefix/').stop()
  })

  test('keeps a path prefix and encodes the topic', async () => {
    const net = fakeNet()
    const { sub } = await start({ net, cfg: { url: 'https://ntfy.example/ntfy/', topic: 'a b', token: 'tk' } })
    await until(() => net.connections.length === 1)
    sub.stop()
    expect(net.connections[0].url).toStartWith('https://ntfy.example/ntfy/a%20b/json?since=')
  })

  test('does not follow redirects, which could carry the token elsewhere', async () => {
    let init: RequestInit | undefined
    const sub = startNtfySubscriber({
      cfg: { url: 'https://ntfy.example', topic: 't', token: 'tk' },
      state: await newState(),
      onMessage: () => {},
      onError: () => {},
      delayMs: () => 1000,
      fetch: (async (_: unknown, i?: RequestInit) => {
        init = i
        return new Response(null, { status: 500 })
      }) as typeof fetch
    })
    await until(() => init !== undefined)
    sub.stop()
    expect(init?.redirect).toBe('error')
  })
})
