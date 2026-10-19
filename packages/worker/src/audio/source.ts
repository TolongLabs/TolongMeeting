import { spawn, type ChildProcess } from 'node:child_process'

/** The PulseAudio source the audio comes from: the monitor of the worker image's `tm_sink`. */
export const AUDIO_SOURCE = 'tm_sink.monitor'
export const SAMPLE_RATE = 16_000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
/** `levelDb` can look back this far. */
export const KEEP_MS = 10_000
const FIRST_CHUNK_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5000

export interface AudioSource {
  /** Wall-clock time of the first sample: the live transcript's time origin. */
  startedAt: Date
  /** Subscribes to 16 kHz mono signed 16-bit little-endian PCM chunks; whole samples only. Returns the unsubscribe. */
  onChunk(cb: (pcm16le: Buffer) => void): () => void
  /** RMS level in dBFS of the last `windowMs` (at most 10 s) of audio; -120 for digital silence. */
  levelDb(windowMs: number): number
  /** Stops the capture process. Rejects if it died before that, or if a subscriber threw. */
  stop(): Promise<void>
}

export interface AudioSourceOptions {
  /**
   * Test-only: read a generated signal from ffmpeg instead of PulseAudio, for hosts without it. Leave unset in
   * production: the source then requires the `tm_sink.monitor` source and fails if it is absent.
   */
  testInput?: 'sine' | 'silence'
}

function command(options: AudioSourceOptions): { bin: string; args: string[] } {
  if (options.testInput !== undefined) {
    const input =
      options.testInput === 'sine' ? `sine=frequency=440:sample_rate=${SAMPLE_RATE}` : 'anullsrc=r=16000:cl=mono'
    return {
      bin: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-re',
        '-f',
        'lavfi',
        '-i',
        input,
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        'pipe:1'
      ]
    }
  }
  return {
    bin: 'parec',
    args: [`--device=${AUDIO_SOURCE}`, '--format=s16le', `--rate=${SAMPLE_RATE}`, '--channels=1', '--latency-msec=100']
  }
}

export function levelOf(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) throw new RangeError('no samples to measure')
  let sum = 0
  for (let i = 0; i < samples; i++) sum += (pcm.readInt16LE(i * 2) / 32768) ** 2
  const rms = Math.sqrt(sum / samples)
  return rms === 0 ? -120 : Math.max(-120, 20 * Math.log10(rms))
}

/**
 * Captures the sink's monitor as 16 kHz mono PCM for live ASR (`parec --device=tm_sink.monitor`). Resolves after the
 * first audio arrives, and rejects with the tool's own message when the monitor is missing.
 */
export async function startAudioSource(options: AudioSourceOptions = {}): Promise<AudioSource> {
  const { bin, args } = command(options)
  const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-2000)
  })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))

  let stopping = false
  let failure: Error | null = null
  const fail = (error: Error) => {
    failure ??= error
  }
  child.once('error', (e) => fail(new Error(`cannot start ${bin}: ${e.message}`)))
  child.once('close', (code, signal) => {
    if (!stopping) fail(new Error(`${bin} exited (${code ?? signal}) before stop: ${stderr.trim()}`))
  })

  const subscribers = new Set<(pcm: Buffer) => void>()
  const kept: Buffer[] = []
  let keptBytes = 0
  let startedAt: Date | null = null
  let spare: Buffer = Buffer.alloc(0)
  let firstChunk!: () => void
  const first = new Promise<void>((resolve) => (firstChunk = resolve))

  child.stdout!.on('data', (data: Buffer) => {
    const joined = spare.length > 0 ? Buffer.concat([spare, data]) : data
    const whole = joined.length - (joined.length % 2)
    spare = joined.subarray(whole)
    if (whole === 0) return
    const pcm = joined.subarray(0, whole)
    if (startedAt === null) {
      startedAt = new Date(Date.now() - whole / BYTES_PER_MS)
      firstChunk()
    }
    kept.push(pcm)
    keptBytes += whole
    while (kept.length > 1 && keptBytes - kept[0]!.length >= KEEP_MS * BYTES_PER_MS) keptBytes -= kept.shift()!.length
    for (const cb of subscribers) {
      try {
        cb(pcm)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })

  const kill = async (): Promise<void> => {
    stopping = true
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`${bin} gave no audio within ${FIRST_CHUNK_TIMEOUT_MS / 1000} s: ${stderr.trim()}`)),
      FIRST_CHUNK_TIMEOUT_MS
    ).unref()
  })
  const died = new Promise<never>((_, reject) => {
    child.once('error', (e) => reject(new Error(`cannot start ${bin}: ${e.message}`)))
    child.once('close', (code, signal) =>
      reject(new Error(`${bin} exited (${code ?? signal}) before any audio: ${stderr.trim()}`))
    )
  })
  try {
    await Promise.race([first, timeout, died])
  } catch (error) {
    await kill()
    throw error
  }

  return {
    startedAt: startedAt!,
    onChunk(cb) {
      subscribers.add(cb)
      return () => void subscribers.delete(cb)
    },
    levelDb(windowMs) {
      if (!(windowMs > 0 && windowMs <= KEEP_MS))
        throw new RangeError(`windowMs must be in (0, ${KEEP_MS}], got ${windowMs}`)
      if (failure !== null) throw failure
      const want = Math.floor((windowMs * BYTES_PER_MS) / 2) * 2
      const parts: Buffer[] = []
      let have = 0
      for (let i = kept.length - 1; i >= 0 && have < want; i--) {
        const chunk = kept[i]!
        const part = have + chunk.length > want ? chunk.subarray(chunk.length - (want - have)) : chunk
        parts.unshift(part)
        have += part.length
      }
      return levelOf(Buffer.concat(parts))
    },
    async stop() {
      await kill()
      if (failure !== null) throw failure
    }
  }
}
