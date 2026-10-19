import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import { formIdFor, newFormRecord, type ChatMessage, type FormCandidate, type JobConfig } from '@tm/core'
import { startFormDispatcher } from '../src/forms/dispatcher'
import { loadFormRecords, saveFormRecord } from '../src/forms/store'
import { CheckpointAuthError } from '../src/profile/profile'
import { runOccurrence } from '../src/run'
import { fakeDeps, makeCfg, type FakeDeps } from './helpers/fake-deps'

let lectureCfg: JobConfig
let workCfg: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT, key: process.env.TM_MASTER_KEY_FILE }

beforeEach(async () => {
  lectureCfg = await makeCfg('lecture')
  workCfg = await makeCfg('work')
  profileRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-profiles-'))
  process.env.TM_PROFILE_ROOT = profileRoot
  process.env.TM_MASTER_KEY_FILE = '/unused: readMasterKey is faked'
})

afterEach(async () => {
  for (const [name, value] of [
    ['TM_PROFILE_ROOT', saved.root],
    ['TM_MASTER_KEY_FILE', saved.key]
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const cfg of [lectureCfg, workCfg]) await rm(join(cfg.dataDir, '..'), { recursive: true, force: true })
  await rm(profileRoot, { recursive: true, force: true })
})

const events = async (cfg: JobConfig) =>
  (await readFile(join(cfg.dataDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
const messages = (d: FakeDeps) => d.pings.map((p) => p.message)

// d.calls holds the first call of each step only: a step that repeats (a tick's) shows once.
test('happy path: order of steps and outcome', async () => {
  const d = fakeDeps({ states: ['in_meeting', 'in_meeting', 'ended'] })
  const o = await runOccurrence(lectureCfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(d.calls).toEqual([
    'prepareProfile',
    'startScreen',
    'launchBrowser',
    'startCheckpoints',
    'checkFormProviders',
    'startFormDispatcher',
    'startAudioSource',
    'startRecorder',
    'goto',
    'join',
    'assertDevicesOff',
    'connectOutputAudio',
    'ensureLayout',
    'dismissNotices',
    'participantCount',
    'startChatCapture',
    'startFrameLoop',
    'startLiveAsr',
    'chat.stop',
    'frames.stop',
    'asr.stop',
    'forms.close',
    'recorder.stop',
    'audio.stop',
    'context.close',
    'checkpoints.stop',
    'checkpointProfile',
    'screen.stop',
    'joinRecording'
  ])
  expect(d.pings.map((p) => p.title)).toEqual(['Joined: Data Mining'])
  expect(JSON.parse(await readFile(join(lectureCfg.dataDir, 'outcome.json'), 'utf8'))).toEqual(o)
  expect(o.joinedAt).not.toBeNull()
})

test('hard stop at end + 30 minutes sweeps chat before leaving', async () => {
  const d = fakeDeps({ states: 'always_in_meeting' })
  const o = await runOccurrence(lectureCfg, d)
  expect(o.endedBy).toBe('hard_stop')
  expect(+d.leftAt!).toBe(+new Date(lectureCfg.entry.end) + 30 * 60_000)
  expect(d.calls.indexOf('sweepNow')).toBe(d.calls.indexOf('leave') - 1)
})

test('busy Zoom account falls back to a guest stage', async () => {
  const d = fakeDeps({
    joins: [{ kind: 'account_busy' }, { kind: 'in_meeting' }],
    states: ['ended']
  })
  await runOccurrence(lectureCfg, d)
  expect(d.calls).toContain('launchGuestStage')
  expect(d.calls).toContain('guest.close')
  // The account's own page leaves the call before the guest joins.
  expect(d.gotos.map((u) => (u === 'about:blank' ? u : 'link'))).toEqual(['link', 'about:blank', 'link'])
  expect(d.joinOpts[1]).toEqual({
    guestName: lectureCfg.identity.zoomGuestName
  })
})

test('Review Focus: never admitted, or ended while waiting', async () => {
  const d = fakeDeps({
    joins: [{ kind: 'lobby' }],
    admissions: ['lobby_expired', 'lobby_expired', 'lobby_expired']
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'not_admitted'
  })
  expect(d.joinCount).toBe(3)
  expect(d.pings.map((p) => p.message)).toEqual(['The bot was still waiting to be let in at the hard stop.'])
  expect(d.calls.indexOf('checkpointProfile')).toBeGreaterThan(d.calls.indexOf('context.close'))
  const e = fakeDeps({
    joins: [{ kind: 'lobby' }],
    admissions: ['lobby_denied']
  })
  expect(await runOccurrence(lectureCfg, e)).toMatchObject({
    result: 'denied'
  })
})

test('devices on: leave at once, ping, fail', async () => {
  const d = fakeDeps({ devicesOn: true })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'failed',
    reason: 'devices_on'
  })
  expect(d.calls.indexOf('leave')).toBe(d.calls.indexOf('assertDevicesOff') + 1)
  // The browser closes right after the leave, before any slow step.
  expect(d.calls.indexOf('context.close')).toBe(d.calls.indexOf('leave') + 1)
  expect(messages(d)).toContain('A microphone or camera showed as on, so the bot left the meeting.')
})

test('one automatic rejoin after a drop, then stop', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'unknown', 'in_meeting', 'unknown'],
    unknownMs: 30_000
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    endedBy: 'dropped'
  })
  expect(d.joinCount).toBe(2)
  expect(d.pings.filter((p) => p.title.startsWith('Alert')).map((p) => p.message)).toEqual([
    'The bot dropped out of the meeting and is rejoining.',
    'The bot dropped out of the meeting again and stopped.'
  ])
})

test('work entries skip forms; non-fixed links are refused', async () => {
  const d = fakeDeps({ states: ['ended'] })
  await runOccurrence(workCfg, d)
  expect(d.calls).not.toContain('checkFormProviders')
  expect(d.forms).toBeNull()
  expect(d.calls).not.toContain('startFormDispatcher')
  expect(
    await runOccurrence(
      {
        ...lectureCfg,
        entry: { ...lectureCfg.entry, link: { kind: 'paste' } }
      },
      fakeDeps({})
    )
  ).toMatchObject({ result: 'failed', reason: 'link_source_unsupported' })
})

test('the profile comes from the newest checkpoint, then the next-newest when one is bad', async () => {
  await rm(join(lectureCfg.profileDir, 'Preferences'))
  const dir = join(profileRoot, lectureCfg.identity.id, 'checkpoints')
  await mkdir(dir, { recursive: true })
  for (const name of ['20261019T100000Z', '20261020T100000Z', '20261021T100000Z'])
    await writeFile(join(dir, `${name}.tar.enc`), '')
  const tried: string[] = []
  const d = fakeDeps({
    states: ['ended'],
    restore: async (file) => {
      tried.push(basename(file).slice(0, 13))
      if (tried.length < 3) throw new CheckpointAuthError()
    }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'completed' })
  expect(tried).toEqual(['20261021T1000', '20261020T1000', '20261019T1000'])

  const broken = fakeDeps({
    restore: async () => {
      throw new CheckpointAuthError()
    }
  })
  expect(await runOccurrence(lectureCfg, broken)).toMatchObject({
    result: 'failed',
    reason: 'step_failed: prepareProfile'
  })
  expect(broken.calls).not.toContain('startScreen')
})

test('a bad tick never ends the meeting', async () => {
  const d = fakeDeps({
    states: ['ended'],
    onState: (n) => {
      if (n === 1) throw new Error('page navigated')
    }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect((await events(lectureCfg)).some((e) => e.type === 'error' && e.data.where === 'tick meetingState')).toBe(true)
})

test('component faults ping once each, never silently', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'in_meeting', 'ended'],
    dispatcherStartFails: new Error('forms directory unreadable'),
    onState: (n) => {
      if (n !== 1) return
      const boom = new Error('boom')
      d.hooks.frames.fatal.forEach((cb) => cb(boom))
      d.hooks.audio.fatal.forEach((cb) => cb(boom))
      d.hooks.recorder.fatal.forEach((cb) => cb(boom))
      d.hooks.checkpoints.onError?.(boom)
      d.hooks.checkpoints.onError?.(boom)
      d.hooks.asr.opts!.onError!(new AiKeyError(401, 'bad key'))
      d.hooks.asr.opts!.onError!(new AiKeyError(401, 'bad key'))
    }
  })
  await runOccurrence(lectureCfg, d)
  expect(messages(d).sort()).toEqual(
    [
      'In the meeting with 5 participants. Recording.',
      "The bot's form submission stopped working. The recording continues.",
      "The bot's audio capture stopped working. The recording continues.",
      "The bot's profile checkpoint stopped working. The recording continues.",
      "The bot's screen capture stopped working. The recording continues.",
      'Your AI key was rejected (401). Recording continues; the summary needs a working key.',
      'The recorder stopped and could not restart. Nothing is recorded from now on.'
    ].sort()
  )
  expect(d.pings.every((p) => p.priority === 'high' || p.title.startsWith('Joined'))).toBe(true)
})

test('three recorder gaps in ten minutes raise recording_unstable', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    onState: (n) => {
      if (n !== 1) return
      const from = new Date(d.clock())
      for (const cb of d.hooks.recorder.gap) for (let i = 0; i < 3; i++) cb({ from, to: new Date(+from + 5000) })
    }
  })
  await runOccurrence(lectureCfg, d)
  expect(messages(d)).toEqual([
    'In the meeting with 5 participants. Recording.',
    'The recorder restarted; 5 seconds are missing from the recording.',
    'The recorder keeps restarting. Parts of the recording are missing.'
  ])
})

test('silence for two minutes reconnects audio and pings; an unknown level does not count', async () => {
  const silent = fakeDeps({ level: -90, states: 'always_in_meeting' })
  await runOccurrence(lectureCfg, silent)
  expect(messages(silent).filter((m) => m.startsWith('No meeting sound'))).toHaveLength(1)

  const unknown = fakeDeps({ level: null, states: 'always_in_meeting' })
  await runOccurrence(lectureCfg, unknown)
  expect(messages(unknown).filter((m) => m.startsWith('No meeting sound'))).toHaveLength(0)
})

const chatMessage = (over: Partial<ChatMessage>): ChatMessage => ({
  key: 'k1',
  sender: 'Dr Lee',
  senderRole: 'host',
  time: '8:01 PM',
  seenAt: '2026-10-21T12:01:00.000Z',
  text: 'sign here',
  links: [],
  replyTo: null,
  ...over
})
const candidateOf = (url: string): FormCandidate => ({
  url,
  source: 'meeting_chat',
  sender: 'Dr Lee',
  senderRole: 'host',
  seenAt: '2026-10-21T12:01:00.000Z'
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const GOOGLE = (id: string) => `https://docs.google.com/forms/d/e/${id}/viewform`

test('links in chat messages are resolved and offered to the form dispatcher without being awaited', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    onState: async (n) => {
      if (n !== 1) return
      await d.hooks.chat.onMessage!(chatMessage({ links: ['https://forms.gle/a', 'https://zoom.us/j/1'] }))
      await settle()
    }
  })
  await runOccurrence(lectureCfg, d)
  expect(d.forms!.offers.map((o) => [o.url, o.finalUrl, o.provider, o.source, o.sender, o.senderRole])).toEqual([
    ['https://forms.gle/a', 'https://forms.gle/a', 'google', 'meeting_chat', 'Dr Lee', 'host']
  ])
  expect(
    (await events(lectureCfg)).filter((e) => e.type === 'form').map((e) => [e.data.outcome, e.data.reason, e.data.host])
  ).toEqual([['ignored', 'not_a_form', 'zoom.us']])
})

test('forms are only handled in lectures, and the dispatcher closes before the recorder stops', async () => {
  const d = fakeDeps({ states: ['ended'] })
  await runOccurrence(lectureCfg, d)
  expect(d.calls.indexOf('forms.close')).toBeGreaterThan(d.calls.indexOf('asr.stop'))
  expect(d.calls.indexOf('forms.close')).toBeLessThan(d.calls.indexOf('recorder.stop'))
  const work = fakeDeps({ states: ['ended'], onState: () => work.hooks.chat.onMessage?.(chatMessage({})) })
  await runOccurrence(workCfg, work)
  expect(work.calls).not.toContain('forms.close')
})

test('a dispatcher that cannot start is pinged, and every form link still reaches the member', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    dispatcherStartFails: new Error('forms directory unreadable'),
    onState: async (n) => {
      if (n !== 1) return
      await d.hooks.chat.onMessage!(chatMessage({ links: [GOOGLE('host-form')] }))
      await d.hooks.chat.onMessage!(
        chatMessage({ key: 'k2', sender: 'Classmate', senderRole: 'participant', links: [GOOGLE('peer-form')] })
      )
      await settle()
    }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'completed' })
  expect(messages(d).filter((m) => !m.startsWith('In the meeting'))).toEqual([
    "The bot's form submission stopped working. The recording continues.",
    "Dr Lee shared a link at 20:01 that couldn't be checked within 5 seconds. It may be a form.",
    "Classmate shared a link at 20:01 that couldn't be checked within 5 seconds. It may be a form."
  ])
  expect(await errorsAt(lectureCfg, 'form submission')).toHaveLength(1)
  expect(
    (await events(lectureCfg)).filter((e) => e.type === 'form').map((e) => [e.data.outcome, e.data.reason, e.data.host])
  ).toEqual([
    ['unresolved', 'dispatcher_unavailable', 'docs.google.com'],
    ['unresolved', 'dispatcher_unavailable', 'docs.google.com']
  ])
})

test('after a restart the chat replay does not handle or ping a form an earlier run handled', async () => {
  const handled = (id: string) => {
    const rec = newFormRecord({ ...candidateOf(GOOGLE(id)), finalUrl: GOOGLE(id), provider: 'google' }, 'occ-1')
    return { ...rec, state: 'submitted' as const, submittedAt: '2026-10-21T12:05:00.000Z' }
  }
  const submitted = handled('done')
  await saveFormRecord(lectureCfg.dataDir, submitted)
  // A record the 1A pinger wrote: it does not parse as a FormRecord, and still counts as handled.
  const oldId = formIdFor(GOOGLE('old'))
  await mkdir(join(lectureCfg.dataDir, 'forms', oldId), { recursive: true })
  await writeFile(
    join(lectureCfg.dataDir, 'forms', oldId, 'record.json'),
    JSON.stringify({ formId: oldId, url: GOOGLE('old'), pingedAt: '2026-10-21T12:02:00.000Z' })
  )
  const handledCalls: string[] = []
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    onState: async (n) => {
      if (n !== 1) return
      const replay = d.hooks.chat.opts!.onReplay!
      await replay(chatMessage({ links: [GOOGLE('done'), GOOGLE('old'), GOOGLE('fresh')] }))
      await settle()
    }
  })
  d.startFormDispatcher = (base) =>
    startFormDispatcher(base, async (f) => {
      handledCalls.push(f.finalUrl)
      return { ...newFormRecord(f, 'occ-1'), state: 'submitted' as const, submittedAt: '2026-10-21T12:06:00.000Z' }
    })
  await runOccurrence(lectureCfg, d)
  expect(handledCalls).toEqual([GOOGLE('fresh')])
  expect(d.pings.map((p) => p.title)).toEqual(['Joined: Data Mining'])
  const { records, invalid } = await loadFormRecords(lectureCfg.dataDir)
  expect(records.find((r) => r.formId === submitted.formId)).toEqual(submitted)
  expect(invalid).toEqual([oldId])
})

test('a failing teardown step is reported and the later steps still run', async () => {
  const d = fakeDeps({
    states: ['ended'],
    recorderStop: async () => {
      throw new Error('ffmpeg gave up')
    }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'completed' })
  for (const step of ['audio.stop', 'context.close', 'checkpointProfile', 'screen.stop', 'joinRecording'])
    expect(d.calls).toContain(step)
  expect((await events(lectureCfg)).find((e) => e.data.where === 'teardown recorder.stop')?.type).toBe('error')
})

test('SIGTERM ends the meeting through the normal teardown', async () => {
  const abort = new AbortController()
  const d = fakeDeps({
    states: 'always_in_meeting',
    onState: (n) => {
      if (n === 2) abort.abort()
    }
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'completed', endedBy: 'terminated', reason: 'terminated' })
  expect(d.calls).toContain('leave')
  expect(d.calls).toContain('checkpointProfile')
})

const hang = (): Promise<never> => new Promise(() => undefined)
const outcomeFile = async (cfg: JobConfig) => JSON.parse(await readFile(join(cfg.dataDir, 'outcome.json'), 'utf8'))
const errorsAt = async (cfg: JobConfig, where: string) =>
  (await events(cfg)).filter((e) => e.type === 'error' && e.data.where === where)

// --- teardown fits the stop timeout ---

test('a hung leave and a hung recorder stop: the checkpoint still runs, inside the budget', async () => {
  const d = fakeDeps({ states: 'always_in_meeting', leave: hang, recorderStop: hang, teardownBudgetMs: 1000 })
  const started = Date.now()
  const o = await runOccurrence(lectureCfg, d)
  const elapsed = Date.now() - started
  expect(o.endedBy).toBe('hard_stop')
  expect(d.calls).toContain('checkpointProfile')
  expect(d.calls).toContain('screen.stop')
  expect(d.calls.indexOf('checkpointProfile')).toBeGreaterThan(d.calls.indexOf('context.close'))
  expect(elapsed).toBeLessThan(1000 + 500)
  expect(await errorsAt(lectureCfg, 'teardown leave')).toHaveLength(1)
  expect(await errorsAt(lectureCfg, 'teardown recorder.stop')).toHaveLength(1)
  expect(await outcomeFile(lectureCfg)).toEqual(o)
})

test('a failed or timed-out leave closes the browser at once, before the next step', async () => {
  for (const leave of [hang, async () => Promise.reject(new Error('page crashed'))]) {
    const cfg = await makeCfg('lecture')
    const d = fakeDeps({ states: 'always_in_meeting', leave, teardownBudgetMs: 800 })
    await runOccurrence(cfg, d)
    expect(d.calls.indexOf('context.close')).toBe(d.calls.indexOf('leave') + 1)
    expect(d.calls.indexOf('chat.stop')).toBeGreaterThan(d.calls.indexOf('context.close'))
    await rm(join(cfg.dataDir, '..'), { recursive: true, force: true })
  }
})

test('joinRecording runs last, and is skipped with an event when no time is left', async () => {
  const d = fakeDeps({ states: ['ended'], checkpoint: hang, teardownBudgetMs: 600 })
  const started = Date.now()
  const o = await runOccurrence(lectureCfg, d)
  expect(Date.now() - started).toBeLessThan(600 + 500)
  expect(d.calls).toContain('checkpointProfile')
  expect(d.calls).not.toContain('joinRecording')
  const [skip] = await errorsAt(lectureCfg, 'teardown joinRecording')
  expect(String(skip!.data.message)).toContain('no teardown time left')
  expect(await outcomeFile(lectureCfg)).toEqual(o)
})

test('the checkpoint is skipped, with an event, only when the browser did not close', async () => {
  const d = fakeDeps({
    states: ['ended'],
    contextClose: async () => Promise.reject(new Error('chrome is stuck'))
  })
  await runOccurrence(lectureCfg, d)
  expect(d.calls).not.toContain('checkpointProfile')
  expect(d.calls).toContain('joinRecording')
  expect(await errorsAt(lectureCfg, 'teardown checkpointProfile')).toHaveLength(1)
})

test('a live transcription error that is not a key problem raises component_failed', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'in_meeting', 'ended'],
    onState: (n) => {
      if (n === 1) d.hooks.asr.opts!.onError!(new Error('ENOSPC: transcript write failed'))
    }
  })
  await runOccurrence(lectureCfg, d)
  expect(messages(d)).toContain("The bot's live transcription stopped working. The recording continues.")
  expect(await errorsAt(lectureCfg, 'live transcription')).toHaveLength(1)
})

// --- extras never end the meeting ---

test.each([
  ['participant count', { participantCount: async () => Promise.reject(new Error('no roster')) }],
  ['notice dismissal', { dismissNotices: async () => Promise.reject(new Error('no dialog')) }],
  ['chat capture', { startFails: { chat: new Error('no chat panel') } }],
  ['screen capture', { startFails: { frames: new Error('ffmpeg missing') } }],
  ['live transcription', { startFails: { asr: new Error('no socket') } }]
])('%s failing is pinged and the recording goes on', async (component, fault) => {
  const d = fakeDeps({ states: ['in_meeting', 'in_meeting', 'ended'], ...fault })
  const o = await runOccurrence(lectureCfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(messages(d)).toContain(`The bot's ${component} stopped working. The recording continues.`)
  expect(d.calls).toContain('startRecorder')
  expect(d.calls.indexOf('joinRecording')).toBeGreaterThan(-1)
  expect((await events(lectureCfg)).some((e) => e.type === 'error' && e.data.where === component)).toBe(true)
})

test('a failure after the join in the audio set-up stays fatal', async () => {
  const d = fakeDeps({ states: 'always_in_meeting' })
  const real = d.adapterFor
  d.adapterFor = (url) => ({
    ...real(url)!,
    connectOutputAudio: async () => Promise.reject(new Error('no sink'))
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'failed',
    reason: 'step_failed: connectOutputAudio'
  })
  expect(d.calls).not.toContain('startFrameLoop')
})

// --- alerts ---

test('a supervisor crash pings run_failed, not a component fault', async () => {
  const d = fakeDeps({})
  d.adapterFor = () => {
    throw new Error('adapter table broken')
  }
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'failed', reason: 'internal_error' })
  expect(messages(d)).toEqual(['The bot stopped unexpectedly. The meeting is no longer being recorded.'])
})

test('a device check that cannot run says so; it is not called a drop', async () => {
  const d = fakeDeps({
    states: 'always_in_meeting',
    assertDevices: (n) => {
      if (n > 1) throw new Error('toolbar not found')
    }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'failed',
    endedBy: 'dropped',
    reason: 'device_check_failed'
  })
  expect(messages(d).filter((m) => !m.startsWith('In the meeting'))).toEqual([
    'The bot could not check that its microphone and camera are off, so it is rejoining the meeting.',
    'The bot could not check its microphone and camera again, so it stopped.'
  ])
})

test('a corrupt attempts.json falls back to this attempt and says so', async () => {
  await mkdir(join(lectureCfg.dataDir, 'recording'), { recursive: true })
  await writeFile(join(lectureCfg.dataDir, 'recording', 'attempts.json'), '{not json')
  const d = fakeDeps({ states: ['ended'] })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'completed' })
  expect(await errorsAt(lectureCfg, 'attempts.json')).toHaveLength(1)
})

// --- SIGTERM ---

test('SIGTERM during a tick whose page call hangs: teardown still runs, inside the budget from the signal', async () => {
  const abort = new AbortController()
  let abortedAt = 0
  const d = fakeDeps({
    states: 'always_in_meeting',
    teardownBudgetMs: 1000,
    onState: (n) => {
      if (n !== 2) return
      abortedAt = Date.now()
      abort.abort()
      return hang()
    }
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'completed', endedBy: 'terminated', reason: 'terminated' })
  expect(Date.now() - abortedAt).toBeLessThan(1000 + 500)
  expect(d.calls).toContain('leave')
  expect(d.calls).toContain('checkpointProfile')
  expect(await outcomeFile(lectureCfg)).toEqual(o)
})

test('SIGTERM before the bot is in the meeting closes the browser first, so a late join cannot stay in the call', async () => {
  const abort = new AbortController()
  let closedWhenJoinEnded = null as boolean | null
  const d = fakeDeps({
    recorderStop: () => new Promise((resolve) => setTimeout(resolve, 300)),
    onJoin: async () => {
      abort.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))
      closedWhenJoinEnded = d.calls.includes('context.close')
    }
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'failed', endedBy: 'terminated', joinedAt: null })
  expect(d.calls).not.toContain('leave')
  expect(closedWhenJoinEnded).toBe(true)
  expect(d.calls).toContain('checkpointProfile')
})

test('SIGTERM during a join that hangs ends as terminated, without a leave', async () => {
  const abort = new AbortController()
  const d = fakeDeps({
    onJoin: () => {
      abort.abort()
      return hang()
    }
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'failed', endedBy: 'terminated', reason: 'terminated', joinedAt: null })
  expect(d.calls).not.toContain('leave')
  expect(d.calls).toContain('checkpointProfile')
  expect(d.calls).toContain('joinRecording')
})

test('SIGTERM in the lobby ends as terminated, not as not admitted', async () => {
  const abort = new AbortController()
  const d = fakeDeps({
    joins: [{ kind: 'lobby' }],
    onAdmission: () => {
      abort.abort()
      return hang()
    }
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'failed', endedBy: 'terminated', reason: 'terminated' })
  expect(messages(d)).toEqual([])
  expect(d.calls).toContain('checkpointProfile')
})

test('SIGTERM during a rejoin is not a failed rejoin', async () => {
  const abort = new AbortController()
  const d = fakeDeps({
    states: ['in_meeting', 'unknown'],
    unknownMs: 30_000,
    onJoin: (n) => {
      if (n !== 2) return
      abort.abort()
      return hang()
    }
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'completed', endedBy: 'terminated', reason: 'terminated' })
  expect(messages(d).some((m) => m.includes('dropped out of the meeting again'))).toBe(false)
})

test('SIGTERM right after the join starts none of the extras', async () => {
  const abort = new AbortController()
  const d = fakeDeps({ states: 'always_in_meeting' })
  const real = d.adapterFor
  d.adapterFor = (url) => ({
    ...real(url)!,
    connectOutputAudio: async () => abort.abort()
  })
  const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(o).toMatchObject({ result: 'completed', endedBy: 'terminated' })
  for (const step of ['startChatCapture', 'startFrameLoop', 'startLiveAsr']) expect(d.calls).not.toContain(step)
  expect(d.calls).toContain('leave')
  expect(d.calls).toContain('checkpointProfile')
})

test('a hung form dispatcher close is bounded, reported, and the checkpoint still runs', async () => {
  const d = fakeDeps({ states: ['ended'], formsClose: hang, teardownBudgetMs: 1000 })
  const started = Date.now()
  await runOccurrence(lectureCfg, d)
  expect(Date.now() - started).toBeLessThan(1000 + 500)
  expect(await errorsAt(lectureCfg, 'teardown forms.close')).toHaveLength(1)
  for (const step of ['recorder.stop', 'context.close', 'checkpointProfile']) expect(d.calls).toContain(step)
})

// --- set-up steps before the join end at SIGTERM ---

test.each(['prepareProfile', 'startScreen', 'launchBrowser'] as const)(
  'SIGTERM while %s hangs ends the run, and the abandoned step failing later is swallowed',
  async (step) => {
    const abort = new AbortController()
    const lateFailures: ((e: Error) => void)[] = []
    const stuck = () =>
      new Promise<never>((_, reject) => {
        lateFailures.push(reject)
        abort.abort()
      })
    const d = fakeDeps({})
    if (step === 'launchBrowser') d.launchBrowser = stuck
    else d[step] = stuck
    const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
    expect(o).toMatchObject({ result: 'failed', endedBy: 'terminated', reason: 'terminated', joinedAt: null })
    expect(d.calls).not.toContain('startCheckpoints')
    expect(await outcomeFile(lectureCfg)).toEqual(o)
    // The step fails after the run has ended. Nothing may be thrown from it (an unhandled rejection fails the run).
    for (const fail of lateFailures) fail(new Error('chrome crashed late'))
    await settle()
  }
)

test.each(['startCheckpoints', 'startAudioSource', 'startRecorder'] as const)(
  'SIGTERM while %s hangs ends the run, and the abandoned step failing later is swallowed',
  async (step) => {
    const abort = new AbortController()
    const lateFailures: ((e: Error) => void)[] = []
    const d = fakeDeps({})
    const stuck = () =>
      new Promise<never>((_, reject) => {
        lateFailures.push(reject)
        abort.abort()
      })
    Object.assign(d, { [step]: stuck })
    const o = await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
    expect(o).toMatchObject({ result: 'failed', endedBy: 'terminated', reason: 'terminated', joinedAt: null })
    expect(d.calls).toContain('checkpointProfile')
    for (const fail of lateFailures) fail(new Error('late failure'))
    await settle()
  }
)

// --- no form link is lost at teardown ---

function gated() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => (release = resolve))
  return { promise, release }
}

test('a link still resolving at SIGTERM reaches the dispatcher before it closes', async () => {
  const abort = new AbortController()
  const gate = gated()
  const d = fakeDeps({
    states: 'always_in_meeting',
    resolve: async (c) => {
      await gate.promise
      return { ...c, finalUrl: c.url, provider: 'google' }
    },
    onState: async (n) => {
      if (n !== 1) return
      await d.hooks.chat.onMessage!(chatMessage({ links: [GOOGLE('late')] }))
      abort.abort()
      setTimeout(gate.release, 100) // the resolve settles after the SIGTERM chat sweep
    }
  })
  await runOccurrence(lectureCfg, { ...d, signal: abort.signal })
  expect(d.calls.indexOf('sweepNow')).toBeGreaterThan(-1)
  expect(d.forms!.offers.map((o) => o.finalUrl)).toEqual([GOOGLE('late')])
  expect(d.pings.map((p) => p.title)).toEqual(['Joined: Data Mining'])
})

test('a link that resolves after the dispatcher closed is pinged by its canonical URL', async () => {
  const gate = gated()
  const raw = `${GOOGLE('x').replace('viewform', 'formResponse')}?entry.1=x&submit=Submit`
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    teardownBudgetMs: 1000,
    resolve: async (c) => {
      await gate.promise
      return { ...c, finalUrl: c.url, provider: 'google' }
    },
    // The intake wait ran out of time; the dispatcher closes, and only then does the resolve finish.
    formsClose: async () => {
      gate.release()
      await settle()
    },
    onState: async (n) => {
      if (n === 1) await d.hooks.chat.onMessage!(chatMessage({ links: [raw] }))
    }
  })
  await runOccurrence(lectureCfg, d)
  expect(d.forms!.offers).toEqual([])
  const unchecked = d.pings.filter((p) => p.title.startsWith('Link seen, not checked'))
  expect(unchecked.map((p) => p.actions?.map((a) => a.url))).toEqual([[GOOGLE('x')]])
  expect(await errorsAt(lectureCfg, 'teardown forms.intake')).toHaveLength(1)
})

test('a form link ping that cannot be sent raises the form_ping_failed alert', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    dispatcherStartFails: new Error('forms directory unreadable'),
    onState: async (n) => {
      if (n !== 1) return
      await d.hooks.chat.onMessage!(chatMessage({ links: [GOOGLE('host-form')] }))
      await settle()
    }
  })
  const send = d.sendPing
  d.sendPing = async (cfg, ping) => {
    if (ping.title.startsWith('Link seen')) throw new Error('ntfy down')
    await send(cfg, ping)
  }
  await runOccurrence(lectureCfg, d)
  expect((await events(lectureCfg)).filter((e) => e.type === 'alert').map((e) => e.data.kind)).toContain(
    'form_ping_failed'
  )
  expect(await errorsAt(lectureCfg, 'form_intake')).toHaveLength(1)
})
