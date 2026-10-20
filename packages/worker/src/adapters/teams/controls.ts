import type { Page } from 'playwright'
import { isTimeout, leaveWithFallback, settled, shown, STEP_TIMEOUT_MS } from '../common'
import { dismissNotices } from '../notices'
import { DevicesOnError } from '../types'
import { navigationGuard } from '../zoom/root'
import { logStep } from './join'
import type { TeamsSelectors } from './selectors'

const MENU_TIMEOUT_MS = 2_000
const AUDIO_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 15_000

// Throws DevicesOnError when the microphone or camera might be live: a control whose "off" form is not on screen is
// reported by its aria-label, a missing control by name. Clicks nothing.
export async function assertTeamsDevicesOff(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors } = sel
  const live = await settled(navigationGuard('devicesOff', 'teams'), async () => {
    const labels: string[] = []
    for (const [name, control, off] of [
      ['microphone', selectors.micButton, selectors.micOff],
      ['camera', selectors.cameraButton, selectors.cameraOff]
    ] as const) {
      if (await shown(page, off).isVisible()) continue
      const button = shown(page, control)
      if (!(await button.isVisible())) labels.push(`${name} control not found`)
      else labels.push((await button.getAttribute('aria-label', { timeout: STEP_TIMEOUT_MS })) ?? name)
    }
    return labels
  })
  if (live.length > 0) throw new DevicesOnError(live)
}

// Clicks the visible allowlist buttons (Got it, OK, Dismiss) and returns their texts, in page order. It fails closed: a
// button is clicked only inside a recognised notice container, and never when the notice's text matches the breakout
// prompt or a noticeDanger pattern (join, start video, allow, unmute, share, record consent). Such a prompt is the
// supervisor's to report, not to answer. The chat and people panes are never searched. Only allowlisted button texts and
// the name of the matched pattern are logged, never the notice's text.
export function dismissTeamsNotices(page: Page, sel: TeamsSelectors): Promise<string[]> {
  const { selectors, texts } = sel
  return dismissNotices(page, 'teams', {
    container: selectors.noticeContainers,
    excluded: [selectors.chatPane, selectors.rosterPane].join(', '),
    allowlist: sel.noticeAllowlist,
    danger: [{ name: 'breakout', source: texts.breakoutPrompt }, ...sel.noticeDanger]
  })
}

// Turns incoming audio back on when Teams has it off: More, then the "turn on incoming audio" menu item. It never
// touches the device controls or any other menu item. Does nothing when the banner is not showing. Whether sound
// reaches the sink is checked afterwards, by 01a.
export async function connectTeamsOutputAudio(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors, texts } = sel
  const item = page
    .locator(selectors.menu)
    .filter({ visible: true })
    .locator(selectors.menuItem)
    .filter({ hasText: new RegExp(texts.incomingAudioOn, 'i') })
    .first()
  // Re-checks the page each time, so a navigation under it never clicks More twice and closes the menu it opened.
  const turnedOn = await settled(navigationGuard('incomingAudio', 'teams'), async () => {
    if (!(await shown(page, selectors.incomingAudioOff).isVisible())) return false
    if (!(await item.isVisible())) {
      await shown(page, selectors.moreButton).click({ timeout: STEP_TIMEOUT_MS })
      logStep('click moreButton')
    }
    await item.click({ timeout: STEP_TIMEOUT_MS })
    logStep('click incomingAudioOn')
    return true
  })
  if (turnedOn)
    await page.locator(selectors.incomingAudioOff).first().waitFor({ state: 'hidden', timeout: AUDIO_TIMEOUT_MS })
}

// Clicks Leave. An organiser's Leave opens a menu: its "Leave" item is clicked and "End meeting" never. Then waits for
// the end screen. When the page fails any of that (no Leave button, no end screen in time), the page is closed instead,
// which drops the call; any other error closes the page too and is then rethrown. Only the error's name is logged,
// never its message, which can quote the page.
export function leaveTeams(page: Page, sel: TeamsSelectors): Promise<void> {
  return leaveWithFallback(page, 'teams', () => clickLeave(page, sel))
}

async function clickLeave(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors, texts } = sel
  await shown(page, selectors.hangupButton).click({ timeout: STEP_TIMEOUT_MS })
  logStep('click hangupButton')
  const menu = page.locator(selectors.menu).filter({ visible: true }).first()
  const opened = await menu.waitFor({ state: 'visible', timeout: MENU_TIMEOUT_MS }).then(
    () => true,
    (error: unknown) => {
      if (isTimeout(error)) return false
      throw error
    }
  )
  if (opened) {
    await menu
      .locator(selectors.hangupMenuItem)
      .filter({ hasText: new RegExp(texts.hangupLeave, 'i') })
      .first()
      .click({ timeout: STEP_TIMEOUT_MS })
    logStep('click hangupLeave')
  }
  const until = Date.now() + LEAVE_TIMEOUT_MS
  await settled(navigationGuard('leave', 'teams'), async () => {
    await page
      .locator(selectors.endScreen)
      .first()
      .waitFor({ state: 'visible', timeout: Math.max(1, until - Date.now()) })
    return true
  })
}
