import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import { isTimeout, LeaveIncomplete, leaveWithFallback, RACE_POLL_MS, settled, shown, STEP_TIMEOUT_MS } from '../common'
import { dismissNotices } from '../notices'
import { DevicesOnError } from '../types'
import { navigationGuard } from '../zoom/root'
import { logStep } from './join'
import type { MeetSelectors } from './selectors'
import { meetTextSignal } from './text'

const AUDIO_TIMEOUT_MS = 10_000
const CONFIRM_TIMEOUT_MS = 2_000
const LEAVE_TIMEOUT_MS = 15_000

// Throws DevicesOnError when the microphone or camera might be live: every visible control matching the toggle selector
// must also match its "off" selector. One live toggle fails the check even when another element (a participant's muted
// tile, say) reads off. A control that is not on screen is reported by name, a live one by its aria-label. Fails
// closed: a permission-denied button without the muted attribute matches no toggle and counts as missing until the live
// client shows what it looks like (plan 05 P5-12). Clicks nothing.
export async function assertMeetDevicesOff(page: Page, sel: MeetSelectors): Promise<void> {
  const { selectors } = sel
  const live = await settled(navigationGuard('devicesOff', 'meet'), async () => {
    const labels: string[] = []
    for (const [name, control, off] of [
      ['microphone', selectors.micToggle, selectors.micOff],
      ['camera', selectors.cameraToggle, selectors.cameraOff]
    ] as const) {
      const toggles = await page
        .locator(control)
        .filter({ visible: true })
        .evaluateAll(
          (els, offCss) => els.map((el) => ({ off: el.matches(offCss), label: el.getAttribute('aria-label') })),
          off
        )
      if (toggles.length === 0) labels.push(`${name} control not found`)
      for (const toggle of toggles) if (!toggle.off) labels.push(toggle.label ?? name)
    }
    return labels
  })
  if (live.length > 0) throw new DevicesOnError(live)
}

// Clicks the visible allowlist buttons (Got it, OK, Dismiss) and returns their texts, in page order. It fails closed: a
// button is clicked only inside a recognised notice container, and never when the notice's text matches the breakout
// prompt or a noticeDanger pattern (join, start video, allow, unmute, share, record consent). Such a prompt is the
// supervisor's to report, not to answer. The side panel (chat, people) is never searched. Only allowlisted button texts
// and the name of the matched pattern are logged, never the notice's text.
export function dismissMeetNotices(page: Page, sel: MeetSelectors): Promise<string[]> {
  const { selectors, texts } = sel
  return dismissNotices(page, 'meet', {
    container: selectors.noticeContainers,
    excluded: selectors.sidePanel,
    allowlist: sel.noticeAllowlist,
    danger: [{ name: 'breakout', source: texts.breakoutPrompt }, ...texts.noticeDanger]
  })
}

// Meet has no output control to click: call audio plays through the page's audio elements. Waits for one to exist and
// throws when none does. Clicks nothing. Whether sound reaches the sink is checked afterwards, by 01a.
export async function connectMeetOutputAudio(page: Page, _sel: MeetSelectors): Promise<void> {
  const until = Date.now() + AUDIO_TIMEOUT_MS
  const found = await settled(navigationGuard('outputAudio', 'meet'), async () => {
    const left = until - Date.now()
    if (left <= 0) return (await page.locator('audio').count()) > 0
    return page
      .locator('audio')
      .first()
      .waitFor({ state: 'attached', timeout: left })
      .then(
        () => true,
        (error: unknown) => {
          if (isTimeout(error)) return false
          throw error
        }
      )
  })
  if (!found) throw new Error('meet: no meeting audio element')
}

// Clicks Leave. A host's Leave opens a dialog: its "Just leave the call" button is clicked and "End the call for
// everyone" never. Then waits for the end screen. When the page fails any of that (no Leave button, no end screen in
// time), the page is closed instead, which drops the call; any other error closes the page too and is then rethrown.
// Only the error's name is logged, never its message, which can quote the page.
export function leaveMeet(page: Page, sel: MeetSelectors): Promise<void> {
  return leaveWithFallback(page, 'meet', () => clickLeave(page, sel))
}

async function clickLeave(page: Page, sel: MeetSelectors): Promise<void> {
  const { selectors, texts } = sel
  await shown(page, selectors.leaveButton).click({ timeout: STEP_TIMEOUT_MS })
  logStep('click leaveButton')
  // The confirmation is looked for inside notice containers only, and only by the anchored "just leave" text.
  const confirm = page
    .locator(selectors.noticeContainers)
    .locator('button, [role="button"]')
    .filter({ visible: true, hasText: new RegExp(texts.leaveConfirm, 'i') })
    .first()
  const asked = await confirm.waitFor({ state: 'visible', timeout: CONFIRM_TIMEOUT_MS }).then(
    () => true,
    (error: unknown) => {
      if (isTimeout(error)) return false
      throw error
    }
  )
  if (asked) {
    await confirm.click({ timeout: STEP_TIMEOUT_MS })
    logStep('click leaveConfirm')
  }
  const until = Date.now() + LEAVE_TIMEOUT_MS
  await settled(navigationGuard('leave', 'meet'), async () => {
    while (Date.now() < until) {
      if ((await meetTextSignal(page, sel, texts.ended)) || (await meetTextSignal(page, sel, texts.endScreen)))
        return true
      await sleep(RACE_POLL_MS)
    }
    throw new LeaveIncomplete('meet')
  })
}
