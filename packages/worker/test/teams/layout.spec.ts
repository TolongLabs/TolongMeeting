import { expect, test } from '@playwright/test'
import { ensureTeamsLayout, teamsParticipantCount, teamsSharedScreenRegion } from '../../src/adapters/teams/layout'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { serveTeams, setTeamsScene, teamsClicks, teamsForbiddenClicks } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one.
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()
const base = { scene: 'meeting', mic: 'off', camera: 'off' } as const

test.use({ viewport: { width: 1920, height: 1080 } })

test('reads the participant count without touching the chat panel', async ({ page }) => {
  await serveTeams(page, { ...base, chatOpen: true, peopleCount: 34 })
  await page.goto(JOIN)
  expect(await teamsParticipantCount(page, sel)).toBe(34)
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
  expect(await teamsClicks(page)).toEqual([])
  await setTeamsScene(page, 'meeting', { peopleCount: null })
  expect(await teamsParticipantCount(page, sel)).toBeNull()
})

test('opens chat, then focuses on content once per share', async ({ page }) => {
  await serveTeams(page, { ...base, chatOpen: false, share: null })
  await page.goto(JOIN)
  await ensureTeamsLayout(page, sel)
  await setTeamsScene(page, 'meeting', {
    share: {
      box: { x: 0, y: 48, width: 1440, height: 900 },
      width: 1440,
      height: 1080
    }
  })
  await ensureTeamsLayout(page, sel)
  await ensureTeamsLayout(page, sel)
  expect(await teamsClicks(page)).toEqual(['Chat', 'View', 'Focus on content'])
  expect(await teamsForbiddenClicks(page)).toEqual([])
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
})

test('the shared-screen region is the picture inside the letterbox', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    share: {
      box: { x: 0, y: 48, width: 1440, height: 900 },
      width: 1440,
      height: 1080
    }
  })
  await page.goto(JOIN)
  expect(await teamsSharedScreenRegion(page, sel)).toEqual({
    x: 120,
    y: 48,
    width: 1200,
    height: 900
  })
  await setTeamsScene(page, 'meeting', { share: null })
  expect(await teamsSharedScreenRegion(page, sel)).toBeNull()
})
