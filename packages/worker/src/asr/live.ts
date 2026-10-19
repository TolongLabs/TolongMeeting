import { mkdir, readFile, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AiKeyError, AsrDisconnected, openAsrStream, type AiConfig } from '@tm/ai'
import type { AudioSource } from '../audio/source'
import { appendDurably } from '../chat/capture'

export interface LiveAsr {
  stop(): Promise<void>
}

export interface LiveAsrOptions {
  // Recording-relative offset of the audio source's first sample, in ms.
  baseMs?: number
  // Receives each fault once it cannot be recovered from, and each non-fatal error or failed write. Without it, the
  // message goes to stderr.
  onError?: (e: Error) => void
  open?: typeof openAsrStream
}

const stderrError = (e: Error): void => {
  console.error(`live transcription: ${e.message}`)
}

// A crash can leave the last line half written. That write was never acknowledged, so it is cut off before new lines
// are appended, and the file stays one JSON object per line.
async function cutTornLine(file: string): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return
  await truncate(file, bytes.lastIndexOf(0x0a) + 1)
}

// Streams the audio source to the ASR service and appends each final result to `out` (one JSON line, recording-relative
// offsets). A failure of the transcription never stops the audio capture or the recording: it is reported and the
// feed to ASR is cut. Each line is fsynced before the next one is written.
export async function startLiveAsr(
  audio: AudioSource,
  ai: AiConfig,
  out: string,
  opts: LiveAsrOptions = {}
): Promise<LiveAsr> {
  const baseMs = opts.baseMs ?? 0
  const onError = opts.onError ?? stderrError
  const open = opts.open ?? openAsrStream
  await mkdir(dirname(out), { recursive: true })
  await cutTornLine(out)

  const stream = open(ai)
  let finished = false // ASR is lost, or the audio failed: no more audio goes to ASR
  let unsubscribe: () => void = () => {}
  let closing: Promise<void> | undefined
  let writes: Promise<void> = Promise.resolve()

  const closeStream = (): Promise<void> => (closing ??= stream.close())

  const finish = (e: Error): void => {
    if (finished) return
    finished = true
    unsubscribe()
    onError(e)
    void closeStream()
  }

  unsubscribe = audio.onChunk((pcm) => {
    stream.send(pcm)
  })
  audio.onFatal(finish)

  stream.onError((e) => {
    if (e instanceof AiKeyError || e instanceof AsrDisconnected) finish(e)
    else if (!finished) onError(e)
  })

  stream.onResult((r) => {
    const line = `${JSON.stringify({ startMs: r.startMs + baseMs, endMs: r.endMs + baseMs, text: r.text })}\n`
    writes = writes.then(() => appendDurably(out, line)).catch((e: unknown) => onError(e as Error))
  })

  return {
    async stop() {
      unsubscribe()
      await closeStream()
      await writes
    }
  }
}
