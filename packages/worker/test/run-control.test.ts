import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlCommand, Heartbeat, JobConfig, MeetingEvent, OccurrenceState } from '@tm/core'
import { runOccurrence } from '../src/run'
import { fakeDeps, makeCfg, type FakeDeps, type FakeOptions } from './helpers/fake-deps'

let base: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT, site: process.env.TM_PUBLIC_URL }
const servers: { stop(): void }[] = []

beforeEach(async () => {
  base = await makeCfg('lecture')
  profileRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-profiles-'))
  process.env.TM_PROFILE_ROOT = profileRoot
  process.env.TM_PUBLIC_URL = 'https://tolong.example.com'
})

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop()
  for (const [name, value] of [
    ['TM_PROFILE_ROOT', saved.root],
    ['TM_PUBLIC_URL', saved.site]
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(join(base.dataDir, '..'), { recursive: true, force: true })
  await rm(profileRoot, { recursive: true, force: true })
})

interface Reply {
  commands?: ControlCommand[]
  link?: string | null
  status?: number
  hang?: boolean
}

// A control server on 127.0.0.1 that records every heartbeat and acknowledges all its events unless told otherwise.
function control(answer: (body: Heartbeat, n: number) => Reply = () => ({})) {
  const seen: Heartbeat[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      expect(req.headers.get('authorization')).toBe('Bearer 1.token')
      const body = (await req.json()) as Heartbeat
      seen.push(body)
      const r = answer(body, seen.length)
      if (r.hang) await Bun.sleep(30_000)
      if (r.status) return new Response(null, { status: r.status })
      return Response.json({ ackedEvents: body.events.length, commands: r.commands ?? [], link: r.link ?? null })
    }
  })
  servers.push({ stop: () => server.stop(true) })
  const events = (): MeetingEvent[] => seen.flatMap((b) => b.events)
  const states = (): OccurrenceState[] =>
    events()
      .filter((e) => e.type === 'state' && 'state' in e.data)
      .map((e) => e.data.state as OccurrenceState)
  return { seen, events, states, url: `http://127.0.0.1:${server.port}/api/control` }
}

const withControl = (url: string, extra: Partial<JobConfig> = {}): JobConfig => ({
  ...base,
  ...extra,
  control: { url, token: '1.token' }
})

// Real time passes at each wait, so a heartbeat reply can arrive while the fake clock runs.
function paced<T extends FakeDeps>(d: T): T {
  const inner = d.sleep
  d.sleep = async (ms) => {
    await inner(ms)
    await Bun.sleep(3)
  }
  d.heartbeat = { intervalMs: 15, backoff: { firstMs: 10, maxMs: 40 } }
  return d
}

const fake = (opts: FakeOptions = {}) => paced(fakeDeps(opts))

const outboxText = (cfg: JobConfig, attempt = 1) =>
  readFile(join(cfg.dataDir, 'outbox', `attempt_${attempt}.jsonl`), 'utf8')
const logged = async (cfg: JobConfig) =>
  (await readFile(join(cfg.dataDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as MeetingEvent)

test('a meeting reports each state in order and hands over with a last heartbeat', async () => {
  const c = control()
  // Long enough in the meeting for a heartbeat (every 15 ms here) to see it.
  const d = fake({ states: [...Array<'in_meeting'>(60).fill('in_meeting'), 'ended'] })
  const cfg = withControl(c.url)
  const o = await runOccurrence(cfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(c.states()).toEqual([
    'verifying_accounts',
    'watching_for_link',
    'joining',
    'in_meeting',
    'leaving',
    'uploading',
    'transcribing'
  ])
  expect(c.seen[0]).toMatchObject({
    occurrenceId: 'occ-1',
    attempt: 1,
    state: 'starting',
    recording: false,
    events: []
  })
  const last = c.seen.at(-1)!
  expect(last).toMatchObject({ state: 'transcribing', recording: false })
  expect(c.seen.some((b) => b.recording && b.state === 'in_meeting' && b.participants === 5)).toBe(true)
  // The last heartbeat comes after outcome.json and the joined recording.
  expect(d.calls.at(-1)).toBe('joinRecording')
  expect(
    c
      .events()
      .filter((e) => e.type === 'state' && 'account' in e.data)
      .map((e) => e.data)
  ).toEqual([{ account: 'google', signedIn: true }])
  expect(c.events().some((e) => e.type === 'joined')).toBe(true)
  expect(await outboxText(cfg)).toBe('')
  expect(JSON.stringify(c.seen)).not.toContain('1.token')
})

test('pings link to the website', async () => {
  const d = fake({ states: ['ended'], signedOut: ['google'] })
  await runOccurrence(withControl(control().url), d)
  const joined = d.pings.find((p) => p.title.startsWith('Joined'))
  expect(joined?.actions).toEqual([{ label: 'Open meeting page', url: 'https://tolong.example.com/meetings/occ-1' }])
  const signin = d.pings.find((p) => p.title.startsWith('Alert'))
  expect(signin?.actions).toEqual([
    { label: 'Sign in again', url: 'https://tolong.example.com/accounts/ident-1/signin' }
  ])
})

test('leave_now leaves, reports left_by_member and finishes without handing over', async () => {
  const c = control((b) => ({ commands: b.state === 'in_meeting' ? ['leave_now'] : [] }))
  const d = fake({ states: 'always_in_meeting' })
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'member_left' })
  expect(d.calls).toContain('leave')
  expect(d.calls).toContain('joinRecording')
  expect(d.calls.indexOf('leave')).toBeLessThan(d.calls.indexOf('recorder.stop'))
  expect(c.states().slice(-2)).toEqual(['in_meeting', 'left_by_member'])
  expect(c.states()).not.toContain('transcribing')
  expect(c.seen.at(-1)).toMatchObject({ state: 'left_by_member' })
})

test('stop ends the meeting like its end: leaving, uploading, transcribing', async () => {
  const c = control((b) => ({ commands: b.state === 'in_meeting' ? ['stop'] : [] }))
  const d = fake({ states: 'always_in_meeting' })
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'stopped' })
  expect(c.states().slice(-4)).toEqual(['in_meeting', 'leaving', 'uploading', 'transcribing'])
  expect(c.seen.at(-1)).toMatchObject({ state: 'transcribing' })
})

test('a stop before the join fails the run and reports failed', async () => {
  const c = control(() => ({ commands: ['stop'] }))
  const d = fake()
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'failed', endedBy: 'stopped', joinedAt: null })
  expect(d.calls).not.toContain('join')
  expect(c.seen.at(-1)).toMatchObject({ state: 'failed' })
})

test('410 stops the worker through the normal teardown and reports nothing more', async () => {
  const c = control((b) => ({ status: b.state === 'in_meeting' ? 410 : undefined }))
  const d = fake({ states: 'always_in_meeting' })
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ endedBy: 'terminated', reason: 'superseded' })
  expect(d.calls).toContain('joinRecording')
  expect(c.states()).not.toContain('transcribing')
  expect(c.states()).not.toContain('leaving')
  expect(c.seen.every((b) => b.state !== 'transcribing')).toBe(true)
})

test('a pasted link is used until joining starts, and a refused one is reported', async () => {
  const c = control(() => ({ link: 'https://zoom.us/j/99999999999?pwd=PASTED' }))
  const d = fake({ states: ['ended'] })
  const cfg = withControl(c.url)
  const o = await runOccurrence({ ...cfg, entry: { ...cfg.entry, link: { kind: 'paste' } } }, d)
  expect(o.result).toBe('completed')
  expect(d.gotos).toEqual(['https://zoom.us/j/99999999999?pwd=PASTED'])

  const e = fake({ states: ['ended'] })
  const adapter = e.adapterFor('https://zoom.us/j/1')!
  e.adapterFor = (url) => (url.includes('evil') ? null : adapter)
  const bad = control(() => ({ link: 'https://evil.example/j/1?pwd=SECRET' }))
  const second = withControl(bad.url)
  await runOccurrence(second, e)
  expect(e.gotos).toEqual([second.entry.link.kind === 'fixed' ? second.entry.link.url : ''])
  const errors = (await logged(second)).filter((x) => x.type === 'error' && x.data.where === 'pasted link')
  expect(errors).toHaveLength(1)
  expect(JSON.stringify(errors)).not.toContain('SECRET')
})

test('without a link the member is pinged at the start, and the run gives up 30 minutes later', async () => {
  const c = control()
  const d = fake()
  const cfg = withControl(c.url)
  const o = await runOccurrence({ ...cfg, entry: { ...cfg.entry, link: { kind: 'paste' } } }, d)
  expect(o).toMatchObject({ result: 'failed', reason: 'no_link' })
  expect(d.calls).not.toContain('startRecorder')
  const ping = d.pings.find((p) => p.message.startsWith('There is no meeting link yet'))
  expect(ping?.actions).toEqual([{ label: 'Open meeting page', url: 'https://tolong.example.com/meetings/occ-1' }])
  expect(c.states()).toEqual(['verifying_accounts', 'watching_for_link', 'no_link'])
})

test('a refused token raises one alert and the meeting is still recorded', async () => {
  const c = control(() => ({ status: 401 }))
  const d = fake({ states: ['in_meeting', 'ended'] })
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(c.seen).toHaveLength(1)
  expect(d.pings.filter((p) => p.message.includes('control channel'))).toHaveLength(1)
  expect(d.calls).toContain('joinRecording')
})

test('a control URL that is not https fails the heartbeat only', async () => {
  const d = fake({ states: ['ended'] })
  const cfg = withControl('http://control.example.com/api/control')
  const o = await runOccurrence(cfg, d)
  expect(o.result).toBe('completed')
  expect(d.pings.some((p) => p.message.includes('control channel'))).toBe(true)
  expect((await logged(cfg)).some((e) => e.type === 'error' && e.data.where === 'control channel')).toBe(true)
})

test('events stay on disk when the server is down, and the next attempt delivers them first', async () => {
  const down = withControl('http://127.0.0.1:1/api/control')
  const d = fake({ states: ['ended'] })
  const o = await runOccurrence(down, d)
  expect(o.result).toBe('completed')
  const kept = (await outboxText(down)).trim().split('\n')
  expect(kept.length).toBeGreaterThan(5)
  expect(kept.some((l) => l.includes('"transcribing"'))).toBe(true)

  const c = control()
  const again = withControl(c.url, { attempt: 2 })
  const e = fake({ states: ['ended'] })
  await runOccurrence(again, e)
  // The restarted worker reports where the first one stopped, and sends the first one's events before its own.
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'transcribing' })
  const sent = c.events()
  expect(sent[0]!.attempt).toBe(1)
  expect(sent.some((x) => x.attempt === 2)).toBe(true)
  expect(sent.filter((x) => x.attempt === 1 && x.type === 'state' && 'state' in x.data)).toEqual([])
  expect(await outboxText(again, 2)).toBe('')
})

test('a final heartbeat the server never answers is cut off inside the teardown budget', async () => {
  const c = control((b) => ({ hang: b.state === 'transcribing' }))
  const d = fake({ states: ['ended'], teardownBudgetMs: 2000 })
  const cfg = withControl(c.url)
  const started = Date.now()
  const o = await runOccurrence(cfg, d)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(o.result).toBe('completed')
  expect((await logged(cfg)).some((e) => e.type === 'error' && e.data.where === 'teardown final heartbeat')).toBe(true)
  expect(await outboxText(cfg)).toContain('transcribing')
})

test('without a control channel nothing is queued and no outbox is made', async () => {
  const d = fake({ states: ['ended'] })
  const o = await runOccurrence(base, d)
  expect(o.result).toBe('completed')
  await expect(outboxText(base)).rejects.toThrow()
})
