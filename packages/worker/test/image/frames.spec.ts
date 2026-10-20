// Runs in the worker image only (needs Xvfb, openbox, Chrome and the tm_sink PulseAudio sink):
//   docker run --rm --shm-size=2g tm-worker:dev test frames.spec.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { startAudioSource } from '../../src/audio/source'
import { launchBrowser } from '../../src/chrome/launch'
import { startScreen } from '../../src/display/screen'
import { startFrameLoop, type Frame } from '../../src/frames/frames'
import { playTone } from '../helpers/image'

test.skip(process.env.TM_IN_IMAGE !== '1', 'needs the worker image')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// stage page red, desk page blue
test('frames every 2 s show the stage only; the audio source reports level', async () => {
  test.setTimeout(120_000)
  const profileDir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  const screen = await startScreen()
  try {
    const { context, stage, desk } = await launchBrowser(profileDir, screen)
    try {
      await stage.setContent('<body style="margin:0;background:#f00"></body>')
      await desk.setContent('<body style="margin:0;background:#00f"></body>')
      const frames: Frame[] = []
      const loop = startFrameLoop(screen, async (f) => {
        frames.push(f)
      })
      // x11grab delivers the first frame after about two intervals, then one per interval
      await sleep(10_000)
      await loop.stop()
      expect(frames.length).toBeGreaterThanOrEqual(3)
      for (let i = 1; i < frames.length; i++) {
        const gap = frames[i]!.at.getTime() - frames[i - 1]!.at.getTime()
        expect(gap).toBeGreaterThan(1500)
        expect(gap).toBeLessThan(2500)
      }
      const { data, info } = await sharp(frames[0]!.png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      expect([info.width, info.height]).toEqual([1920, 1080])
      const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
      expect(at(960, 540)).toEqual([255, 0, 0])
      expect(at(1919, 540)).toEqual([255, 0, 0])

      const audio = await startAudioSource()
      try {
        await playTone(stage)
        await sleep(2000)
        expect(audio.levelDb(1000)).toBeGreaterThan(-30)
      } finally {
        await audio.stop()
      }
    } finally {
      await context.close()
    }
  } finally {
    await screen.stop()
    await rm(profileDir, { recursive: true, force: true })
  }
})
