import { expect, test, type Page } from '@playwright/test'
import { meetAdapter } from '../src/adapters/meet'
import { teamsAdapter } from '../src/adapters/teams'
import type { PlatformAdapter } from '../src/adapters/types'
import { zoomAdapter } from '../src/adapters/zoom'
import { meetForbiddenClicks, serveMeet } from './meet/serve'
import { serveTeams } from './teams/serve'

// The behaviour every adapter shows on a live meeting and on a meeting that has ended, checked on each platform's
// fixture the same way. The fixtures are imitations that have NOT been checked against the real clients.
const MEET_JOIN = 'https://meet.google.com/abc-defg-hij'
const TEAMS_JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'

interface Case {
  adapter: PlatformAdapter
  live(page: Page): Promise<void>
  ended(page: Page): Promise<void>
  /** Throws when the fixture saw a click the bot must never make. */
  noForbiddenClicks?(page: Page): Promise<void>
}

const cases: Case[] = [
  {
    adapter: zoomAdapter,
    live: async (page) => void (await page.goto('/zoom-meeting-top.html')),
    ended: async (page) => void (await page.goto('/zoom-ended.html'))
  },
  {
    adapter: teamsAdapter,
    live: async (page) => {
      await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
      await page.goto(TEAMS_JOIN)
    },
    ended: async (page) => {
      await serveTeams(page, { scene: 'ended' })
      await page.goto(TEAMS_JOIN)
    }
  },
  {
    adapter: meetAdapter,
    live: async (page) => {
      await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
      await page.goto(MEET_JOIN)
    },
    ended: async (page) => {
      await serveMeet(page, { scene: 'ended' })
      await page.goto(MEET_JOIN)
    },
    noForbiddenClicks: async (page) => expect(await meetForbiddenClicks(page)).toEqual([])
  }
]

for (const { adapter, live, ended, noForbiddenClicks } of cases) {
  test.describe(adapter.platform, () => {
    test.use({ viewport: { width: 1920, height: 1080 } })
    test.afterEach(async ({ page }) => noForbiddenClicks?.(page))

    test('a live meeting reads as in_meeting, with devices off and nothing to dismiss', async ({ page }) => {
      await live(page)
      expect(await adapter.meetingState(page)).toBe('in_meeting')
      await adapter.assertDevicesOff(page)
      expect(await adapter.dismissNotices(page)).toEqual([])
      const count = await adapter.participantCount(page)
      expect(count === null || Number.isInteger(count)).toBe(true)
    })

    test('an ended meeting reads as ended and shows no shared screen', async ({ page }) => {
      await ended(page)
      expect(await adapter.meetingState(page)).toBe('ended')
      expect(await adapter.sharedScreenRegion(page)).toBeNull()
    })
  })
}
