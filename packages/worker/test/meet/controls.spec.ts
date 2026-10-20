import { expect, test } from '@playwright/test'
import {
  assertMeetDevicesOff,
  connectMeetOutputAudio,
  dismissMeetNotices,
  leaveMeet
} from '../../src/adapters/meet/controls'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetMeetingState } from '../../src/adapters/meet/state'
import { DevicesOnError } from '../../src/adapters/types'
import { meetClicks, serveMeet } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one (plan 05 task 10).
const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  )
}

test('devices off passes; either device on, or a missing control, throws', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await assertMeetDevicesOff(page, sel)
  for (const [patch, label] of [
    [{ mic: 'on' }, 'Turn off microphone'],
    [{ camera: 'on' }, 'Turn off camera']
  ] as const) {
    await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off', ...patch })
    await page.goto(MEET)
    const error = await rejection(assertMeetDevicesOff(page, sel))
    expect(error).toBeInstanceOf(DevicesOnError)
    expect((error as DevicesOnError).labels).toEqual([label])
  }
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.micToggle)
  const missing = await rejection(assertMeetDevicesOff(page, sel))
  expect(missing).toBeInstanceOf(DevicesOnError)
  expect((missing as DevicesOnError).labels).toEqual(['microphone control not found'])
  expect(await meetClicks(page)).toEqual([])
})

test('a permission-denied device button is not read as off', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'denied', camera: 'off' })
  await page.goto(MEET)
  const error = await rejection(assertMeetDevicesOff(page, sel))
  expect(error).toBeInstanceOf(DevicesOnError)
  expect((error as DevicesOnError).labels).toEqual(['microphone control not found'])
  expect(await meetClicks(page)).toEqual([])
})

test('clicks only allowlisted buttons inside notices, never the breakout prompt or side panel', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    sidePanel: 'chat',
    breakout: true,
    notices: [
      { role: 'dialog', text: 'Others may see your video differently', button: 'Got it' },
      { role: 'alert', text: 'This call is being recorded', button: 'Dismiss' },
      { role: 'dialog', text: 'Someone wants to join this call', button: 'Admit' },
      { role: 'dialog', text: 'Turn on captions?', button: 'Turn on captions' },
      { role: 'dialog', text: 'Allow microphone?', button: 'OK' },
      { role: 'dialog', text: 'Join the breakout room to continue', button: 'OK' },
      { role: 'dialog', text: 'Unmute to speak', button: 'Got it' },
      { role: 'dialog', text: 'The host started a screen share', button: 'Got it' },
      { role: 'dialog', text: 'You can start your video now', button: 'Got it' },
      { role: 'dialog', text: 'The host asks for your consent to record you', button: 'OK' }
    ]
  })
  await page.goto(MEET)
  expect(await dismissMeetNotices(page, sel)).toEqual(['Got it', 'Dismiss'])
  expect(await meetClicks(page)).toEqual(['Got it', 'Dismiss'])
  await expect(page.locator(sel.selectors.sidePanel)).toBeVisible()
  await expect(page.getByText("You've been invited to join breakout room 1")).toBeVisible()
})

test('an allowlisted button outside any notice is left alone', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', sidePanel: 'chat' })
  await page.goto(MEET)
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.textContent = 'OK'
    document.querySelector('main')?.append(button)
    const inPanel = document.createElement('button')
    inPanel.textContent = 'Dismiss'
    document.querySelector("[role='complementary']")?.append(inPanel)
    // A notice inside the side panel is the panel's, not a notice.
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inDialog = document.createElement('button')
    inDialog.textContent = 'Got it'
    dialog.append(inDialog)
    document.querySelector("[role='complementary']")?.append(dialog)
  })
  expect(await dismissMeetNotices(page, sel)).toEqual([])
  expect(await meetClicks(page)).toEqual([])
})

test('output audio needs no clicks, and fails loudly when no audio element exists', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await connectMeetOutputAudio(page, sel)
  expect(await meetClicks(page)).toEqual([])
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off', audioElements: 0 })
  await page.goto(MEET)
  await expect(connectMeetOutputAudio(page, sel)).rejects.toThrow(/no meeting audio/)
  expect(await meetClicks(page)).toEqual([])
})

test('leaves without ending the call for everyone, even as host', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off', host: true })
  await page.goto(MEET)
  await leaveMeet(page, sel)
  expect(await meetClicks(page)).toEqual(['Leave call', 'Just leave the call'])
  expect(await meetMeetingState(page, sel)).toBe('ended')
  expect(page.isClosed()).toBe(false)
})

test('leaves with one click when there is no dialog', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await leaveMeet(page, sel)
  expect(await meetClicks(page)).toEqual(['Leave call'])
  expect(await meetMeetingState(page, sel)).toBe('ended')
})

test('closes the page when Leave cannot be clicked', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.leaveButton)
  await leaveMeet(page, sel)
  expect(page.isClosed()).toBe(true)
})
