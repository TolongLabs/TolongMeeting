import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localParts, meanDiff, meanLuma, type GreyImage } from '@tm/core'
import type { AlertKind } from '@tm/notify'
import type { Rect } from '../adapters/types'
import type { EventLog } from '../events'
import type { FormPinger } from '../forms/pinger'
import { HealthMonitor } from '../health/health'
import { decodeQr } from '../qr/qr'
import { QrConfirmer } from '../qr/confirm'
import { hashOf, KeyframeSelector, thumbnail } from './keyframes'
import type { Frame } from './frames'

export interface FrameHandlerDeps {
  dataDir: string
  timeZone: string
  /** The first recording start: keyframe offsets count from here. */
  recordingStart: Date
  lecture: boolean
  region: () => Rect | null
  participants: () => number | null
  /** Sink level over the last second, or null when unknown (the audio source failed or has not heard a second yet). */
  levelDb: () => number | null
  emit: EventLog['emit']
  /** `detail` names what failed for the kinds that need one (`component_failed`). */
  onAlert: (k: AlertKind, detail?: string) => void
  pinger: FormPinger | null
  /** Test seam: defaults to decodeQr. */
  decode?: typeof decodeQr
  /** Test seam: a decode that takes longer than this fails. Default 10 s. */
  decodeTimeoutMs?: number
}

/** The frame callback, plus the QR scanner's controls. */
export interface FrameHandler {
  (f: Frame): Promise<void>
  /** Resolves when no frame waits for the QR scanner and no decode is running. */
  flush(): Promise<void>
  /** Stops the QR scanner: the waiting frame is dropped, a running decode is abandoned and offers nothing more. */
  stop(): void
}

export const QR_DECODE_TIMEOUT_MS = 10_000
const QR_ERROR_WINDOW_MS = 60_000

const FRAME_NAME = /^(\d{4})_\d{6}\.png$/

// The frame loop calls this for every frame and stops for good when it throws, so a step that fails is reported as an
// error event and the next frame goes on. It stays quick: the health check and the keyframe rule run for every frame.
// QR decoding is slow and can hang, so it does not run in the callback: the callback leaves the latest frame in a slot
// and a loop of its own decodes it. A frame that waits while a decode runs is replaced by the next one.
export function createFrameHandler(d: FrameHandlerDeps): FrameHandler {
  const framesDir = join(d.dataDir, 'frames')
  const decode = d.decode ?? decodeQr
  const decodeTimeoutMs = d.decodeTimeoutMs ?? QR_DECODE_TIMEOUT_MS
  const health = new HealthMonitor((kind) => d.onAlert(kind))
  const selector = new KeyframeSelector()
  const confirmer = new QrConfirmer()
  let previous: GreyImage | null = null
  let counter: number | null = null
  let slot: Frame | null = null
  let scanning: Promise<void> | null = null
  let stopped = false
  let lastQrReport = Number.NEGATIVE_INFINITY

  // Keyframes of an earlier attempt are on disk: numbering goes on after them.
  async function nextNumber(): Promise<number> {
    if (counter === null) {
      let names: string[] = []
      try {
        names = await readdir(framesDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      counter = Math.max(0, ...names.map((n) => Number(FRAME_NAME.exec(n)?.[1] ?? 0)))
    }
    counter += 1
    return counter
  }

  async function report(where: string, error: unknown): Promise<void> {
    await d
      .emit('error', { where, message: error instanceof Error ? error.message : String(error) })
      .catch((e: unknown) => {
        console.error(`frame handler: error event not written (${where}): ${(e as Error).message}`)
      })
  }

  async function keyframe(f: Frame, thumb: GreyImage): Promise<void> {
    if (!(await selector.consider(thumb, () => hashOf(f.png)))) return
    const name = `${String(await nextNumber()).padStart(4, '0')}_${localParts(f.at, d.timeZone).hhmmss}.png`
    await mkdir(framesDir, { recursive: true })
    await writeFile(join(framesDir, name), f.png)
    await d.emit('keyframe', {
      file: `frames/${name}`,
      region: d.region(),
      offsetMs: f.at.getTime() - d.recordingStart.getTime()
    })
  }

  // One decode with a hard limit. A decode that outlives it is abandoned, not cancelled.
  function decodeWithin(f: Frame): Promise<string[]> {
    const run = decode(f.png, d.region())
    run.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`QR decode did not finish within ${decodeTimeoutMs / 1000} s`)),
        decodeTimeoutMs
      )
    })
    return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
  }

  async function scan(f: Frame): Promise<void> {
    let texts: string[]
    try {
      texts = await decodeWithin(f)
    } catch (error) {
      // Codes cannot be read: forms on the shared screen would go unseen, so say so. The alert is limited by the
      // runner; the error event is limited here, one a minute, as for the per-tick steps.
      const at = f.at.getTime()
      if (at - lastQrReport >= QR_ERROR_WINDOW_MS) {
        lastQrReport = at
        await report('qr', error)
      }
      if (!stopped) d.onAlert('component_failed', 'QR scanning')
      return
    }
    if (stopped) return
    for (const text of confirmer.push(texts)) {
      if (!/^https?:\/\//i.test(text)) continue
      try {
        await d.pinger!.offer({ url: text, source: 'qr', sender: null, senderRole: null, seenAt: f.at.toISOString() })
      } catch (error) {
        // The pinger already emitted its own error event.
        console.error(`frame handler: form offer failed: ${(error as Error).message}`)
        d.onAlert('form_ping_failed')
      }
    }
  }

  async function scanLoop(): Promise<void> {
    while (slot !== null && !stopped) {
      const f = slot
      slot = null
      await scan(f)
    }
  }

  function submit(f: Frame): void {
    if (!d.lecture || d.pinger === null || stopped) return
    slot = f
    kick()
  }

  function kick(): void {
    if (scanning !== null) return
    scanning = scanLoop().finally(() => {
      scanning = null
      // A frame that arrived as the loop was ending still gets its turn.
      if (slot !== null && !stopped) kick()
    })
  }

  const handler = async (f: Frame): Promise<void> => {
    try {
      const thumb = await thumbnail(f.png)
      health.sample({
        atMs: f.at.getTime(),
        meanLuma: meanLuma(thumb),
        diffPrev: previous === null ? 255 : meanDiff(thumb, previous),
        levelDb: d.levelDb(),
        participants: d.participants()
      })
      previous = thumb
      await keyframe(f, thumb)
    } catch (error) {
      await report('frame', error)
      return
    }
    submit(f)
  }
  return Object.assign(handler, {
    async flush() {
      while (scanning !== null) await scanning
    },
    stop() {
      stopped = true
      slot = null
    }
  })
}
