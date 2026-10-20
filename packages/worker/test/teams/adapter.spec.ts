import { expect } from '@playwright/test'
import { teamsAdapter } from '../../src/adapters/teams'
import { DevicesOnError } from '../../src/adapters/types'
import { serveTeams, teamsForbiddenClicks, test } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one.
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const soon = () => new Date(Date.now() + 5_000)

test.use({ viewport: { width: 1920, height: 1080 } })

test('joins, reads the meeting and leaves through the adapter alone', async ({ page }) => {
  await serveTeams(page, {
    scene: 'launcher',
    afterLauncher: 'prejoin',
    afterJoin: 'meeting',
    peopleCount: 7,
    roster: [{ name: 'Member' }]
  })
  await page.goto(JOIN)
  expect(await teamsAdapter.join(page, { guestName: null })).toEqual({ kind: 'in_meeting' })
  expect(await teamsAdapter.waitUntilAdmitted(page, soon())).toBe('admitted')
  await teamsAdapter.assertDevicesOff(page)
  await teamsAdapter.connectOutputAudio(page)
  await teamsAdapter.ensureLayout(page)
  expect(await teamsAdapter.meetingState(page)).toBe('in_meeting')
  expect(await teamsAdapter.participantCount(page)).toBe(7)
  expect(await teamsAdapter.sharedScreenRegion(page)).toBeNull()
  expect(await teamsAdapter.dismissNotices(page)).toEqual([])
  expect(await teamsAdapter.sweepChat(page)).toEqual([])
  expect((await teamsAdapter.readChat(page, { seenKeys: [] })).messages).toEqual([])
  await teamsAdapter.leave(page)
  expect(await teamsForbiddenClicks(page)).toEqual([])
})

test('a Microsoft sign-in page is a sign-in request, not a failure', async ({ page }) => {
  await serveTeams(page, { scene: 'signin' })
  await page.goto('https://login.microsoftonline.com/common/oauth2/authorize')
  expect(await teamsAdapter.join(page, { guestName: null })).toEqual({
    kind: 'signin_required',
    host: 'login.microsoftonline.com'
  })
})

test('a live microphone is reported as devices on', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'on', camera: 'off' })
  await page.goto(JOIN)
  await expect(teamsAdapter.assertDevicesOff(page)).rejects.toBeInstanceOf(DevicesOnError)
})
