import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { z } from 'zod'
import type { AiConfig } from '@tm/core'
import { AiKeyError } from './errors'

export interface AsrResult {
  startMs: number // offsets from the first byte sent
  endMs: number
  text: string
}

export interface AsrOptions {
  now?: () => number
  rotateAfterMs?: number
  forceRotateMs?: number
  reconnectDelaysMs?: number[] // one entry per retry; default 1, 2, 4, 8, 16 s
}

export interface AsrStream {
  send(pcm16le: Buffer): void
  onResult(cb: (r: AsrResult) => void): void
  onError(cb: (e: Error) => void): void
  close(): Promise<void>
}

export class AsrDisconnected extends Error {
  constructor(cause: Error) {
    super('ASR connection was lost and could not be restored', { cause })
    this.name = 'AsrDisconnected'
  }
}

const BYTES_PER_MS = 32 // 16 kHz, mono, 16-bit
const CHUNK_BYTES = 3_200 // 100 ms
const REPLAY_BYTES = 160_000 // 5 s
const DEFAULT_ROTATE_MS = 6_000_000 // 100 minutes
const DEFAULT_FORCE_ROTATE_MS = 6_600_000 // 110 minutes
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
const FINISH_WAIT_MS = 5_000
const LINGER_MS = 10_000

// Server events that carry no state this client needs. Any other type is reported through onError.
const IGNORED_EVENTS = new Set([
  'session.created',
  'session.updated',
  'conversation.item.created',
  'input_audio_buffer.committed',
  'conversation.item.input_audio_transcription.text'
])

const Envelope = z.object({ type: z.string() })
const SpeechStarted = z.object({ item_id: z.string().optional(), audio_start_ms: z.number().optional() })
const SpeechStopped = z.object({ item_id: z.string().optional(), audio_end_ms: z.number().optional() })
const Transcript = z.object({ item_id: z.string().optional(), transcript: z.string() })
const TranscriptFailed = z.object({
  item_id: z.string().optional(),
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    param: z.string().optional()
  })
})
const ServerError = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional()
})

interface Turn {
  start?: number
  end?: number
}

interface Session {
  seq: number
  ws: WebSocket
  ready: boolean
  confirmed: boolean // session.updated seen; the next server event shows the connection is stable
  baseMs: number // stream time of this session's first byte, replay included
  delivered: number // bytes handed to this session, replay included
  createdAt: number
  outbox: string[] // JSON messages waiting for the socket to open
  turns: Map<string, Turn> // pending speech by item_id; key '' when the server sent no item_id
  failure?: Error // why this connection failed, when the socket says so
  finished: Promise<void>
  markFinished: () => void
  linger?: ReturnType<typeof setTimeout>
}

export function openAsrStream(cfg: AiConfig, opts: AsrOptions = {}): AsrStream {
  const now = opts.now ?? Date.now
  const rotateAfterMs = opts.rotateAfterMs ?? DEFAULT_ROTATE_MS
  const forceRotateMs = opts.forceRotateMs ?? DEFAULT_FORCE_ROTATE_MS
  const reconnectDelaysMs = opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS
  const url = new URL(cfg.asrUrl)
  url.searchParams.set('model', cfg.models.asr)

  const resultListeners: Array<(r: AsrResult) => void> = []
  const errorListeners: Array<(e: Error) => void> = []
  const sessions = new Set<Session>() // open, connecting or lingering
  let current: Session | undefined
  let accepted = 0 // bytes accepted by send(): the live stream position
  let ring = Buffer.alloc(0) // the last REPLAY_BYTES accepted
  let pending = Buffer.alloc(0) // audio not yet making a whole 100 ms chunk
  let seq = 0
  let lastSeq = 0 // session of the last emitted result
  let lastEnd = 0
  let lastText = ''
  let attempts = 0 // reconnects since the last stable connection
  let closing = false
  let failed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function emitError(e: Error): void {
    for (const cb of errorListeners) cb(e)
  }

  function fail(e: Error): void {
    if (failed) return
    failed = true
    clearTimeout(reconnectTimer)
    current = undefined
    for (const s of [...sessions]) s.ws.close()
    sessions.clear()
    emitError(e)
  }

  function write(s: Session, msg: object): void {
    s.outbox.push(JSON.stringify({ event_id: `evt_${randomUUID()}`, ...msg }))
    if (s.ready) flush(s)
  }

  function flush(s: Session): void {
    while (s.outbox.length > 0) s.ws.send(s.outbox.shift()!)
  }

  function appendAudio(s: Session, audio: Buffer): void {
    for (let off = 0; off < audio.length; off += CHUNK_BYTES) {
      const chunk = audio.subarray(off, off + CHUNK_BYTES)
      write(s, { type: 'input_audio_buffer.append', audio: chunk.toString('base64') })
      s.delivered += chunk.length
    }
  }

  function sentMs(s: Session): number {
    return s.baseMs + s.delivered / BYTES_PER_MS
  }

  function openSession(): Session {
    seq += 1
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    let markFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve
    })
    const s: Session = {
      seq,
      ws,
      ready: false,
      confirmed: false,
      baseMs: (accepted - ring.length) / BYTES_PER_MS,
      delivered: 0,
      createdAt: now(),
      outbox: [],
      turns: new Map(),
      finished,
      markFinished
    }
    sessions.add(s)
    pending = Buffer.alloc(0) // the replay below covers everything accepted so far
    write(s, {
      type: 'session.update',
      session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { type: 'server_vad' } }
    })
    appendAudio(s, ring)
    ws.on('open', () => {
      s.ready = true
      flush(s)
    })
    ws.on('message', (data) => onMessage(s, data.toString()))
    ws.on('unexpected-response', (_req, res) => {
      res.resume() // drain the body so the socket is released
      const status = res.statusCode
      if (status === 401 || status === 402 || status === 429) {
        fail(new AiKeyError(status, `ASR handshake rejected with HTTP ${status}`))
        return
      }
      s.failure = new Error(`ASR handshake rejected with HTTP ${status}`)
      ws.terminate() // ends in 'close', which drives the reconnect backoff
    })
    ws.on('error', (e) => {
      s.failure ??= e
    })
    ws.on('close', (code, reason) => onClose(s, code, reason.toString()))
    return s
  }

  function onClose(s: Session, code: number, reason: string): void {
    s.ready = false
    sessions.delete(s)
    clearTimeout(s.linger)
    if (s !== current || closing || failed) return
    current = undefined
    if (attempts >= reconnectDelaysMs.length) {
      fail(
        new AsrDisconnected(
          s.failure ?? new Error(`ASR connection closed (code ${code}${reason ? `: ${reason}` : ''})`)
        )
      )
      return
    }
    const delay = reconnectDelaysMs[attempts]!
    attempts += 1
    reconnectTimer = setTimeout(() => {
      if (!closing && !failed) current = openSession()
    }, delay)
  }

  function rotateIfDue(atSpeechStop: boolean): void {
    if (!current) return
    const age = now() - current.createdAt
    if (age >= forceRotateMs || (atSpeechStop && age >= rotateAfterMs)) rotate()
  }

  function rotate(): void {
    const old = current!
    current = undefined
    write(old, { type: 'session.finish' })
    old.linger = setTimeout(() => old.ws.close(), LINGER_MS)
    current = openSession()
  }

  function turnFor(s: Session, itemId: string | undefined): Turn {
    const key = itemId ?? ''
    let turn = s.turns.get(key)
    if (!turn) {
      turn = {}
      s.turns.set(key, turn)
    }
    return turn
  }

  function onMessage(s: Session, raw: string): void {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      fail(new Error('ASR sent a message that is not JSON'))
      return
    }
    const envelope = Envelope.safeParse(json)
    if (!envelope.success) {
      fail(new Error('ASR sent a message without a type'))
      return
    }
    const type = envelope.data.type
    if (type === 'session.updated') {
      s.confirmed = true
    } else if (s.confirmed) {
      // The first server event after session.updated: this connection is stable, so the backoff starts over.
      s.confirmed = false
      if (s === current) attempts = 0
    }
    switch (type) {
      case 'session.finished':
        s.markFinished()
        return
      case 'input_audio_buffer.speech_started': {
        const ev = SpeechStarted.safeParse(json)
        if (!ev.success) return fail(badEvent(type))
        turnFor(s, ev.data.item_id).start = s.baseMs + (ev.data.audio_start_ms ?? s.delivered / BYTES_PER_MS)
        return
      }
      case 'input_audio_buffer.speech_stopped': {
        const ev = SpeechStopped.safeParse(json)
        if (!ev.success) return fail(badEvent(type))
        turnFor(s, ev.data.item_id).end = s.baseMs + (ev.data.audio_end_ms ?? s.delivered / BYTES_PER_MS)
        if (s === current) rotateIfDue(true)
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const ev = Transcript.safeParse(json)
        if (!ev.success) return fail(badEvent(type))
        emitResult(s, ev.data.item_id, ev.data.transcript)
        return
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const ev = TranscriptFailed.safeParse(json)
        if (!ev.success) return fail(badEvent(type))
        s.turns.delete(ev.data.item_id ?? '')
        const { code, message } = ev.data.error
        emitError(new Error(`ASR transcription failed (${code ?? 'no code'}): ${message ?? 'no message'}`))
        return
      }
      case 'error': {
        const ev = ServerError.safeParse(json)
        if (!ev.success) return fail(badEvent(type))
        const code = ev.data.code ?? ev.data.error?.code ?? ''
        const message = ev.data.message ?? ev.data.error?.message ?? code
        const status = keyStatusFor(code)
        if (status !== undefined) {
          fail(new AiKeyError(status, `ASR rejected the key (${code})`))
          return
        }
        emitError(new Error(`ASR error${code ? ` ${code}` : ''}: ${message}`))
        return
      }
      default:
        if (IGNORED_EVENTS.has(type)) return
        emitError(new Error(`ASR sent an unknown event type: ${type}`))
        return
    }
  }

  function emitResult(s: Session, itemId: string | undefined, transcript: string): void {
    const key = itemId ?? ''
    const turn = s.turns.get(key)
    s.turns.delete(key)
    const r: AsrResult = {
      startMs: turn?.start ?? lastEnd,
      endMs: turn?.end ?? sentMs(s),
      text: transcript.trim()
    }
    if (s.seq > lastSeq && r.startMs < lastEnd) {
      // A newer session replayed audio the last result already covered.
      r.text = dropOverlap(lastText, r.text)
      r.startMs = lastEnd
    }
    if (r.text === '' || r.endMs <= lastEnd) return
    lastEnd = r.endMs
    lastText = r.text
    lastSeq = s.seq
    for (const cb of resultListeners) cb(r)
  }

  current = openSession()

  return {
    send(pcm16le: Buffer): void {
      if (closing) throw new Error('send() called after close()')
      accepted += pcm16le.length
      ring = Buffer.concat([ring, pcm16le]).subarray(-REPLAY_BYTES)
      if (failed) return // the failure was already reported through onError
      if (!current) {
        pending = Buffer.alloc(0) // reconnect replays the ring, which covers this audio
        return
      }
      pending = Buffer.concat([pending, pcm16le])
      rotateIfDue(false)
      if (!current) return
      const whole = pending.length - (pending.length % CHUNK_BYTES)
      if (whole > 0) {
        appendAudio(current, pending.subarray(0, whole))
        pending = pending.subarray(whole)
      }
    },
    onResult(cb: (r: AsrResult) => void): void {
      resultListeners.push(cb)
    },
    onError(cb: (e: Error) => void): void {
      errorListeners.push(cb)
    },
    async close(): Promise<void> {
      if (closing) return
      closing = true
      clearTimeout(reconnectTimer)
      const s = current
      current = undefined
      if (s && !failed) {
        if (pending.length > 0) appendAudio(s, pending)
        pending = Buffer.alloc(0)
        write(s, { type: 'session.finish' })
        await waitUpTo(s.finished, FINISH_WAIT_MS)
      }
      for (const x of [...sessions]) {
        clearTimeout(x.linger)
        x.ws.close()
      }
      sessions.clear()
    }
  }
}

export function dropOverlap(prev: string, next: string): string {
  const prevWords = prev.trim().split(/\s+/).filter(Boolean)
  const nextWords = next.trim().split(/\s+/).filter(Boolean)
  const prevNorm = prevWords.map(normaliseWord)
  const nextNorm = nextWords.map(normaliseWord)
  const longest = Math.min(30, prevNorm.length, nextNorm.length)
  for (let k = longest; k >= 1; k--) {
    const suffix = prevNorm.slice(prevNorm.length - k)
    if (suffix.every((w, i) => w === nextNorm[i])) return nextWords.slice(k).join(' ')
  }
  return nextWords.join(' ')
}

function normaliseWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function keyStatusFor(code: string): 401 | 402 | 429 | undefined {
  if (/InvalidApiKey|Unauthorized/.test(code)) return 401
  if (/Arrearage|Quota|insufficient/i.test(code)) return 402
  if (/Throttl|RateLimit/i.test(code)) return 429
  return undefined
}

function badEvent(type: string): Error {
  return new Error(`ASR sent a malformed ${type} event`)
}

async function waitUpTo(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}
