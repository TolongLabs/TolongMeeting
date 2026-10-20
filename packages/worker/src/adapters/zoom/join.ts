import { setTimeout as sleep } from 'node:timers/promises'
import type { Frame as PwFrame, Locator, Page } from 'playwright'
import { DevicesOnError, type AdmissionResult, type JoinResult } from '../types'
import { navigationGuard, zoomRoot } from './root'
import { textPattern, zoomSelectors, type ZoomSelectors } from './selectors'

export const ZOOM_TIMEOUTS = { join: 60_000, step: 10_000, audio: 15_000 }

const JOIN_POLL_MS = 500
const ADMISSION_POLL_MS = 2_000
const MAX_DEVICE_PROMPT_CLICKS = 3
const LEAVE_CONFIRM_MS = 3_000

// Steps are logged by selector name only: page text can hold names, meeting titles and chat.
export function logStep(step: string): void {
  console.info(`zoom: ${step}`)
}

// A step's action timeout: the usual step timeout, cut to what is left before the deadline (at least 1 ms, because
// Playwright reads 0 as "no timeout").
function stepTimeout(deadline: number): number {
  return Math.max(1, Math.min(ZOOM_TIMEOUTS.step, deadline - Date.now()))
}

// Playwright's TimeoutError, by name: an action that was cut to the deadline fails with it.
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

async function bodyText(root: PwFrame, timeout: number): Promise<string> {
  return root.locator('body').innerText({ timeout })
}

// The first match that is on screen: Zoom keeps hidden copies of some controls in the DOM.
export function shown(root: PwFrame, selector: string): Locator {
  return root.locator(selector).filter({ visible: true }).first()
}

export async function visible(root: PwFrame, selector: string): Promise<boolean> {
  return shown(root, selector).isVisible()
}

export async function zoomJoin(
  page: Page,
  // timeoutMs is for tests; the adapter interface passes only guestName.
  opts: { guestName: string | null; timeoutMs?: number }
): Promise<JoinResult> {
  const { selectors: sel, texts } = await zoomSelectors()
  const signIn = textPattern(texts.signInRequired)
  const busy = textPattern(texts.accountBusy)
  const lobby = textPattern(texts.lobby)
  const over = textPattern(texts.ended)
  const deadline = Date.now() + (opts.timeoutMs ?? ZOOM_TIMEOUTS.join)
  const guard = navigationGuard('join')
  let promptClicks = 0
  let joinClicked = false

  // One look at the page: a result when it shows one, else an action on the pre-join screen, else null.
  async function pollOnce(): Promise<JoinResult | null> {
    const root = await zoomRoot(page)
    if (await visible(root, sel.leaveButton)) return { kind: 'in_meeting' }
    const text = await bodyText(root, stepTimeout(deadline))
    if (signIn.test(text)) return { kind: 'signin_required', host: new URL(page.url()).hostname }
    if (busy.test(text)) return { kind: 'account_busy' }
    if (lobby.test(text)) return { kind: 'lobby' }
    // A link to a meeting that is over (or was never held) shows a notice instead of the pre-join screen.
    if (over.test(text)) return { kind: 'failed', reason: 'meeting_ended' }
    if (joinClicked) return null

    if (promptClicks < MAX_DEVICE_PROMPT_CLICKS && (await visible(root, sel.continueWithoutDevices))) {
      await shown(root, sel.continueWithoutDevices).click({ timeout: stepTimeout(deadline) })
      promptClicks += 1
      logStep('click continueWithoutDevices')
    } else if (await visible(root, sel.nameInput)) {
      const input = shown(root, sel.nameInput)
      if ((await input.inputValue({ timeout: stepTimeout(deadline) })).trim() === '') {
        if (opts.guestName === null) return { kind: 'failed', reason: 'name_required' }
        await input.fill(opts.guestName, { timeout: stepTimeout(deadline) })
        logStep('fill nameInput')
        // The typed name is verified from the DOM before Join is clicked.
        if ((await input.inputValue({ timeout: stepTimeout(deadline) })) !== opts.guestName) {
          return { kind: 'failed', reason: 'name_not_set' }
        }
      }
      await shown(root, sel.joinButton).click({ timeout: stepTimeout(deadline) })
      joinClicked = true
      logStep('click joinButton')
    }
    return null
  }

  while (Date.now() < deadline) {
    try {
      const result = await guard.run(pollOnce)
      if (result) return result
    } catch (error) {
      // An action cut to the deadline ran out of time with the deadline: that is the timeout, not a fault.
      if (!isTimeout(error) || Date.now() < deadline) throw error
      break
    }
    await sleep(Math.min(JOIN_POLL_MS, Math.max(0, deadline - Date.now())))
  }
  // A page that kept navigating under the polls is named, so it is not mistaken for a pre-join screen that never loaded.
  const race = guard.lastRace === null ? '' : ` (last navigation race: ${guard.lastRace})`
  return { kind: 'failed', reason: `prejoin_timeout${race}` }
}

export async function zoomWaitUntilAdmitted(page: Page, deadline: Date): Promise<AdmissionResult> {
  const { selectors: sel, texts } = await zoomSelectors()
  const denied = textPattern(texts.lobbyDenied)
  const ended = textPattern(texts.ended)
  const limit = deadline.getTime()
  const guard = navigationGuard('waitUntilAdmitted')

  async function pollOnce(): Promise<AdmissionResult | null> {
    const root = await zoomRoot(page)
    if (await visible(root, sel.leaveButton)) return 'admitted'
    const text = await bodyText(root, stepTimeout(limit))
    // A meeting that ends before the member is let in counts as a denial.
    if (denied.test(text) || ended.test(text)) return 'lobby_denied'
    return null
  }

  for (;;) {
    try {
      const result = await guard.run(pollOnce)
      if (result) return result
    } catch (error) {
      if (!isTimeout(error) || Date.now() < limit) throw error
    }
    const remaining = limit - Date.now()
    if (remaining <= 0) {
      if (guard.lastRace !== null) logStep(`lobby expired, last navigation race: ${guard.lastRace}`)
      return 'lobby_expired'
    }
    await sleep(Math.min(ADMISSION_POLL_MS, remaining))
  }
}

async function labelsOf(root: PwFrame, selector: string, name: string): Promise<string[]> {
  const labels = await root.locator(selector).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))
  if (labels.length === 0) throw new Error(`zoom: ${name} not found, cannot confirm the device is off`)
  // A button without a label says nothing about the device, so it cannot count as "off".
  if (labels.some((label) => label.trim() === ''))
    throw new Error(`zoom: ${name} has no aria-label, cannot read the device state`)
  return labels
}

// Reads the audio and video toolbar buttons' labels; "mute ..." and "stop ... video" mean the device is live.
export async function zoomAssertDevicesOff(page: Page): Promise<void> {
  const config: ZoomSelectors = await zoomSelectors()
  const root = await zoomRoot(page)
  const audio = await labelsOf(root, config.selectors.audioButton, 'audioButton')
  const video = await labelsOf(root, config.selectors.videoButton, 'videoButton')
  const live = textPattern(config.texts.devicesOnLabel)
  const on = [...new Set([...audio, ...video])].filter((label) => live.test(label.trim()))
  if (on.length > 0) throw new DevicesOnError(on)
}

export async function zoomLeave(page: Page): Promise<void> {
  const { selectors: sel } = await zoomSelectors()
  const root = await zoomRoot(page)
  await shown(root, sel.leaveButton).click({ timeout: ZOOM_TIMEOUTS.step })
  logStep('click leaveButton')
  await shown(root, sel.leaveConfirm).click({ timeout: LEAVE_CONFIRM_MS })
  logStep('click leaveConfirm')
}
