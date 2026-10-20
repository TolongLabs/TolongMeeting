import { expect, test, type Page } from '@playwright/test'
import { joinMeet } from '../../src/adapters/meet/join'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one: Meet's real anonymous pre-join, automation-block and "Switch here" wording are unverified (plan 05 task 10).
const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()

// Clicks on controls the join must never touch (join.js keeps the log).
const forbiddenClicks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __forbidden: string[] }).__forbidden)

test('turns devices off, then joins now', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'on', camera: 'on', joinAs: 'join-now' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await meetClicks(page)).toEqual(['Turn off microphone', 'Turn off camera', 'Join now'])
  expect(await forbiddenClicks(page)).toEqual([])
})

test('asks to join when the organisation does not trust the member', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'off', camera: 'off', joinAs: 'ask' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'lobby' })
  expect(await meetClicks(page)).toEqual(['Ask to join'])
  expect(await forbiddenClicks(page)).toEqual([])
})

test('passes the device dialog without granting anything', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin-permissions', mic: 'off', camera: 'off', joinAs: 'join-now' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await meetClicks(page)).toEqual(['Continue without microphone and camera', 'Join now'])
  expect(await forbiddenClicks(page)).toEqual([])
})

test('joins here too, never switching the member out of the call', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'off', camera: 'off', joinAs: 'other-device' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await meetClicks(page)).toEqual(['Join here too'])
  expect(await forbiddenClicks(page)).toEqual([])
})

test('an anonymous pre-join means the session expired: no guest knock', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin-anonymous' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'signin_required', host: 'meet.google.com' })
  await expect(page.locator(sel.selectors.prejoinNameInput)).toHaveValue('')
  expect(await meetClicks(page)).toEqual([])
})

test('a Google sign-in page is signin_required on its host', async ({ page }) => {
  await serveMeet(page, { scene: 'signin' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'signin_required', host: 'accounts.google.com' })
})

test('an automation block fails at once', async ({ page }) => {
  await serveMeet(page, { scene: 'blocked' })
  await page.goto(MEET)
  const started = Date.now()
  expect(await joinMeet(page, sel)).toEqual({ kind: 'failed', reason: 'meet_blocked' })
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('an invalid code fails; an unrecognised page times out', async ({ page }) => {
  await serveMeet(page, { scene: 'invalid' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'failed', reason: 'invalid_link' })
  await serveMeet(page, { scene: 'blank' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel, 3_000)).toEqual({ kind: 'failed', reason: 'prejoin_timeout' })
})

for (const scene of ['ended', 'left'] as const) {
  test(`the ${scene} screen is meeting_ended, with nothing clicked`, async ({ page }) => {
    await serveMeet(page, { scene })
    await page.goto(MEET)
    expect(await joinMeet(page, sel)).toEqual({ kind: 'failed', reason: 'meeting_ended' })
    expect(await meetClicks(page)).toEqual([])
  })
}

test('a device that stays on is never followed by a join click', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'on', camera: 'off', joinAs: 'join-now' })
  await page.goto(MEET)
  // The mic button ignores the click: the handler runs before the render, so it puts the state back.
  await page.evaluate(() => {
    const meet = (window as unknown as { __meet: { cfg: { mic: string }; onClick(fn: () => void): void } }).__meet
    meet.onClick(() => {
      meet.cfg.mic = 'on'
    })
  })
  expect(await joinMeet(page, sel)).toEqual({ kind: 'failed', reason: 'device_toggle_stuck' })
  expect(await meetClicks(page)).toEqual(['Turn off microphone'])
})

test('a device button that cannot be read fails closed', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'denied', camera: 'off', joinAs: 'join-now' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'failed', reason: 'device_toggle_missing' })
  expect(await meetClicks(page)).toEqual([])
})

test('page text is never logged', async ({ page }) => {
  const info = console.info
  const lines: string[] = []
  console.info = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await serveMeet(page, { scene: 'prejoin', mic: 'on', camera: 'on', joinAs: 'ask' })
    await page.goto(MEET)
    await joinMeet(page, sel)
  } finally {
    console.info = info
  }
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) expect(line).toMatch(/^meet: (click \w+(\[\d\])?)$/)
  expect(lines.join('\n')).not.toMatch(/abc-defg-hij|Ask to join|google/)
})
