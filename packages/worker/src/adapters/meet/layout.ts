import type { Page } from 'playwright'
import { shown, withPanel } from '../common'
import type { Rect } from '../types'
import { logStep } from './join'
import { meetState } from './page-state'
import type { MeetSelectors } from './selectors'

const STEP_TIMEOUT_MS = 10_000

// The first integer in the People button's text, else in its aria-label, else null. Reads only: never clicks.
export async function meetParticipantCount(page: Page, sel: MeetSelectors): Promise<number | null> {
  const button = await page.evaluate((selector) => {
    const el = document.querySelector(selector)
    return el ? { text: el.textContent ?? '', label: el.getAttribute('aria-label') ?? '' } : null
  }, sel.selectors.peopleButton)
  if (!button) return null
  const digits = /\d+/.exec(button.text)?.[0] ?? /\d+/.exec(button.label)?.[0]
  return digits === undefined ? null : Number(digits)
}

// Turns captions off when they are on (never on), opens the chat panel when it is not on screen, then, once per share,
// spotlights the shared screen through More options, Adjust view and the Spotlight option. It never clicks anything else:
// a missing menu item is a fault, not a reason to pick another control. It runs under the page's panel lock, so it never
// interleaves with a role read or a chat sweep (both take the same lock).
export function ensureMeetLayout(page: Page, sel: MeetSelectors): Promise<void> {
  return withPanel(page, () => layoutNow(page, sel))
}

async function layoutNow(page: Page, sel: MeetSelectors): Promise<void> {
  const { selectors, texts } = sel
  const state = meetState(page)
  if (await shown(page, selectors.captionsOnButton).isVisible()) {
    await shown(page, selectors.captionsOnButton).click({ timeout: STEP_TIMEOUT_MS })
    logStep('click captionsOnButton')
  }
  if (!(await shown(page, selectors.chatScroller).isVisible())) {
    await shown(page, selectors.chatButton).click({ timeout: STEP_TIMEOUT_MS })
    logStep('click chatButton')
    await shown(page, selectors.chatScroller).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  }
  if (!(await shown(page, selectors.sharedScreen).isVisible())) {
    state.shareSeen = false
    return
  }
  if (state.shareSeen) return
  await shown(page, selectors.moreButton).click({ timeout: STEP_TIMEOUT_MS })
  logStep('click moreButton')
  await page
    .locator(selectors.menu)
    .locator(selectors.menuItem)
    .filter({ hasText: new RegExp(texts.layoutMenu, 'i'), visible: true })
    .first()
    .click({ timeout: STEP_TIMEOUT_MS })
  logStep('click layout menu item')
  const spotlight = page
    .locator(selectors.radio)
    .filter({ hasText: new RegExp(texts.spotlight, 'i'), visible: true })
    .first()
  // The dialog that holds the Spotlight option, so Close never lands on another dialog's or the side panel's.
  const dialog = page.locator(selectors.dialog).filter({ has: spotlight, visible: true }).first()
  await spotlight.click({ timeout: STEP_TIMEOUT_MS })
  logStep('click spotlight')
  await dialog.locator(selectors.dialogClose).filter({ visible: true }).first().click({ timeout: STEP_TIMEOUT_MS })
  logStep('click dialog close')
  await dialog.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
  state.shareSeen = true
}

// The picture inside the first visible shared-screen element: its box shrunk to the intrinsic size (videoWidth/Height),
// contain-fitted and centred, rounded to whole pixels, in stage coordinates (Meet is not framed and does not scroll, so
// these are the page's). An element with no picture yet (zero intrinsic size) is passed over. Null when no share is
// visible, so the caller falls back to its brightness crop.
export async function meetSharedScreenRegion(page: Page, sel: MeetSelectors): Promise<Rect | null> {
  const box = await page.evaluate((selector) => {
    for (const el of document.querySelectorAll<HTMLVideoElement>(selector)) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue
      const { x, y, width, height } = el.getBoundingClientRect()
      if (width <= 0 || height <= 0) continue
      const iw = el.videoWidth
      const ih = el.videoHeight
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
