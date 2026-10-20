import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AddressInfo } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  AiKeyError,
  AsrDisconnected,
  AsrProtocolError,
  dropOverlap,
  openAsrStream,
  type AiConfig,
  type AsrResult
} from '../src/index'

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
  let closeOnAccept = false
  let handshakes = 0
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info, cb) => {
      handshakes += 1
      if (rejectWith) cb(false, rejectWith)
      else cb(true)
    }
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
    if (closeOnAccept) {
      ws.close(1011, 'accepted then closed')
      return
    }
    ws.on('message', (data) => {
      const ev = JSON.parse(data.toString())
      conn.events.push(ev)
      conn.lastInbound = Date.now()
      if (ev.type === 'input_audio_buffer.append') conn.appends.push(ev.audio)
      if (ev.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'session.updated', event_id: `event_${index}`, session: ev.session }))
      }
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
    connectionCount: (): number => conns.length,
    handshakeCount: (): number => handshakes,
    emit(i: number, ev: object): void {
      const c = conns[i]
      if (c) c.ws.send(JSON.stringify(ev))
      else queued.set(i, [...(queued.get(i) ?? []), ev])
    },
    emitRaw(i: number, frame: string): void {
      conns[i]!.ws.send(frame)
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
    acceptThenClose(): void {
      closeOnAccept = true
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
  const ids = fake.conn(0).events.map((e) => e.event_id)
  expect(ids.every((id) => /^evt_[0-9a-f-]{36}$/.test(id))).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  await s.close()
  expect(fake.conn(0).events.at(-1)).toMatchObject({ type: 'session.finish' })
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

test('pending speech is keyed by item_id, so a second turn starting before the first completes keeps its own offsets', async () => {
  const got: AsrResult[] = []
  const s = openAsrStream(fake.cfg)
  s.onResult((r) => got.push(r))
  s.send(sec(4))
  fake.emit(0, { type: 'input_audio_buffer.speech_started', item_id: 'item_a', audio_start_ms: 500 })
  fake.emit(0, { type: 'input_audio_buffer.speech_stopped', item_id: 'item_a', audio_end_ms: 2500 })
  fake.emit(0, { type: 'input_audio_buffer.speech_started', item_id: 'item_b', audio_start_ms: 2600 })
  fake.emit(0, { type: 'input_audio_buffer.speech_stopped', item_id: 'item_b', audio_end_ms: 3500 })
  fake.emit(0, {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_a',
    transcript: 'first turn'
  })
  fake.emit(0, {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_b',
    transcript: 'second turn'
  })
  await until(() => got.length === 2)
  expect(got[0]).toEqual({ startMs: 500, endMs: 2500, text: 'first turn' })
  expect(got[1]).toEqual({ startMs: 2600, endMs: 3500, text: 'second turn' })
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
  expect(fake.conn(1).appendedBytes()).toBe(160_000)
  fake.emit(0, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'the deadline is Friday' })
  fake.emit(1, { type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
  fake.emit(1, { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 5000 })
  fake.emit(1, {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'deadline is Friday at noon'
  })
  await until(() => got.length === 2)
  expect(got[1]).toMatchObject({ startMs: 7900, endMs: 8000 })
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

test('a connection that reaches session.updated and then speaks resets the backoff', async () => {
  const errs: Error[] = []
  const s = openAsrStream(fake.cfg, { reconnectDelaysMs: [1] })
  s.onError((e) => errs.push(e))
  s.send(sec(1))
  await fake.waitForAppends(10)
  fake.conn(0).ws.close(1011, 'first drop')
  await fake.waitForConnections(2)
  // The fake has already sent session.updated on connection 1; this event is the proof of a stable connection.
  fake.emit(1, { type: 'input_audio_buffer.committed', item_id: 'item_c', previous_item_id: null })
  fake.conn(1).ws.close(1011, 'second drop')
  await fake.waitForConnections(3)
  expect(errs).toEqual([])
  await s.close()
})

test('a server that accepts then closes exhausts the backoff instead of looping', async () => {
  fake.acceptThenClose()
  const errs: Error[] = []
  const s = openAsrStream(fake.cfg, { reconnectDelaysMs: [5, 5] })
  s.onError((e) => errs.push(e))
  await until(() => errs.length === 1)
  expect(errs[0]).toBeInstanceOf(AsrDisconnected)
  expect(fake.connectionCount()).toBe(3)
  expect((errs[0] as AsrDisconnected).cause).toMatchObject({ message: expect.stringContaining('code 1011') })
  await s.close()
})

test('a handshake rejected with 503 is retried, then raises AsrDisconnected with the cause', async () => {
  fake.rejectHandshake(503)
  const errs: Error[] = []
  const s = openAsrStream(fake.cfg, { reconnectDelaysMs: [5, 5, 5] })
  s.onError((e) => errs.push(e))
  await until(() => errs.length === 1)
  expect(fake.handshakeCount()).toBe(4)
  expect(errs[0]).toBeInstanceOf(AsrDisconnected)
  expect(errs[0]).not.toBeInstanceOf(AiKeyError)
  expect((errs[0] as AsrDisconnected).cause).toMatchObject({ message: 'ASR handshake rejected with HTTP 503' })
  await s.close()
})

test('a failed transcription and an unknown event go to onError and the stream stays up', async () => {
  const errs: Error[] = []
  const got: AsrResult[] = []
  const s = openAsrStream(fake.cfg)
  s.onError((e) => errs.push(e))
  s.onResult((r) => got.push(r))
  s.send(sec(1))
  fake.emit(0, {
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item_x',
    content_index: 0,
    error: { code: 'InvalidAudio', message: 'audio too short' }
  })
  fake.emit(0, { type: 'session.mystery' })
  fake.emit(0, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'still here' })
  await until(() => got.length === 1 && errs.length === 2)
  expect(errs[0]!.message).toContain('InvalidAudio')
  expect(errs[0]!.message).toContain('audio too short')
  expect(errs[1]!.message).toContain('session.mystery')
  expect(got[0]).toEqual({ startMs: 0, endMs: 1000, text: 'still here' })
  expect(fake.connectionCount()).toBe(1)
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

test.each([
  ['a frame that is not JSON', 'not-json', 'secret transcript words {'],
  ['a frame without a type', 'no-type', JSON.stringify({ transcript: 'secret transcript words' })],
  [
    'an event with a malformed body',
    'bad-event',
    JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 42 })
  ]
])('%s ends the stream with AsrProtocolError, once, without the frame in the error', async (_name, reason, frame) => {
  const errs: Error[] = []
  const s = openAsrStream(fake.cfg)
  s.onError((e) => errs.push(e))
  s.send(sec(1))
  await fake.waitForAppends(10)
  fake.emitRaw(0, frame)
  fake.emitRaw(0, frame)
  await until(() => errs.length === 1)
  await Bun.sleep(30)
  expect(errs).toHaveLength(1)
  expect(errs[0]).toBeInstanceOf(AsrProtocolError)
  expect(errs[0]).toMatchObject({ name: 'AsrProtocolError', reason })
  expect(errs[0]!.message).not.toContain('secret')
  expect(JSON.stringify(errs[0])).not.toContain('secret')
  s.send(sec(1)) // after a failure send() still accepts audio and drops it
  await s.close()
})
