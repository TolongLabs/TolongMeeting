import { expect } from '@playwright/test'
import { meetAdapter } from '../../src/adapters/meet'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { DevicesOnError } from '../../src/adapters/types'
import { meetForbiddenClicks, serveMeet, test } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one (plan 05 task 10). Every test also ends with the fixture's forbidden-click check (`test` from ./serve).
const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const soon = () => new Date(Date.now() + 5_000)

test.use({ viewport: { width: 1920, height: 1080 } })

test('joins, reads the meeting and leaves through the adapter alone', async ({ page }) => {
  await serveMeet(page, {
    scene: 'prejoin',
    mic: 'on',
    camera: 'on',
    joinAs: 'join-now',
    peopleCount: 7,
    people: [{ name: 'Ms Tan', label: 'Host' }]
  })
  await page.goto(MEET)
  expect(await meetAdapter.join(page, { guestName: null })).toEqual({ kind: 'in_meeting' })
  expect(await meetAdapter.waitUntilAdmitted(page, soon())).toBe('admitted')
  await meetAdapter.assertDevicesOff(page)
  await meetAdapter.connectOutputAudio(page)
  await meetAdapter.ensureLayout(page)
  expect(await meetAdapter.meetingState(page)).toBe('in_meeting')
  expect(await meetAdapter.participantCount(page)).toBe(7)
  expect(await meetAdapter.sharedScreenRegion(page)).toBeNull()
  expect(await meetAdapter.dismissNotices(page)).toEqual([])
  expect((await meetAdapter.readChat(page, { seenKeys: [] })).messages).toEqual([])
  expect(await meetAdapter.sweepChat(page)).toEqual([])
  await meetAdapter.leave(page)
  expect(await meetForbiddenClicks(page)).toEqual([])
})

test('a Google sign-in page is a sign-in request, not a failure', async ({ page }) => {
  await serveMeet(page, { scene: 'signin' })
  await page.goto(MEET)
  expect(await meetAdapter.join(page, { guestName: null })).toEqual({
    kind: 'signin_required',
    host: 'accounts.google.com'
  })
})

test('a live microphone is reported as devices on', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'on', camera: 'off' })
  await page.goto(MEET)
  await expect(meetAdapter.assertDevicesOff(page)).rejects.toBeInstanceOf(DevicesOnError)
})

test('a device toggle that cannot be read fails the check closed', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off', omit: [sel.selectors.micToggle] })
  await page.goto(MEET)
  await expect(meetAdapter.assertDevicesOff(page)).rejects.toBeInstanceOf(DevicesOnError)
})
