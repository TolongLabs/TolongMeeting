import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { z } from 'zod'
import type { Rect } from '../adapters/types'
import type { Screen } from '../types'
import { muteDesk, muteDeskContext } from './mute'

// Chrome 152 ignores `--app=about:blank` and opens a normal window with tabs, a toolbar and infobars (a 937 px tall
// viewport). App mode needs a URL it accepts, so the stage starts on a data: page.
const STAGE_URL = 'data:text/html,<title>stage</title>'

// Flags from the design (docs/trd/meeting-worker.md) and spike 2 (DESIGN_ARGS in spikes/00-setup/worker/browser.mjs).
export function chromeArgs(screen: Screen): string[] {
  const { x, y, width, height } = screen.stage
  return [
    `--app=${STAGE_URL}`,
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
    '--no-default-browser-check',
    // Without it, Chrome shows a 56 px infobar ("unsupported command-line flag: --no-sandbox") above the stage content
    // in the image, where the sandbox is off.
    '--test-type'
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

const PreferencesSchema = z.record(z.string(), z.unknown())

// Asks Chrome for the system title bar instead of its own frame, so a window manager that draws none (openbox with
// decor=no) leaves the whole window to the page. Merges into an existing Preferences file and keeps its other keys.
// Call it before Chrome starts: Chrome rewrites the file on exit.
export async function useSystemTitleBar(profileDir: string): Promise<void> {
  const file = join(profileDir, 'Default', 'Preferences')
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const prefs = text === null ? {} : PreferencesSchema.parse(JSON.parse(text))
  const browser = prefs.browser === undefined ? {} : PreferencesSchema.parse(prefs.browser)
  await mkdir(join(profileDir, 'Default'), { recursive: true })
  await writeFile(file, JSON.stringify({ ...prefs, browser: { ...browser, custom_chrome_frame: false } }))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const targetIdOf = async (context: BrowserContext, page: Page): Promise<string> => {
  const session = await context.newCDPSession(page)
  try {
    return (await session.send('Target.getTargetInfo')).targetInfo.targetId
  } finally {
    await session.detach()
  }
}

// The Playwright page for a CDP target id.
async function pageForTarget(context: BrowserContext, targetId: string): Promise<Page> {
  const deadline = Date.now() + 10_000
  const checked = new Set<Page>()
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (checked.has(page)) continue
      checked.add(page)
      if ((await targetIdOf(context, page)) === targetId) return page
    }
    await sleep(50)
  }
  throw new Error(`no page for target ${targetId} within 10 s`)
}

// Moves the window of a target to `rect` and returns its window id.
async function placeWindow(cdp: CDPSession, targetId: string, rect: Rect): Promise<number> {
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId })
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: rect.x, top: rect.y, width: rect.width, height: rect.height, windowState: 'normal' }
  })
  return windowId
}

interface Stage {
  context: BrowserContext
  /** Browser-level CDP session; it lives as long as the browser. */
  cdp: CDPSession
  page: Page
  targetId: string
  windowId: number
}

// The stage is the --app window Chrome opens itself: the one page target on the stage URL.
async function findStageTarget(cdp: CDPSession): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets')
    const stages = targetInfos.filter((t) => t.type === 'page' && t.url.startsWith('data:text/html,'))
    if (stages.length > 1) throw new Error(`expected one --app stage target, found ${stages.length}`)
    if (stages.length === 1) return stages[0]!.targetId
    await sleep(50)
  }
  throw new Error('Chrome did not open the --app stage window within 10 s')
}

// The page content area must be exactly the stage rectangle: that is what gets recorded.
async function requireStageViewport(page: Page, stage: Rect): Promise<void> {
  // muteDeskContext tells the stage from the desk by display mode: the stage must be an app window.
  if (!(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)))
    throw new Error('the stage is not an app-mode window (display-mode is not standalone)')
  const want = [stage.width, stage.height, stage.x, stage.y]
  const deadline = Date.now() + 5_000
  let got: number[] = []
  while (Date.now() < deadline) {
    got = await page.evaluate(() => [innerWidth, innerHeight, screenX, screenY])
    if (got.every((v, i) => v === want[i])) return
    await sleep(50)
  }
  throw new Error(`the stage viewport is ${got.join(',')} (width,height,x,y), expected ${want.join(',')}`)
}

async function launchStage(profileDir: string, screen: Screen): Promise<Stage> {
  await useSystemTitleBar(profileDir)
  const context = await chromium.launchPersistentContext(profileDir, launchOptions(screen))
  try {
    const browser = context.browser()
    if (!browser) throw new Error('Playwright returned no browser for the persistent context')
    const cdp = await browser.newBrowserCDPSession()
    const targetId = await findStageTarget(cdp)
    const page = await pageForTarget(context, targetId)
    const windowId = await placeWindow(cdp, targetId, screen.stage)
    await requireStageViewport(page, screen.stage)
    return { context, cdp, page, targetId, windowId }
  } catch (error) {
    await context.close()
    throw error
  }
}

interface Guard {
  stage: Stage
  /** Null for the guest stage, which has no desk: any other page is closed. */
  desk: { rect: Rect; windowId: number | null } | null
  handled: WeakMap<Page, Promise<void>>
}

const guards = new WeakMap<BrowserContext, Guard>()

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return 'unknown'
  }
}

// Every page except the stage is a desk page. A page opened from the stage window (a popup) is closed so it never
// covers the recorded stage; any other page is muted and sits on the desk. A page that cannot be muted is closed rather
// than left audible.
async function guardPage(guard: Guard, page: Page): Promise<void> {
  const { stage, desk } = guard
  const context = stage.context
  try {
    const targetId = await targetIdOf(context, page)
    if (targetId === stage.targetId) return
    const { windowId } = await stage.cdp.send('Browser.getWindowForTarget', { targetId })
    const opener = await page.opener()
    const fromStage =
      windowId === stage.windowId || (opener !== null && (await targetIdOf(context, opener)) === stage.targetId)
    if (fromStage || !desk) {
      console.error(`[tm-worker] closed a popup opened by the stage (${originOf(page.url())})`)
      await page.close()
      return
    }
    await muteDesk(page)
    if (windowId !== desk.windowId) await placeWindow(stage.cdp, targetId, desk.rect)
  } catch (error) {
    if (page.isClosed()) return
    console.error(
      `[tm-worker] closing a page that could not be guarded: ${error instanceof Error ? error.message : error}`
    )
    await page.close()
  }
}

function track(guard: Guard, page: Page): Promise<void> {
  let handled = guard.handled.get(page)
  if (!handled) {
    handled = guardPage(guard, page)
    guard.handled.set(page, handled)
  }
  return handled
}

function watchPages(guard: Guard): void {
  guard.stage.context.on('page', (page) => void track(guard, page))
}

export async function launchBrowser(
  profileDir: string,
  screen: Screen
): Promise<{ context: BrowserContext; stage: Page; desk: Page }> {
  const stage = await launchStage(profileDir, screen)
  const { context, cdp } = stage
  try {
    const guard: Guard = { stage, desk: { rect: screen.desk, windowId: null }, handled: new WeakMap() }
    guards.set(context, guard)
    await muteDeskContext(context)
    watchPages(guard)
    // The first tabbed window: Chrome puts every later context.newPage() tab into it, as the stage is an app window.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    const desk = await pageForTarget(context, targetId)
    await track(guard, desk)
    guard.desk!.windowId = await placeWindow(cdp, targetId, screen.desk)
    if (guard.desk!.windowId === stage.windowId) throw new Error('the desk opened in the stage window')
    return { context, stage: stage.page, desk }
  } catch (error) {
    await context.close()
    throw error
  }
}

// Opens a tab in the desk window and returns it already muted. Use it for every tab the worker itself opens on the desk.
export async function openDeskTab(context: BrowserContext): Promise<Page> {
  const guard = guards.get(context)
  if (!guard?.desk || guard.desk.windowId === null) throw new Error('openDeskTab needs a context from launchBrowser')
  const page = await context.newPage()
  await track(guard, page)
  if (page.isClosed()) throw new Error('the new desk tab was closed')
  const { windowId } = await guard.stage.cdp.send('Browser.getWindowForTarget', {
    targetId: await targetIdOf(context, page)
  })
  if (windowId !== guard.desk.windowId) throw new Error('the new tab did not open in the desk window')
  return page
}

// Chrome may still be flushing files when the connection drops, and may recreate files after the first removal, so
// remove until the directory stays gone.
async function removeProfile(dir: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    await sleep(300)
    if (!existsSync(dir)) return
    if (Date.now() > deadline) throw new Error(`could not remove the guest profile ${dir}`)
  }
}

// A throw-away profile on the stage, for the Zoom guest fallback. Playwright's non-persistent launch cannot see the
// --app window, so this uses a persistent context on a temporary directory that is removed when the browser closes.
export async function launchGuestStage(screen: Screen): Promise<{ browser: Browser; stage: Page }> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-guest-'))
  try {
    const stage = await launchStage(dir, screen)
    const browser = stage.context.browser()
    if (!browser) throw new Error('Playwright returned no browser for the guest context')
    browser.once('disconnected', () => void removeProfile(dir))
    watchPages({ stage, desk: null, handled: new WeakMap() })
    return { browser, stage: stage.page }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
