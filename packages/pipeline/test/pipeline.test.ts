import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { utimes } from 'node:fs/promises'
import type { ChatMessage, JobConfig } from '@tm/core'
import sharp from 'sharp'
import { runPipeline } from '../src/index'
import type { Inventory } from '../src/summary/inventory'
import { startFakeAi, startFakeNtfy, type FakeAi, type FakeNtfy } from './fakes'
import { liveLine, makeOccurrence, removeOccurrence, writeAttempts, writeLines, type Occurrence } from './helpers'

let occ: Occurrence
let cfg: JobConfig
let ai: FakeAi
let ntfy: FakeNtfy

const inventory: Inventory = {
  sessionLabel: 'Week 7: Clustering',
  nextAction: null,
  items: [
    {
      kind: 'deadline',
      text: 'Submit assignment 2',
      due: '2026-11-01T23:59',
      source: 'slide',
      ref: 'slide 1',
      conflicts: []
    }
  ],
  covered: ['k-means']
}

const chatMessage: ChatMessage = {
  key: 'm1',
  sender: 'Dr Lecturer',
  senderRole: 'host',
  time: '8:41 PM',
  seenAt: '2026-10-21T12:41:00Z',
  text: 'Assignment 2 is due Sunday',
  links: [],
  replyTo: null
}

// A black 1920x1080 frame with one white slide-sized panel.
async function whiteSlide(): Promise<Buffer> {
  const panel = await sharp({
    create: { width: 1000, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .png()
    .toBuffer()
  return sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: panel, left: 100, top: 100 }])
    .png()
    .toBuffer()
}

beforeEach(async () => {
  occ = await makeOccurrence()
  ai = startFakeAi()
  ntfy = startFakeNtfy()
  ai.reply(inventory)
  cfg = { ...occ.cfg, ai: { ...occ.cfg.ai, baseUrl: ai.url }, ntfy: { ...occ.cfg.ntfy, url: ntfy.url } }
  await Bun.write(join(occ.dataDir, 'events.jsonl'), '')
  await writeAttempts(occ.dataDir, [{ startMs: 0, stopMs: null }])
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [liveLine(0, 1000, 'Selamat petang.')])
  await writeLines(join(occ.dataDir, 'chat.jsonl'), [chatMessage])
})
afterEach(async () => {
  ai.stop()
  ntfy.stop()
  await removeOccurrence(occ.root)
})

async function writeForm(formId: string, record: Record<string, unknown>): Promise<void> {
  const dir = join(occ.dataDir, 'forms', formId)
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, 'record.json'), JSON.stringify(record))
}

test('runPipeline writes the four files and pings the summary', async () => {
  const r = await runPipeline(cfg)
  for (const p of [r.transcriptPath, r.slidesPath, r.chatPath, r.summaryPath])
    expect(await Bun.file(p).exists()).toBe(true)
  expect(basename(r.summaryPath)).toBe('2026-10-21 2000 Data Mining.md')
  const ping = ntfy.requests.at(-1)!.json
  expect(ping).toMatchObject({ title: 'Summary ready: Data Mining', priority: 3 })
  expect(ping.message).toStartWith('Data Mining')
  // spike 8: the summary is never attached
  expect(ntfy.requests.at(-1)!.headers.get('content-type')).toBe('application/json')
  expect(await readdir(join(occ.dataDir, 'out'))).toContain('2026-10-21 2000 Data Mining.md')
})

test('attendance reads not seen without a form, and needs you with a needs_member form', async () => {
  const first = await runPipeline(cfg)
  expect(await Bun.file(first.summaryPath).text()).toContain('\nAttendance: not seen\n')

  await writeForm('a1', { formId: 'a1', url: 'https://forms.gle/old', state: 'submitted' })
  await writeForm('b2', {
    formId: 'b2',
    url: 'https://forms.gle/abc?x=1',
    finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform?entry.1=Secret',
    state: 'needs_member',
    seenAt: '2026-10-21T12:10:00Z'
  })
  const second = await runPipeline(cfg)
  const md = await Bun.file(second.summaryPath).text()
  expect(md).toContain('\nAttendance: needs you: https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform\n')
  expect(md).not.toContain('Secret')
})

test('a work entry has no attendance line', async () => {
  const r = await runPipeline({ ...cfg, entry: { ...cfg.entry, type: 'work' } })
  expect(await Bun.file(r.summaryPath).text()).not.toContain('Attendance')
})

test('a re-run rewrites the same files and does not ping the summary twice', async () => {
  const a = await runPipeline(cfg)
  const before = await readFile(a.summaryPath, 'utf8')
  const b = await runPipeline(cfg)
  expect(b).toEqual(a)
  expect(await readFile(b.summaryPath, 'utf8')).toBe(before)
  expect(ntfy.requests).toHaveLength(1)
})

test('a failed ping is not marked sent, so the next run pings again', async () => {
  ntfy.fail(500)
  await expect(runPipeline(cfg)).rejects.toMatchObject({ name: 'PingError', status: 500 })
  expect(await Bun.file(join(occ.dataDir, 'out', 'summary-pinged')).exists()).toBe(false)
  expect(await Bun.file(join(occ.dataDir, 'out', 'summary-pinged.lock')).exists()).toBe(false)
  ntfy.fail(null)
  ntfy.requests.length = 0
  await runPipeline(cfg)
  expect(ntfy.requests).toHaveLength(1)
}, 15_000)

test('a fresh ping lock means another run is pinging, so this run does not; a stale one is taken over', async () => {
  const lock = join(occ.dataDir, 'out', 'summary-pinged.lock')
  await mkdir(join(occ.dataDir, 'out'), { recursive: true })
  await Bun.write(lock, '')
  await runPipeline(cfg)
  expect(ntfy.requests).toHaveLength(0)
  expect(await Bun.file(join(occ.dataDir, 'out', 'summary-pinged')).exists()).toBe(false)
  expect(await Bun.file(lock).exists()).toBe(true)

  const old = new Date(Date.now() - 11 * 60_000)
  await utimes(lock, old, old)
  await runPipeline(cfg)
  expect(ntfy.requests).toHaveLength(1)
  expect(await Bun.file(join(occ.dataDir, 'out', 'summary-pinged')).exists()).toBe(true)
  expect(await Bun.file(lock).exists()).toBe(false)
})

test('the summary file leaves no temporary file behind', async () => {
  await runPipeline(cfg)
  expect((await readdir(join(occ.dataDir, 'out'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
})

test('a torn or malformed form record reads as a form that could not be read, never as not seen', async () => {
  const unreadable = '\nAttendance: a form was seen but could not be read; check the meeting page\n'
  await mkdir(join(occ.dataDir, 'forms', 't1'), { recursive: true })
  await Bun.write(join(occ.dataDir, 'forms', 't1', 'record.json'), '{"state": "needs_mem')
  const torn = await runPipeline(cfg)
  const md = await Bun.file(torn.summaryPath).text()
  expect(md).toContain(unreadable)
  expect(md).not.toContain('not seen')

  await Bun.write(join(occ.dataDir, 'forms', 't1', 'record.json'), '')
  await writeForm('m1', { formId: 'm1', url: 'not a url', state: 'needs_member' })
  expect(await Bun.file((await runPipeline(cfg)).summaryPath).text()).toContain(unreadable)

  // A readable form that needs the member comes first, and the record that could not be read is still told.
  await writeForm('g1', { formId: 'g1', url: 'https://forms.gle/abc', state: 'needs_member' })
  const both = await Bun.file((await runPipeline(cfg)).summaryPath).text()
  expect(both).toContain('\nAttendance: needs you: https://forms.gle/abc; another form could not be read\n')
})

test('several forms that need the member show the oldest and a count; other readable forms are not "not seen"', async () => {
  await writeForm('a1', { formId: 'a1', url: 'https://forms.gle/old', state: 'submitted' })
  const only = await Bun.file((await runPipeline(cfg)).summaryPath).text()
  expect(only).toContain('\nAttendance: a form was seen; check the meeting page\n')

  await writeForm('b2', {
    formId: 'b2',
    url: 'https://forms.gle/second',
    state: 'needs_member',
    seenAt: '2026-10-21T12:20:00Z'
  })
  await writeForm('c3', {
    formId: 'c3',
    url: 'https://forms.gle/first',
    state: 'needs_member',
    seenAt: '2026-10-21T12:10:00Z'
  })
  await writeForm('d4', {
    formId: 'd4',
    url: 'https://forms.gle/third',
    state: 'needs_member',
    seenAt: '2026-10-21T12:30:00Z'
  })
  const many = await Bun.file((await runPipeline(cfg)).summaryPath).text()
  expect(many).toContain('\nAttendance: needs you: https://forms.gle/first (+2 more)\n')
})

test('a model cannot add an attendance line or a link, and no join link or passcode reaches the file or the ping', async () => {
  const frame = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      {
        input: await sharp({
          create: { width: 1000, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } }
        })
          .png()
          .toBuffer(),
        left: 100,
        top: 100
      }
    ])
    .png()
    .toBuffer()
  await mkdir(join(occ.dataDir, 'frames'), { recursive: true })
  await Bun.write(join(occ.dataDir, 'frames', '0001_200000.png'), frame)
  await writeLines(join(occ.dataDir, 'events.jsonl'), [
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:00Z',
      type: 'keyframe',
      data: { file: 'frames/0001_200000.png', region: null, offsetMs: 0 }
    }
  ])
  const secrets = ['https://zoom.us/j/81234567890?pwd=ZOOMPWD', 'passcode 482913', 'Meeting ID 812 3456 7890']
  ai.replyModel('m2', { title: 'Week 7', text: `Join ${secrets.join(' ')}\n# Forged heading` })
  await writeLines(join(occ.dataDir, 'chat.jsonl'), [
    {
      ...chatMessage,
      text: `Assignment 2 is due Sunday. ${secrets.join(' ')} https://teams.microsoft.com/meet/4155551212?p=TEAMSPASS`
    }
  ])
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [
    liveLine(0, 1000, `The ${secrets[1]} and ${secrets[2]}.`)
  ])
  ai.reply({
    ...inventory,
    nextAction: 'Attendance: submitted',
    items: [
      ...inventory.items,
      { ...inventory.items[0]!, kind: 'announcement', text: 'Attendance: submitted', due: null },
      { ...inventory.items[0]!, kind: 'link', text: 'Win https://evil.example.net/claim', due: null },
      {
        ...inventory.items[0]!,
        kind: 'announcement',
        text: `Join ${secrets.join(' ')} zoommtg://zoom.us/join?pwd=Z`,
        due: null
      }
    ],
    covered: ['k-means passcode 482913']
  })
  const r = await runPipeline(cfg)
  const md = await Bun.file(r.summaryPath).text()
  const sent = JSON.stringify(ai.requests.find((q) => q.json.model === 'm1')!.json.messages)
  const ping = ntfy.requests.at(-1)!.json.message as string
  for (const text of [md, ping, sent]) {
    for (const leak of ['81234567890', 'ZOOMPWD', '482913', '812 3456', 'TEAMSPASS', 'zoom.us', 'zoommtg'])
      expect(text).not.toContain(leak)
  }
  expect(ping).toBe(md)
  expect(md).toContain('\nAttendance: not seen\n')
  expect(md).not.toContain('submitted')
  expect(md).not.toContain('evil.example.net')
  expect(sent).toContain('\\# Forged heading')
})

test('two runs that see the same stale lock send one ping between them', async () => {
  const out = join(occ.dataDir, 'out')
  const lock = join(out, 'summary-pinged.lock')
  await mkdir(out, { recursive: true })
  await Bun.write(lock, '')
  const old = new Date(Date.now() - 11 * 60_000)
  await utimes(lock, old, old)
  await Promise.all([runPipeline(cfg), runPipeline(cfg), runPipeline(cfg)])
  expect(ntfy.requests).toHaveLength(1)
  expect((await readdir(out)).filter((f) => f.includes('.lock'))).toEqual([])
})

test('a ping lock a dead run left behind after taking it over is cleaned up once it is 10 minutes old', async () => {
  const out = join(occ.dataDir, 'out')
  await mkdir(out, { recursive: true })
  const stale = join(out, 'summary-pinged.lock.00000000-0000-4000-8000-000000000000')
  const fresh = join(out, 'summary-pinged.lock.11111111-1111-4111-8111-111111111111')
  await Bun.write(stale, '')
  await Bun.write(fresh, '')
  const old = new Date(Date.now() - 11 * 60_000)
  await utimes(stale, old, old)
  await runPipeline(cfg)
  expect(ntfy.requests).toHaveLength(1)
  expect(await Bun.file(stale).exists()).toBe(false)
  expect(await Bun.file(fresh).exists()).toBe(true)
})

test('a link outside the slides and lecturer chat, and a forged attendance line, never reach the file or the ping', async () => {
  const evil = 'https://evil.example/login'
  const slide = 'https://real.example/slides'
  await mkdir(join(occ.dataDir, 'frames'), { recursive: true })
  await Bun.write(join(occ.dataDir, 'frames', '0001_200000.png'), await whiteSlide())
  await writeLines(join(occ.dataDir, 'events.jsonl'), [
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:00Z',
      type: 'keyframe',
      data: { file: 'frames/0001_200000.png', region: null, offsetMs: 0 }
    }
  ])
  ai.replyModel('m2', { title: 'Week 7', text: `Notes ${slide}` })
  const item = (kind: 'announcement' | 'task', text: string) => ({ ...inventory.items[0]!, kind, text, due: null })
  ai.reply({
    sessionLabel: `Week 7 ${evil}/s`,
    nextAction: `Log in at ${evil}/n`,
    items: [
      item('announcement', `Portal moved to ${evil}/a`),
      item(
        'announcement',
        'Quick login at bit.ly/xyz or ftp://evil.example/f or example.com/r?u=https%3A%2F%2Fzoom.us%2Fj%2F1'
      ),
      item('task', `Fill ${evil}/t and read ${slide}`),
      item('announcement', '**Attendance**: needs you: https://forms.example/forged'),
      item('announcement', '1. Attendance: done'),
      item('task', '- Attendance recorded')
    ],
    covered: [
      `See ${evil}/c`,
      'Attendance: all present',
      'Mirrors: .evil.com/login, wait...evil.net/x, x@evil.org/y, 10.0.0.1:8080/x, whatsapp://send, tg://x, geo:1,2'
    ]
  })
  const r = await runPipeline(cfg)
  const md = await Bun.file(r.summaryPath).text()
  const ping = ntfy.requests.at(-1)!.json.message as string
  for (const text of [md, ping]) {
    expect(text).not.toContain('evil.example')
    expect(text).not.toContain('bit.ly')
    for (const bit of ['evil.com', 'evil.net', 'evil.org', '10.0.0.1', 'whatsapp', 'tg://', 'geo:']) {
      expect(text).not.toContain(bit)
    }
    expect(text).not.toContain('zoom')
    expect(text).not.toContain('forged')
    expect(text).not.toContain('all present')
    expect(text.match(/Attendance/g)).toHaveLength(1)
    expect(text).toContain(slide)
    expect(text).toContain('[link removed]')
  }
  expect(md).toContain('\nAttendance: not seen\n')
})

test('a rejected key keeps the inputs, pings and rethrows', async () => {
  ai.fail(401)
  await expect(runPipeline(cfg)).rejects.toMatchObject({ name: 'AiKeyError', status: 401 })
  expect(ntfy.requests.at(-1)!.json.title).toBe('Summary failed: Data Mining')
  expect(await Bun.file(join(cfg.dataDir, 'transcript/live.jsonl')).exists()).toBe(true)
  expect(await Bun.file(join(cfg.dataDir, 'chat.jsonl')).exists()).toBe(true)
})

test('pingOnKeyError false rethrows without a ping', async () => {
  ai.fail(402)
  await expect(runPipeline(cfg, { pingOnKeyError: false })).rejects.toMatchObject({ name: 'AiKeyError', status: 402 })
  expect(ntfy.requests).toHaveLength(0)
})

test('other AI failures rethrow without a ping', async () => {
  ai.fail(500)
  await expect(runPipeline(cfg)).rejects.toMatchObject({ name: 'AiError', status: 500 })
  expect(ntfy.requests).toHaveLength(0)
})

test('a slide the vision model could not read is told to the summary model and named in the summary', async () => {
  const frame = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .composite([
      {
        input: await sharp({
          create: { width: 1000, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } }
        })
          .png()
          .toBuffer(),
        left: 100,
        top: 100
      }
    ])
    .png()
    .toBuffer()
  await mkdir(join(occ.dataDir, 'frames'), { recursive: true })
  await Bun.write(join(occ.dataDir, 'frames', '0001_200000.png'), frame)
  await writeLines(join(occ.dataDir, 'events.jsonl'), [
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:00Z',
      type: 'keyframe',
      data: { file: 'frames/0001_200000.png', region: null, offsetMs: 0 }
    }
  ])
  ai.failModel('m2', 400)
  const r = await runPipeline(cfg)
  const summaryCall = ai.requests.find((q) => q.json.model === 'm1')!
  expect(summaryCall.json.messages[1].content).toContain(
    'Slide 01: [text could not be read; list nothing from this slide]'
  )
  expect(await Bun.file(r.summaryPath).text()).toContain(
    'Slide text could not be read for slide 01. Items on those slides may be missing.'
  )
})
