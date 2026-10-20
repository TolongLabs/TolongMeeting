import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { parseJob, type ChatMessage, type EventType, type FormCandidate, type ResolvedForm } from '@tm/core'
import { zoomAdapter, type PlatformAdapter } from '../src/adapters'
import { appendDurably, startChatCapture, type AppendHandle } from '../src/chat/capture'
import { onFormCandidate } from '../src/forms/intake'
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

test('form links in messages are resolved and offered to the form dispatcher', async ({ page }) => {
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
  const offered: ResolvedForm[] = []
  const tasks: Promise<void>[] = []
  const inFlight = new Set<string>()

  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      for (const url of m.links) {
        const candidate: FormCandidate = {
          url,
          source: 'meeting_chat',
          sender: m.sender,
          senderRole: m.senderRole,
          seenAt: m.seenAt
        }
        tasks.push(
          onFormCandidate(candidate, {
            cfg,
            resolve,
            dispatcher: { offer: (f) => void offered.push(f), close: async () => [] },
            emitEvent: emit,
            ping: async () => {},
            inFlight,
            pinged: new Set<string>()
          })
        )
      }
    },
    { pollMs: 200, emit }
  )
  await expect.poll(async () => (await rows()).length).toBe(4)
  await c.stop()
  await Promise.all(tasks)
  expect(offered.map((f) => [f.finalUrl, f.provider]).sort()).toEqual([
    [GOOGLE_FORM, 'google'],
    ['https://forms.office.com/r/xyz', 'microsoft']
  ])
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

// Six messages arrive one frame apart, and the list moves down to each new one before the next arrives. The 4-row list
// shows each of them only for a moment, so a parse that waits 250 ms sees just the last window. The sweep is 10 minutes
// away, so every row has to be captured as it renders.
test('a burst that scrolls past each new row keeps all six without a sweep', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  const c = await startChatCapture(page, zoomAdapter, file, async () => {}, { pollMs: 200, sweepMs: 600_000, emit })
  await expect.poll(async () => (await keys()).length).toBe(4)
  await page.evaluate(async () => {
    const fixture = (window as unknown as { __fixture: { addMessage(m: object): void; scrollTop(y: number): void } })
      .__fixture
    for (let i = 1; i <= 6; i++) {
      fixture.addMessage({ sender: 'Student Burst', time: `8:5${i} PM`, text: `burst ${i}` })
      fixture.scrollTop(80 * i)
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
  })
  await expect.poll(async () => (await keys()).length, { timeout: 5_000 }).toBe(10)
  await c.stop()
  const burst = (await rows()).filter((m) => m.sender === 'Student Burst').map((m) => m.text)
  expect(burst).toEqual(['burst 1', 'burst 2', 'burst 3', 'burst 4', 'burst 5', 'burst 6'])
  expect(new Set(await keys()).size).toBe(10)
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
    ['chat', 'read', 'read failed'],
    ['chat', 'read', 'read failed']
  ])
  // The thrown message is not copied into the event.
  expect(JSON.stringify(events)).not.toContain('detached')
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
  expect(errors()).toEqual([{ where: 'chat', step: 'append', code: 'EIO', message: 'append failed' }])
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

// Opens the file for real, but its first write lands `keep` characters and then fails with EIO. `cutBack`, when given,
// is the error truncate throws.
const partialWrite =
  (keep: number, cutBack?: Error) =>
  async (path: string): Promise<AppendHandle> => {
    const real = await open(path, 'a')
    return {
      stat: () => real.stat(),
      appendFile: async (data: string) => {
        await real.appendFile(data.slice(0, keep))
        throw Object.assign(new Error('EIO: input/output error'), { code: 'EIO' })
      },
      sync: () => real.sync(),
      truncate: async (len: number) => {
        if (cutBack !== undefined) throw cutBack
        await real.truncate(len)
      },
      close: () => real.close()
    }
  }

test('a write that fails after a partial write is cut back to the size before it', async () => {
  await writeFile(file, 'row one\n')
  const data = 'row two is longer\n'
  await expect(appendDurably(file, data, partialWrite(6))).rejects.toMatchObject({ code: 'EIO' })
  expect(await readFile(file, 'utf8')).toBe('row one\n')
  await appendDurably(file, data)
  expect(await readFile(file, 'utf8')).toBe(`row one\n${data}`)
})

test('when the cut-back also fails, the write error is the one thrown', async () => {
  await writeFile(file, 'row one\n')
  const cutBack = Object.assign(new Error('read-only file system'), { code: 'EROFS' })
  await expect(appendDurably(file, 'row two\n', partialWrite(4, cutBack))).rejects.toMatchObject({ code: 'EIO' })
  // The partial bytes stay: the next start cuts them off only if they are the last line.
  expect(await readFile(file, 'utf8')).toBe('row one\nrow ')
})

test('a delivery that throws is retried on the next tick and delivered once, in order', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  let failed = false
  const delivered: string[] = []
  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      if (!failed) {
        failed = true
        throw new Error(`cannot show ${m.text}`)
      }
      delivered.push(m.key)
    },
    { pollMs: 200, emit }
  )
  await expect.poll(() => delivered.length).toBe(4)
  await c.stop()
  expect(delivered).toEqual(await keys())
  expect(errors()).toEqual([{ where: 'chat', step: 'deliver', code: null, message: 'delivery failed' }])
  // The failure's text is chat text and must not reach an event.
  expect(JSON.stringify(events)).not.toContain('Attendance')
})

test('a delivery that always throws is abandoned after three attempts and the rows behind it go on', async ({
  page
}) => {
  await page.goto('/zoom-meeting-top.html')
  const attempts = new Map<string, number>()
  const delivered: string[] = []
  let stuck: string | null = null
  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      stuck ??= m.key
      attempts.set(m.key, (attempts.get(m.key) ?? 0) + 1)
      if (m.key === stuck) throw new Error(`cannot show ${m.text}`)
      delivered.push(m.key)
    },
    { pollMs: 200, emit }
  )
  await expect.poll(() => delivered.length, { timeout: 5_000 }).toBe(3)
  const before = await readFile(file, 'utf8')
  // Further ticks neither retry the skipped row nor write anything.
  await new Promise((r) => setTimeout(r, 700))
  await c.stop()
  expect(await readFile(file, 'utf8')).toBe(before)
  expect(attempts.get(stuck!)).toBe(3)
  const written = await keys()
  expect(written).toHaveLength(4)
  expect(delivered).toEqual(written.filter((k) => k !== stuck))
  const abandoned = errors().filter((e) => e.message === 'delivery abandoned')
  expect(abandoned).toEqual([
    { where: 'chat', step: 'deliver', code: null, message: 'delivery abandoned', line: written.indexOf(stuck!) + 1 }
  ])
  expect(errors().filter((e) => e.message === 'delivery failed')).toHaveLength(2)
  expect(JSON.stringify(events)).not.toContain('Attendance')
  expect(JSON.stringify(events)).not.toContain(stuck!)
})

test('a replay that always throws is abandoned after three attempts, with step replay', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  const row = (n: number): ChatMessage => ({
    key: `Student ${n}|8:4${n} PM|secret text ${n}`,
    sender: `Student ${n}`,
    senderRole: 'participant',
    time: `8:4${n} PM`,
    seenAt: `2026-10-21T08:4${n}:00.000Z`,
    text: `secret text ${n}`,
    links: [],
    replyTo: null
  })
  const seeded = [row(1), row(2), row(3)].map((m) => `${JSON.stringify(m)}\n`).join('')
  await writeFile(file, seeded)
  const idle: PlatformAdapter = {
    ...zoomAdapter,
    readChat: async (_p, cursor) => ({ messages: [], cursor }),
    sweepChat: async () => []
  }
  const replayed: string[] = []
  const tries = new Map<string, number>()
  const c = await startChatCapture(page, idle, file, async () => {}, {
    pollMs: 200,
    emit,
    onReplay: async (m) => {
      tries.set(m.key, (tries.get(m.key) ?? 0) + 1)
      if (m.key === row(2).key) throw new Error(m.text)
      replayed.push(m.key)
    }
  })
  await expect.poll(() => replayed.length, { timeout: 5_000 }).toBe(2)
  await c.stop()
  expect(replayed).toEqual([row(1).key, row(3).key])
  expect(tries.get(row(2).key)).toBe(3)
  expect(errors().filter((e) => e.message === 'delivery abandoned')).toEqual([
    { where: 'chat', step: 'replay', code: null, message: 'delivery abandoned', line: 2 }
  ])
  expect(await readFile(file, 'utf8')).toBe(seeded)
  expect(JSON.stringify(events)).not.toContain('secret')
})

test('a restart replays the rows on disk through onReplay before the first poll, and does not deliver them', async ({
  page
}) => {
  await page.goto('/zoom-meeting-top.html?seed=2')
  const a = await startChatCapture(page, zoomAdapter, file, async () => {}, { pollMs: 200, emit })
  await expect.poll(async () => (await keys()).length).toBe(2)
  await a.stop()
  const before = await readFile(file, 'utf8')

  await page.reload()
  const log: string[] = []
  const replayed: string[] = []
  const delivered: string[] = []
  const reading: PlatformAdapter = {
    ...zoomAdapter,
    readChat: async (p, cursor) => {
      log.push('read')
      return zoomAdapter.readChat(p, cursor)
    }
  }
  const b = await startChatCapture(
    page,
    reading,
    file,
    async (m) => {
      delivered.push(m.key)
    },
    {
      pollMs: 200,
      emit,
      onReplay: async (m) => {
        replayed.push(m.key)
        log.push(`replay ${m.key}`)
      }
    }
  )
  expect(b.loaded.map((m) => m.key)).toEqual(await keys())
  await expect.poll(() => log.includes('read')).toBe(true)
  await b.stop()
  expect(log.slice(0, 3)).toEqual([`replay ${replayed[0]}`, `replay ${replayed[1]}`, 'read'])
  expect(replayed).toEqual(await keys())
  expect(delivered).toEqual([])
  expect(await readFile(file, 'utf8')).toBe(before)
  expect(errors()).toEqual([])
})

test('a row that is not JSON fails the start with a fixed message and no row text', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  await writeFile(file, '{"key":"Student A|8:42\n{"key":"Dr Lecturer"}\n')
  await expect(startChatCapture(page, zoomAdapter, file, async () => {}, { pollMs: 200, emit })).rejects.toThrow(
    'chat.jsonl has a row that is not valid JSON'
  )
  expect(errors()).toEqual([
    { where: 'chat', step: 'load', code: null, message: 'chat.jsonl has a row that is not valid JSON' }
  ])
  expect(JSON.stringify(events)).not.toContain('Student A')
})

test('a roster read that keeps failing delivers the messages and reports one error a minute', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  let clock = 1_000_000
  let n = 0
  const failing: PlatformAdapter = {
    ...zoomAdapter,
    readChat: async (_p, cursor) => {
      n += 1
      const key = `k${n}`
      const message: ChatMessage = {
        key,
        sender: 'Lecturer',
        senderRole: 'unknown',
        time: '10:00',
        seenAt: '2026-10-21T10:00:00.000Z',
        text: `https://forms.gle/${key}`,
        links: [`https://forms.gle/${key}`],
        replyTo: null
      }
      return {
        messages: [message],
        cursor,
        rosterError: Object.assign(new Error('roster is empty'), { code: 'EROSTER' })
      }
    },
    sweepChat: async () => []
  }
  const delivered: string[] = []
  const c = await startChatCapture(
    page,
    failing,
    file,
    async (m) => {
      delivered.push(m.key)
    },
    { pollMs: 100, emit, now: () => clock }
  )
  await expect.poll(() => delivered.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(3)
  expect(errors()).toEqual([{ where: 'chat', step: 'roster', code: 'EROSTER', message: 'roster read failed' }])
  clock += 61_000
  const before = delivered.length
  await expect.poll(() => delivered.length, { timeout: 5_000 }).toBeGreaterThan(before)
  await c.stop()
  expect(errors().map((e) => e.step)).toEqual(['roster', 'roster'])
  expect(JSON.stringify(events)).not.toContain('forms.gle')
})
