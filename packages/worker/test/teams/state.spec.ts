import { expect, test } from '@playwright/test'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { teamsMeetingState, waitTeamsAdmitted } from '../../src/adapters/teams/state'
import { teamsState } from '../../src/adapters/teams/page-state'
import { serveTeams, setTeamsScene, teamsClicks, teamsForbiddenClicks } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one.
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()
const soon = (ms: number) => new Date(Date.now() + ms)

for (const [scene, state] of [
  ['lobby', 'lobby'],
  ['meeting', 'in_meeting'],
  ['ended', 'ended'],
  ['left', 'ended'],
  ['removed', 'removed'],
  ['blank', 'unknown']
] as const) {
  test(`scene ${scene} reads as ${state}`, async ({ page }) => {
    await serveTeams(page, { scene, mic: 'off', camera: 'off' })
    await page.goto(JOIN)
    expect(await teamsMeetingState(page, sel)).toBe(state)
    expect(await teamsClicks(page)).toEqual([])
  })
}

test('chat text from a recurring thread is never an end signal', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    chatOpen: true,
    messages: [
      {
        id: 'old1',
        sender: 'Lecturer',
        time: '26/10',
        datetime: '2026-10-26T11:00:00Z',
        text: 'The meeting has ended, see you next week'
      },
      {
        id: 'old2',
        sender: 'Student',
        time: '26/10',
        datetime: '2026-10-26T11:00:05Z',
        text: 'Someone removed you from the meeting?'
      }
    ]
  })
  await page.goto(JOIN)
  await expect(page.locator(sel.selectors.chatMessage).first()).toBeVisible()
  expect(await teamsMeetingState(page, sel)).toBe('in_meeting')
})

test('with Leave showing, an end or removal notice in a dialog still ends the meeting', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    notices: [{ role: 'dialog', text: 'The meeting has ended', button: 'OK' }]
  })
  await page.goto(JOIN)
  expect(await teamsMeetingState(page, sel)).toBe('ended')
  await setTeamsScene(page, 'meeting', {
    notices: [{ role: 'dialog', text: 'Someone removed you from the meeting', button: 'OK' }]
  })
  expect(await teamsMeetingState(page, sel)).toBe('removed')
  expect(await teamsClicks(page)).toEqual([])
})

test('with Leave showing, end text outside a dialog is not an end', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    notices: [{ role: 'status', text: 'Recording has started.', button: 'OK' }]
  })
  await page.goto(JOIN)
  await page.evaluate(() => {
    const note = document.createElement('p')
    note.textContent = 'The meeting has ended'
    document.getElementById('stage')?.append(note)
  })
  expect(await teamsMeetingState(page, sel)).toBe('in_meeting')
})

test('a breakout prompt and an automatic move both read as breakout_prompt, untouched', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off', breakout: 'prompt' })
  await page.goto(JOIN)
  expect(await teamsMeetingState(page, sel)).toBe('breakout_prompt')
  await setTeamsScene(page, 'meeting', { breakout: 'moved' })
  expect(await teamsMeetingState(page, sel)).toBe('breakout_prompt')
  expect(await teamsClicks(page)).toEqual([])
  expect(await teamsForbiddenClicks(page)).toEqual([])
})

test('admitted when the organiser lets the bot in', async ({ page }) => {
  await serveTeams(page, { scene: 'lobby', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  const before = Date.now()
  setTimeout(() => void setTeamsScene(page, 'meeting'), 3_000)
  expect(await waitTeamsAdmitted(page, sel, soon(20_000), 500)).toBe('admitted')
  expect(teamsState(page).joinedAt).toBeGreaterThanOrEqual(before)
  expect(await teamsClicks(page)).toEqual([])
})

test('denied and expired lobbies', async ({ page }) => {
  await serveTeams(page, { scene: 'lobby-denied' })
  await page.goto(JOIN)
  expect(await waitTeamsAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_denied')
  await setTeamsScene(page, 'lobby-expired')
  expect(await waitTeamsAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_expired')
})

test('the deadline ends the wait as lobby_expired', async ({ page }) => {
  await serveTeams(page, { scene: 'lobby' })
  await page.goto(JOIN)
  const started = Date.now()
  expect(await waitTeamsAdmitted(page, sel, soon(2_000), 500)).toBe('lobby_expired')
  expect(Date.now() - started).toBeLessThan(3_500)
  expect(teamsState(page).joinedAt).toBeNull()
})
