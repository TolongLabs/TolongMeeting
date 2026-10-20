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
    '--no-default-browser-check'
  ]
}

// Chrome shows a 56 px "unsupported command-line flag" infobar above the stage for flags such as
// --disable-blink-features. In the image, the managed policy CommandLineFlagSecurityWarningsEnabled (from
// docker/worker/chrome-policy.json) hides it. A developer host or CI runner has no such policy, so there --test-type
// hides it instead; the worker image never passes it.
const hostOnlyArgs = (): string[] => (process.env.TM_IN_IMAGE === '1' ? [] : ['--test-type'])

// Playwright adds --no-sandbox unless chromiumSandbox is true. Chrome's sandbox needs user namespaces, which Docker
// usually denies, so inside the worker image (TM_IN_IMAGE=1) the sandbox is off and the container is the isolation
// boundary. Everywhere else (a developer host) the sandbox stays on.
const launchOptions = (screen: Screen, extraArgs: string[]) => ({
  channel: 'chrome',
  headless: false,
  chromiumSandbox: process.env.TM_IN_IMAGE !== '1',
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [...chromeArgs(screen), ...hostOnlyArgs(), ...extraArgs]
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
  // muteDeskContext mutes only display-mode browser documents: the stage must be an app window, which is not one.
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

async function launchStage(profileDir: string, screen: Screen, extraArgs: string[]): Promise<Stage> {
  await useSystemTitleBar(profileDir)
  const context = await chromium.launchPersistentContext(profileDir, launchOptions(screen, extraArgs))
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

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Closes a page and logs a failure instead of rejecting. A page that is already closed is not a failure.
async function closePage(page: Page, why: string): Promise<void> {
  try {
    await page.close()
  } catch (error) {
    if (!page.isClosed()) console.error(`[tm-worker] could not close ${why}: ${describe(error)}`)
  }
}

// Every page except the stage is a desk page, muted at once (the page-level mute is the backstop for the context init
// script, which skips documents that do not report display-mode browser). A page opened from the stage window (a popup)
// is muted on creation and then closed, so it never plays and never covers the recorded stage; any other page sits on
// the desk. A page that cannot be muted is closed rather than left audible.
async function guardPage(guard: Guard, page: Page): Promise<void> {
  const { stage, desk } = guard
  const context = stage.context
  try {
    const targetId = await targetIdOf(context, page)
    if (targetId === stage.targetId) return
    await muteDesk(page)
    const { windowId } = await stage.cdp.send('Browser.getWindowForTarget', { targetId })
    const opener = await page.opener()
    const fromStage =
      windowId === stage.windowId || (opener !== null && (await targetIdOf(context, opener)) === stage.targetId)
    if (fromStage || !desk) {
      console.error(`[tm-worker] closed a popup opened by the stage (${originOf(page.url())})`)
      await page.close()
      return
    }
    if (windowId !== desk.windowId) await placeWindow(stage.cdp, targetId, desk.rect)
  } catch (error) {
    if (page.isClosed()) return
    console.error(`[tm-worker] closing a page that could not be guarded: ${describe(error)}`)
    await closePage(page, 'a page that could not be guarded')
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
  guard.stage.context.on('page', (page) => {
    track(guard, page).catch((error) => console.error(`[tm-worker] page guard failed: ${describe(error)}`))
  })
}

// `extraArgs` are more Chrome flags, for tests only (the end-to-end run points Zoom's hosts at a local server with them).
// The worker never passes any: production flags are the list in chromeArgs.
export async function launchBrowser(
  profileDir: string,
  screen: Screen,
  extraArgs: string[] = []
): Promise<{ context: BrowserContext; stage: Page; desk: Page }> {
  const stage = await launchStage(profileDir, screen, extraArgs)
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

/** A tab the worker opened did not land in the desk window; it has been closed, so it never shows on the stage. */
export class TabNotOnDeskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TabNotOnDeskError'
  }
}

/** A tab that must not stay open (it is off the desk, or setting it up failed) could not be closed: it is still open. */
export class TabCloseFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TabCloseFailedError'
  }
}

// The CDP window id of the window that holds `page`.
async function windowIdOf(context: BrowserContext, page: Page): Promise<number> {
  const session = await context.newCDPSession(page)
  try {
    return (await session.send('Browser.getWindowForTarget')).windowId
  } finally {
    await session.detach()
  }
}

// Closes a tab that must not stay open. If it is still open afterwards, throws TabCloseFailedError, so no caller ever
// assumes a tab is gone when it is not.
async function discardTab(page: Page, why: string, cause?: unknown): Promise<void> {
  await closePage(page, why)
  if (!page.isClosed()) throw new TabCloseFailedError(`could not close ${why}: it is still open`, { cause })
}

// Checks whether a CDP window id still belongs to an open window.
async function isWindowAlive(cdp: CDPSession, windowId: number): Promise<boolean> {
  try {
    await cdp.send('Browser.getWindowBounds', { windowId })
    return true
  } catch {
    return false
  }
}

// Opens a tab in the desk window and returns it already muted. Use it for every tab the worker itself opens on the desk.
// Two ways in, one code path: pass the context from launchBrowser (the desk window is the one launchBrowser made), or
// pass a desk Page, with an optional `open` that creates the tab (default: a new tab of the page's context). For a
// launchBrowser context the desk window is always the one launchBrowser recorded: a Page in any other window (the
// stage, a guest stage) is refused before anything is opened. Only a context without a guard (plain Playwright) takes
// the passed Page's own window as the desk. A tab that lands in any other window is closed and TabNotOnDeskError is
// thrown; if it cannot be closed, TabCloseFailedError is thrown instead. Any other failure after the tab opened closes
// the tab too, then rethrows. A launchBrowser context also runs the tab through its page guard; any other context only
// gets the page-level mute. If the desk window was closed, calling openDeskTab with context reopens the desk window.
export async function openDeskTab(context: BrowserContext): Promise<Page>
export async function openDeskTab(desk: Page, open?: () => Promise<Page>): Promise<Page>
export async function openDeskTab(target: BrowserContext | Page, open?: () => Promise<Page>): Promise<Page> {
  const deskPage = 'context' in target ? target : null
  const context = 'context' in target ? target.context() : target
  const guard = guards.get(context)
  let deskWindow: number
  let reopeningWindow = false
  if (guard) {
    if (guard.desk === null) throw new Error('openDeskTab: this browser has no desk window')
    const windowAlive = guard.desk.windowId !== null && (await isWindowAlive(guard.stage.cdp, guard.desk.windowId))
    if (!windowAlive) {
      reopeningWindow = true
      deskWindow = -1
    } else {
      deskWindow = guard.desk.windowId!
      if (deskPage && !deskPage.isClosed() && (await windowIdOf(context, deskPage)) !== deskWindow) {
        throw new Error('openDeskTab: the page is not in the desk window')
      }
    }
  } else if (deskPage && !deskPage.isClosed()) deskWindow = await windowIdOf(context, deskPage)
  else throw new Error('openDeskTab needs a context from launchBrowser')
  const page = await (open ?? (() => context.newPage()))()
  let onDesk: boolean
  try {
    if (guard) await track(guard, page)
    else await muteDesk(page)
    if (page.isClosed()) throw new Error('the new desk tab was closed')
    const windowId = await windowIdOf(context, page)
    if (reopeningWindow && guard?.desk) {
      if (windowId === guard.stage.windowId) throw new Error('the desk opened in the stage window')
      guard.desk.windowId = windowId
      deskWindow = windowId
    }
    onDesk = windowId === deskWindow
  } catch (error) {
    await discardTab(page, 'a desk tab that could not be set up', error)
    throw error
  }
  if (!onDesk) {
    await discardTab(page, 'a tab outside the desk window')
    throw new TabNotOnDeskError('the new tab did not open in the desk window')
  }
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
    const stage = await launchStage(dir, screen, [])
    const browser = stage.context.browser()
    if (!browser) throw new Error('Playwright returned no browser for the guest context')
    browser.once('disconnected', () => {
      removeProfile(dir).catch((error) => console.error(`[tm-worker] ${describe(error)}`))
    })
    const guard: Guard = { stage, desk: null, handled: new WeakMap() }
    guards.set(stage.context, guard)
    watchPages(guard)
    return { browser, stage: stage.page }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
