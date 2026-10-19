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
  onAlert: (k: AlertKind) => void
  pinger: FormPinger | null
  /** Test seam: defaults to decodeQr. */
  decode?: typeof decodeQr
}

const FRAME_NAME = /^(\d{4})_\d{6}\.png$/

// The frame loop calls this for every frame and stops for good when it throws, so a step that fails is reported as an
// error event and the next frame goes on. It stays quick: the health check and the keyframe rule run first.
export function createFrameHandler(d: FrameHandlerDeps): (f: Frame) => Promise<void> {
  const framesDir = join(d.dataDir, 'frames')
  const decode = d.decode ?? decodeQr
  const health = new HealthMonitor((kind) => d.onAlert(kind))
  const selector = new KeyframeSelector()
  const confirmer = new QrConfirmer()
  let previous: GreyImage | null = null
  let counter: number | null = null

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

  async function codes(f: Frame): Promise<void> {
    if (!d.lecture || d.pinger === null) return
    let texts: string[]
    try {
      texts = await decode(f.png, d.region())
    } catch (error) {
      // Codes cannot be read: forms on the shared screen would go unseen, so say so.
      await report('qr', error)
      d.onAlert('form_ping_failed')
      return
    }
    for (const text of confirmer.push(texts)) {
      if (!/^https?:\/\//i.test(text)) continue
      try {
        await d.pinger.offer({ url: text, source: 'qr', sender: null, senderRole: null, seenAt: f.at.toISOString() })
      } catch (error) {
        // The pinger already emitted its own error event.
        console.error(`frame handler: form offer failed: ${(error as Error).message}`)
        d.onAlert('form_ping_failed')
      }
    }
  }

  return async (f) => {
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
    await codes(f)
  }
}
