// Runs in the worker image only (needs Xvfb, openbox, Chrome and the tm_sink PulseAudio sink):
//   docker run --rm --shm-size=2g tm-worker:dev test launch.spec.ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchBrowser, openDeskTab } from '../../src/chrome/launch'
import { startScreen } from '../../src/display/screen'
import { browserCmdline, expectStageFilled, playTone, sinkLevelDb, windowBounds } from '../helpers/image'

test.skip(process.env.TM_IN_IMAGE !== '1', 'needs the worker image')

test('stage and desk split, no automation flag, devices denied, every desk page muted', async () => {
  test.setTimeout(120_000)
  const profileDir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  const screen = await startScreen()
  try {
    const { context, stage, desk } = await launchBrowser(profileDir, screen)
    try {
      // The content area is exactly the stage rectangle: no Chrome frame, infobar or window-manager decoration.
      expect(await stage.evaluate(() => [innerWidth, innerHeight, screenX, screenY, navigator.webdriver])).toEqual([
        1920,
        1080,
        0,
        0,
        false
      ])
      expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
      expect(await windowBounds(context, desk)).toEqual({ left: 1920, top: 0, width: 1920, height: 1080 })
      await expectStageFilled(stage, screen.display)
      expect(browserCmdline(profileDir)).not.toContain('--enable-automation')
      expect(
        await stage.evaluate(() =>
          navigator.mediaDevices.getUserMedia({ audio: true }).then(
            () => 'ok',
            (e) => e.name
          )
        )
      ).toBe('NotAllowedError')

      // The real sink: tones on the desk (first tab, a new desk tab, a popup) are silent, the stage's is not.
      await playTone(desk)
      expect(await sinkLevelDb(3000)).toBeLessThan(-60)
      const tab = await openDeskTab(context)
      await playTone(tab)
      expect(await sinkLevelDb(3000)).toBeLessThan(-60)
      await desk.setContent(`<button id="b" onclick="window.open('about:blank')">open</button>`)
      const opened = context.waitForEvent('page')
      await desk.click('#b')
      const popup = await opened
      await playTone(popup)
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
