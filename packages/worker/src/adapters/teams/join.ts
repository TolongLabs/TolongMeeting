import { setTimeout as sleep } from 'node:timers/promises'
import type { Locator, Page } from 'playwright'
import { DeviceControlMissing, isTimeout, shown, stepTimeout } from '../common'
import type { JoinResult } from '../types'
import { navigationGuard } from '../zoom/root'
import { teamsState } from './page-state'
import type { TeamsSelectors } from './selectors'
import { teamsTextSignal } from './text'

const JOIN_POLL_MS = 500
// How long the toggles get to show "off" after their click before the join gives up on them.
const TOGGLE_SETTLE_MS = 2_000
const MAX_PERMISSION_CLICKS = 3

// Steps are logged by selector name only: page text can hold names, meeting titles and chat.
export function logStep(step: string): void {
  console.info(`teams: ${step}`)
}

// Re-exported for the watchers, which look at the Teams page too.
export { shown }

// What a toggle or radio says about itself: aria-checked="true"/"false", or a checkbox or radio input's checked state.
// Anything else (the attribute stripped, "mixed", a plain button) is `unknown`: it is never read as off.
type ToggleState = 'on' | 'off' | 'unknown'

const TOGGLES = ['prejoinCameraToggle', 'prejoinMicToggle'] as const
type ToggleName = (typeof TOGGLES)[number]

function readToggle(locator: Locator, timeout: number): Promise<ToggleState> {
  return locator.evaluate(
    (el): ToggleState => {
      const aria = el.getAttribute('aria-checked')
      if (aria === 'true') return 'on'
      if (aria === 'false') return 'off'
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        return el.checked ? 'on' : 'off'
      }
      return 'unknown'
    },
    undefined,
    { timeout }
  )
}

// Starts on the page the caller has opened at the normalised link and never navigates itself. Every 500 ms it
// classifies the page and acts on the first rule that matches. The only controls it clicks are the "continue on this
// browser" launcher button, the permission dialog's continue button, the camera and microphone toggles (only to turn
// them off), the computer-audio option and "Join now". It never types: the guest path is refused, not filled in.
export async function joinTeams(page: Page, sel: TeamsSelectors, timeoutMs = 90_000): Promise<JoinResult> {
  const { selectors, texts } = sel
  const deadline = Date.now() + timeoutMs
  const guard = navigationGuard('join', 'teams')
  const permission = new RegExp(texts.permissionContinue, 'i')
  let permissionClicks = 0
  let joinClicked = false

  // How each device toggle reads now. Throws DeviceControlMissing when one is not on screen.
  async function readToggles(): Promise<Record<ToggleName, ToggleState>> {
    const states: Record<ToggleName, ToggleState> = { prejoinCameraToggle: 'unknown', prejoinMicToggle: 'unknown' }
    for (const name of TOGGLES) {
      const toggle = shown(page, selectors[name])
      if (!(await toggle.isVisible())) throw new DeviceControlMissing('teams', name)
      states[name] = await readToggle(toggle, stepTimeout(deadline))
    }
    return states
  }

  // Both devices must read off before Join is clicked. A toggle that cannot be read is never guessed at: nothing is
  // clicked and the join fails as unreadable.
  async function turnDevicesOff(): Promise<JoinResult | null> {
    const first = await readToggles()
    if (TOGGLES.some((name) => first[name] === 'unknown')) return { kind: 'failed', reason: 'device_toggle_unreadable' }
    for (const name of TOGGLES) {
      if (first[name] === 'on') {
        await shown(page, selectors[name]).click({ timeout: stepTimeout(deadline) })
        logStep(`click ${name}`)
      }
    }
    // The computer-audio option is a radio: clicking one that is already selected changes nothing.
    const audio = shown(page, selectors.prejoinComputerAudio)
    if (!(await audio.isVisible())) return { kind: 'failed', reason: 'audio_option_missing' }
    if ((await readToggle(audio, stepTimeout(deadline))) !== 'on') {
      await audio.click({ timeout: stepTimeout(deadline) })
      logStep('click prejoinComputerAudio')
    }
    // Re-read: a toggle that still reads on is never followed by a Join click.
    const settleUntil = Math.min(deadline, Date.now() + TOGGLE_SETTLE_MS)
    for (;;) {
      const now = await readToggles()
      if (TOGGLES.some((name) => now[name] === 'unknown')) return { kind: 'failed', reason: 'device_toggle_unreadable' }
      if (TOGGLES.every((name) => now[name] === 'off')) return null
      if (Date.now() >= settleUntil) return { kind: 'failed', reason: 'device_toggle_stuck' }
      await sleep(100)
    }
  }

  // One look at the page: a result when it shows one, else an action on the launcher or pre-join screen, else null.
  async function pollOnce(): Promise<JoinResult | null> {
    const host = new URL(page.url()).hostname
    if (sel.signInHosts.includes(host)) {
      if (await teamsTextSignal(page, sel, texts.deviceBlocked))
        return { kind: 'failed', reason: 'device_not_compliant' }
      return { kind: 'signin_required', host }
    }
    if (await teamsTextSignal(page, sel, texts.invalidLink)) return { kind: 'failed', reason: 'invalid_link' }
    // A link whose meeting is over (or one the member just left) shows the end screen instead of the pre-join screen. With
    // Leave showing the meeting is live, and end text counts only inside a notice container (as in teamsMeetingState).
    const live = await shown(page, selectors.hangupButton).isVisible()
    if (
      (await shown(page, selectors.endScreen).isVisible()) ||
      (await teamsTextSignal(page, sel, texts.ended, live ? selectors.noticeContainers : undefined))
    ) {
      return { kind: 'failed', reason: 'meeting_ended' }
    }

    if (!joinClicked) {
      const permissionButton = page
        .locator('button, [role="button"]')
        .filter({ hasText: permission, visible: true })
        .first()
      if (await shown(page, selectors.launcherWebJoin).isVisible()) {
        await shown(page, selectors.launcherWebJoin).click({ timeout: stepTimeout(deadline) })
        logStep('click launcherWebJoin')
        return null
      }
      if (permissionClicks < MAX_PERMISSION_CLICKS && (await permissionButton.isVisible())) {
        await permissionButton.click({ timeout: stepTimeout(deadline) })
        permissionClicks += 1
        logStep('click permissionContinue')
        return null
      }
      // A pre-join that asks for a name is the anonymous one: the session is gone. Nothing is typed.
      if (await shown(page, selectors.prejoinNameInput).isVisible()) return { kind: 'signin_required', host }
      if (await shown(page, selectors.prejoinJoinButton).isVisible()) {
        const failure = await turnDevicesOff()
        if (failure) return failure
        await shown(page, selectors.prejoinJoinButton).click({ timeout: stepTimeout(deadline) })
        joinClicked = true
        logStep('click prejoinJoinButton')
        return null
      }
    }

    if (
      (await shown(page, selectors.lobbyScreen).isVisible()) ||
      (await teamsTextSignal(page, sel, texts.lobby)) ||
      (await teamsTextSignal(page, sel, texts.lobbyDenied)) ||
      (await teamsTextSignal(page, sel, texts.lobbyExpired))
    ) {
      return { kind: 'lobby' }
    }
    if (await shown(page, selectors.hangupButton).isVisible()) {
      teamsState(page).joinedAt = Date.now()
      return { kind: 'in_meeting' }
    }
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
