import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChatMessage, JobConfig } from '@tm/core'
import { runPipeline } from '../src/index'
import type { Inventory } from '../src/summary/inventory'
import { startFakeAi, startFakeNtfy, type FakeAi, type FakeServer } from './fakes'
import { liveLine, makeOccurrence, removeOccurrence, writeAttempts, writeLines, type Occurrence } from './helpers'

let occ: Occurrence
let cfg: JobConfig
let ai: FakeAi
let ntfy: FakeServer

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
  ntfy.stop()
  await expect(runPipeline(cfg)).rejects.toThrow()
  expect(await Bun.file(join(occ.dataDir, 'out', 'summary-pinged')).exists()).toBe(false)
  ntfy = startFakeNtfy()
  await runPipeline({ ...cfg, ntfy: { ...cfg.ntfy, url: ntfy.url } })
  expect(ntfy.requests).toHaveLength(1)
}, 15_000)

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
