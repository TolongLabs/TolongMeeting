import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { buildTeamsAdapter, TEAMS_TIMEOUTS, teamsAdapter } from '../src/adapters/teams'
import { teamsSelectors } from '../src/adapters/teams/selectors'
import { waitTeamsAdmitted } from '../src/adapters/teams/state'

// The adapter reads its selector map from here, as the Playwright config sets it for the fixture specs.
process.env.TM_SELECTORS_DIR ??= resolve(import.meta.dir, '../../../config/selectors')

// A page whose every call starts a step that never finishes.
function hangingPage(): Page {
  const hang: object = new Proxy(() => hang, {
    get: (_target, key) => (key === 'then' ? () => undefined : hang)
  })
  return hang as Page
}

const SHORT = Object.fromEntries(Object.keys(TEAMS_TIMEOUTS).map((key) => [key, 50])) as unknown as Parameters<
  typeof buildTeamsAdapter
>[0]

test('the Teams adapter is the Teams platform and owns the meeting links', () => {
  expect(teamsAdapter.platform).toBe('teams')
  expect(teamsAdapter.normaliseLink('https://teams.live.com/meet/9876543210987?p=TESTPASS')).toBe(
    'https://teams.live.com/meet/9876543210987?p=TESTPASS'
  )
})

test('its default limits are the planned ones', () => {
  expect(TEAMS_TIMEOUTS).toEqual({
    join: 100_000,
    connectOutputAudio: 15_000,
    ensureLayout: 15_000,
    assertDevicesOff: 5_000,
    readChat: 20_000,
    sweepChat: 120_000,
    sharedScreenRegion: 5_000,
    participantCount: 5_000,
    meetingState: 5_000,
    dismissNotices: 5_000,
    leave: 20_000
  })
})

test('a step that runs past its limit rejects, naming the method and the limit', async () => {
  const adapter = buildTeamsAdapter(SHORT)
  const page = hangingPage()
  await expect(adapter.meetingState(page)).rejects.toThrow('teams meetingState timed out after 50 ms')
  await expect(adapter.leave(page)).rejects.toThrow('teams leave timed out after 50 ms')
  await expect(adapter.participantCount(page)).rejects.toThrow('teams participantCount timed out after 50 ms')
  await expect(adapter.readChat(page, { seenKeys: [] })).rejects.toThrow('teams readChat timed out after 50 ms')
})

test('an admission wait whose page never answers still ends at the deadline', async () => {
  const sel = await teamsSelectors()
  const started = Date.now()
  expect(await waitTeamsAdmitted(hangingPage(), sel, new Date(started + 200), 50)).toBe('lobby_expired')
  expect(Date.now() - started).toBeLessThan(2_000)
})
