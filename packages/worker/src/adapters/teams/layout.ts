import type { Page } from 'playwright'
import type { Rect } from '../types'
import { logStep, shown } from './join'
import { teamsState } from './page-state'
import type { TeamsSelectors } from './selectors'

const STEP_TIMEOUT_MS = 10_000

// The first integer in the People button's text, else in its aria-label, else null. Reads only: never clicks.
export async function teamsParticipantCount(page: Page, sel: TeamsSelectors): Promise<number | null> {
  const button = await page.evaluate((selector) => {
    const el = document.querySelector(selector)
    return el ? { text: el.textContent ?? '', label: el.getAttribute('aria-label') ?? '' } : null
  }, sel.selectors.rosterButton)
  if (!button) return null
  const digits = /\d+/.exec(button.text)?.[0] ?? /\d+/.exec(button.label)?.[0]
  return digits === undefined ? null : Number(digits)
}

// Opens the chat panel when it is not on screen, then, once per share, switches the View menu to "Focus on content" so
// the shared screen fills the stage. It clicks nothing else: a missing menu item is a fault, not a reason to pick another.
export async function ensureTeamsLayout(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors, texts } = sel
  const state = teamsState(page)
  if (!(await shown(page, selectors.chatPane).isVisible())) {
    await shown(page, selectors.chatButton).click({ timeout: STEP_TIMEOUT_MS })
    logStep('click chatButton')
    await shown(page, selectors.chatPane).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  }
  if (!(await shown(page, selectors.sharedScreen).isVisible())) {
    state.shareSeen = false
    return
  }
  if (state.shareSeen) return
  await shown(page, selectors.viewButton).click({ timeout: STEP_TIMEOUT_MS })
  logStep('click viewButton')
  const focus = page
    .locator(selectors.menu)
    .locator(selectors.menuItem)
    .filter({ hasText: new RegExp(texts.focusOnContent, 'i'), visible: true })
    .first()
  await focus.click({ timeout: STEP_TIMEOUT_MS })
  logStep('click focus on content')
  state.shareSeen = true
}

// The picture inside the first visible shared-screen element: its box shrunk to the intrinsic size (videoWidth/Height for
// a video, width/height for a canvas), contain-fitted and centred, in viewport coordinates, rounded to whole pixels. An
// element with no picture yet (zero intrinsic size) is passed over. Null when no share is visible, so the caller falls
// back to its brightness crop.
export async function teamsSharedScreenRegion(page: Page, sel: TeamsSelectors): Promise<Rect | null> {
  const box = await page.evaluate((selector) => {
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue
      const { x, y, width, height } = el.getBoundingClientRect()
      if (width <= 0 || height <= 0) continue
      const [iw, ih] =
        el instanceof HTMLVideoElement
          ? [el.videoWidth, el.videoHeight]
          : [(el as HTMLCanvasElement).width, (el as HTMLCanvasElement).height]
      if (iw <= 0 || ih <= 0) continue
      const scale = Math.min(width / iw, height / ih)
      const w = iw * scale
      const h = ih * scale
      return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h }
    }
    return null
  }, sel.selectors.sharedScreen)
  if (!box) return null
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  }
}
