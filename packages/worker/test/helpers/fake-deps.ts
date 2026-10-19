import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { ChatMessage, FormCandidate, FormProvider, JobConfig } from '@tm/core'
import type { Ping } from '@tm/notify'
import { DevicesOnError } from '../../src/adapters'
import type { AdmissionResult, JoinResult, MeetingState, PlatformAdapter } from '../../src/adapters/types'
import type { ChatCaptureOptions } from '../../src/chat/capture'
import type { LiveAsrOptions } from '../../src/asr/live'
import type { Frame } from '../../src/frames/frames'
import type { FormPinger } from '../../src/forms/pinger'
import type { RunDeps } from '../../src/run-deps'

const MINUTE = 60_000

export interface FakeOptions {
  /** What `meetingState` answers, one entry per call; the last entry repeats. */
  states?: MeetingState[] | 'always_in_meeting'
  /** An 'unknown' entry stays the answer until this much fake time has passed. */
  unknownMs?: number
  /** What `join` answers, one per call; the last repeats. Default: in the meeting. */
  joins?: JoinResult[]
  /** What `waitUntilAdmitted` answers, one per call. A 'lobby_expired' moves the clock to its deadline. */
  admissions?: AdmissionResult[]
  devicesOn?: boolean
  /** The sink level `levelDb` reports. Default -20; null means unknown. */
  level?: number | null
  signedOut?: FormProvider[]
  /** The pinger's `ready` rejects, as when the forms directory cannot be read. */
  pingerReadyRejects?: boolean
  /** Called by `restoreProfile`. Default: succeeds. */
  restore?: (file: string) => Promise<void>
  /** Called at the start of every `meetingState` call with its 1-based number; it may throw or await. */
  onState?: (call: number) => void | Promise<void>
  /** Called by `recorder.stop`. */
  recorderStop?: () => Promise<void>
}

export interface FakeDeps extends RunDeps {
  /** The first call of each step, in order. A step called many times (the per-tick ones) appears once. */
  calls: string[]
  pings: Ping[]
  joinCount: number
  joinOpts: unknown[]
  leftAt: Date | null
  formPinger: (FormPinger & { offers: FormCandidate[] }) | null
  /** Hooks into what the runner wired up. */
  hooks: {
    chat: { onMessage?: (m: ChatMessage) => Promise<void>; opts?: ChatCaptureOptions }
    asr: { opts?: LiveAsrOptions }
    frames: { handler?: (f: Frame) => Promise<void>; fatal: ((e: Error) => void)[] }
    recorder: { gap: ((g: { from: Date; to: Date }) => void)[]; fatal: ((e: Error) => void)[] }
    audio: { fatal: ((e: Error) => void)[] }
    checkpoints: { onError?: (e: unknown) => void }
  }
  clock(): Date
}

export const LECTURE_START = '2026-10-21T20:00:00+08:00'
export const LECTURE_END = '2026-10-21T22:00:00+08:00'

// A job with its own data and profile directories. The profile directory is not empty, so it is not restored.
export async function makeCfg(type: 'lecture' | 'work' = 'lecture'): Promise<JobConfig> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-run-'))
  const profileDir = join(root, 'profile')
  await mkdir(profileDir)
  await writeFile(join(profileDir, 'Preferences'), '{}')
  return {
    occurrenceId: 'occ-1',
    attempt: 1,
    entry: {
      name: 'Data Mining',
      type,
      start: LECTURE_START,
      end: LECTURE_END,
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'fixed', url: 'https://zoom.us/j/12345678901?pwd=SECRETPWD' },
      trustedSenders: [],
      transcription: 'live',
      formDetails: {},
      attendanceKeywords: []
    },
    identity: {
      id: 'ident-1',
      name: 'Main',
      zoomGuestName: 'Ali Student',
      formProviders: ['google'],
      organisation: null
    },
    member: { id: 'm-1', displayName: 'Ali', mentionNames: [], details: [] },
    ai: {
      baseUrl: 'https://ai.example.com/v1',
      apiKey: 'sk-test',
      asrUrl: 'wss://ai.example.com/asr',
      models: { summary: 's', vision: 'v', formMatch: 'f', asr: 'a' }
    },
    ntfy: { url: 'https://ntfy.example.com', topic: 't', token: 'tk' },
    dataDir: join(root, 'data'),
    profileDir,
    control: null
  }
}

export function fakeDeps(opts: FakeOptions = {}): FakeDeps {
  const calls: string[] = []
  const rec = (name: string): void => {
    if (!calls.includes(name)) calls.push(name)
  }
  let t = Date.parse(LECTURE_START) - 30 * MINUTE
  const clock = () => new Date(t)
  const pings: Ping[] = []
  const joins = opts.joins ?? [{ kind: 'in_meeting' }]
  const admissions = [...(opts.admissions ?? [])]
  const states = opts.states ?? ['in_meeting']
  const level = opts.level === undefined ? -20 : opts.level
  let stateIndex = 0
  let stateCalls = 0
  let unknownFrom: number | null = null
  const fake = {
    calls,
    pings,
    joinCount: 0,
    joinOpts: [] as unknown[],
    leftAt: null as Date | null,
    formPinger: null as FakeDeps['formPinger'],
    hooks: {
      chat: {},
      asr: {},
      frames: { fatal: [] },
      recorder: { gap: [], fatal: [] },
      audio: { fatal: [] },
      checkpoints: {}
    } as FakeDeps['hooks'],
    clock
  }

  const page = (): Page =>
    ({
      goto: async () => rec('goto'),
      url: () => 'https://app.zoom.us/wc/12345678901/join',
      isClosed: () => false,
      screenshot: async () => Buffer.from('png'),
      ariaSnapshot: async () => '- document'
    }) as unknown as Page

  const nextState = (): MeetingState => {
    if (states === 'always_in_meeting') return 'in_meeting'
    const at = () => states[Math.min(stateIndex, states.length - 1)]!
    let current = at()
    if (current === 'unknown' && (opts.unknownMs ?? 0) > 0) {
      unknownFrom ??= t
      if (t - unknownFrom <= opts.unknownMs!) return 'unknown'
      unknownFrom = null
      stateIndex += 1
      current = at()
    }
    stateIndex += 1
    return current
  }

  const adapter: PlatformAdapter = {
    platform: 'zoom',
    normaliseLink: (url) => url,
    join: async (_page, joinOpts) => {
      rec('join')
      fake.joinOpts.push(joinOpts)
      const result = joins[Math.min(fake.joinCount, joins.length - 1)]!
      fake.joinCount += 1
      return result
    },
    waitUntilAdmitted: async (_page, deadline) => {
      rec('waitUntilAdmitted')
      const answer = admissions.shift() ?? 'admitted'
      if (answer === 'lobby_expired') t = Math.max(t, deadline.getTime())
      return answer
    },
    assertDevicesOff: async () => {
      rec('assertDevicesOff')
      if (opts.devicesOn) throw new DevicesOnError(['Mute'])
    },
    connectOutputAudio: async () => rec('connectOutputAudio'),
    ensureLayout: async () => rec('ensureLayout'),
    readChat: async () => {
      throw new Error('the chat is read by startChatCapture, which is faked')
    },
    sweepChat: async () => {
      throw new Error('the chat is read by startChatCapture, which is faked')
    },
    sharedScreenRegion: async () => null,
    participantCount: async () => {
      rec('participantCount')
      return 5
    },
    meetingState: async () => {
      stateCalls += 1
      await opts.onState?.(stateCalls)
      return nextState()
    },
    dismissNotices: async () => {
      rec('dismissNotices')
      return []
    },
    leave: async () => {
      rec('leave')
      fake.leftAt = clock()
    }
  }

  const stage = page()
  const deps: RunDeps = {
    readMasterKey: async () => Buffer.alloc(32, 7),
    prepareProfile: async () => rec('prepareProfile'),
    restoreProfile: async (file) => {
      rec('restoreProfile')
      await opts.restore?.(file)
    },
    startScreen: async () => {
      rec('startScreen')
      return {
        display: ':99',
        width: 3840,
        height: 1080,
        stage: { x: 0, y: 0, width: 1920, height: 1080 },
        desk: { x: 1920, y: 0, width: 1920, height: 1080 },
        stop: async () => rec('screen.stop')
      }
    },
    launchBrowser: async () => {
      rec('launchBrowser')
      return { context: { close: async () => rec('context.close') } as never, stage, desk: page() }
    },
    launchGuestStage: async () => {
      rec('launchGuestStage')
      return { browser: { close: async () => rec('guest.close') } as never, stage: page() }
    },
    startCheckpoints: (_dir, _out, _key, onError) => {
      rec('startCheckpoints')
      fake.hooks.checkpoints.onError = onError
      return { stop: async () => rec('checkpoints.stop') }
    },
    checkpointProfile: async () => {
      rec('checkpointProfile')
      return 'checkpoint'
    },
    checkFormProviders: async () => {
      rec('checkFormProviders')
      return opts.signedOut ?? []
    },
    startAudioSource: async () => {
      rec('startAudioSource')
      return {
        startedAt: new Date(t),
        onChunk: () => () => undefined,
        onFatal: (cb) => void fake.hooks.audio.fatal.push(cb),
        levelDb: () => level,
        stop: async () => rec('audio.stop')
      }
    },
    startRecorder: async () => {
      rec('startRecorder')
      return {
        startedAt: new Date(t),
        stop: async () => {
          rec('recorder.stop')
          await opts.recorderStop?.()
        },
        onGap: (cb) => void fake.hooks.recorder.gap.push(cb),
        onFatal: (cb) => void fake.hooks.recorder.fatal.push(cb)
      }
    },
    joinRecording: async () => {
      rec('joinRecording')
      return 'meeting.mkv'
    },
    adapterFor: () => adapter,
    startChatCapture: async (_page, _adapter, _file, onMessage, chatOpts) => {
      rec('startChatCapture')
      fake.hooks.chat.onMessage = onMessage
      fake.hooks.chat.opts = chatOpts
      return { loaded: [], sweepNow: async () => rec('sweepNow'), stop: async () => rec('chat.stop') }
    },
    startFrameLoop: (_screen, handler) => {
      rec('startFrameLoop')
      fake.hooks.frames.handler = handler
      return {
        onFatal: (cb) => void fake.hooks.frames.fatal.push(cb),
        stop: async () => rec('frames.stop')
      }
    },
    startLiveAsr: async (_audio, _ai, _out, asrOpts) => {
      rec('startLiveAsr')
      fake.hooks.asr.opts = asrOpts
      return { stop: async () => rec('asr.stop') }
    },
    createFormPinger: () => {
      const offers: FormCandidate[] = []
      const ready = opts.pingerReadyRejects
        ? Promise.reject(new Error('forms directory unreadable'))
        : Promise.resolve()
      const pinger = {
        ready,
        offers,
        offer: async (c: FormCandidate) => void offers.push(c),
        idle: async () => rec('pinger.idle')
      }
      fake.formPinger = pinger
      return pinger
    },
    sendPing: async (_cfg, ping) => void pings.push(ping),
    now: clock,
    sleep: async (ms) => {
      t += ms
    }
  }
  return Object.assign(fake, deps) as FakeDeps
}
