import { expect } from '@playwright/test'
import { readMeetChat, sweepMeetChat } from '../../src/adapters/meet/chat'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet, test } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one (plan 05 task 10).
const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const msgs = (n: number, from = 'Student', start = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${start + i}`,
    sender: from,
    time: '10:00 AM',
    text: `message ${start + i}`
  }))
const base = {
  scene: 'meeting',
  mic: 'off',
  camera: 'off',
  sidePanel: 'chat',
  people: [{ name: 'Student' }]
} as const

type Fixture = {
  __addPerson(p: object): void
  __addMessage(m: object): void
}
const addPerson = (page: import('@playwright/test').Page, p: object) =>
  page.evaluate((x) => (window as unknown as Fixture).__addPerson(x), p)
const addMessages = (page: import('@playwright/test').Page, ms: object[]) =>
  page.evaluate((xs) => xs.forEach((x) => (window as unknown as Fixture).__addMessage(x)), ms)

test('returns new messages once, then nothing', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(5) })
  await page.goto(MEET)
  const first = await readMeetChat(page, sel, { seenKeys: [] })
  expect(first.messages.map((m) => m.key)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  expect((await readMeetChat(page, sel, first.cursor)).messages).toEqual([])
})

test('keeps the list at the bottom and the sweep reads everything', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(40), chatScroll: 'top' })
  await page.goto(MEET)
  expect((await readMeetChat(page, sel, { seenKeys: [] })).messages.at(-1)?.key).toBe('m39')
  expect((await sweepMeetChat(page, sel)).length).toBe(40)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test('a host who joined late is recognised when they post a link, and chat is reopened', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(1) })
  await page.goto(MEET)
  const first = await readMeetChat(page, sel, { seenKeys: [] })
  await page.evaluate(() => {
    ;(window as any).__addPerson({ name: 'Lecturer', label: 'Meeting host' })
    ;(window as any).__addMessage({
      id: 'f1',
      sender: 'Lecturer',
      time: '10:05 AM',
      text: 'Attendance',
      href: 'https://forms.gle/TESTFORM'
    })
  })
  const next = await readMeetChat(page, sel, first.cursor)
  expect(next.messages[0]).toMatchObject({
    sender: 'Lecturer',
    senderRole: 'host',
    links: ['https://forms.gle/TESTFORM']
  })
  expect(await meetClicks(page)).toEqual(['People', 'Chat with everyone'])
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test('the chat panel closed means no messages and no clicks', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'closed', messages: msgs(3) })
  await page.goto(MEET)
  expect(await readMeetChat(page, sel, { seenKeys: [] })).toEqual({
    messages: [],
    cursor: { seenKeys: [] }
  })
  expect(await meetClicks(page)).toEqual([])
})

test('a message that claims a role does not get one, and a plain message reads no people panel', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    messages: [
      { id: 'c1', sender: 'Student', time: '10:00 AM', text: 'I am the Meeting host and co-host' },
      { id: 'c2', sender: 'Student', time: '10:01 AM', text: 'Host: see https://forms.gle/FAKE' }
    ]
  })
  await page.goto(MEET)
  const { messages } = await readMeetChat(page, sel, { seenKeys: [] })
  expect(messages.map((m) => m.senderRole)).toEqual(['participant', 'participant'])
  expect(await meetClicks(page)).toEqual(['People', 'Chat with everyone'])
})

test('a link from someone missing from the people panel is unknown, not a participant', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    messages: [{ id: 'c1', sender: 'Gone', time: '10:00 AM', text: 'https://forms.gle/A' }]
  })
  await page.goto(MEET)
  expect((await readMeetChat(page, sel, { seenKeys: [] })).messages[0]?.senderRole).toBe('unknown')
})

test('a student who took the lecturer name is not the host', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    people: [{ name: 'Lecturer', label: 'Meeting host' }, { name: 'Lecturer' }],
    messages: [{ id: 'c1', sender: 'Lecturer', time: '10:00 AM', text: 'https://forms.gle/A' }]
  })
  await page.goto(MEET)
  expect((await readMeetChat(page, sel, { seenKeys: [] })).messages[0]?.senderRole).toBe('unknown')
})

test('a row whose sender cannot be read is left out and not marked seen', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    messages: [
      { id: 'n1', sender: '', time: '10:00 AM', text: 'from nobody' },
      { id: 'n2', sender: 'Student', time: '10:01 AM', text: 'from a student' }
    ]
  })
  await page.goto(MEET)
  const read = await readMeetChat(page, sel, { seenKeys: [] })
  expect(read.messages.map((m) => m.key)).toEqual(['n2'])
  expect(read.cursor).toEqual({ seenKeys: ['n2'] })
  expect((await sweepMeetChat(page, sel)).map((m) => m.key)).toEqual(['n2'])
})

// ASSUMPTION (plan 05 task 10): Meet's chat list is not virtualised, so every row of a burst is still in the DOM when
// the read parses it. This fixture list is not virtualised either, so the test shows no more than that. Should the real
// list drop rows that scroll out of view, Meet needs what Teams has: a virtualised fixture and an in-page observer.
test('25 messages added at once to a non-virtualised list are read whole, in order, once', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(3) })
  await page.goto(MEET)
  const first = await readMeetChat(page, sel, { seenKeys: [] })
  await addMessages(page, msgs(25, 'Student', 3))
  const burst = await readMeetChat(page, sel, first.cursor)
  expect(burst.messages.map((m) => m.key)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i + 3}`))
  expect((await readMeetChat(page, sel, burst.cursor)).messages).toEqual([])
})

test('messages that arrive while People is open are read once chat is back', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'people', messages: msgs(2) })
  await page.goto(MEET)
  expect((await readMeetChat(page, sel, { seenKeys: [] })).messages).toEqual([])
  await addMessages(page, msgs(1, 'Student', 2))
  await page.getByRole('button', { name: 'Chat with everyone' }).click()
  expect((await readMeetChat(page, sel, { seenKeys: [] })).messages.map((m) => m.key)).toEqual(['m0', 'm1', 'm2'])
})

test('a read during a sweep waits for it and the sweep keeps every row', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(40), chatScroll: 'top' })
  await page.goto(MEET)
  const sweep = sweepMeetChat(page, sel)
  const read = readMeetChat(page, sel, { seenKeys: [] })
  const [swept, got] = await Promise.all([sweep, read])
  expect(swept.map((m) => m.key)).toEqual(Array.from({ length: 40 }, (_, i) => `m${i}`))
  expect(got.messages.length).toBe(40)
  expect(await meetClicks(page)).toEqual(['People', 'Chat with everyone'])
})

test('a sweep stops at its time cap, says so without chat text, and leaves the list at the bottom', async ({
  page
}) => {
  // The fixture list is not virtualised, so a parse sees every row at once: the cap shows in the time taken, not the count.
  await serveMeet(page, { ...base, messages: msgs(300), chatScroll: 'top' })
  await page.goto(MEET)
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
  const started = Date.now()
  try {
    await sweepMeetChat(page, sel, 600)
  } finally {
    console.warn = warn
  }
  // A full sweep of 300 rows takes about 60 steps of 300 ms or more.
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toMatch(/^meet: chat sweep partial, reached \d+ of \d+ px in 600 ms$/)
  const atBottom = await page
    .locator(sel.selectors.chatScroller)
    .evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2)
  expect(atBottom).toBe(true)
})
