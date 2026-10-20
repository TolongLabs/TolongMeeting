import { expect } from '@playwright/test'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetMeetingState, waitMeetAdmitted } from '../../src/adapters/meet/state'
import { meetClicks, serveMeet, setMeetScene, test } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one (plan 05 task 10).
const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const soon = (ms: number) => new Date(Date.now() + ms)

for (const [scene, state] of [
  ['lobby', 'lobby'],
  ['lobby-review', 'lobby'],
  ['meeting', 'in_meeting'],
  ['ended', 'ended'],
  ['left', 'ended'],
  ['removed', 'removed'],
  ['blank', 'unknown']
] as const) {
  test(`scene ${scene} reads as ${state}`, async ({ page }) => {
    await serveMeet(page, { scene, mic: 'off', camera: 'off' })
    await page.goto(MEET)
    expect(await meetMeetingState(page, sel)).toBe(state)
    expect(await meetClicks(page)).toEqual([])
  })
}

test('chat and spoken captions are never state signals', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    sidePanel: 'chat',
    captions: 'and then you left the meeting',
    messages: [{ id: 'c1', sender: 'Student', time: '10:01', text: "You've been removed from the meeting" }]
  })
  await page.goto(MEET)
  await expect(page.locator(sel.selectors.chatMessage).first()).toBeVisible()
  await expect(page.locator(sel.selectors.captionsRegion)).toBeVisible()
  expect(await meetMeetingState(page, sel)).toBe('in_meeting')
})

test('with Leave showing, an end or removal notice in a dialog still ends the call', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    notices: [{ role: 'dialog', text: 'The call has ended', button: 'OK' }]
  })
  await page.goto(MEET)
  expect(await meetMeetingState(page, sel)).toBe('ended')
  await setMeetScene(page, 'meeting', {
    notices: [{ role: 'alert', text: "You've been removed from the meeting", button: 'OK' }]
  })
  expect(await meetMeetingState(page, sel)).toBe('removed')
  expect(await meetClicks(page)).toEqual([])
})

test('with Leave showing, end text outside a dialog is not an end', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting' })
  await page.goto(MEET)
  await page.evaluate(() => {
    for (const text of ['You left the meeting', 'Return to home screen']) {
      const note = document.createElement('p')
      note.textContent = text
      document.querySelector('main')?.append(note)
    }
  })
  expect(await meetMeetingState(page, sel)).toBe('in_meeting')
  // Once Leave is gone, the same text on the page is the end screen.
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.leaveButton)
  expect(await meetMeetingState(page, sel)).toBe('ended')
})

test('a breakout prompt reads as breakout_prompt and is not touched', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off', breakout: true })
  await page.goto(MEET)
  expect(await meetMeetingState(page, sel)).toBe('breakout_prompt')
  expect(await meetClicks(page)).toEqual([])
})

test('breakout words on a participant tile are not a prompt while Leave shows', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off', tiles: ['Breakout room helper (Ali)'] })
  await page.goto(MEET)
  await expect(page.getByText('Breakout room helper (Ali)')).toBeVisible()
  expect(await meetMeetingState(page, sel)).toBe('in_meeting')
  // The same words in a dialog still are one; without Leave they count wherever they are.
  await setMeetScene(page, 'meeting', { breakout: true })
  expect(await meetMeetingState(page, sel)).toBe('breakout_prompt')
  await setMeetScene(page, 'meeting', { breakout: false, omit: [sel.selectors.leaveButton] })
  expect(await meetMeetingState(page, sel)).toBe('breakout_prompt')
  expect(await meetClicks(page)).toEqual([])
})

test('admitted from the lobby, and from the review queue', async ({ page }) => {
  for (const scene of ['lobby', 'lobby-review'] as const) {
    await serveMeet(page, { scene, mic: 'off', camera: 'off' })
    await page.goto(MEET)
    setTimeout(() => void setMeetScene(page, 'meeting'), 2_000)
    expect(await waitMeetAdmitted(page, sel, soon(20_000), 500)).toBe('admitted')
    expect(await meetClicks(page)).toEqual([])
  }
})

test('denied, expired and deadline outcomes', async ({ page }) => {
  await serveMeet(page, { scene: 'lobby-denied' })
  await page.goto(MEET)
  expect(await waitMeetAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_denied')
  await setMeetScene(page, 'lobby-expired')
  expect(await waitMeetAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_expired')
  await setMeetScene(page, 'lobby-review')
  const started = Date.now()
  expect(await waitMeetAdmitted(page, sel, soon(2_000), 500)).toBe('lobby_expired')
  expect(Date.now() - started).toBeLessThan(3_500)
  expect(await meetClicks(page)).toEqual([])
})

test('a reload under the wait is a race, not a failure', async ({ page }) => {
  await serveMeet(page, { scene: 'lobby' })
  await page.goto(MEET)
  const wait = waitMeetAdmitted(page, sel, soon(20_000), 100)
  for (let i = 0; i < 3; i++) await page.reload()
  await setMeetScene(page, 'meeting')
  expect(await wait).toBe('admitted')
})
