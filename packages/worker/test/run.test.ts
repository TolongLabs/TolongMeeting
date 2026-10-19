import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import type { ChatMessage, JobConfig } from '@tm/core'
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
    'pinger.idle',
    'recorder.stop',
    'joinRecording',
    'audio.stop',
    'context.close',
    'checkpoints.stop',
    'checkpointProfile',
    'screen.stop'
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
  expect(d.formPinger).toBeNull()
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
    pingerReadyRejects: true,
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
      "A form couldn't be checked or pinged. Open the meeting page to see what the bot recorded.",
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

test('links in chat messages go to the pinger, one after the other', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'ended'],
    onState: async (n) => {
      if (n !== 1) return
      const m: ChatMessage = {
        key: 'k1',
        sender: 'Dr Lee',
        senderRole: 'host',
        time: '8:01 PM',
        seenAt: '2026-10-21T12:01:00.000Z',
        text: 'sign here',
        links: ['https://forms.gle/a', 'https://forms.gle/b'],
        replyTo: null
      }
      await d.hooks.chat.onMessage!(m)
    }
  })
  await runOccurrence(lectureCfg, d)
  expect(d.formPinger!.offers.map((o) => [o.url, o.source, o.sender, o.senderRole])).toEqual([
    ['https://forms.gle/a', 'meeting_chat', 'Dr Lee', 'host'],
    ['https://forms.gle/b', 'meeting_chat', 'Dr Lee', 'host']
  ])
})

test('a failing teardown step is reported and the later steps still run', async () => {
  const d = fakeDeps({
    states: ['ended'],
    recorderStop: async () => {
      throw new Error('ffmpeg gave up')
    }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({ result: 'completed' })
  for (const step of ['joinRecording', 'audio.stop', 'context.close', 'checkpointProfile', 'screen.stop'])
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
  expect(o).toMatchObject({ result: 'completed', endedBy: 'hard_stop', reason: 'terminated' })
  expect(d.calls).toContain('leave')
  expect(d.calls).toContain('checkpointProfile')
})
