import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { buildMeetAdapter, MEET_TIMEOUTS, meetAdapter } from '../src/adapters/meet'
import { meetSelectors } from '../src/adapters/meet/selectors'
import { waitMeetAdmitted } from '../src/adapters/meet/state'
import { adapterFor } from '../src/adapters'

// The adapter reads its selector map from here, as the Playwright config sets it for the fixture specs.
process.env.TM_SELECTORS_DIR ??= resolve(import.meta.dir, '../../../config/selectors')

// A page whose every call starts a step that never finishes.
function hangingPage(): Page {
  const hang: object = new Proxy(() => hang, {
    get: (_target, key) => (key === 'then' ? () => undefined : hang)
  })
  return hang as Page
}

const SHORT = Object.fromEntries(Object.keys(MEET_TIMEOUTS).map((key) => [key, 50])) as unknown as Parameters<
  typeof buildMeetAdapter
>[0]

test('the Meet adapter is the Meet platform and owns the meeting links', () => {
  expect(meetAdapter.platform).toBe('meet')
  expect(meetAdapter.normaliseLink('https://meet.google.com/abc-defg-hij?authuser=1')).toBe(
    'https://meet.google.com/abc-defg-hij'
  )
})

test('adapterFor picks meet for Meet links only', () => {
  expect(adapterFor('https://meet.google.com/abc-defg-hij?authuser=1')?.platform).toBe('meet')
  expect(adapterFor('https://meet.google.com/new')).toBeNull()
  expect(adapterFor('https://us02web.zoom.us/j/1234567890?pwd=TESTPASS')?.platform).toBe('zoom')
})

test('its default limits are the planned ones', () => {
  expect(MEET_TIMEOUTS).toEqual({
    join: 100_000,
    connectOutputAudio: 15_000,
    ensureLayout: 20_000,
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
  const adapter = buildMeetAdapter(SHORT)
  const page = hangingPage()
  await expect(adapter.meetingState(page)).rejects.toThrow('meet meetingState timed out after 50 ms')
  await expect(adapter.leave(page)).rejects.toThrow('meet leave timed out after 50 ms')
  await expect(adapter.participantCount(page)).rejects.toThrow('meet participantCount timed out after 50 ms')
  await expect(adapter.readChat(page, { seenKeys: [] })).rejects.toThrow('meet readChat timed out after 50 ms')
})

test('an admission wait whose page never answers still ends at the deadline', async () => {
  const sel = await meetSelectors()
  const started = Date.now()
  expect(await waitMeetAdmitted(hangingPage(), sel, new Date(started + 200), 50)).toBe('lobby_expired')
  expect(Date.now() - started).toBeLessThan(2_000)
})
