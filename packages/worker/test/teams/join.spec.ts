import { expect, test } from '@playwright/test'
import { joinTeams } from '../../src/adapters/teams/join'
import { teamsState } from '../../src/adapters/teams/page-state'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { teamsTextSignal } from '../../src/adapters/teams/text'
import { serveTeams, teamsClicks, teamsForbiddenClicks } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one.
const JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0?context=%7B%22Tid%22%3A%22TENANT%22%7D'
const sel = await teamsSelectors()

test('continues on this browser, turns devices off, picks computer audio and joins', async ({ page }) => {
  await serveTeams(page, {
    scene: 'launcher',
    mic: 'on',
    camera: 'on',
    audio: 'none'
  })
  await page.goto(JOIN)
  const before = Date.now()
  expect(await joinTeams(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await teamsClicks(page)).toEqual([
    'Continue on this browser',
    'Camera',
    'Microphone',
    'Computer audio',
    'Join now'
  ])
  expect(await teamsForbiddenClicks(page)).toEqual([])
  expect(teamsState(page).joinedAt).toBeGreaterThanOrEqual(before)
  // Devices ended up off, and the join never touched the in-meeting controls.
  await expect(page.locator(sel.selectors.micOff)).toBeVisible()
  await expect(page.locator(sel.selectors.cameraOff)).toBeVisible()
})

test('passes the blocked-devices dialog without granting anything', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin-permissions',
    mic: 'off',
    camera: 'off',
    audio: 'computer'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await teamsClicks(page)).toEqual(['Continue without audio or video', 'Join now'])
  expect(await teamsForbiddenClicks(page)).toEqual([])
})

test('reports the lobby', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin',
    mic: 'off',
    camera: 'off',
    audio: 'computer',
    afterJoin: 'lobby'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'lobby' })
  expect(teamsState(page).joinedAt).toBeNull()
})

test('an anonymous pre-join means the session expired: no guest join', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin-anonymous',
    mic: 'off',
    camera: 'off',
    audio: 'computer'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'signin_required',
    host: 'teams.microsoft.com'
  })
  await expect(page.locator(sel.selectors.prejoinNameInput)).toHaveValue('')
  expect(await teamsClicks(page)).toEqual([])
})

test('a Microsoft sign-in page is signin_required on its host', async ({ page }) => {
  await serveTeams(page, { scene: 'signin' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'signin_required',
    host: 'login.microsoftonline.com'
  })
})

test('a managed-device block is a failure, not a sign-in', async ({ page }) => {
  await serveTeams(page, { scene: 'device-blocked' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'failed',
    reason: 'device_not_compliant'
  })
})

test('an invalid link fails', async ({ page }) => {
  await serveTeams(page, { scene: 'invalid' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'failed',
    reason: 'invalid_link'
  })
})

test('an unrecognised page times out', async ({ page }) => {
  await serveTeams(page, { scene: 'blank' })
  await page.goto(JOIN)
  const started = Date.now()
  expect(await joinTeams(page, sel, 3_000)).toEqual({
    kind: 'failed',
    reason: 'prejoin_timeout'
  })
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a toggle that stays on blocks the join: Join is never clicked', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin',
    mic: 'on',
    camera: 'off',
    audio: 'computer',
    stuck: 'mic'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'failed', reason: 'device_toggle_stuck' })
  expect(await teamsClicks(page)).toEqual(['Microphone'])
})

test('a pre-join without a microphone toggle is not joined', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin',
    mic: 'off',
    camera: 'off',
    audio: 'computer',
    omit: [sel.selectors.prejoinMicToggle]
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'failed', reason: 'device_toggle_missing' })
  expect(await teamsClicks(page)).toEqual([])
})

test('a permission dialog that keeps coming back is clicked 3 times, then left alone', async ({ page }) => {
  await serveTeams(page, { scene: 'prejoin-permissions', mic: 'off', camera: 'off', audio: 'computer' })
  await page.goto(JOIN)
  // Every click puts the dialog back, and Join now leads back to the dialog, so the join can never finish.
  await page.evaluate(() => {
    document.addEventListener('click', () => setTimeout(() => window.__scene('prejoin-permissions'), 0), true)
  })
  expect(await joinTeams(page, sel, 4_000)).toEqual({ kind: 'failed', reason: 'prejoin_timeout' })
  expect((await teamsClicks(page)).filter((c) => c === 'Continue without audio or video')).toHaveLength(3)
})

test('chat text never counts as a page signal', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    chatOpen: true,
    messages: [
      {
        id: 'a',
        sender: 'Student',
        time: '10:00',
        datetime: '2026-10-26T10:00:00Z',
        text: 'This meeting link is invalid'
      }
    ]
  })
  await page.goto(JOIN)
  expect(await teamsTextSignal(page, sel, sel.texts.invalidLink)).toBe(false)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'in_meeting' })
})
