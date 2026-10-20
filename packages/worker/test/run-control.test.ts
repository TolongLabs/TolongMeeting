import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACTIVE_STATES,
  StateEventDataSchema,
  triggerFor,
  type ControlCommand,
  type Heartbeat,
  type JobConfig,
  type MeetingEvent,
  type OccurrenceState
} from '@tm/core'
import { runOccurrence, type OccurrenceOutcome } from '../src/run'
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

// The server's rule for a worker's state changes (web/lib/control.ts): from `restarting` only `resume:<resume_state>`
// is taken (a state on the in-meeting path stands for it when `resume_state` is on the path too); elsewhere a worker moves along the machine's edges, but never to a state it does not own.
const CANNOT_ENTER = new Set<OccurrenceState>([
  'deleted',
  'completed',
  'post_processing',
  'waiting_for_pc',
  'restarting',
  'skipped_capacity',
  'skipped_identity_clash',
  'skipped_pc_offline'
])
const MEETING_PATH: OccurrenceState[] = ['joining', 'in_lobby', 'in_meeting']
const MOVES_FROM = new Set<OccurrenceState>([...ACTIVE_STATES, 'uploading'])

// A control server that applies each heartbeat's state changes the way the real one does, so a restarted worker that
// reports the wrong state stays in `restarting`.
function stateful(start: OccurrenceState, resumeState: OccurrenceState) {
  const model = { state: start, illegal: [] as string[] }
  const moveTo = (next: OccurrenceState): void => {
    if (next === model.state) return
    if (
      model.state === 'restarting' &&
      next !== resumeState &&
      MEETING_PATH.includes(resumeState) &&
      MEETING_PATH.includes(next)
    ) {
      moveTo(resumeState)
      if (next === model.state) return
    }
    if (MEETING_PATH.includes(next) && MEETING_PATH.indexOf(next) < MEETING_PATH.indexOf(model.state)) return
    const trigger = triggerFor(model.state, next)
    const resumes = model.state === 'restarting' && trigger === `resume:${resumeState}`
    const allowed =
      resumes || (MOVES_FROM.has(model.state) && !CANNOT_ENTER.has(next) && !trigger?.startsWith('resume:'))
    if (trigger === null || !allowed) model.illegal.push(`${model.state} -> ${next}`)
    else model.state = next
  }
  const c = control((body) => {
    for (const e of body.events) {
      const change = e.type === 'state' ? StateEventDataSchema.safeParse(e.data) : null
      if (change?.success) moveTo(change.data.state)
    }
    moveTo(body.state)
    return {}
  })
  return { ...c, model }
}

const line = (e: MeetingEvent): string => `${JSON.stringify(e)}\n`
const stateEvent = (n: number, state: string, attempt = 1): MeetingEvent => ({
  occurrenceId: 'occ-1',
  attempt,
  at: `2026-10-21T12:00:${String(n).padStart(2, '0')}.000Z`,
  type: 'state',
  data: { state }
})
const errorEvent = (n: number): MeetingEvent => ({
  ...stateEvent(n, 'x'),
  type: 'error',
  data: { where: 'earlier', n }
})

// What attempt 1 left behind: its event log, and the events the server never got.
async function leftBehind(cfg: JobConfig, log: MeetingEvent[], unsent: MeetingEvent[]): Promise<void> {
  await mkdir(join(cfg.dataDir, 'outbox'), { recursive: true })
  await writeFile(join(cfg.dataDir, 'events.jsonl'), log.map(line).join(''))
  await writeFile(join(cfg.dataDir, 'outbox', 'attempt_1.jsonl'), unsent.map(line).join(''))
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
  expect(joined?.actions).toEqual([
    { label: 'Open meeting page', url: 'https://tolong.example.com/meetings/occ-1' },
    { label: 'Make the bot leave', url: 'https://tolong.example.com/meetings/occ-1/leave' },
    { label: 'Take over', url: 'https://tolong.example.com/meetings/occ-1/take-over' }
  ])
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

test('410 leaves the meeting and closes the browser, but leaves the checkpoint, outcome and recording to the new attempt', async () => {
  const c = control((b) => ({ status: b.state === 'in_meeting' ? 410 : undefined }))
  const d = fake({ states: 'always_in_meeting' })
  const cfg = withControl(c.url)
  const o = await runOccurrence(cfg, d)
  expect(o).toMatchObject({ endedBy: 'terminated', reason: 'superseded' })
  expect(d.calls).toContain('leave')
  expect(d.calls).toContain('context.close')
  expect(d.calls).not.toContain('checkpointProfile')
  expect(d.calls).not.toContain('joinRecording')
  await expect(readFile(join(cfg.dataDir, 'outcome.json'), 'utf8')).rejects.toThrow()
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
  const second = await runOccurrence(again, e)
  // The server never heard of the first attempt, so the restarted worker starts from `starting`; the meeting is over,
  // so it does not join again, and it sends the first one's events before its own.
  expect(second).toEqual(o)
  expect(e.calls).not.toContain('join')
  expect(e.calls).not.toContain('launchBrowser')
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'starting' })
  const sent = c.events()
  expect(sent[0]!.attempt).toBe(1)
  expect(sent.some((x) => x.attempt === 2)).toBe(true)
  expect(sent.filter((x) => x.attempt === 1 && x.type === 'state' && 'state' in x.data)).toEqual([])
  expect(c.states().at(-1)).toBe('transcribing')
  expect(await outboxText(again, 2)).toBe('')
})

test('a restarted worker reports the state the server acknowledged, though the log is ahead of it', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  // The server applied up to `joining` before the crash; the log goes on to `in_meeting`, which it never got.
  const log = [
    stateEvent(1, 'verifying_accounts'),
    stateEvent(2, 'watching_for_link'),
    stateEvent(3, 'joining'),
    stateEvent(4, 'in_meeting')
  ]
  await leftBehind(cfg, log, [log[3]!, errorEvent(5)])
  const c = stateful('restarting', 'joining')
  const d = fake({ states: ['in_meeting', 'ended'] })
  const o = await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'joining' })
  expect(c.model.illegal).toEqual([])
  expect(c.model.state).toBe('transcribing')
  // The earlier attempt's error event still arrives; its state change does not.
  expect(c.events().some((e) => e.attempt === 1 && e.type === 'error')).toBe(true)
  expect(c.events().some((e) => e.attempt === 1 && e.type === 'state')).toBe(false)
})

test('a restart after the meeting ended reports the acknowledged state, then hands over without joining again', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  const log = [
    stateEvent(1, 'verifying_accounts'),
    stateEvent(2, 'watching_for_link'),
    stateEvent(3, 'joining'),
    stateEvent(4, 'in_meeting'),
    stateEvent(5, 'leaving'),
    stateEvent(6, 'uploading'),
    stateEvent(7, 'transcribing')
  ]
  // The server has `in_meeting`; the rest was not sent, and the first attempt wrote its outcome before it died.
  await leftBehind(cfg, log, log.slice(4))
  const joinedAt = '2026-10-21T12:00:04.000Z'
  const earlier: OccurrenceOutcome = {
    result: 'completed',
    endedBy: 'page',
    reason: null,
    joinedAt,
    endedAt: '2026-10-21T13:00:00.000Z'
  }
  await writeFile(join(cfg.dataDir, 'outcome.json'), JSON.stringify(earlier))
  const c = stateful('restarting', 'in_meeting')
  const d = fake({ states: 'always_in_meeting' })
  const o = await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(o).toEqual(earlier)
  expect(d.calls).not.toContain('launchBrowser')
  expect(d.calls).not.toContain('join')
  expect(d.calls).toContain('joinRecording')
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'in_meeting' })
  expect(c.states()).toEqual(['leaving', 'uploading', 'transcribing'])
  expect(c.model.illegal).toEqual([])
  expect(c.model.state).toBe('transcribing')
  expect(c.seen.at(-1)).toMatchObject({ state: 'transcribing' })
})

// A meeting that ended while the worker was down: attempt 1 logged every state, and the server has only `in_meeting`.
async function endedWhileDown(cfg: JobConfig): Promise<OccurrenceOutcome> {
  const log = [
    stateEvent(1, 'verifying_accounts'),
    stateEvent(2, 'watching_for_link'),
    stateEvent(3, 'joining'),
    stateEvent(4, 'in_meeting'),
    stateEvent(5, 'leaving'),
    stateEvent(6, 'uploading'),
    stateEvent(7, 'transcribing')
  ]
  await leftBehind(cfg, log, log.slice(4))
  const earlier: OccurrenceOutcome = {
    result: 'completed',
    endedBy: 'page',
    reason: null,
    joinedAt: '2026-10-21T12:00:04.000Z',
    endedAt: '2026-10-21T13:00:00.000Z'
  }
  await writeFile(join(cfg.dataDir, 'outcome.json'), JSON.stringify(earlier))
  return earlier
}

test('a restarted worker that finds the meeting over reports nothing after its resumed state until the server takes it', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  const earlier = await endedWhileDown(cfg)
  // The server refuses the first heartbeat, which carries the resumed state.
  const c = control((_, n) => (n === 1 ? { status: 500 } : {}))
  const d = fake({ states: 'always_in_meeting' })
  const o = await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(o).toEqual(earlier)
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'in_meeting' })
  // The heartbeat the server takes is still in the resumed state: the states after it come only once it is taken.
  expect(c.seen[1]).toMatchObject({ attempt: 2, state: 'in_meeting' })
  expect(c.seen.slice(0, 2).flatMap((b) => b.events.filter((e) => e.type === 'state'))).toEqual([])
  expect(c.states()).toEqual(['leaving', 'uploading', 'transcribing'])
  expect(c.seen.at(-1)).toMatchObject({ state: 'transcribing' })
})

test('a restarted worker the server never takes does not walk ahead of it; the states wait in the outbox', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  await endedWhileDown(cfg)
  const c = control(() => ({ status: 500 }))
  const d = fake({ states: 'always_in_meeting', teardownBudgetMs: 2000 })
  const started = Date.now()
  await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(c.events().filter((e) => e.type === 'state')).toEqual([])
  const own = (await logged(cfg)).filter((e) => e.attempt === 2)
  expect(own.filter((e) => e.type === 'state')).toEqual([])
  expect(own.filter((e) => e.type === 'error').map((e) => e.data.where)).toContain('teardown resume')
  expect(await outboxText(cfg, 2)).not.toContain('"type":"state"')
  expect(d.calls).toContain('joinRecording')
}, 10_000)

test('a worker replaced while it waits for its resumed state does not join the recording again', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  await endedWhileDown(cfg)
  const c = control(() => ({ status: 410 }))
  const d = fake({ states: 'always_in_meeting' })
  await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(d.calls).not.toContain('joinRecording')
  expect(c.events().filter((e) => e.type === 'state')).toEqual([])
}, 10_000)

test('a restart whose lost acknowledgement leaves it behind resume_state still leaves restarting when admitted straight in', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  // The server applied `in_lobby`, but the heartbeat reply was lost: that change is still unsent, so the worker
  // reports `joining`, and the rejoin is admitted straight in (it never passes through `in_lobby`).
  const log = [
    stateEvent(1, 'verifying_accounts'),
    stateEvent(2, 'watching_for_link'),
    stateEvent(3, 'joining'),
    stateEvent(4, 'in_lobby')
  ]
  await leftBehind(cfg, log, [log[3]!])
  const c = stateful('restarting', 'in_lobby')
  const d = fake({ states: ['in_meeting', 'ended'] })
  const o = await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'joining' })
  expect(c.states()).not.toContain('in_lobby')
  expect(c.model.illegal).toEqual([])
  expect(c.model.state).toBe('transcribing')
})

// Attempt 1 joined, recorded a segment and was cut short (SIGTERM); the meeting ended while the worker was down.
async function cutShortAfterJoining(cfg: JobConfig, joinedAt: string | null): Promise<void> {
  await leftBehind(cfg, [stateEvent(1, 'in_meeting')], [])
  await mkdir(join(cfg.dataDir, 'recording'), { recursive: true })
  await writeFile(join(cfg.dataDir, 'recording', 'attempt_1_seg_000.mkv'), 'video')
  await writeFile(
    join(cfg.dataDir, 'outcome.json'),
    JSON.stringify({
      result: joinedAt === null ? 'failed' : 'completed',
      endedBy: 'terminated',
      reason: 'terminated',
      joinedAt,
      endedAt: '2026-10-21T12:30:00.000Z'
    })
  )
}

test('a rejoin that finds the meeting over still hands over the earlier attempt’s recording', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  const joinedAt = '2026-10-21T12:00:04.000Z'
  await cutShortAfterJoining(cfg, joinedAt)
  const c = stateful('restarting', 'in_meeting')
  const d = fake({ joins: [{ kind: 'failed', reason: 'meeting_ended' }], states: 'always_in_meeting' })
  const o = await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page', joinedAt })
  expect(d.calls).toContain('joinRecording')
  expect(c.states()).toEqual(['leaving', 'uploading', 'transcribing'])
  expect(c.model.illegal).toEqual([])
  expect(c.model.state).toBe('transcribing')
  expect(JSON.parse(await readFile(join(cfg.dataDir, 'outcome.json'), 'utf8'))).toMatchObject({
    result: 'completed',
    joinedAt
  })
})

test('the same hand-over works when the server resumes at a state behind the worker’s', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  await cutShortAfterJoining(cfg, '2026-10-21T12:00:04.000Z')
  const c = stateful('restarting', 'joining')
  const d = fake({ joins: [{ kind: 'failed', reason: 'meeting_ended' }], states: 'always_in_meeting' })
  await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(c.seen[0]).toMatchObject({ attempt: 2, state: 'in_meeting' })
  expect(c.states()).toEqual(['leaving', 'uploading', 'transcribing'])
  expect(c.model.illegal).toEqual([])
  expect(c.model.state).toBe('transcribing')
})

test('a rejoin that finds the meeting over fails when no earlier attempt joined or left a segment', async () => {
  const never = withControl('http://unused', { attempt: 2 })
  await cutShortAfterJoining(never, null)
  const a = stateful('restarting', 'in_meeting')
  const d = fake({ joins: [{ kind: 'failed', reason: 'meeting_ended' }], states: 'always_in_meeting' })
  expect(await runOccurrence({ ...never, control: { url: a.url, token: '1.token' } }, d)).toMatchObject({
    result: 'failed',
    reason: 'meeting_ended'
  })
  expect(a.model.state).toBe('failed')

  const bare = withControl('http://unused', { attempt: 2, dataDir: `${base.dataDir}-bare` })
  await cutShortAfterJoining(bare, '2026-10-21T12:00:04.000Z')
  await rm(join(bare.dataDir, 'recording', 'attempt_1_seg_000.mkv'))
  const b = stateful('restarting', 'in_meeting')
  const e = fake({ joins: [{ kind: 'failed', reason: 'meeting_ended' }], states: 'always_in_meeting' })
  expect(await runOccurrence({ ...bare, control: { url: b.url, token: '1.token' } }, e)).toMatchObject({
    result: 'failed'
  })
  expect(b.model.state).toBe('failed')
  await rm(bare.dataDir, { recursive: true, force: true })
})

test('a cut-short earlier attempt (SIGTERM) does not end the meeting: the restarted worker joins again', async () => {
  const cfg = withControl('http://unused', { attempt: 2 })
  await leftBehind(cfg, [stateEvent(1, 'verifying_accounts')], [])
  await writeFile(
    join(cfg.dataDir, 'outcome.json'),
    JSON.stringify({
      result: 'completed',
      endedBy: 'terminated',
      reason: 'terminated',
      joinedAt: null,
      endedAt: '2026-10-21T12:30:00.000Z'
    })
  )
  const c = stateful('restarting', 'verifying_accounts')
  const d = fake({ states: ['ended'] })
  const o = await runOccurrence({ ...cfg, control: { url: c.url, token: '1.token' } }, d)
  expect(o).toMatchObject({ endedBy: 'page' })
  expect(d.calls).toContain('join')
  expect(c.model.state).toBe('transcribing')
})

test('a damaged outbox file is set aside with one error event and one ping, and the control channel still starts', async () => {
  const c = control()
  const cfg = withControl(c.url)
  const kept = errorEvent(1)
  await mkdir(join(cfg.dataDir, 'outbox'), { recursive: true })
  await writeFile(join(cfg.dataDir, 'outbox', 'attempt_1.jsonl'), `${line(kept)}{"occurrenceId":"occ-1","at\n`)
  const d = fake({ states: ['ended'] })
  const o = await runOccurrence(cfg, d)
  expect(o.result).toBe('completed')
  expect(await readdir(join(cfg.dataDir, 'outbox'))).toContain('attempt_1.jsonl.damaged')
  expect(c.events()).toContainEqual(kept)
  expect(c.seen.at(-1)).toMatchObject({ state: 'transcribing' })
  const errors = (await logged(cfg)).filter((e) => e.type === 'error' && e.data.where === 'event outbox')
  expect(errors).toHaveLength(1)
  expect(d.pings.filter((p) => p.message.includes('event outbox'))).toHaveLength(1)
})

test('a bad TM_PUBLIC_URL costs the pings their links, not the run', async () => {
  process.env.TM_PUBLIC_URL = 'http://not-https.example.com'
  const c = control()
  const cfg = withControl(c.url)
  const d = fake({ states: ['ended'], signedOut: ['google'] })
  const o = await runOccurrence(cfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(d.pings.length).toBeGreaterThan(0)
  expect(d.pings.every((p) => p.actions === undefined || p.actions.length === 0)).toBe(true)
  expect(d.pings.some((p) => p.message.includes('site links'))).toBe(true)
  const errors = (await logged(cfg)).filter((e) => e.type === 'error' && e.data.where === 'site links')
  expect(errors).toHaveLength(1)
  expect(c.seen.at(-1)).toMatchObject({ state: 'transcribing' })
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

test('a final heartbeat that uses its whole window still leaves the heartbeat its stop step', async () => {
  const c = control((b) => ({ hang: b.state === 'transcribing' }))
  // The checkpoint hangs too, so it takes all the time it is given and the heartbeat only has its reserve.
  const d = fake({ states: ['ended'], teardownBudgetMs: 2000, checkpoint: () => new Promise<void>(() => {}) })
  const cfg = withControl(c.url)
  const started = Date.now()
  await runOccurrence(cfg, d)
  expect(Date.now() - started).toBeLessThan(4000)
  const where = (await logged(cfg)).filter((e) => e.type === 'error').map((e) => e.data.where)
  expect(where).toContain('teardown final heartbeat')
  // Neither the stop step nor the outbox write was skipped for lack of time.
  expect(where).not.toContain('teardown heartbeat.stop')
  expect(where).not.toContain('teardown outbox.settled')
  expect(where).toContain('teardown checkpointProfile')
}, 10_000)

test('without a control channel nothing is queued and no outbox is made', async () => {
  const d = fake({ states: ['ended'] })
  const o = await runOccurrence(base, d)
  expect(o.result).toBe('completed')
  await expect(outboxText(base)).rejects.toThrow()
})
