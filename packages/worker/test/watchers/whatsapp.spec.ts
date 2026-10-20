import { expect, test } from '@playwright/test'
import { WatcherSigninError, resetWatcherEnv, type DeskStep } from '../../src/watchers/loop'
import { whatsappSelectors } from '../../src/watchers/selectors'
import { startWatcher, whatsappReader } from '../../src/watchers/whatsapp'
import { serveWatcherFixtures, type WhatsAppChat, type WhatsAppMessage, type WhatsAppWindow } from './serve'
import { watchHarness } from './harness'

test.use({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' })
test.beforeEach(() => resetWatcherEnv())

const zoom = (n: number) => `https://example.zoom.us/j/0000000000${n}?pwd=PASSCODE`
const [Z0, Z1, Z2] = [0, 1, 2].map(zoom)
const F2 = 'https://forms.gle/TESTFORM2'

const direct: DeskStep = (step) => step()
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
// Linkless messages from 19 hours to 3 hours ago, from different senders.
const filler = (count: number): WhatsAppMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    sender: `Member ${i % 7}`,
    at: ago(19 - (16 * i) / (count - 1)),
    text: `Chatter ${i}`
  }))

const history: WhatsAppMessage[] = [
  { id: 'old', sender: 'Rep', at: ago(30), text: 'Last week', href: Z0 },
  { id: 'a', sender: 'Rep', at: ago(20), text: 'Yesterday', href: Z1 },
  ...filler(60),
  { id: 'b', sender: 'Rep', at: ago(2), text: 'Today', href: Z2 },
  { id: 'c', sender: 'Rep', at: ago(1), text: 'Early form', href: 'https://forms.gle/TESTFORM1' },
  { id: 'd', sender: 'Rep', at: ago(0.2), text: 'See you soon' }
]

const chat = (name: string, messages: WhatsAppMessage[] = []): WhatsAppChat => ({ name, messages })
const touched = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as WhatsAppWindow).__touched ?? false)

test('opens the chat with exactly that name and leaves the search empty', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    whatsapp: { mode: 'chats', chats: [chat('Class 7A (old)'), chat('class 7a'), chat('Class 7A', history)] }
  })
  const h = watchHarness()
  const stop = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
  const sel = await whatsappSelectors()
  expect(await page.textContent(sel.headerTitle)).toBe('Class 7A')
  expect((await page.textContent(sel.searchBox))?.trim()).toBe('')
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
  expect(await touched(page)).toBe(false)
  await stop.stop()
})

test('a shared name is ambiguous, a missing one not found, a composed form matches', async ({ context, page }) => {
  // The fixture stores "Café" decomposed (e + combining accent); the request is composed and has a trailing space.
  await serveWatcherFixtures(context, {
    whatsapp: { mode: 'chats', chats: [chat('Study group'), chat('Study group'), chat('Café')] }
  })
  const stops: { stop(): Promise<void> }[] = []
  const reason = (name: string) =>
    startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: name }, () => {}).then(
      (s) => {
        stops.push(s)
        return 'ok'
      },
      (e: { reason?: string }) => e.reason
    )
  expect(await reason('Study group')).toBe('ambiguous')
  expect(await reason('Nope')).toBe('not_found')
  expect(await reason('Café ')).toBe('ok')
  for (const s of stops) await s.stop()
})

test('the link-device code means signed out', async ({ context, page }) => {
  await serveWatcherFixtures(context, { whatsapp: { mode: 'qr', chats: [] } })
  const e = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, () => {}).catch(
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(WatcherSigninError)
  expect((e as WatcherSigninError).host).toBe('web.whatsapp.com')
})

test('form links during the meeting carry the WhatsApp sender', async ({ context, page }) => {
  await serveWatcherFixtures(context, { whatsapp: { mode: 'chats', chats: [chat('Class 7A', history)] } })
  const h = watchHarness()
  const stop = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
  h.set({ phase: () => 'during', formsSince: () => new Date(Date.now() - 600_000) })
  await page.evaluate(
    (f) =>
      (window as unknown as WhatsAppWindow).__addMessage('Class 7A', {
        id: 'w1',
        sender: 'Dr Lecturer',
        at: new Date().toISOString(),
        text: `Attendance ${f}`
      }),
    F2
  )
  await h.polls(1)
  await stop.stop()
  expect(h.forms.map((c) => [c.url, c.sender])).toEqual([[F2, 'Dr Lecturer']])
  expect(await touched(page)).toBe(false)
})

test('a chat the member switched away from is reopened, at most 3 times', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    whatsapp: { mode: 'chats', chats: [chat('Class 7A', history), chat('Other')] }
  })
  const h = watchHarness()
  const stop = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
  const sel = await whatsappSelectors()
  const away = () => page.evaluate(() => (window as unknown as WhatsAppWindow).__switchChat('Other'))
  // The member switches away right after each of the first three reopens puts the chat back.
  let switches = 0
  h.set({
    deskStep: async (step) => {
      const result = await step()
      const shown = await page.textContent(sel.headerTitle)
      if (shown === 'Class 7A' && switches < 3) {
        switches++
        await away()
      }
      return result
    }
  })
  await away()
  await expect.poll(() => h.statuses, { timeout: 20_000 }).toEqual([{ kind: 'chat_lost' }])
  await stop.stop()
  // Three reopens put the chat back each time; the fourth loss is reported and the chat is left alone.
  expect(switches).toBe(3)
  expect(await page.textContent(sel.headerTitle)).toBe('Other')
})

test('the history scroll reaches back to the cut-off, in chat order, and sends nothing', async ({ context, page }) => {
  await serveWatcherFixtures(context, { whatsapp: { mode: 'chats', chats: [chat('Class 7A', history)] } })
  const reader = whatsappReader('Class 7A', await whatsappSelectors())
  await reader.open(page)
  const read = await reader.history(page, new Date(Date.now() - 24 * 3_600_000), direct)
  // 'old' is 30 hours back: scrolling stops once it is collected, and the time filter cuts it.
  expect(read.map((m) => m.key)).toEqual(
    ['a', ...filler(60).map((m) => m.id), 'b', 'c', 'd'].map((id) => `Class 7A:${id}`)
  )
  expect(read[0]).toMatchObject({ sender: 'Rep', senderRole: 'unknown', replyTo: null, links: [Z1] })
  // The sent time is an ISO date: the watcher loop places a form link in time by it.
  expect(read[0]!.time).toBe(history[1]!.at.replace(/:\d{2}\.\d{3}Z$/, ':00.000Z'))
  // The page keeps the older rows it loaded, 'old' among them: a poll must not report any row from before the scan's
  // start, or an old meeting link would become the newest.
  expect(await page.locator('[data-id="Class 7A:old"]').count()).toBe(1)
  expect((await reader.latest(page)).map((m) => m.key)).toEqual(read.map((m) => m.key))
  expect(await touched(page)).toBe(false)
})

test.describe('US date order', () => {
  test.use({ locale: 'en-US' })
  test('the 24-hour scan still finds the newest link', async ({ context, page }) => {
    await serveWatcherFixtures(context, { whatsapp: { mode: 'chats', chats: [chat('Class 7A', history)] } })
    const h = watchHarness()
    const stop = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
    await stop.stop()
    expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
  })
})
