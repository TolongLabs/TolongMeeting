import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { AiKeyError, AsrDisconnected, openAsrStream, type AiConfig } from '@tm/ai'
import { startLiveAsr } from '../src/asr/live'
import type { AudioSource } from '../src/audio/source'

// A local server that imitates the DashScope realtime protocol closely enough for the client under test.
interface FakeAsr {
  cfg: AiConfig
  appendedBytes(): number
  finishes(): number
  emit(ev: object): void
  rejectHandshake(status: number): void
  // Text the server sends as the transcript of the pending turn when the client asks it to finish.
  transcriptOnFinish(text: string): void
  connections(): number
  stop(): void
}

function startFakeAsr(): FakeAsr {
  const sockets: ServerWebSocket<unknown>[] = []
  let appended = 0
  let finishes = 0
  let connections = 0
  let rejectWith: number | undefined
  let finishText: string | undefined
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (rejectWith !== undefined) return new Response('rejected', { status: rejectWith })
      return srv.upgrade(req) ? undefined : new Response('not a websocket', { status: 400 })
    },
    websocket: {
      open(ws) {
        connections += 1
        sockets.push(ws)
      },
      message(ws, raw) {
        const ev = JSON.parse(String(raw))
        if (ev.type === 'input_audio_buffer.append') appended += Buffer.from(ev.audio, 'base64').length
        if (ev.type === 'session.update') {
          ws.send(JSON.stringify({ type: 'session.updated', event_id: 'event_0', session: ev.session }))
        }
        if (ev.type === 'session.finish') {
          finishes += 1
          if (finishText !== undefined) {
            ws.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                transcript: finishText
              })
            )
          }
          ws.send(JSON.stringify({ type: 'session.finished' }))
        }
      }
    }
  })
  return {
    cfg: {
      baseUrl: 'http://unused.invalid/v1',
      apiKey: 'sk-test',
      asrUrl: `ws://127.0.0.1:${server.port}/realtime`,
      models: { summary: 'qwen3.7-plus', vision: 'qwen3-vl-plus', formMatch: 'qwen-flash', asr: 'asr-test' }
    },
    appendedBytes: () => appended,
    finishes: () => finishes,
    connections: () => connections,
    emit(ev) {
      for (const ws of sockets) ws.send(JSON.stringify(ev))
    },
    rejectHandshake(status) {
      rejectWith = status
    },
    transcriptOnFinish(text) {
      finishText = text
    },
    stop() {
      for (const ws of sockets) ws.close()
      server.stop(true)
    }
  }
}

// An AudioSource the test drives by hand. It records how often the capture was stopped.
function fakeAudio() {
  const subscribers = new Set<(pcm: Buffer) => void>()
  const fatal: Array<(e: Error) => void> = []
  let failure: Error | undefined
  let stops = 0
  return {
    startedAt: new Date(0),
    onChunk(cb: (pcm: Buffer) => void) {
      subscribers.add(cb)
      return () => void subscribers.delete(cb)
    },
    onFatal(cb: (e: Error) => void) {
      if (failure) cb(failure)
      else fatal.push(cb)
    },
    levelDb: () => -120,
    async stop() {
      stops += 1
    },
    push(pcm: Buffer) {
      for (const cb of [...subscribers]) cb(pcm)
    },
    fail(e: Error) {
      failure = e
      subscribers.clear()
      for (const cb of fatal) cb(e)
    },
    subscribers: () => subscribers.size,
    stops: () => stops
  } satisfies AudioSource & Record<string, unknown> & { push(pcm: Buffer): void; fail(e: Error): void }
}

const SECOND = Buffer.alloc(32_000) // 16 kHz, mono, 16-bit: one second of audio

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the condition')
    await Bun.sleep(5)
  }
}

async function linesOf(file: string): Promise<unknown[]> {
  const text = await readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) =>
    e.code === 'ENOENT' ? '' : Promise.reject(e)
  )
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

let asr: FakeAsr
let dir: string
beforeEach(async () => {
  asr = startFakeAsr()
  dir = await mkdtemp(join(tmpdir(), 'asr-live-'))
})
afterEach(async () => {
  asr.stop()
  await rm(dir, { recursive: true, force: true })
})

test('results are written as recording-relative lines as they arrive, and stop writes the rest', async () => {
  const out = join(dir, 'transcript', 'live.jsonl')
  const audio = fakeAudio()
  const live = await startLiveAsr(audio, asr.cfg, out, { baseMs: 4000 })
  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 32_000)

  asr.emit({ type: 'input_audio_buffer.speech_started', audio_start_ms: 500 })
  asr.emit({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 2500 })
  asr.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'selamat petang semua' })
  // Durable before stop(): the line is on disk while the stream is still open.
  await until(async () => (await linesOf(out)).length === 1)
  expect(await linesOf(out)).toEqual([{ startMs: 4500, endMs: 6500, text: 'selamat petang semua' }])

  asr.emit({ type: 'input_audio_buffer.speech_started', audio_start_ms: 2600 })
  asr.emit({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 3500 })
  asr.transcriptOnFinish('pending turn')
  await live.stop()

  expect(asr.finishes()).toBe(1)
  expect(await linesOf(out)).toEqual([
    { startMs: 4500, endMs: 6500, text: 'selamat petang semua' },
    { startMs: 6600, endMs: 7500, text: 'pending turn' }
  ])
  expect(audio.stops()).toBe(0)
})

test('a rejected key is reported once, stops the audio feed, and leaves capture running', async () => {
  const out = join(dir, 'live.jsonl')
  const audio = fakeAudio()
  const errs: Error[] = []
  const live = await startLiveAsr(audio, asr.cfg, out, { onError: (e) => errs.push(e) })
  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 32_000)

  asr.emit({ type: 'error', error: { code: 'Arrearage', message: 'account in arrears' } })
  asr.emit({ type: 'error', error: { code: 'Arrearage', message: 'account in arrears' } })
  await until(() => errs.length === 1)
  await Bun.sleep(50)

  expect(errs).toHaveLength(1)
  expect(errs[0]).toBeInstanceOf(AiKeyError)
  expect(errs[0]).toMatchObject({ status: 402 })
  expect(audio.subscribers()).toBe(0)
  audio.push(SECOND)
  await Bun.sleep(50)
  expect(asr.appendedBytes()).toBe(32_000)
  expect(audio.stops()).toBe(0)
  await live.stop()
})

test('a key rejected at the handshake is reported as AiKeyError', async () => {
  asr.rejectHandshake(401)
  const errs: Error[] = []
  const audio = fakeAudio()
  const live = await startLiveAsr(audio, asr.cfg, join(dir, 'live.jsonl'), { onError: (e) => errs.push(e) })
  await until(() => errs.length === 1)
  expect(errs[0]).toBeInstanceOf(AiKeyError)
  expect(errs[0]).toMatchObject({ status: 401 })
  await live.stop()
})

test('a lost connection is reported once as AsrDisconnected and capture is not stopped', async () => {
  asr.rejectHandshake(503)
  const errs: Error[] = []
  const audio = fakeAudio()
  const live = await startLiveAsr(audio, asr.cfg, join(dir, 'live.jsonl'), {
    onError: (e) => errs.push(e),
    open: (cfg) => openAsrStream(cfg, { reconnectDelaysMs: [1, 1] })
  })
  await until(() => errs.length === 1)
  await Bun.sleep(30)
  expect(errs).toHaveLength(1)
  expect(errs[0]).toBeInstanceOf(AsrDisconnected)
  expect(audio.stops()).toBe(0)
  await live.stop()
})

test('a transcription error is reported and the stream keeps writing', async () => {
  const out = join(dir, 'live.jsonl')
  const audio = fakeAudio()
  const errs: Error[] = []
  const live = await startLiveAsr(audio, asr.cfg, out, { onError: (e) => errs.push(e) })
  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 32_000)
  asr.emit({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item_x',
    error: { code: 'InvalidAudio', message: 'audio too short' }
  })
  await until(() => errs.length === 1)
  expect(errs[0]!.message).toContain('InvalidAudio')

  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 64_000)
  asr.emit({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1000 })
  asr.emit({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1800 })
  asr.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'still here' })
  await live.stop()
  expect(await linesOf(out)).toEqual([{ startMs: 1000, endMs: 1800, text: 'still here' }])
  expect(errs).toHaveLength(1)
})

test('an audio failure is reported once and closes the ASR stream', async () => {
  const errs: Error[] = []
  const audio = fakeAudio()
  const live = await startLiveAsr(audio, asr.cfg, join(dir, 'live.jsonl'), { onError: (e) => errs.push(e) })
  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 32_000)

  const parec = new Error('parec exited (1) before stop')
  audio.fail(parec)
  audio.fail(new Error('a second failure'))
  await live.stop()

  expect(errs).toEqual([parec])
  expect(asr.finishes()).toBe(1)
})

test('a failed write is reported through onError', async () => {
  const sub = join(dir, 'transcript')
  const audio = fakeAudio()
  const errs: Error[] = []
  const live = await startLiveAsr(audio, asr.cfg, join(sub, 'live.jsonl'), { onError: (e) => errs.push(e) })
  await rm(sub, { recursive: true }) // the directory goes away after start, so the next append fails
  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 32_000)
  asr.emit({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 })
  asr.emit({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 500 })
  asr.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'lost' })
  await until(() => errs.length === 1)
  await live.stop()
  expect(errs[0]).toMatchObject({ code: 'ENOENT' })
})

test('a transcript path that is a directory fails at start', async () => {
  await expect(startLiveAsr(fakeAudio(), asr.cfg, dir)).rejects.toMatchObject({ code: 'EISDIR' })
})

test('a line a crash left half written is cut off before new results are appended', async () => {
  const out = join(dir, 'live.jsonl')
  await writeFile(out, '{"startMs":0,"endMs":1000,"text":"kept"}\n{"startMs":1000,"endMs":20')
  const audio = fakeAudio()
  const live = await startLiveAsr(audio, asr.cfg, out, { baseMs: 5000 })
  audio.push(SECOND)
  await until(() => asr.appendedBytes() === 32_000)
  asr.emit({ type: 'input_audio_buffer.speech_started', audio_start_ms: 100 })
  asr.emit({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 900 })
  asr.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'after restart' })
  await live.stop()
  expect(await linesOf(out)).toEqual([
    { startMs: 0, endMs: 1000, text: 'kept' },
    { startMs: 5100, endMs: 5900, text: 'after restart' }
  ])
})
