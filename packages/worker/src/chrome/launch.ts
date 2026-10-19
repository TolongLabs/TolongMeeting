import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { Rect } from '../adapters/types'
import type { Screen } from '../types'
import { muteDesk } from './mute'

// Flags from the design (docs/trd/meeting-worker.md) and spike 2 (DESIGN_ARGS in spikes/00-setup/worker/browser.mjs).
export function chromeArgs(screen: Screen): string[] {
  const { x, y, width, height } = screen.stage
  return [
    '--app=about:blank',
    `--window-position=${x},${y}`,
    `--window-size=${width},${height}`,
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--password-store=basic',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--deny-permission-prompts',
    '--no-first-run',
    '--no-default-browser-check'
  ]
}

// Playwright adds --no-sandbox unless chromiumSandbox is true. Chrome's sandbox needs user namespaces, which Docker
// usually denies, so inside the worker image (TM_IN_IMAGE=1) the sandbox is off and the container is the isolation
// boundary. Everywhere else (a developer host) the sandbox stays on.
const launchOptions = (screen: Screen) => ({
  channel: 'chrome',
  headless: false,
  chromiumSandbox: process.env.TM_IN_IMAGE !== '1',
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: chromeArgs(screen)
})

// Moves the window that holds `page` to `rect` and returns its window id.
async function placeWindow(context: BrowserContext, page: Page, rect: Rect): Promise<number> {
  const cdp = await context.newCDPSession(page)
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: rect.x, top: rect.y, width: rect.width, height: rect.height, windowState: 'normal' }
    })
    return windowId
  } finally {
    await cdp.detach()
  }
}

async function firstPage(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.waitForEvent('page'))
  await page.waitForLoadState('domcontentloaded')
  return page
}

// Opens `about:blank` in a new window (not a tab of the stage window).
async function openWindow(context: BrowserContext, from: Page): Promise<Page> {
  const cdp = await context.newCDPSession(from)
  try {
    const opened = context.waitForEvent('page')
    await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    return await opened
  } finally {
    await cdp.detach()
  }
}

export async function launchBrowser(
  profileDir: string,
  screen: Screen
): Promise<{ context: BrowserContext; stage: Page; desk: Page }> {
  const context = await chromium.launchPersistentContext(profileDir, launchOptions(screen))
  try {
    const stage = await firstPage(context)
    const stageWindow = await placeWindow(context, stage, screen.stage)
    const desk = await openWindow(context, stage)
    const deskWindow = await placeWindow(context, desk, screen.desk)
    if (deskWindow === stageWindow) throw new Error('the desk opened in the stage window')
    await muteDesk(desk)
    return { context, stage, desk }
  } catch (error) {
    await context.close()
    throw error
  }
}

// A throw-away profile on the stage, for the Zoom guest fallback. Playwright's non-persistent launch cannot see the
// --app window, so this uses a persistent context on a temporary directory that is removed when the browser closes.
export async function launchGuestStage(screen: Screen): Promise<{ browser: Browser; stage: Page }> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-guest-'))
  const context = await chromium.launchPersistentContext(dir, launchOptions(screen))
  const browser = context.browser()
  try {
    if (!browser) throw new Error('Playwright returned no browser for the guest context')
    // Chrome may still be flushing files when the connection drops, so retry the removal.
    browser.once('disconnected', () => void rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
    const stage = await firstPage(context)
    await placeWindow(context, stage, screen.stage)
    return { browser, stage }
  } catch (error) {
    await context.close()
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
