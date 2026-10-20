// The `chat` link source, end to end (plan 02): the real `runOccurrence` watches a WhatsApp group or a Discord channel
// (the watcher fixtures, served on the real host names), the class link arrives after T-10, and the bot joins it on the
// fake Zoom. A look-alike link in the same chat is never joined. After a SIGTERM the restarted attempt rejoins the link
// kept in `joined-link` and no other.
//   xvfb-run -a bunx playwright test -c packages/worker/playwright.config.ts --project=e2e --workers=2
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  CHAT_PASSCODE,
  JOIN_PASSCODE,
  MEETING_ID,
  chatJoinLink,
  finished,
  startWorker,
  until,
  type Running
} from './support/harness'
import { MINUTE, eventsOf, expectNoSecrets, joinMeeting, pause, stateReached, useWorld } from './support/checks'
import {
  serveWatcherFixtures,
  type DiscordMessage,
  type DiscordWindow,
  type WhatsAppMessage,
  type WhatsAppWindow
} from '../watchers/serve'

const ctx = useWorld()

const OTHER_MEETING = '81234567899'
const OTHER_LINK = `https://e2e.zoom.us/j/${OTHER_MEETING}?pwd=OTHERPWD1`
// Links that look like a class link and are not one: another host that starts with the Zoom name, a name before an @,
// a port, a plain-http scheme. None may be joined, and the page of none may be opened.
const LOOKALIKES = [
  'https://e2e.zoom.us.evil.test/j/81234567891?pwd=EVILPWD1',
  'https://e2e.zoom.us@evil.test/j/81234567892?pwd=EVILPWD2',
  'http://e2e.zoom.us/j/81234567893?pwd=EVILPWD3',
  'https://e2e.zoom.us:8443/j/81234567894?pwd=EVILPWD4',
  'https://evil.test/redirect?to=https://e2e.zoom.us/j/81234567895'
]
const EVIL_SECRETS = ['EVILPWD1', 'EVILPWD2', 'EVILPWD3', 'EVILPWD4', 'OTHERPWD1']

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const pageOn = (r: Running, host: string): Page => {
  const page = r.context.pages().find((p) => !p.isClosed() && new URL(p.url()).hostname === host)
  if (page === undefined) throw new Error(`no open page on ${host}`)
  return page
}
const watcherReady = (r: Running, app: string) => async () =>
  (await r.events()).some((e) => e.type === 'state' && e.data.account === app && e.data.signedIn === true)

/** Everything the fake Zoom was asked for: the join pages by meeting number, and nothing else. */
const joinPages = (zoom: { requests: string[] }) => zoom.requests.filter((p) => /^\/(wc\/join|j)\/\d+$/.test(p))

// The start is 8 minutes away, so the bot is already inside the join window (T-10) when the link arrives.
const START_IN = 8 * MINUTE
const END_IN = 50 * MINUTE

test('WhatsApp: the class link posted after T-10 is joined, look-alikes are ignored, a restart rejoins the saved link only', async () => {
  const { world } = ctx
  test.setTimeout(10 * MINUTE)
  const t0 = Date.now()
  const link = { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' } as const
  const chatter: WhatsAppMessage[] = [
    // A link from last week's class, older than the 24-hour scan.
    {
      id: 'old',
      sender: 'Rep',
      at: ago(30 * 60),
      text: 'Last week',
      href: 'https://e2e.zoom.us/j/81234500000?pwd=LASTWEEK'
    },
    { id: 'c1', sender: 'Rep', at: ago(50), text: 'Class tonight at 8' },
    { id: 'c2', sender: 'Aina', at: ago(40), text: 'Thanks!' }
  ]
  const served = (later: WhatsAppMessage[]) => (x: Running) =>
    serveWatcherFixtures(x.context, {
      whatsapp: { mode: 'chats', chats: [{ name: 'Class 7A', messages: [...chatter, ...later] }] }
    })

  const r = ctx.track(startWorker(world, { link, startInMs: START_IN, endInMs: END_IN, onBrowser: served([]) }))
  const alive = finished(r)

  // The watcher reads the group; there is no class link in it yet.
  await until('the WhatsApp watcher', 120_000, watcherReady(r, 'whatsapp'), alive)
  expect(await stateReached(r, 'joining')()).toBe(false)

  // The rep posts the link, with look-alikes around it, in one go.
  const posted = [LOOKALIKES[0]!, chatJoinLink, ...LOOKALIKES.slice(1)].map<WhatsAppMessage>((href, i) => ({
    id: `p${i}`,
    sender: 'Rep',
    at: new Date().toISOString(),
    text: href === chatJoinLink ? 'Tonight link' : 'Link',
    href
  }))
  await pageOn(r, 'web.whatsapp.com').evaluate(
    (ms) => ms.forEach((m) => (window as unknown as WhatsAppWindow).__addMessage('Class 7A', m)),
    posted
  )

  // The watcher polls every 25 to 45 s before the join: the bot is in the waiting room within a minute or so.
  await joinMeeting(world, r, () => world.zoom.admit())
  const joining = (await r.events()).filter((e) => e.type === 'state' && e.data.state === 'joining')
  expect(joining.map((e) => e.data.link)).toEqual([{ source: 'watched', host: 'e2e.zoom.us' }])

  // The saved link is the one from the chat, nothing else; the file is private to the worker.
  const savedPath = join(r.dataDir, 'joined-link')
  const saved = (await readFile(savedPath, 'utf8')).trim()
  expect(saved).toBe(`https://e2e.zoom.us/wc/join/${MEETING_ID}?pwd=${CHAT_PASSCODE}`)
  expect((await stat(savedPath)).mode & 0o777).toBe(0o600)
  // Only that meeting was opened: no look-alike, no other number, not the entry's own passcode.
  expect(joinPages(world.zoom)).toEqual([`/wc/join/${MEETING_ID}`])
  expect(world.zoom.joinPageLoads()).toBe(1)
  expect(r.decoyRequests).toEqual([])
  expect(r.posts).toHaveLength(0)

  // SIGTERM in the middle of the meeting.
  await pause(6_000)
  r.abort()
  const first = await r.outcome
  expect(first).toMatchObject({ result: 'completed', endedBy: 'terminated', reason: 'terminated' })
  expect(r.endedAt()! - r.abortedAt()!).toBeLessThan(50_000)
  expect((await readFile(savedPath, 'utf8')).trim()).toBe(saved)
  const firstEvents = (await r.events()).length

  // A newer, different meeting link is in the chat by the time the container restarts.
  const later: WhatsAppMessage[] = [
    ...posted,
    { id: 'n1', sender: 'Rep', at: new Date().toISOString(), text: 'Use this one instead', href: OTHER_LINK }
  ]
  const second = ctx.track(
    startWorker(world, {
      link,
      attempt: 2,
      freshProfile: true,
      startInMs: t0 + START_IN - Date.now(),
      endInMs: t0 + END_IN - Date.now(),
      onBrowser: served(later)
    })
  )
  await until(
    'the second attempt in the meeting',
    150_000,
    async () => {
      const events = (await second.events()).slice(firstEvents)
      return events.some((e) => e.type === 'joined')
    },
    finished(second)
  )
  await pause(8_000)
  world.zoom.end()
  const outcome = await second.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })

  // It rejoined the saved link: the same meeting twice in all, from the same source, and no other page was opened.
  const rejoined = (await second.events())
    .slice(firstEvents)
    .filter((e) => e.type === 'state' && e.data.state === 'joining')
  expect(rejoined.map((e) => e.data.link)).toEqual([{ source: 'watched', host: 'e2e.zoom.us' }])
  expect(joinPages(world.zoom)).toEqual([`/wc/join/${MEETING_ID}`, `/wc/join/${MEETING_ID}`])
  expect(world.zoom.requests.join(' ')).not.toContain(OTHER_MEETING)
  expect(second.decoyRequests).toEqual([])
  expect(second.posts).toHaveLength(0)
  expect(await eventsOf(second, 'error')).toEqual([])
  expect((await readFile(savedPath, 'utf8')).trim()).toBe(saved)

  // No link or passcode anywhere the member or the AI service could see it, whichever link it came from.
  // One joined ping per attempt, and nothing else: no form, no watcher problem, no alert.
  expect(world.ntfy.pings.map((p) => p.title)).toEqual(['Joined: Data Mining', 'Joined: Data Mining'])
  await expectNoSecrets(world, second, [JOIN_PASSCODE, CHAT_PASSCODE, ...EVIL_SECRETS], ['e2e.zoom.us'])
})

test('Discord: the class link posted after T-10 is joined, and a look-alike after it is ignored', async () => {
  const { world } = ctx
  test.setTimeout(8 * MINUTE)
  const channel = '/channels/123456789012345678/234567890123456789'
  const link = { kind: 'chat', app: 'discord', chat: `https://discord.com${channel}` } as const
  const messages: DiscordMessage[] = [
    { id: '1000000000000000001', sender: 'Rep', datetime: ago(50), text: 'Class tonight' },
    { id: '1000000000000000002', sender: 'Aina', datetime: ago(40), text: 'Thanks!' }
  ]
  const r = ctx.track(
    startWorker(world, {
      link,
      startInMs: START_IN,
      endInMs: END_IN,
      onBrowser: (x) => serveWatcherFixtures(x.context, { discord: { channelPath: channel, messages } })
    })
  )
  const alive = finished(r)
  await until('the Discord watcher', 120_000, watcherReady(r, 'discord'), alive)
  expect(await stateReached(r, 'joining')()).toBe(false)

  const posted = [chatJoinLink, ...LOOKALIKES].map<DiscordMessage>((href, i) => ({
    id: `100000000000000010${i}`,
    sender: 'Rep',
    datetime: new Date(Date.now() + i * 1000).toISOString(),
    text: href === chatJoinLink ? 'Tonight link' : 'Link',
    href
  }))
  await pageOn(r, 'discord.com').evaluate(
    (ms) => ms.forEach((m) => (window as unknown as DiscordWindow).__addMessage(m)),
    posted
  )

  await joinMeeting(world, r, () => world.zoom.admit())
  const joining = (await r.events()).filter((e) => e.type === 'state' && e.data.state === 'joining')
  expect(joining.map((e) => e.data.link)).toEqual([{ source: 'watched', host: 'e2e.zoom.us' }])
  expect(joinPages(world.zoom)).toEqual([`/wc/join/${MEETING_ID}`])
  expect(r.decoyRequests).toEqual([])

  await pause(6_000)
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(await eventsOf(r, 'error')).toEqual([])
  expect(r.posts).toHaveLength(0)
  expect(world.ntfy.pings.map((p) => p.title)).toEqual(['Joined: Data Mining'])
  await expectNoSecrets(world, r, [JOIN_PASSCODE, CHAT_PASSCODE, ...EVIL_SECRETS], ['e2e.zoom.us'])
})
