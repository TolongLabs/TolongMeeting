import { setTimeout as sleep } from 'node:timers/promises'
import type { Frame as PwFrame, Locator, Page } from 'playwright'
import { DevicesOnError, type AdmissionResult, type JoinResult } from '../types'
import { duringNavigation, zoomRoot } from './root'
import { textPattern, zoomSelectors, type ZoomSelectors } from './selectors'

export const ZOOM_TIMEOUTS = { join: 60_000, step: 10_000, audio: 15_000 }

const JOIN_POLL_MS = 500
const ADMISSION_POLL_MS = 2_000
const MAX_DEVICE_PROMPT_CLICKS = 3
const LEAVE_CONFIRM_MS = 3_000

// Steps are logged by selector name only: page text can hold names, meeting titles and chat.
function logStep(step: string): void {
  console.info(`zoom: ${step}`)
}

async function bodyText(root: PwFrame): Promise<string> {
  return root.locator('body').innerText()
}

// The first match that is on screen: Zoom keeps hidden copies of some controls in the DOM.
function shown(root: PwFrame, selector: string): Locator {
  return root.locator(selector).filter({ visible: true }).first()
}

async function visible(root: PwFrame, selector: string): Promise<boolean> {
  return shown(root, selector).isVisible()
}

export async function zoomJoin(page: Page, opts: { guestName: string | null }): Promise<JoinResult> {
  const { selectors: sel, texts } = await zoomSelectors()
  const signIn = textPattern(texts.signInRequired)
  const busy = textPattern(texts.accountBusy)
  const lobby = textPattern(texts.lobby)
  const deadline = Date.now() + ZOOM_TIMEOUTS.join
  let promptClicks = 0
  let joinClicked = false

  // One look at the page: a result when it shows one, else an action on the pre-join screen, else null.
  async function pollOnce(): Promise<JoinResult | null> {
    const root = await zoomRoot(page)
    if (await visible(root, sel.leaveButton)) return { kind: 'in_meeting' }
    const text = await bodyText(root)
    if (signIn.test(text)) return { kind: 'signin_required', host: new URL(page.url()).hostname }
    if (busy.test(text)) return { kind: 'account_busy' }
    if (lobby.test(text)) return { kind: 'lobby' }
    if (joinClicked) return null

    if (promptClicks < MAX_DEVICE_PROMPT_CLICKS && (await visible(root, sel.continueWithoutDevices))) {
      await shown(root, sel.continueWithoutDevices).click({ timeout: ZOOM_TIMEOUTS.step })
      promptClicks += 1
      logStep('click continueWithoutDevices')
    } else if (await visible(root, sel.nameInput)) {
      const input = shown(root, sel.nameInput)
      if ((await input.inputValue()).trim() === '') {
        if (opts.guestName === null) return { kind: 'failed', reason: 'name_required' }
        await input.fill(opts.guestName, { timeout: ZOOM_TIMEOUTS.step })
        logStep('fill nameInput')
        // The typed name is verified from the DOM before Join is clicked.
        if ((await input.inputValue()) !== opts.guestName) return { kind: 'failed', reason: 'name_not_set' }
      }
      await shown(root, sel.joinButton).click({ timeout: ZOOM_TIMEOUTS.step })
      joinClicked = true
      logStep('click joinButton')
    }
    return null
  }

  while (Date.now() < deadline) {
    const result = await duringNavigation(pollOnce)
    if (result) return result
    await sleep(JOIN_POLL_MS)
  }
  return { kind: 'failed', reason: 'prejoin_timeout' }
}

export async function zoomWaitUntilAdmitted(page: Page, deadline: Date): Promise<AdmissionResult> {
  const { selectors: sel, texts } = await zoomSelectors()
  const denied = textPattern(texts.lobbyDenied)
  const ended = textPattern(texts.ended)

  async function pollOnce(): Promise<AdmissionResult | null> {
    const root = await zoomRoot(page)
    if (await visible(root, sel.leaveButton)) return 'admitted'
    const text = await bodyText(root)
    // A meeting that ends before the member is let in counts as a denial.
    if (denied.test(text) || ended.test(text)) return 'lobby_denied'
    return null
  }

  for (;;) {
    const result = await duringNavigation(pollOnce)
    if (result) return result
    const remaining = deadline.getTime() - Date.now()
    if (remaining <= 0) return 'lobby_expired'
    await sleep(Math.min(ADMISSION_POLL_MS, remaining))
  }
}

async function labelsOf(root: PwFrame, selector: string): Promise<string[]> {
  return root.locator(selector).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))
}

// Reads the audio and video toolbar buttons' labels; "mute ..." and "stop ... video" mean the device is live.
export async function zoomAssertDevicesOff(page: Page): Promise<void> {
  const config: ZoomSelectors = await zoomSelectors()
  const root = await zoomRoot(page)
  const audio = await labelsOf(root, config.selectors.audioButton)
  const video = await labelsOf(root, config.selectors.videoButton)
  if (audio.length === 0) throw new Error('zoom: audioButton not found, cannot confirm the microphone is off')
  if (video.length === 0) throw new Error('zoom: videoButton not found, cannot confirm the camera is off')
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
