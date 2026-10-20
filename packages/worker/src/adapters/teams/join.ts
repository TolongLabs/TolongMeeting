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

// "On" for a toggle or radio: aria-checked="true", or a checked input.
function readsOn(locator: Locator, timeout: number): Promise<boolean> {
  return locator.evaluate(
    (el) => el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true,
    {
      timeout
    }
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

  // The toggles must read off before Join is clicked. Returns the names of those that do not.
  async function togglesOn(): Promise<string[]> {
    const on: string[] = []
    for (const [name, css] of [
      ['prejoinCameraToggle', selectors.prejoinCameraToggle],
      ['prejoinMicToggle', selectors.prejoinMicToggle]
    ] as const) {
      if (!(await shown(page, css).isVisible())) throw new DeviceControlMissing('teams', name)
      if (await readsOn(shown(page, css), stepTimeout(deadline))) on.push(name)
    }
    return on
  }

  async function turnDevicesOff(): Promise<JoinResult | null> {
    for (const name of ['prejoinCameraToggle', 'prejoinMicToggle'] as const) {
      const toggle = shown(page, selectors[name])
      if (!(await toggle.isVisible())) return { kind: 'failed', reason: 'device_toggle_missing' }
      if (await readsOn(toggle, stepTimeout(deadline))) {
        await toggle.click({ timeout: stepTimeout(deadline) })
        logStep(`click ${name}`)
      }
    }
    const audio = shown(page, selectors.prejoinComputerAudio)
    if (!(await audio.isVisible())) return { kind: 'failed', reason: 'audio_option_missing' }
    if (!(await readsOn(audio, stepTimeout(deadline)))) {
      await audio.click({ timeout: stepTimeout(deadline) })
      logStep('click prejoinComputerAudio')
    }
    // Re-read: a toggle that still reads on is never followed by a Join click.
    const settleUntil = Math.min(deadline, Date.now() + TOGGLE_SETTLE_MS)
    for (;;) {
      if ((await togglesOn()).length === 0) return null
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
