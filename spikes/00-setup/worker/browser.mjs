import { chromium } from 'playwright'

export const DESIGN_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--autoplay-policy=no-user-gesture-required',
  '--password-store=basic',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding'
]

async function windowOf(context, page) {
  const cdp = await context.newCDPSession(page)
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    return { cdp, windowId }
  } catch (e) {
    await cdp.detach()
    throw e
  }
}

async function place(context, page, left) {
  const { cdp, windowId } = await windowOf(context, page)
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left, top: 0, width: 1920, height: 1080, windowState: 'normal' }
  })
  const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId })
  await cdp.detach()
  return { windowId, bounds }
}

export async function openDeskTab(context, url, initScripts = []) {
  const page = await context.newPage()
  for (const s of initScripts) await page.addInitScript(s)
  await page.goto(url)
  return page
}

export async function launchSpikeBrowser({
  profileDir = '/profile',
  stageUrl,
  deskUrls = ['about:blank'],
  extraArgs = [],
  deskInitScripts = []
}) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [...DESIGN_ARGS, ...extraArgs, `--app=${stageUrl}`, '--window-position=0,0', '--window-size=1920,1080']
  })
  const stage = context.pages()[0] ?? (await context.waitForEvent('page'))
  await stage.waitForLoadState('domcontentloaded')
  const stageWin = await place(context, stage, 0)

  const desks = []
  const [first, ...rest] = deskUrls
  const deskFirst = await context.newPage()
  for (const s of deskInitScripts) await deskFirst.addInitScript(s)
  await deskFirst.goto(first)
  desks.push(deskFirst)
  const deskWin = await place(context, deskFirst, 1920)
  if (deskWin.windowId === stageWin.windowId) throw new Error('desk opened in stage window')
  for (const url of rest) desks.push(await openDeskTab(context, url, deskInitScripts))
  for (const d of desks) {
    const { windowId } = await windowOf(context, d).then(async (w) => {
      await w.cdp.detach()
      return w
    })
    if (windowId === stageWin.windowId) throw new Error('desk opened in stage window')
  }
  context.tmBounds = { stageBounds: stageWin.bounds, deskBounds: deskWin.bounds }
  return { context, stage, desks }
}
