import { expect, test } from '@playwright/test'
import { WatcherChatError, WatcherSigninError, resetWatcherEnv } from '../../src/watchers/loop'
import { discordReader, startWatcher } from '../../src/watchers/discord'
import { discordSelectors } from '../../src/watchers/selectors'
import { serveWatcherFixtures, type DiscordMessage, type DiscordWindow } from './serve'
import { watchHarness } from './harness'

test.use({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' })
test.beforeEach(() => resetWatcherEnv())

const CH = 'https://discord.com/channels/123456789012345678/234567890123456789'
const chat = { kind: 'chat', app: 'discord', chat: CH } as const
const zoom = (n: number) => `https://example.zoom.us/j/0000000000${n}?pwd=PASSCODE`
const [Z0, Z1, Z2, Z3, Z4, Z5] = [0, 1, 2, 3, 4, 5].map(zoom)
const P = 'https://pasted.zoom.us/j/00000000009?pwd=PASSCODE'
const F2 = 'https://forms.gle/TESTFORM2'
const F3 = 'https://forms.gle/TESTFORM3'

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
// Linkless messages from 19 hours to 3 hours ago, from different senders so none is a follow-up.
const filler = (count: number): DiscordMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    sender: `Member ${i % 7}`,
    datetime: ago(19 - (16 * i) / (count - 1)),
    text: `Chatter ${i}`
  }))

const messages: DiscordMessage[] = [
  { id: 'old', sender: 'Rep', datetime: ago(30), text: 'Last week', href: Z0 },
  { id: 'a', sender: 'Rep', datetime: ago(20), text: 'Yesterday', href: Z1 },
  ...filler(60),
  { id: 'b', sender: 'Rep', datetime: ago(2), text: 'Today', href: Z2 },
  { id: 'c', sender: 'Rep', datetime: ago(1), text: 'Early form', href: 'https://forms.gle/TESTFORM1' },
  { id: 'd', sender: 'Rep', datetime: ago(0.2), text: 'See you soon' }
]

test('the 24-hour scan reports only the newest meeting link, without touching the page', async ({ context, page }) => {
  await serveWatcherFixtures(context, { discord: { channelPath: new URL(CH).pathname, messages } })
  const h = watchHarness()
  let navigations = 0
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++
  })
  const stop = await startWatcher(page, chat, h.onLink)
  await h.polls(2)
  await stop.stop()
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
  expect(h.forms).toEqual([])
  expect(navigations).toBe(1)
  expect(await page.evaluate(() => (window as unknown as DiscordWindow).__touched ?? false)).toBe(false)
})

test('a newer link replaces it and a pasted link overrides both', async ({ context, page }) => {
  await serveWatcherFixtures(context, { discord: { channelPath: new URL(CH).pathname, messages } })
  const h = watchHarness()
  const stop = await startWatcher(page, chat, h.onLink)
  const add = (id: string, text: string, href: string) =>
    page.evaluate((m) => (window as unknown as DiscordWindow).__addMessage(m), {
      id,
      sender: 'Rep',
      datetime: new Date().toISOString(),
      text,
      href
    })
  await add('e', 'Corrected', Z3)
  await h.polls(1)
  h.set({ pastedLink: () => P })
  await h.polls(1)
  await add('f', 'Another', Z4)
  await h.polls(1)
  await stop.stop()
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }, { meetingUrl: Z3 }, { meetingUrl: P }])
})

test('during the meeting form links are reported with their sender, follow-ups included', async ({ context, page }) => {
  await serveWatcherFixtures(context, { discord: { channelPath: new URL(CH).pathname, messages } })
  const h = watchHarness()
  const stop = await startWatcher(page, chat, h.onLink)
  h.set({ phase: () => 'during', formsSince: () => new Date(Date.now() - 600_000) })
  const datetime = new Date().toISOString()
  await page.evaluate(
    ([f, z, g, t]) => {
      const add = (window as unknown as DiscordWindow).__addMessage
      add({ id: 'g', sender: 'Lecturer', datetime: t!, text: 'Attendance', href: f })
      add({ id: 'h', sender: 'Lecturer', datetime: t!, text: 'Wrong room', href: z })
      add({ id: 'i', sender: 'Lecturer', datetime: t!, text: 'Second form', href: g })
    },
    [F2, Z5, F3, datetime] as const
  )
  await h.polls(1)
  await stop.stop()
  expect(h.forms.map((c) => [c.url, c.source, c.sender, c.senderRole])).toEqual([
    [F2, 'watched_chat', 'Lecturer', 'unknown'],
    [F3, 'watched_chat', 'Lecturer', 'unknown']
  ])
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
})

test('polls wait 25 to 45 s before the meeting and 12 to 25 s during it', async ({ context, page }) => {
  await serveWatcherFixtures(context, { discord: { channelPath: new URL(CH).pathname, messages } })
  const h = watchHarness()
  const stop = await startWatcher(page, chat, h.onLink)
  await h.polls(3)
  h.set({ phase: () => 'during' })
  await h.polls(3)
  await stop.stop()
  for (const d of h.delays) {
    expect(d.ms).toBeGreaterThanOrEqual(d.phase === 'before' ? 25_000 : 12_000)
    expect(d.ms).toBeLessThanOrEqual(d.phase === 'before' ? 45_000 : 25_000)
  }
  expect(new Set(h.delays.map((d) => d.phase))).toEqual(new Set(['before', 'during']))
})

test('a signed-out profile and an unreachable channel reject the start', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    discord: { channelPath: new URL(CH).pathname, messages, loginRequired: true }
  })
  const e = await startWatcher(page, chat, () => {}).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(WatcherSigninError)
  expect((e as WatcherSigninError).host).toBe('discord.com')
  const other = 'https://discord.com/channels/123456789012345678/999999999999999999'
  const e2 = await startWatcher(await context.newPage(), { ...chat, chat: other }, () => {}).catch((x: unknown) => x)
  expect(e2).toBeInstanceOf(WatcherChatError)
  expect((e2 as WatcherChatError).reason).toBe('not_found')
})

test('only a Discord chat source is accepted', async ({ page }) => {
  const wrong = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class' }, () => {}).catch(
    (x: unknown) => x
  )
  expect(wrong).toBeInstanceOf(TypeError)
  const bad = await startWatcher(page, { kind: 'chat', app: 'discord', chat: 'not a link' }, () => {}).catch(
    (x: unknown) => x
  )
  expect((bad as WatcherChatError).reason).toBe('not_found')
})

test('the history scroll reaches back to the cut-off, in time order, and sends nothing', async ({ context, page }) => {
  await serveWatcherFixtures(context, { discord: { channelPath: new URL(CH).pathname, messages } })
  const reader = discordReader(CH, await discordSelectors())
  await reader.open(page)
  const since = new Date(Date.now() - 24 * 3_600_000)
  const read = await reader.history(page, since)
  // 'old' is 30 hours back: scrolling stops once it is collected, and it is cut by the time filter.
  expect(read.map((m) => m.key)).toEqual(['a', ...filler(60).map((m) => m.id), 'b', 'c', 'd'])
  expect(read[0]).toMatchObject({ sender: 'Rep', senderRole: 'unknown', replyTo: null, links: [Z1] })
  expect(read[0]!.text.startsWith('Yesterday')).toBe(true)
  // 'c' and 'd' follow 'b' from the same sender: they render without a name and take the one before.
  expect(read.slice(-3).map((m) => m.sender)).toEqual(['Rep', 'Rep', 'Rep'])
  expect((await reader.latest(page)).map((m) => m.key)).toEqual(read.slice(-25).map((m) => m.key))
  expect(await page.evaluate(() => (window as unknown as DiscordWindow).__touched ?? false)).toBe(false)
})
