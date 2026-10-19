// Form tabs on a real launchBrowser desk: muted, in the desk window, never in the stage window. Needs Xvfb and Chrome:
//   TM_HOST_LAUNCH=1 bunx playwright test -c packages/worker/playwright.config.ts form-open-host --project=host
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchBrowser, launchGuestStage } from '../../src/chrome/launch'
import { startScreen } from '../../src/display/screen'
import { driverFor } from '../../src/forms/drivers'
import { TabNotOnDeskError, openDeskTab, openForm } from '../../src/forms/open'
import { googleUrl, routeFormFixtures } from '../forms/route'

test.skip(process.env.TM_HOST_LAUNCH !== '1', 'set TM_HOST_LAUNCH=1 (needs Xvfb and google-chrome)')

const windowOf = async (p: Page) =>
  (await (await p.context().newCDPSession(p)).send('Browser.getWindowForTarget')).windowId

test('a form opens in a muted desk tab, never in the stage window', async () => {
  test.setTimeout(120_000)
  const dir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  const screen = await startScreen({ windowManager: 'none' })
  try {
    const { context, stage, desk } = await launchBrowser(dir, screen)
    try {
      const fx = await routeFormFixtures(context)
      const driver = await driverFor('google')
      const tab = await openDeskTab(context)
      expect(await openForm(tab, googleUrl('attendance'), driver)).toBe('form')
      expect(await windowOf(tab)).toBe(await windowOf(desk))
      expect(await windowOf(tab)).not.toBe(await windowOf(stage))
      expect(await tab.evaluate(() => Symbol.for('tm.deskMuted') in window)).toBe(true)
      expect(fx.requests).toEqual([googleUrl('attendance')])

      // the Page form of openDeskTab uses the same guard and the same window check
      const second = await openDeskTab(desk)
      expect(await windowOf(second)).toBe(await windowOf(desk))
      expect(await second.evaluate(() => Symbol.for('tm.deskMuted') in window)).toBe(true)
      const before = context.pages().length
      const popup = async () => {
        const [p] = await Promise.all([
          desk.waitForEvent('popup'),
          desk.evaluate(() => window.open('about:blank', '_blank', 'popup,left=2000,top=0,width=600,height=400'))
        ])
        return p
      }
      await expect(openDeskTab(desk, popup)).rejects.toThrow(TabNotOnDeskError)
      expect(context.pages()).toHaveLength(before)

      // a Page that is not in the desk window (the stage) is refused before anything is opened
      await expect(openDeskTab(stage)).rejects.toThrow(/not in the desk window/)
      expect(context.pages()).toHaveLength(before)
    } finally {
      await context.close()
    }

    // a guest stage has no desk: nothing is opened there
    const guest = await launchGuestStage(screen)
    try {
      const guestContext = guest.stage.context()
      const guestPages = guestContext.pages().length
      await expect(openDeskTab(guest.stage)).rejects.toThrow(/no desk window/)
      expect(guestContext.pages()).toHaveLength(guestPages)
    } finally {
      await guest.browser.close()
    }
  } finally {
    await screen.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
