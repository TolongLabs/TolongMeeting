import { setTimeout as sleep } from 'node:timers/promises'
import type { Locator, Page } from 'playwright'
import { DeviceControlMissing, isTimeout, shown, stepTimeout } from '../common'
import type { JoinResult } from '../types'
import { navigationGuard } from '../zoom/root'
import type { MeetSelectors } from './selectors'
import { meetTextSignal } from './text'

const JOIN_POLL_MS = 500
// How long the toggles get to show "off" after their click before the join gives up on them.
const TOGGLE_SETTLE_MS = 2_000
const MAX_PERMISSION_CLICKS = 3
const MEET_HOST = 'meet.google.com'

// Steps are logged by name only: page text can hold names, meeting titles and chat.
export function logStep(step: string): void {
  console.info(`meet: ${step}`)
}

export { shown }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Starts on the page the caller has opened at the normalised link and never navigates itself. Every 500 ms it
// classifies the page and acts on the first rule that matches. The only controls it clicks are the permission
// dialog's "continue without" button, the microphone and camera toggles (only to turn them off) and one join button
// named in `joinButtons` ("Join now", "Join here too", "Ask to join"). It never clicks "Switch here", "Present" or
// "Use Companion mode", and it never types: an anonymous pre-join is refused, not filled in.
//
// The wording, attributes and flow are guesses from config/selectors/meet.json and the fixtures in
// test/fixtures/meet; none of it has been checked against the real Meet client (plan 05 task 10).
export async function joinMeet(page: Page, sel: MeetSelectors, timeoutMs = 90_000): Promise<JoinResult> {
  const { selectors, texts } = sel
  const deadline = Date.now() + timeoutMs
  const guard = navigationGuard('join', 'meet')
  const permission = new RegExp(texts.permissionContinue, 'i')
  let permissionClicks = 0
  let joinClicked = false

  // Names of the device toggles that do not read "off". Throws DeviceControlMissing when one is not on screen.
  async function togglesOn(): Promise<('micToggle' | 'cameraToggle')[]> {
    const on: ('micToggle' | 'cameraToggle')[] = []
    for (const [name, toggle, off] of [
      ['micToggle', selectors.micToggle, selectors.micOff],
      ['cameraToggle', selectors.cameraToggle, selectors.cameraOff]
    ] as const) {
      const control = shown(page, toggle)
      if (!(await control.isVisible())) throw new DeviceControlMissing('meet', name)
      const isOff = await control.evaluate((el, css) => el.matches(css), off, { timeout: stepTimeout(deadline) })
      if (!isOff) on.push(name)
    }
    return on
  }

  async function turnDevicesOff(): Promise<JoinResult | null> {
    for (const name of await togglesOn()) {
      await shown(page, selectors[name]).click({ timeout: stepTimeout(deadline) })
      logStep(`click ${name}`)
    }
    // Re-read: a toggle that still reads on is never followed by a join click.
    const settleUntil = Math.min(deadline, Date.now() + TOGGLE_SETTLE_MS)
    for (;;) {
      if ((await togglesOn()).length === 0) return null
      if (Date.now() >= settleUntil) return { kind: 'failed', reason: 'device_toggle_stuck' }
      await sleep(100)
    }
  }

  // The earliest entry of joinButtons that is on screen as a button whose whole text is that entry.
  async function joinButton(): Promise<{ name: string; button: Locator } | null> {
    for (const name of sel.joinButtons) {
      const button = page
        .locator('button, [role="button"]')
        .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`), visible: true })
        .first()
      if (await button.isVisible()) return { name, button }
    }
    return null
  }

  // One look at the page: a result when it shows one, else an action on the pre-join screen, else null.
  async function pollOnce(): Promise<JoinResult | null> {
    const host = new URL(page.url()).hostname
    if (sel.signInHosts.includes(host)) return { kind: 'signin_required', host }
    if (await meetTextSignal(page, sel, texts.blocked)) return { kind: 'failed', reason: 'meet_blocked' }
    if (await meetTextSignal(page, sel, texts.invalidLink)) return { kind: 'failed', reason: 'invalid_link' }
    // A code whose call is over (or that the member left) shows the end screen instead of the pre-join screen.
    if ((await meetTextSignal(page, sel, texts.ended)) || (await meetTextSignal(page, sel, texts.endScreen))) {
      return { kind: 'failed', reason: 'meeting_ended' }
    }

    if (!joinClicked) {
      const permissionButton = page
        .locator('button, [role="button"]')
        .filter({ hasText: permission, visible: true })
        .first()
      if (permissionClicks < MAX_PERMISSION_CLICKS && (await permissionButton.isVisible())) {
        await permissionButton.click({ timeout: stepTimeout(deadline) })
        permissionClicks += 1
        logStep('click permissionContinue')
        return null
      }
      // A pre-join that asks for a name is the anonymous one: the session is gone. Nothing is typed.
      if (await shown(page, selectors.prejoinNameInput).isVisible()) return { kind: 'signin_required', host: MEET_HOST }
      const join = await joinButton()
      if (join) {
        const failure = await turnDevicesOff()
        if (failure) return failure
        await join.button.click({ timeout: stepTimeout(deadline) })
        joinClicked = true
        logStep(`click joinButtons[${sel.joinButtons.indexOf(join.name)}]`)
        return null
      }
    }

    if (
      (await meetTextSignal(page, sel, texts.lobby)) ||
      (await meetTextSignal(page, sel, texts.lobbyDenied)) ||
      (await meetTextSignal(page, sel, texts.lobbyExpired))
    ) {
      return { kind: 'lobby' }
    }
    if (await shown(page, selectors.leaveButton).isVisible()) return { kind: 'in_meeting' }
    return null
  }

  while (Date.now() < deadline) {
    try {
      const result = await guard.run(pollOnce)
      if (result) return result
    } catch (error) {
      if (error instanceof DeviceControlMissing) return { kind: 'failed', reason: 'device_toggle_missing' }
      // An action cut to the deadline ran out of time with the deadline: that is the timeout, not a fault.
      if (!isTimeout(error) || Date.now() < deadline) throw error
      break
    }
    await sleep(Math.min(JOIN_POLL_MS, Math.max(0, deadline - Date.now())))
  }
  // A page that kept navigating under the polls is named, so it is not mistaken for a pre-join that never loaded.
  const race = guard.lastRace === null ? '' : ` (last navigation race: ${guard.lastRace})`
  return { kind: 'failed', reason: `prejoin_timeout${race}` }
}
