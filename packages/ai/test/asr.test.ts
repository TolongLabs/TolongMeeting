import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AddressInfo } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { AiKeyError, dropOverlap, openAsrStream, type AiConfig, type AsrResult } from '../src/index'

// A real ws server on a random local port that imitates the DashScope realtime protocol.
interface Conn {
  url: string
  headers: IncomingHttpHeaders
  ws: WebSocket
  events: Array<Record<string, any>>
  appends: string[]
  lastInbound: number
  appendedBytes: () => number
}

function startFake() {
  const conns: Conn[] = []
  const queued = new Map<number, object[]>() // server events emitted before the connection exists
  let rejectWith: number | undefined
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info, cb) => (rejectWith ? cb(false, rejectWith) : cb(true))
  })
  wss.on('connection', (ws, req) => {
    const index = conns.length
    const conn: Conn = {
      url: req.url ?? '',
      headers: req.headers,
      ws,
      events: [],
      appends: [],
      lastInbound: Date.now(),
      appendedBytes: () => conn.appends.reduce((n, a) => n + Buffer.from(a, 'base64').length, 0)
    }
    conns.push(conn)
    ws.on('message', (data) => {
      const ev = JSON.parse(data.toString())
      conn.events.push(ev)
      conn.lastInbound = Date.now()
      if (ev.type === 'input_audio_buffer.append') conn.appends.push(ev.audio)
      if (ev.type === 'session.finish') ws.send(JSON.stringify({ type: 'session.finished' }))
    })
    for (const ev of queued.get(index) ?? []) ws.send(JSON.stringify(ev))
    queued.delete(index)
  })
  const port = (wss.address() as AddressInfo).port
  const cfg: AiConfig = {
    baseUrl: 'http://unused.invalid/v1',
    apiKey: 'sk-test',
    asrUrl: `ws://127.0.0.1:${port}/realtime`,
    models: {
      summary: 'qwen3.7-plus',
      vision: 'qwen3-vl-plus',
      formMatch: 'qwen-flash',
      asr: 'qwen3-asr-flash-realtime'
    }
  }
  return {
    cfg,
    conn: (i: number): Conn => conns[i]!,
    emit(i: number, ev: object): void {
      const c = conns[i]
      if (c) c.ws.send(JSON.stringify(ev))
      else queued.set(i, [...(queued.get(i) ?? []), ev])
    },
    async waitForAppends(n: number): Promise<void> {
      await until(() => (conns[0]?.appends.length ?? 0) >= n)
    },
    // Resolves once connection n-1 exists and has gone quiet, so its replay has arrived.
    async waitForConnections(n: number): Promise<void> {
      await until(() => conns.length >= n && conns[n - 1]!.events.length > 0)
      await until(() => Date.now() - conns[n - 1]!.lastInbound >= 50)
    },
    rejectHandshake(status: number): void {
      rejectWith = status
    },
    stop(): void {
      for (const c of conns) c.ws.terminate()
      wss.close()
    }
  }
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the fake server')
    await Bun.sleep(5)
  }
}

const sec = (s: number) => Buffer.alloc(32_000 * s) // 16 kHz mono s16le = 32 bytes per ms

let fake: ReturnType<typeof startFake>
beforeEach(() => {
  fake = startFake()
})
afterEach(() => {
  fake.stop()
})

test('handshake, session.update and append in 100 ms chunks', async () => {
  const s = openAsrStream(fake.cfg)
  s.send(sec(1))
  await fake.waitForAppends(10)
  expect(fake.conn(0).headers.authorization).toBe('Bearer sk-test')
  expect(fake.conn(0).url).toBe('/realtime?model=qwen3-asr-flash-realtime')
  expect(fake.conn(0).events[0]).toMatchObject({
    type: 'session.update',
    session: {
      input_audio_format: 'pcm',
      sample_rate: 16000,
      turn_detection: { type: 'server_vad' }
    }
  })
  expect(Buffer.from(fake.conn(0).appends[0]!, 'base64').length).toBe(3200)
  await s.close()
  expect(fake.conn(0).events.at(-1)).toEqual({ type: 'session.finish' })
})

test('results are stamped with stream offsets, falling back to bytes sent', async () => {
  const got: AsrResult[] = []
  const s = openAsrStream(fake.cfg)
  s.onResult((r) => got.push(r))
  s.send(sec(3))
  fake.emit(0, { type: 'input_audio_buffer.speech_started', audio_start_ms: 500 })
  fake.emit(0, { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 2500 })
  fake.emit(0, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'selamat petang semua' })
  fake.emit(0, { type: 'input_audio_buffer.speech_started' })
  fake.emit(0, { type: 'input_audio_buffer.speech_stopped' })
  fake.emit(0, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'okay' })
  await until(() => got.length === 2)
  expect(got[0]).toEqual({ startMs: 500, endMs: 2500, text: 'selamat petang semua' })
  expect(got[1]!.endMs).toBe(3000)
  await s.close()
})

test('rotation at a pause replays 5 s and removes duplicate text', async () => {
  let t = 0
  const got: AsrResult[] = []
  const s = openAsrStream(fake.cfg, { now: () => t, rotateAfterMs: 1000, forceRotateMs: 2000 })
  s.onResult((r) => got.push(r))
  s.send(sec(8))
  t = 1500
  fake.emit(0, { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 7900 })
  await fake.waitForConnections(2)
  expect(fake.conn(1).appendedBytes()).toBeGreaterThanOrEqual(160_000)
  fake.emit(0, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'the deadline is Friday' })
  fake.emit(1, { type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
  fake.emit(1, { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 5000 })
  fake.emit(1, {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'deadline is Friday at noon'
  })
  await until(() => got.length === 2)
  expect(got[1]!.text).toBe('at noon')
  await s.close()
})

test('dropOverlap', () => {
  expect(dropOverlap('the deadline is Friday', 'Deadline is Friday, at noon')).toBe('at noon')
  expect(dropOverlap('hello', 'world')).toBe('world')
  expect(dropOverlap('see you', 'see you')).toBe('')
})

test('an unexpected close reconnects with the same 5 s replay', async () => {
  const errs: Error[] = []
  const s = openAsrStream(fake.cfg)
  s.onError((e) => errs.push(e))
  s.send(sec(1))
  await fake.waitForAppends(10)
  fake.conn(0).ws.close(1011, 'server restart')
  await fake.waitForConnections(2)
  expect(fake.conn(1).events[0]!.type).toBe('session.update')
  expect(fake.conn(1).appendedBytes()).toBe(32_000)
  expect(errs).toEqual([])
  await s.close()
})

test('a rejected key raises AiKeyError through onError', async () => {
  fake.rejectHandshake(401)
  const errs: Error[] = []
  const s = openAsrStream(fake.cfg)
  s.onError((e) => errs.push(e))
  await until(() => errs.length === 1)
  expect(errs[0]).toBeInstanceOf(AiKeyError)
  expect(errs[0]).toMatchObject({ name: 'AiKeyError', status: 401 })
  await s.close()
})
