// Host-side proof of the Task 7 launch path, for machines without openbox, PulseAudio or the worker image.
// It starts a real Xvfb and the installed Chrome. Run it with:
//   TM_HOST_LAUNCH=1 bunx playwright test -c packages/worker/playwright.config.ts --project=host
// What it cannot show (policy, openbox placement, the audio sink) is covered by test/image/launch.spec.ts.
import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchBrowser, launchGuestStage } from '../../src/chrome/launch'
import { startScreen } from '../../src/display/screen'
import { browserCmdline, windowBounds } from '../helpers/image'

test.skip(process.env.TM_HOST_LAUNCH !== '1', 'set TM_HOST_LAUNCH=1 (needs Xvfb and google-chrome)')

const hostDisplay = process.env.TM_HOST_DISPLAY ?? ':98'

test('without openbox, startScreen fails loudly unless the test option allows it', async () => {
  const hasOpenbox = await import('node:child_process').then(({ execFileSync }) => {
    try {
      execFileSync('which', ['openbox'])
      return true
    } catch {
      return false
    }
  })
  test.skip(hasOpenbox, 'openbox is installed here')
  await expect(startScreen({ display: hostDisplay })).rejects.toThrow('cannot start openbox')
})

test('stage and desk windows land on their halves of the screen', async () => {
  test.setTimeout(90_000)
  const previousDisplay = process.env.DISPLAY
  const profileDir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  const screen = await startScreen({ display: hostDisplay, windowManager: 'none' })
  try {
    expect(screen.stage).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(screen.desk).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 })
    expect(process.env.DISPLAY).toBe(hostDisplay)
    const { context, stage, desk } = await launchBrowser(profileDir, screen)
    try {
      expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
      expect(await windowBounds(context, desk)).toEqual({ left: 1920, top: 0, width: 1920, height: 1080 })
      expect(await stage.evaluate(() => navigator.webdriver)).toBe(false)
      const cmd = browserCmdline()
      expect(cmd).not.toContain('--enable-automation')
      expect(cmd).toContain('--app=about:blank')
      expect(cmd).toContain('--deny-permission-prompts')

      // Desk muting: media elements cannot be unmuted and the Web Audio destination is a zero gain node.
      await desk.setContent('<audio id="a"></audio>')
      const muted = await desk.evaluate(async () => {
        const audio = document.getElementById('a') as HTMLAudioElement
        audio.muted = false
        const ctx = new AudioContext()
        const dest = ctx.destination as unknown as GainNode
        return {
          muted: audio.muted,
          gain: dest.gain?.value,
          offline: new OfflineAudioContext(1, 1, 8000).destination.constructor.name
        }
      })
      expect(muted).toEqual({ muted: true, gain: 0, offline: 'AudioDestinationNode' })
      const stageAudio = await stage.evaluate(() => new AudioContext().destination.constructor.name)
      expect(stageAudio).toBe('AudioDestinationNode')
    } finally {
      await context.close()
    }
  } finally {
    await screen.stop()
    if (previousDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = previousDisplay
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('the guest stage sits on the stage rectangle and cleans up its profile', async () => {
  test.setTimeout(90_000)
  const previousDisplay = process.env.DISPLAY
  const screen = await startScreen({ display: hostDisplay, windowManager: 'none' })
  try {
    const { browser, stage } = await launchGuestStage(screen)
    const context = stage.context()
    expect(await windowBounds(context, stage)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
    await browser.close()
    await expect
      .poll(() => readdirSync(tmpdir()).filter((name) => name.startsWith('tm-guest-')), { timeout: 10_000 })
      .toEqual([])
  } finally {
    await screen.stop()
    if (previousDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = previousDisplay
  }
})
