import { expect, test } from '@playwright/test'
import { runSmokeEntry } from '../../src/smoke/run'
import { teamsSmoke } from '../../src/smoke/teams'
import { serveTeams, type TeamsFixtureConfig } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one.
const URL = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const cfg: TeamsFixtureConfig = {
  scene: 'prejoin',
  mic: 'off',
  camera: 'off',
  audio: 'computer',
  chatOpen: false,
  roster: [{ name: 'Member' }],
  messages: [{ id: 's1', sender: 'Host', time: '09:00', datetime: new Date().toISOString(), text: 'smoke' }]
}

test.use({ viewport: { width: 1920, height: 1080 } })

test('passes on the full imitation', async ({ page }) => {
  await serveTeams(page, cfg)
  expect(await runSmokeEntry(page, teamsSmoke, URL)).toEqual({ missing: [] })
})

test('fails loudly, naming the key, when the roster button is gone', async ({ page }) => {
  await serveTeams(page, { ...cfg, omit: ['#roster-button'] })
  expect((await runSmokeEntry(page, teamsSmoke, URL)).missing).toContain('rosterButton')
})
