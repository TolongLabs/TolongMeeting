import { mkdir, readFile, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AiKeyError, AsrDisconnected, AsrProtocolError, openAsrStream, type AiConfig, type AsrResult } from '@tm/ai'
import type { AudioSource } from '../audio/source'
import { appendDurably, createDurably } from '../chat/capture'

export interface LiveAsr {
  stop(): Promise<void>
}

export interface LiveAsrOptions {
  // Recording-relative offset of the audio source's first sample, in ms.
  baseMs?: number
  // Receives (1) the one terminal fault that ended the transcription (AiKeyError, AsrDisconnected or AsrProtocolError;
  // the audio feed is already cut and the stream closing when it is called), (2) each non-fatal ASR error, and (3)
  // write failures: the first one, then one summary with the count of lines dropped, when writes recover or at stop().
  // It is never called after stop() has returned, and a throw from it is logged to stderr and otherwise ignored.
  // Audio capture faults are NOT passed here: the audio source owns those alerts. Without it, the message goes to
  // stderr.
  onError?: (e: Error) => void
  // Called once with each result (recording-relative offsets), as it arrives and before its line is written, so a
  // failed write cannot hide it. It is never called after stop() has returned, and a throw from it is logged to
  // stderr by name and otherwise ignored: it cannot reach the speech path.
  onResult?: (r: AsrResult) => void
  open?: typeof openAsrStream
}

const stderrError = (e: Error): void => {
  console.error(`live transcription: ${e.message}`)
}

// A crash can leave the last line half written. That write was never acknowledged, so it is cut off before new lines
// are appended, and the file stays one JSON object per line. Returns whether a line was cut.
async function cutTornLine(file: string): Promise<boolean> {
  const bytes = await readFile(file)
  if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return false
  await truncate(file, bytes.lastIndexOf(0x0a) + 1)
  return true
}

// Streams the audio source to the ASR service and appends each final result to `out` (one JSON line, recording-relative
// offsets). A failure of the transcription never stops the audio capture or the recording: it is reported through
// onError and the feed to ASR is cut. Each line is fsynced before the next one is written.
export async function startLiveAsr(
  audio: AudioSource,
  ai: AiConfig,
  out: string,
  opts: LiveAsrOptions = {}
): Promise<LiveAsr> {
  const baseMs = opts.baseMs ?? 0
  const handler = opts.onError ?? stderrError
  const open = opts.open ?? openAsrStream
  await mkdir(dirname(out), { recursive: true })
  await createDurably(out)
  if (await cutTornLine(out)) console.error('live transcription: cut a partial last line from the transcript file')

  const stream = open(ai)
  let terminal = false // ASR is lost: no more audio goes to ASR and no further ASR error is reported
  let stopped = false // stop() has returned: nothing is reported any more
  let unsubscribe: () => void = () => {}
  let closing: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let writes: Promise<void> = Promise.resolve()
  let failingWrites = false // the last write failed and no later write has succeeded
  let dropped = 0 // lines not written since the first failure of this run

  // onError is caller code: whatever it does, it cannot wedge the feed or the writes chain.
  const report = (e: Error): void => {
    if (stopped) return
    try {
      handler(e)
    } catch {
      console.error('live transcription: the onError handler threw')
    }
  }

  const closeStream = (): Promise<void> => (closing ??= stream.close())

  // Cuts the audio feed and closes the stream. Nothing here can throw into a caller of the audio or stream callbacks.
  const cutOff = (): void => {
    unsubscribe()
    closeStream().catch(() => {
      console.error('live transcription: closing the ASR stream failed')
    })
  }

  unsubscribe = audio.onChunk((pcm) => {
    stream.send(pcm)
  })
  // The recorder owns audio alerts, so a capture fault only ends the ASR stream: its last results are still written.
  audio.onFatal(cutOff)

  stream.onError((e) => {
    if (terminal) return
    if (e instanceof AiKeyError || e instanceof AsrDisconnected || e instanceof AsrProtocolError) {
      terminal = true
      cutOff() // before the handler runs, so a handler that throws or hangs cannot keep the audio flowing
    }
    report(e)
  })

  const reportDropped = (): void => {
    if (dropped === 0) return
    const n = dropped
    dropped = 0
    report(new Error(`live transcription: ${n} transcript line${n === 1 ? ' was' : 's were'} not written`))
  }

  stream.onResult((r) => {
    if (opts.onResult !== undefined && !stopped) {
      try {
        opts.onResult({ startMs: r.startMs + baseMs, endMs: r.endMs + baseMs, text: r.text })
      } catch (e) {
        console.error(`live transcription: the onResult handler threw (${e instanceof Error ? e.name : 'unknown'})`)
      }
    }
    const line = `${JSON.stringify({ startMs: r.startMs + baseMs, endMs: r.endMs + baseMs, text: r.text })}\n`
    // This task never rejects: a failed append is counted, and report() swallows what the handler throws.
    writes = writes.then(async () => {
      try {
        await appendDurably(out, line)
      } catch (e) {
        dropped += 1
        if (!failingWrites) {
          failingWrites = true
          report(e as Error)
        }
        return
      }
      if (failingWrites) {
        failingWrites = false
        reportDropped()
      }
    })
  })

  return {
    stop() {
      stopping ??= (async () => {
        unsubscribe()
        try {
          await closeStream()
          await writes
          reportDropped()
        } finally {
          stopped = true
        }
      })()
      return stopping
    }
  }
}
