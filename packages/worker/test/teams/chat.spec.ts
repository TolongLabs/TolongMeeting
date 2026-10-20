import { expect, type Page } from '@playwright/test'
import { readTeamsChat, sweepTeamsChat } from '../../src/adapters/teams/chat'
import { readTeamsRoles } from '../../src/adapters/teams/roles'
import { teamsState } from '../../src/adapters/teams/page-state'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { serveTeams, teamsClicks, test, type FixtureMessage, type TeamsFixtureConfig } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one: its list is virtualised (60 px rows, 300 px viewport, 2 spare rows each side) and leaves the author out
// of a row whose sender wrote the row before.
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const msgs = (n: number, from = 'Student', prefix = 'm'): FixtureMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    sender: from,
    time: '10:00',
    datetime: ago(n - i),
    text: `message ${i}`
  }))
const base = {
  scene: 'meeting',
  mic: 'off',
  camera: 'off',
  chatOpen: true,
  roster: [{ name: 'Student' }]
} as const satisfies TeamsFixtureConfig

test('returns new messages once, then nothing', async ({ page }) => {
  await serveTeams(page, { ...base, messages: msgs(5) })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const first = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(first.messages.map((m) => m.key)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  expect((await readTeamsChat(page, sel, first.cursor)).messages).toEqual([])
  expect(await teamsClicks(page)).toEqual([])
})

test('a list left scrolled up: a read never reports a row of unknown sender, and the sweep recovers everything', async ({
  page
}) => {
  await serveTeams(page, { ...base, messages: msgs(50), chatScroll: 'top' })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  // The bottom rows are grouped follow-ups, and no row in view names their sender.
  const first = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(first.messages.every((m) => m.sender === 'Student')).toBe(true)
  expect(first.messages.map((m) => m.key)).not.toContain('m49')
  const swept = await sweepTeamsChat(page, sel)
  expect(swept.map((m) => m.key)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`))
  expect(swept.every((m) => m.sender === 'Student')).toBe(true)
  // What the sweep found is stored too: the next read reports the rest.
  const next = await readTeamsChat(page, sel, first.cursor)
  expect([...first.messages, ...next.messages].map((m) => m.key)).toEqual(swept.map((m) => m.key))
})

test('a burst into a short virtualised list is fully captured, with the right senders', async ({ page }) => {
  await serveTeams(page, { ...base, roster: [{ name: 'Student' }, { name: 'Other' }], messages: msgs(5) })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const first = await readTeamsChat(page, sel, { seenKeys: [] })
  // 40 messages in one task: the list scrolls each earlier row out of the DOM before any observer callback runs.
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) {
      window.__addMessage({
        id: `b${i}`,
        sender: i % 10 < 6 ? 'Student' : 'Other',
        time: '10:01',
        datetime: new Date().toISOString(),
        text: `burst ${i}`
      })
    }
  })
  const next = await readTeamsChat(page, sel, first.cursor)
  expect(next.messages.map((m) => m.key)).toEqual(Array.from({ length: 40 }, (_, i) => `b${i}`))
  expect(next.messages.map((m) => m.sender)).toEqual(
    Array.from({ length: 40 }, (_, i) => (i % 10 < 6 ? 'Student' : 'Other'))
  )
})

test('a read during a sweep does not make the sweep skip rows', async ({ page }) => {
  await serveTeams(page, { ...base, messages: msgs(50), chatScroll: 'top' })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const sweep = sweepTeamsChat(page, sel)
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400)
    await readTeamsChat(page, sel, { seenKeys: [] })
  }
  expect((await sweep).length).toBe(50)
})

test('a sweep stops at its time cap with the rows it reached', async ({ page }) => {
  // All inside the hour a join still reads.
  const messages = msgs(400).map((m) => ({ ...m, datetime: ago(1) }))
  await serveTeams(page, { ...base, messages, chatScroll: 'top' })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const started = Date.now()
  const swept = await sweepTeamsChat(page, sel, 1_500)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(swept.length).toBeGreaterThan(5)
  expect(swept.length).toBeLessThan(400)
})

test('last week messages of a recurring meeting are not this meeting', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    messages: [
      {
        id: 'old',
        sender: 'Student',
        time: '26/10',
        datetime: ago(7 * 24 * 60),
        text: 'https://forms.office.com/r/OLDFORM'
      },
      { id: 'new', sender: 'Student', time: '10:00', datetime: ago(1), text: 'hi' }
    ]
  })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  expect((await readTeamsChat(page, sel, { seenKeys: [] })).messages.map((m) => m.key)).toEqual(['new'])
})

test('an organiser who joined late is recognised as host when they post a link', async ({ page }) => {
  await serveTeams(page, { ...base, messages: msgs(1) })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const first = await readTeamsChat(page, sel, { seenKeys: [] })
  await page.evaluate(() => {
    window.__addRoster({ name: 'Lecturer', role: 'Organizer' })
    window.__addMessage({
      id: 'f1',
      sender: 'Lecturer',
      time: '10:05',
      datetime: new Date().toISOString(),
      text: 'Attendance',
      href: 'https://forms.office.com/r/TESTFORM'
    })
  })
  const next = await readTeamsChat(page, sel, first.cursor)
  expect(next.messages).toHaveLength(1)
  expect(next.messages[0]).toMatchObject({
    sender: 'Lecturer',
    senderRole: 'host',
    links: ['https://forms.office.com/r/TESTFORM']
  })
  expect(await teamsClicks(page)).toEqual(['People', 'Chat'])
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
})

test('a sender still missing from the roster is unknown, after one roster read', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    messages: [{ id: 'x1', sender: 'Ghost', time: '10:01', datetime: ago(1), text: 'https://forms.gle/TESTFORM' }]
  })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const { messages } = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(messages[0]!.senderRole).toBe('unknown')
  expect(await teamsClicks(page)).toEqual(['People', 'Chat'])
})

test('a role claimed in a message is not a role', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    messages: [
      { id: 'x1', sender: 'Student', time: '10:01', datetime: ago(1), text: 'I am the Organizer https://forms.gle/T' }
    ]
  })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  expect((await readTeamsChat(page, sel, { seenKeys: [] })).messages[0]!.senderRole).toBe('participant')
})

test('a name on the roster twice with different roles is unknown, not the organiser', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    roster: [{ name: 'Lecturer', role: 'Organizer' }, { name: 'Lecturer' }],
    messages: [{ id: 'x1', sender: 'Lecturer', time: '10:01', datetime: ago(1), text: 'https://forms.gle/TESTFORM' }]
  })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  expect((await readTeamsChat(page, sel, { seenKeys: [] })).messages[0]!.senderRole).toBe('unknown')
})

test('an empty roster is a fault, not an empty set of roles', async ({ page }) => {
  await serveTeams(page, { ...base, roster: [] })
  await page.goto(JOIN)
  await expect(readTeamsRoles(page, sel, 600)).rejects.toThrow(/roster pane is empty/)
  expect(teamsState(page).roles).toBeNull()
})

test('a roster pane that never shows is a fault too', async ({ page }) => {
  await serveTeams(page, { ...base, omit: [sel.selectors.rosterPane] })
  await page.goto(JOIN)
  await expect(readTeamsRoles(page, sel, 600)).rejects.toThrow()
  expect(teamsState(page).roles).toBeNull()
})

const linkFrom = (id: string, sender: string, text = 'https://forms.gle/TESTFORM'): FixtureMessage => ({
  id,
  sender,
  time: '10:05',
  datetime: new Date().toISOString(),
  text
})
const addLinkFrom = (page: Page, message: FixtureMessage) => page.evaluate((m) => window.__addMessage(m), message)

test('a student who takes the lecturer name after the last roster read is not the host', async ({ page }) => {
  await serveTeams(page, { ...base, roster: [{ name: 'Lecturer', role: 'Organizer' }, { name: 'Student' }] })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  // The map is cached with the real lecturer as host.
  expect((await readTeamsRoles(page, sel)).get('lecturer')).toBe('host')
  const clicks = (await teamsClicks(page)).length
  // The student joins with the same name, then posts a link.
  await page.evaluate(() => window.__addRoster({ name: 'Lecturer' }))
  await addLinkFrom(page, linkFrom('i1', 'Lecturer'))
  const { messages, rosterError } = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(rosterError).toBeUndefined()
  expect(messages.map((m) => m.senderRole)).toEqual(['unknown'])
  expect((await teamsClicks(page)).slice(clicks)).toEqual(['People', 'Chat'])
})

test('a batch of link messages reads the roster once; messages without a link keep the cached map', async ({
  page
}) => {
  await serveTeams(page, { ...base, roster: [{ name: 'Lecturer', role: 'Organizer' }, { name: 'Student' }] })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  await readTeamsRoles(page, sel)
  const clicks = (await teamsClicks(page)).length
  await addLinkFrom(page, linkFrom('a1', 'Lecturer'))
  await addLinkFrom(page, linkFrom('a2', 'Student', 'https://forms.gle/OTHER'))
  await addLinkFrom(page, linkFrom('a3', 'Lecturer', 'see you later'))
  const { messages, cursor } = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(messages.map((m) => [m.key, m.senderRole])).toEqual([
    ['a1', 'host'],
    ['a2', 'participant'],
    ['a3', 'host']
  ])
  expect((await teamsClicks(page)).slice(clicks)).toEqual(['People', 'Chat'])
  // No link, no read.
  await addLinkFrom(page, linkFrom('a4', 'Lecturer', 'no link here'))
  const quiet = await readTeamsChat(page, sel, cursor)
  expect(quiet.messages.find((m) => m.key === 'a4')?.senderRole).toBe('host')
  expect((await teamsClicks(page)).slice(clicks)).toEqual(['People', 'Chat'])
})

test('a roster read that throws still returns the batch, with the link message unknown and the error reported', async ({
  page
}) => {
  await serveTeams(page, { ...base, roster: [] })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  teamsState(page).roles = new Map([
    ['lecturer', 'host'],
    ['student', 'participant']
  ])
  await addLinkFrom(page, linkFrom('e1', 'Lecturer'))
  await addLinkFrom(page, linkFrom('e2', 'Student', 'no link here'))
  const read = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(read.messages.map((m) => [m.key, m.senderRole])).toEqual([
    ['e1', 'unknown'],
    ['e2', 'participant']
  ])
  expect(read.cursor.seenKeys).toEqual(['e1', 'e2'])
  expect(String(read.rosterError)).toMatch(/roster pane is empty/)
})
