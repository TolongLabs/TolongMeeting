import { expect, test } from 'bun:test'
import { adapterFor, type PlatformAdapter } from '../src/adapters'
import { teamsAdapter } from '../src/adapters/teams'
import { zoomAdapter } from '../src/adapters/zoom'

// The checks every PlatformAdapter must pass. Zoom and Teams run through the same table; Meet joins it when plan 05
// registers its adapter.
const ZOOM_LINK = 'https://us02web.zoom.us/j/1234567890?pwd=TESTPASS'
const TEAMS_LINK = 'https://teams.live.com/meet/9876543210987?p=TESTPASS'
const NOT_A_MEETING = [
  'https://example.com/j/1234567890',
  'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
  'not a url',
  ''
]

const METHODS = [
  'normaliseLink',
  'join',
  'connectOutputAudio',
  'ensureLayout',
  'waitUntilAdmitted',
  'assertDevicesOff',
  'readChat',
  'sweepChat',
  'sharedScreenRegion',
  'participantCount',
  'meetingState',
  'dismissNotices',
  'leave'
] as const

const cases: { adapter: PlatformAdapter; platform: string; own: string; other: string }[] = [
  { adapter: zoomAdapter, platform: 'zoom', own: ZOOM_LINK, other: TEAMS_LINK },
  { adapter: teamsAdapter, platform: 'teams', own: TEAMS_LINK, other: ZOOM_LINK }
]

for (const { adapter, platform, own, other } of cases) {
  test(`${platform} adapter has the full PlatformAdapter surface`, () => {
    expect(adapter.platform).toBe(platform as PlatformAdapter['platform'])
    for (const method of METHODS) expect(typeof adapter[method]).toBe('function')
  })

  test(`${platform} adapter normalises its own links, once and for all`, () => {
    const normal = adapter.normaliseLink(own)
    expect(normal).not.toBeNull()
    expect(adapter.normaliseLink(normal!)).toBe(normal)
  })

  test(`${platform} adapter refuses the other platform's links and non-meeting URLs`, () => {
    for (const url of [other, ...NOT_A_MEETING]) expect(adapter.normaliseLink(url)).toBeNull()
  })

  test(`adapterFor picks the ${platform} adapter for its link`, () => {
    expect(adapterFor(own)?.platform).toBe(platform as PlatformAdapter['platform'])
  })
}

test('adapterFor returns null for a URL no adapter owns', () => {
  for (const url of NOT_A_MEETING) expect(adapterFor(url)).toBeNull()
})
