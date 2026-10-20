import { expect, test } from '@playwright/test'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { WatcherSigninError, resetWatcherEnv, type DeskStep } from '../../src/watchers/loop'
import { startWatcher, teamsChatReader } from '../../src/watchers/teams'
import { teamsClicks } from '../teams/serve'
import { watchHarness } from './harness'
import { serveWatcherFixtures, type TeamsChatWindow } from './serve'

test.use({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' })
test.beforeEach(() => resetWatcherEnv())

const CHAT = 'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'
const chat = { kind: 'chat', app: 'teams', chat: CHAT } as const
const MEETING =
  'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0?context=%7B%22Tid%22%3A%22TENANT%22%7D'

const direct: DeskStep = (step) => step()
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const filler = Array.from({ length: 40 }, (_, i) => ({
  id: `w${i}`,
  sender: 'Classmate',
  time: '',
  datetime: ago(22 - i * 0.45),
  text: `note ${i}`
}))
const messages = [
  {
    id: 'old',
    sender: 'Rep',
    time: '',
    datetime: ago(30),
    text: 'Last week',
    href: 'https://teams.live.com/meet/9876543210987?p=TESTPASS'
  },
  ...filler,
  {
    id: 'a',
    sender: 'Rep',
    time: '',
    datetime: ago(3),
    text: 'Zoom today',
    href: 'https://example.zoom.us/j/00000000001?pwd=PASSCODE'
  },
  { id: 'b', sender: 'Rep', time: '', datetime: ago(1), text: 'Moved to Teams', href: MEETING }
]

test('the 24-hour scan goes through the launcher and reports only the newest meeting link, read-only', async ({
  context,
  page
}) => {
  await serveWatcherFixtures(context, { teams: { chatUrl: CHAT, launcher: true, messages } })
  const h = watchHarness()
  const stop = await startWatcher(page, chat, h.onLink)
  await h.polls(2)
  await stop.stop()
  expect(h.meeting).toEqual([{ meetingUrl: MEETING }])
  expect(h.forms).toEqual([])
  expect(await teamsClicks(page)).toEqual(['Continue on this browser'])
  expect(await page.evaluate(() => (window as unknown as TeamsChatWindow).__touched ?? false)).toBe(false)
})

test('during the meeting form links come with their sender', async ({ context, page }) => {
  await serveWatcherFixtures(context, { teams: { chatUrl: CHAT, messages, scroll: 'top' } })
  const h = watchHarness()
  const stop = await startWatcher(page, chat, h.onLink)
  h.set({ phase: () => 'during', formsSince: () => new Date(Date.now() - 600_000) })
  await page.evaluate(
    (t) =>
      (window as unknown as TeamsChatWindow).__addMessage({
        id: 'f',
        sender: 'Lecturer',
        time: '',
        datetime: t,
        text: 'Attendance',
        href: 'https://forms.office.com/r/TESTFORM'
      }),
    new Date().toISOString()
  )
  await h.polls(1)
  await stop.stop()
  expect(h.forms.map((c) => [c.url, c.source, c.sender])).toEqual([
    ['https://forms.office.com/r/TESTFORM', 'watched_chat', 'Lecturer']
  ])
})

const hourly = Array.from({ length: 70 }, (_, i) => ({
  id: `h${i}`,
  sender: 'Classmate',
  time: '',
  datetime: ago(70.5 - i),
  text: `note ${i}`
}))

test('history reaches back 24 hours through lazily loaded batches', async ({ context, page }) => {
  await serveWatcherFixtures(context, { teams: { chatUrl: CHAT, messages: hourly } })
  const reader = teamsChatReader(CHAT, await teamsSelectors())
  await reader.open(page)
  const found = await reader.history(page, new Date(Date.now() - 24 * 3_600_000), direct)
  expect(found.map((m) => m.key)).toEqual(hourly.slice(47).map((m) => m.id))
})

test('history holds the desk one scroll step at a time', async ({ context, page }) => {
  await serveWatcherFixtures(context, { teams: { chatUrl: CHAT, messages: hourly } })
  const reader = teamsChatReader(CHAT, await teamsSelectors())
  await reader.open(page)
  let steps = 0
  let running = 0
  let overlapped = false
  const counted: DeskStep = async (step) => {
    steps += 1
    running += 1
    overlapped ||= running > 1
    try {
      return await step()
    } finally {
      running -= 1
    }
  }
  await reader.history(page, new Date(Date.now() - 24 * 3_600_000), counted)
  // The first read, at least two scroll steps (the list shows 20 rows and loads 20 more each time), and the move back.
  expect(steps).toBeGreaterThanOrEqual(4)
  expect(overlapped).toBe(false)
})

test('history stops at its time budget with what it has read', async ({ context, page }) => {
  await serveWatcherFixtures(context, { teams: { chatUrl: CHAT, messages: hourly } })
  const reader = teamsChatReader(CHAT, await teamsSelectors(), 0)
  await reader.open(page)
  const found = await reader.history(page, new Date(Date.now() - 24 * 3_600_000), direct)
  // Out of time before the first scroll: only the rows the list showed, newest 20 of the 70.
  expect(found.map((m) => m.key)).toEqual(hourly.slice(50).map((m) => m.id))
})

test('a signed-out profile rejects the start with the sign-in host', async ({ context, page }) => {
  await serveWatcherFixtures(context, { teams: { chatUrl: CHAT, messages, loginRequired: true } })
  const e = await startWatcher(page, chat, () => {}).catch((x: unknown) => x)
  expect([e instanceof WatcherSigninError, (e as WatcherSigninError).host]).toEqual([true, 'login.microsoftonline.com'])
})
