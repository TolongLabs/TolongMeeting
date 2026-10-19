// Runs in the worker image only (needs Xvfb, openbox, Chrome and the tm_sink PulseAudio sink):
//   docker run --rm --shm-size=2g tm-worker:dev test launch.spec.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchBrowser } from '../../src/chrome/launch'
import { startScreen } from '../../src/display/screen'
import { browserCmdline, playTone, sinkLevelDb, windowBounds } from '../helpers/image'

test.skip(process.env.TM_IN_IMAGE !== '1', 'needs the worker image')

test('stage and desk split, no automation flag, devices denied, desk muted', async () => {
  test.setTimeout(90_000)
  const profileDir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  const screen = await startScreen()
  try {
    const { context, stage, desk } = await launchBrowser(profileDir, screen)
    try {
      expect(await stage.evaluate(() => [innerWidth, innerHeight, navigator.webdriver])).toEqual([1920, 1080, false])
      expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
      expect(await windowBounds(context, desk)).toEqual({ left: 1920, top: 0, width: 1920, height: 1080 })
      expect(browserCmdline()).not.toContain('--enable-automation')
      expect(
        await stage.evaluate(() =>
          navigator.mediaDevices.getUserMedia({ audio: true }).then(
            () => 'ok',
            (e) => e.name
          )
        )
      ).toBe('NotAllowedError')
      await playTone(desk)
      expect(await sinkLevelDb(3000)).toBeLessThan(-60)
      await playTone(stage)
      expect(await sinkLevelDb(3000)).toBeGreaterThan(-30)
      expect(await stage.goto('file:///etc/hostname').catch((e) => String(e))).toContain('ERR_BLOCKED_BY_ADMINISTRATOR')
    } finally {
      await context.close()
    }
  } finally {
    await screen.stop()
    await rm(profileDir, { recursive: true, force: true })
  }
})
