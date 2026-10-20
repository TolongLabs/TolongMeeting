import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  newFormRecord,
  type ChatMessage,
  type ControlCommand,
  type Heartbeat,
  type JobConfig,
  type MeetingEvent,
  type OccurrenceState,
  type ResolvedForm
} from '@tm/core'
import { startFormDispatcher } from '../src/forms/dispatcher'
import { runOccurrence } from '../src/run'
import { fakeDeps, makeCfg, type FakeDeps, type FakeOptions } from './helpers/fake-deps'

let work: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT, site: process.env.TM_PUBLIC_URL }
const servers: { stop(): void }[] = []

beforeEach(async () => {
  work = {
    ...(await makeCfg('work')),
    member: { id: 'm-1', displayName: 'Ali', mentionNames: ['Aisyah'], details: [] }
  }
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
  await rm(join(work.dataDir, '..'), { recursive: true, force: true })
  await rm(profileRoot, { recursive: true, force: true })
})

// A control server that records every heartbeat; `answer` says which commands to send back.
function control(answer: (body: Heartbeat) => ControlCommand[] = () => []) {
  const seen: Heartbeat[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Heartbeat
      seen.push(body)
      return Response.json({ ackedEvents: body.events.length, commands: answer(body), link: null })
    }
  })
  servers.push({ stop: () => server.stop(true) })
  const events = (): MeetingEvent[] => seen.flatMap((b) => b.events)
  const stateEvents = () => events().filter((e) => e.type === 'state' && 'state' in e.data)
  const states = (): OccurrenceState[] => stateEvents().map((e) => e.data.state as OccurrenceState)
  return { seen, events, stateEvents, states, url: `http://127.0.0.1:${server.port}/api/control` }
}

const withControl = (url: string): JobConfig => ({ ...work, control: { url, token: '1.token' } })

// Real time passes at each wait, so a heartbeat reply can arrive while the fake clock runs.
function paced(d: FakeDeps): FakeDeps {
  const inner = d.sleep
  d.sleep = async (ms) => {
    await inner(ms)
    await Bun.sleep(3)
  }
  d.heartbeat = { intervalMs: 15, backoff: { firstMs: 10, maxMs: 40 } }
  return d
}
const fake = (opts: FakeOptions = {}) => paced(fakeDeps(opts))

const loggedEvents = async (cfg: JobConfig): Promise<MeetingEvent[]> =>
  (await readFile(join(cfg.dataDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as MeetingEvent)

// --- mention alerts ---

// Runs a short meeting and feeds `results` to the live transcription as it goes.
async function hear(cfg: JobConfig, results: { startMs: number; endMs: number; text: string }[]): Promise<FakeDeps> {
  const d: FakeDeps = fakeDeps({
    states: ['in_meeting', 'in_meeting', 'in_meeting', 'ended'],
    onState: async (n) => {
      if (n !== 2) return
      for (const r of results) d.hooks.asr.opts!.onResult!(r)
      await Bun.sleep(5)
    }
  })
  await runOccurrence(cfg, d)
  return d
}
const mentionPings = (d: FakeDeps) => d.pings.filter((p) => p.title.startsWith('Your name was mentioned'))

test('a mention ping never carries a link or a passcode, even one read aloud', async () => {
  const d = await hear(work, [
    { startMs: 0, endMs: 5_000, text: 'join at https://zoom.us/j/12345678901?pwd=SECRETPWD or zoom.us/j/12345678901' },
    { startMs: 5_000, endMs: 10_000, text: 'the passcode is 4 8 1 5 9 2 and the password is hunter two' },
    { startMs: 10_000, endMs: 15_000, text: 'Aisyah, are you there?' }
  ])
  const [ping] = mentionPings(d)
  expect(ping).toBeDefined()
  expect(ping!.message).toContain('Aisyah, are you there?')
  const text = `${ping!.title}\n${ping!.message}`
  for (const secret of ['https://', 'zoom.us', 'pwd', 'SECRETPWD', '12345678901', '4 8 1 5 9 2', 'hunter'])
    expect(text).not.toContain(secret)
  // The buttons are the website's own pages.
  expect(ping!.actions).toEqual([
    { label: 'Open meeting page', url: 'https://tolong.example.com/meetings/occ-1' },
    { label: 'Take over', url: 'https://tolong.example.com/meetings/occ-1/take-over' }
  ])
})

test('a roll call pings once in 2 minutes, every mention is still an event, and the event holds no text', async () => {
  const roll = (endMs: number) => ({ startMs: endMs - 2_000, endMs, text: 'Aisyah? Aisyah, are you there?' })
  const d = await hear(work, [roll(52_000), roll(58_000), roll(70_000), roll(175_000)])
  expect(mentionPings(d)).toHaveLength(2)
  const mentions = (await loggedEvents(work)).filter((e) => e.type === 'mention')
  expect(mentions.map((e) => e.data)).toEqual([{ atMs: 52_000 }, { atMs: 58_000 }, { atMs: 70_000 }, { atMs: 175_000 }])
})

test('a restarted worker keeps the debounce: a ping sent 60 s before the recorder started still holds', async () => {
  const d: FakeDeps = fakeDeps({
    states: ['in_meeting', 'in_meeting', 'in_meeting', 'ended'],
    onState: async (n) => {
      if (n !== 2) return
      const say = (endMs: number) => d.hooks.asr.opts!.onResult!({ startMs: endMs - 2_000, endMs, text: 'Aisyah?' })
      say(30_000) // 90 s after the earlier attempt's ping: inside the window
      say(61_000) // 121 s after it: a new ping
      await Bun.sleep(5)
    }
  })
  const startRecorder = d.startRecorder
  d.startRecorder = async (...args) => {
    const recorder = await startRecorder(...args)
    // What the earlier attempt left in events.jsonl: one mention (and so one ping) 60 s before this recorder started.
    const earlier = { occurrenceId: work.occurrenceId, attempt: 1, type: 'mention', data: { atMs: 1 } }
    const at = new Date(recorder.startedAt.getTime() - 60_000).toISOString()
    await appendFile(join(work.dataDir, 'events.jsonl'), `${JSON.stringify({ ...earlier, at })}\n`)
    return recorder
  }
  await runOccurrence(work, d)
  expect(mentionPings(d)).toHaveLength(1)
  expect(mentionPings(d)[0]!.message).toContain('Aisyah?')
  const atMs = (await loggedEvents(work))
    .filter((e) => e.type === 'mention' && e.data.atMs !== 1)
    .map((e) => e.data.atMs)
  expect(atMs).toEqual([30_000, 61_000])
})

test('a lecture, a native-transcription work entry and a member without names start no watch', async () => {
  const lecture = fakeDeps({ states: ['in_meeting', 'ended'] })
  await runOccurrence({ ...(await makeCfg('lecture')), member: work.member }, lecture)
  expect(lecture.hooks.asr.opts).toBeDefined()
  expect(lecture.hooks.asr.opts!.onResult).toBeUndefined()

  const nativeCfg: JobConfig = { ...work, entry: { ...work.entry, transcription: 'native' } }
  const native = fakeDeps({ states: ['in_meeting', 'ended'] })
  await runOccurrence(nativeCfg, native)
  expect(native.calls).not.toContain('startLiveAsr')

  const nameless = fakeDeps({ states: ['in_meeting', 'ended'] })
  await runOccurrence({ ...work, member: { ...work.member, mentionNames: ['A', ''] } }, nameless)
  expect(nameless.hooks.asr.opts!.onResult).toBeUndefined()
})

// --- linkUsed ---

test('linkUsed goes out from the moment joining starts, without its passcode', async () => {
  const c = control()
  const d = fake({ states: [...Array<'in_meeting'>(40).fill('in_meeting'), 'ended'] })
  await runOccurrence(withControl(c.url), d)
  const joiningAt = c.seen.findIndex((b) => b.state === 'joining' || b.state === 'in_meeting')
  expect(joiningAt).toBeGreaterThanOrEqual(0)
  expect(c.seen.slice(0, joiningAt).every((b) => b.linkUsed === undefined)).toBe(true)
  expect(c.seen.at(-1)!.linkUsed).toBe('https://zoom.us/j/12345678901')
  expect(c.seen.filter((b) => b.linkUsed !== undefined).length).toBeGreaterThan(0)
  expect(JSON.stringify(c.seen)).not.toContain('SECRETPWD')
})

// --- leave and take over ---

test.each(['leave_now', 'take_over'] as const)(
  '%s leaves through the page, reports left_by_member with the command and hands nothing over',
  async (command) => {
    const c = control((b) => (b.state === 'in_meeting' ? [command] : []))
    const d = fake({ states: 'always_in_meeting' })
    const cfg = withControl(c.url)
    const o = await runOccurrence(cfg, d)
    expect(o).toMatchObject({ result: 'completed', endedBy: 'member_left', command })
    expect(d.calls).toContain('leave')
    expect(d.stageCloses).toBe(0)
    expect(c.states().slice(-2)).toEqual(['in_meeting', 'left_by_member'])
    for (const state of ['leaving', 'uploading', 'transcribing']) expect(c.states()).not.toContain(state)
    expect(c.stateEvents().find((e) => e.data.state === 'left_by_member')!.data).toEqual({
      state: 'left_by_member',
      command
    })
    expect(JSON.parse(await readFile(join(cfg.dataDir, 'outcome.json'), 'utf8'))).toMatchObject({ command })
  }
)

test('a take_over after a leave_now in the same batch is reported as take_over', async () => {
  const c = control((b) => (b.state === 'in_meeting' ? ['leave_now', 'take_over'] : []))
  await runOccurrence(withControl(c.url), fake({ states: 'always_in_meeting' }))
  expect(c.stateEvents().find((e) => e.data.state === 'left_by_member')!.data.command).toBe('take_over')
})

const GOOGLE = (id: string) => `https://docs.google.com/forms/d/e/${id}/viewform`
const formMessage = (url: string): ChatMessage => ({
  key: `k-${url}`,
  sender: 'Dr Lee',
  senderRole: 'host',
  time: '8:01 PM',
  seenAt: new Date().toISOString(),
  text: 'sign here',
  links: [url],
  replyTo: null
})

// A lecture whose form submit takes `submitMs`. The real dispatcher runs; only the form handler is scripted.
function submitting(command: 'leave_now' | 'take_over', opts: FakeOptions & { submitMs: number }) {
  const log = { clicks: 0, submitDone: false, leaveSawSubmitDone: null as boolean | null, started: false }
  let sent = false
  const c = control(() => (log.started && !sent && (sent = true) ? [command] : []))
  const d = fake({
    ...opts,
    states: 'always_in_meeting',
    leave: async () => void (log.leaveSawSubmitDone = log.submitDone)
  })
  d.startFormDispatcher = (base) =>
    startFormDispatcher(base, async (f: ResolvedForm) => {
      log.clicks += 1
      log.started = true
      await Bun.sleep(opts.submitMs)
      log.submitDone = true
      return { ...newFormRecord(f, 'occ-1'), state: 'submitted' }
    })
  const cfg: JobConfig = { ...withControl(c.url), entry: { ...work.entry, type: 'lecture' } }
  const offered = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const send = d.hooks.chat.onMessage
      if (send === undefined) return
      clearInterval(timer)
      void send(formMessage(GOOGLE('exam'))).then(resolve)
    }, 2)
  })
  return { c, d, cfg, log, offered }
}

test.each(['leave_now', 'take_over'] as const)(
  'a %s during a form submit waits for the submit, then leaves, and Submit is clicked once',
  async (command) => {
    const t = submitting(command, { submitMs: 300 })
    const o = await runOccurrence(t.cfg, t.d)
    await t.offered
    expect(o).toMatchObject({ endedBy: 'member_left', command })
    expect(t.log.clicks).toBe(1)
    // The leave click came only after the submit finished.
    expect(t.log.leaveSawSubmitDone).toBe(true)
    expect(t.d.calls.indexOf('forms.close')).toBeLessThan(t.d.calls.indexOf('leave'))
    expect(t.c.states().at(-1)).toBe('left_by_member')
    const errors = (await loggedEvents(t.cfg)).filter((e) => e.type === 'error').map((e) => e.data.where)
    expect(errors).not.toContain('teardown forms.settle')
  }
)

test('a form that arrives again after the leave command is not submitted a second time', async () => {
  const t = submitting('leave_now', { submitMs: 200 })
  const again = (): void => {
    const send = t.d.hooks.chat.onMessage
    if (send !== undefined) void send(formMessage(GOOGLE('exam')))
  }
  const inner = t.d.sleep
  t.d.sleep = async (ms) => {
    if (t.log.started) again()
    await inner(ms)
  }
  await runOccurrence(t.cfg, t.d)
  expect(t.log.clicks).toBe(1)
})

// --- the teardown budget ---

test('a form that never settles costs the leave only its bound; the final heartbeat is still sent in the budget', async () => {
  const c = control((b) => (b.state === 'in_meeting' ? ['leave_now'] : []))
  const d = fake({ states: 'always_in_meeting', formsClose: () => new Promise<void>(() => {}), teardownBudgetMs: 2000 })
  const cfg: JobConfig = { ...withControl(c.url), entry: { ...work.entry, type: 'lecture' } }
  const started = Date.now()
  const o = await runOccurrence(cfg, d)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(o).toMatchObject({ endedBy: 'member_left' })
  expect(d.calls).toContain('leave')
  const where = (await loggedEvents(cfg)).filter((e) => e.type === 'error').map((e) => e.data.where)
  expect(where).toContain('teardown forms.settle')
  expect(where).not.toContain('teardown final heartbeat')
  expect(c.states().at(-1)).toBe('left_by_member')
}, 10_000)

test('a leave click that does not take is cut at its bound and the browser is closed', async () => {
  const c = control((b) => (b.state === 'in_meeting' ? ['leave_now'] : []))
  const d = fake({ states: 'always_in_meeting', leaveStays: true, teardownBudgetMs: 2000 })
  const cfg = withControl(c.url)
  const started = Date.now()
  await runOccurrence(cfg, d)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(d.calls).toContain('context.close')
  const where = (await loggedEvents(cfg)).filter((e) => e.type === 'error').map((e) => e.data.where)
  expect(where).toContain('teardown leave')
  expect(where).not.toContain('teardown final heartbeat')
  expect(c.states().at(-1)).toBe('left_by_member')
}, 10_000)
