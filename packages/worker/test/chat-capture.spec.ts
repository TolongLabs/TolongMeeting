import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parseJob, type ChatMessage, type EventType, type FormCandidate, type ResolvedForm } from '@tm/core'
import { zoomAdapter, type PlatformAdapter } from '../src/adapters'
import { appendDurably, startChatCapture } from '../src/chat/capture'
import { createFormPinger, type FormPingerDeps } from '../src/forms/pinger'
import { formProviderOf } from '../src/forms/links'

const GOOGLE_FORM = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform'

let dir: string
let file: string
let events: Array<{ type: EventType; data: Record<string, unknown> }>
const emit = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
  events.push({ type, data })
}
const errors = (): Array<Record<string, unknown>> => events.filter((e) => e.type === 'error').map((e) => e.data)

const rows = async (): Promise<ChatMessage[]> =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ChatMessage)
const keys = async (): Promise<string[]> => (await rows()).map((m) => m.key)

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-chat-'))
  file = join(dir, 'chat.jsonl')
  events = []
})

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('each message lands in chat.jsonl once, before it is delivered', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  const delivered: ChatMessage[] = []
  const durableWhenDelivered: boolean[] = []
  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      delivered.push(m)
      durableWhenDelivered.push((await keys()).includes(m.key))
    },
    { pollMs: 200, emit }
  )
  await expect.poll(() => delivered.length).toBe(4)
  await c.stop()
  expect(durableWhenDelivered).toEqual([true, true, true, true])
  expect(await keys()).toEqual(delivered.map((m) => m.key))
  expect(new Set(await keys()).size).toBe(4)
  expect(errors()).toEqual([])
})

test('form links in messages are offered to the form pinger', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  const cfg = parseJob({
    occurrenceId: 'occ-chat',
    attempt: 1,
    entry: {
      name: 'Data Mining',
      type: 'lecture',
      start: '2026-10-21T14:00:00+08:00',
      end: '2026-10-21T16:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'paste' },
      trustedSenders: ['Dr Lecturer'],
      transcription: 'live',
      formDetails: {},
      attendanceKeywords: []
    },
    identity: { id: 'id-1', name: 'Member', zoomGuestName: 'Member', formProviders: ['google', 'microsoft'] },
    member: { id: 'm-1', displayName: 'Member', mentionNames: [], details: [] },
    ai: {
      baseUrl: 'https://ai.example/v1',
      apiKey: 'key',
      asrUrl: 'wss://asr.example/ws',
      models: { summary: 's', vision: 'v', formMatch: 'f', asr: 'a' }
    },
    ntfy: { url: 'http://127.0.0.1:9/', topic: 'tm-test', token: 'tok' },
    dataDir: dir,
    profileDir: join(dir, 'profile'),
    control: null
  })
  // Stands in for the network: forms.gle resolves to a Google form, the Microsoft link is already final.
  const resolve = async (c: FormCandidate): Promise<ResolvedForm | null> => {
    const finalUrl = new URL(c.url).hostname === 'forms.gle' ? GOOGLE_FORM : c.url
    const provider = formProviderOf(finalUrl)
    return provider === null ? null : { ...c, finalUrl, provider }
  }
  const pings: unknown[] = []
  const pinger = createFormPinger({
    cfg,
    send: async (p) => {
      pings.push(p)
    },
    emit,
    resolve
  } satisfies FormPingerDeps)

  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      for (const url of m.links) {
        await pinger.offer({
          url,
          source: 'meeting_chat',
          sender: m.sender,
          senderRole: m.senderRole,
          seenAt: m.seenAt
        })
      }
    },
    { pollMs: 200, emit }
  )
  await expect.poll(async () => (await rows()).length).toBe(4)
  await c.stop()
  await pinger.idle()
  expect(pings).toHaveLength(2)
  expect((await readdir(join(dir, 'forms'))).length).toBe(2)
  expect((await rows()).flatMap((m) => m.links)).toEqual(['https://forms.gle/abc', 'https://forms.office.com/r/xyz'])
})

test('a sweep adds the rows the polls missed, with no duplicates', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html?seed=60')
  // The poll only sees the rows in view at the bottom of the virtualised list.
  const c = await startChatCapture(page, zoomAdapter, file, async () => {}, { pollMs: 200, sweepMs: 600_000, emit })
  await expect.poll(async () => (await rows()).length).toBeGreaterThan(0)
  expect((await rows()).length).toBeLessThan(60)
  await c.sweepNow()
  await c.stop()
  const written = await keys()
  expect(written).toHaveLength(60)
  expect(new Set(written).size).toBe(60)
  expect(errors()).toEqual([])
})

test('a thrown read is reported and capture carries on', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  let reads = 0
  const flaky: PlatformAdapter = {
    ...zoomAdapter,
    readChat: async (p, cursor) => {
      reads += 1
      if (reads <= 2) throw new Error('frame was detached')
      return zoomAdapter.readChat(p, cursor)
    }
  }
  const c = await startChatCapture(page, flaky, file, async () => {}, { pollMs: 200, emit })
  await expect.poll(async () => (await keys()).length).toBe(4)
  await c.stop()
  expect(errors().map((e) => [e.where, e.step, e.message])).toEqual([
    ['chat', 'read', 'frame was detached'],
    ['chat', 'read', 'frame was detached']
  ])
  expect(new Set(await keys()).size).toBe(4)
})

test('a failed append is retried and writes nothing twice', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  let fail = true
  const append = async (f: string, data: string) => {
    if (fail) {
      fail = false
      throw Object.assign(new Error('EIO: input/output error'), { code: 'EIO' })
    }
    await appendDurably(f, data)
  }
  const delivered: string[] = []
  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      delivered.push(m.key)
    },
    { pollMs: 200, append, emit }
  )
  await expect.poll(async () => (await keys()).length).toBe(4)
  await c.stop()
  expect(errors()).toEqual([{ where: 'chat', step: 'append', code: 'EIO', message: 'EIO: input/output error' }])
  expect(new Set(await keys()).size).toBe(4)
  expect(delivered).toEqual(await keys())
})

test('a restart over an existing chat.jsonl writes no row twice', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html?seed=60')
  const a = await startChatCapture(page, zoomAdapter, file, async () => {}, { pollMs: 200, sweepMs: 1_000, emit })
  await expect.poll(async () => (await keys()).length, { timeout: 30_000 }).toBe(60)
  await a.stop()
  const before = await readFile(file, 'utf8')

  await page.reload()
  const delivered: string[] = []
  const b = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      delivered.push(m.key)
    },
    { pollMs: 200, emit }
  )
  await b.sweepNow()
  await b.stop()
  expect(await readFile(file, 'utf8')).toBe(before)
  expect(delivered).toEqual([])
  expect(new Set(await keys()).size).toBe(60)
  expect(errors()).toEqual([])
})

test('a torn last line from a crash is cut off and its message read again', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  const kept: ChatMessage = {
    key: 'Dr Lecturer|8:41 PM|Attendance: https://forms.gle/abc',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    time: '8:41 PM',
    seenAt: '2026-10-21T08:41:00.000Z',
    text: 'Attendance: https://forms.gle/abc',
    links: ['https://forms.gle/abc'],
    replyTo: null
  }
  await writeFile(file, `${JSON.stringify(kept)}\n{"key":"Student A|8:42`)
  const c = await startChatCapture(page, zoomAdapter, file, async () => {}, { pollMs: 200, emit })
  await expect.poll(async () => (await keys()).length).toBe(4)
  await c.stop()
  expect(new Set(await keys()).size).toBe(4)
  expect((await keys())[0]).toBe(kept.key)
  expect(errors()).toEqual([])
})
