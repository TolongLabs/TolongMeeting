import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { ChatMessage, FormCandidate, FormProvider, JobConfig, LinkSource, ResolvedForm } from '@tm/core'
import type { Ping } from '@tm/notify'
import { DevicesOnError } from '../../src/adapters'
import type { AdmissionResult, JoinResult, MeetingState, PlatformAdapter, Rect } from '../../src/adapters/types'
import type { ChatCaptureOptions } from '../../src/chat/capture'
import type { LiveAsrOptions } from '../../src/asr/live'
import type { Frame } from '../../src/frames/frames'
import type { FormDispatcher } from '../../src/forms/dispatcher'
import { signinUrlsFor, type SigninTabOptions } from '../../src/control/desk-tabs'
import { formProviderOf } from '../../src/forms/links'
import { runChatWatcher, type ChatSourceReader } from '../../src/watchers/loop'
import type { RunDeps } from '../../src/run-deps'

const MINUTE = 60_000

const EMPTY_CHAT: ChatSourceReader = { open: async () => undefined, history: async () => [], latest: async () => [] }

/**
 * A chat watcher the run can start. It is the real watcher loop over a scripted chat source, so the run meets the loop's
 * own statuses and phases. A test sets the loop's clock and sleep with `configureWatchers` and resets them afterwards.
 */
export interface FakeWatcherOptions {
  /** The chat the loop reads. Default: an empty chat. */
  reader?: ChatSourceReader
  /** Called at the start of each `startWatcher` with its 1-based call number: an error makes that start reject. */
  fails?: (call: number) => Error | null
}

export interface FakeOptions {
  /** The adapter's platform. Default: zoom. */
  platform?: PlatformAdapter['platform']
  /** A chat watcher for chat entries. Without it `startWatcher` answers null: the app has no watcher. */
  watcher?: FakeWatcherOptions
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
  /** The providers `checkFormProviders` reports signed out; a function is asked at every check. */
  signedOut?: FormProvider[] | (() => FormProvider[])
  /** `startFormDispatcher` throws, as when the forms directory cannot be read. */
  dispatcherStartFails?: Error
  /** Called by the dispatcher's `close`; it may never settle. */
  formsClose?: () => Promise<void>
  /** What `resolveFormLink` answers. Default: the real rules for a link already on a form host, else not a form. */
  resolve?: (c: FormCandidate) => Promise<ResolvedForm | null>
  /** Called by `launchBrowser`; it may never settle. */
  onLaunch?: () => void | Promise<void>
  /** Called by `restoreProfile`. Default: succeeds. */
  restore?: (file: string) => Promise<void>
  /** Called at the start of every `meetingState` call with its 1-based number; it may throw or await. */
  onState?: (call: number) => void | Promise<void>
  /** Called by `recorder.stop`. */
  recorderStop?: () => Promise<void>
  /** The time teardown has in all (a short one lets a test hang a step). */
  teardownBudgetMs?: number
  /** Called by `adapter.leave`; it may throw or never settle. */
  leave?: () => Promise<void>
  /** Called by `context.close`. */
  contextClose?: () => Promise<void>
  /** Called by `checkpointProfile`. */
  checkpoint?: () => Promise<void>
  /** Called by `joinRecording`. */
  joinRecording?: () => Promise<void>
  /** Called by `adapter.join` with its 1-based call number; it may never settle. */
  onJoin?: (call: number) => void | Promise<void>
  /** Called by `adapter.waitUntilAdmitted`; it may never settle. */
  onAdmission?: () => Promise<void>
  /** Called by every `assertDevicesOff` that finds the devices off, with its 1-based call number; it may throw. */
  assertDevices?: (call: number) => void
  /** Replace the adapter's `participantCount` / `dismissNotices`. */
  participantCount?: () => Promise<number | null>
  dismissNotices?: () => Promise<string[]>
  /** Make a start step throw (the optional parts of the run). */
  startFails?: Partial<Record<'chat' | 'frames' | 'asr', Error>>
}

export interface FakeDeps extends RunDeps {
  /** The first call of each step, in order. A step called many times (the per-tick ones) appears once. */
  calls: string[]
  pings: Ping[]
  joinCount: number
  joinOpts: unknown[]
  /** How many times the run called `ensureLayout` (`calls` holds only the first). */
  layoutCalls: number
  /** Every URL the stage pages were sent to, in order. */
  gotos: string[]
  leftAt: Date | null
  /** The fake dispatcher the run started, with the forms it was offered. Null until started. */
  forms: (FormDispatcher & { offers: ResolvedForm[] }) | null
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
  /** The remote views running now (started and not stopped), with the password each was given. */
  vnc: { display: string; desk: Rect; secret: string }[]
  /** The sign-in tabs open now. */
  tabs: string[]
  /** The options each sign-in pause passed to `openSigninTabs`. */
  signinOptions: SigninTabOptions[]
  /** Every chat source a watcher was started on, in order. */
  watcherStarts: LinkSource[]
  /** The desk tabs opened for watchers, with whether each is still open. */
  watcherTabs: { closed: boolean }[]
  /** What `idleMs` answers. */
  idle: number
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
  let deviceChecks = 0
  let unknownFrom: number | null = null
  const fake = {
    calls,
    pings,
    joinCount: 0,
    joinOpts: [] as unknown[],
    layoutCalls: 0,
    gotos: [] as string[],
    leftAt: null as Date | null,
    forms: null as FakeDeps['forms'],
    hooks: {
      chat: {},
      asr: {},
      frames: { fatal: [] },
      recorder: { gap: [], fatal: [] },
      audio: { fatal: [] },
      checkpoints: {}
    } as FakeDeps['hooks'],
    clock,
    vnc: [] as FakeDeps['vnc'],
    tabs: [] as string[],
    signinOptions: [] as SigninTabOptions[],
    watcherStarts: [] as LinkSource[],
    watcherTabs: [] as { closed: boolean }[],
    idle: 0
  }

  const page = (): Page =>
    ({
      goto: async (url: string) => {
        rec('goto')
        fake.gotos.push(url)
      },
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
    platform: opts.platform ?? 'zoom',
    normaliseLink: (url) => url,
    join: async (_page, joinOpts) => {
      rec('join')
      fake.joinOpts.push(joinOpts)
      await opts.onJoin?.(fake.joinCount + 1)
      const result = joins[Math.min(fake.joinCount, joins.length - 1)]!
      fake.joinCount += 1
      return result
    },
    waitUntilAdmitted: async (_page, deadline) => {
      rec('waitUntilAdmitted')
      await opts.onAdmission?.()
      const answer = admissions.shift() ?? 'admitted'
      if (answer === 'lobby_expired') t = Math.max(t, deadline.getTime())
      return answer
    },
    assertDevicesOff: async () => {
      rec('assertDevicesOff')
      if (opts.devicesOn) throw new DevicesOnError(['Mute'])
      deviceChecks += 1
      opts.assertDevices?.(deviceChecks)
    },
    connectOutputAudio: async () => rec('connectOutputAudio'),
    ensureLayout: async () => {
      rec('ensureLayout')
      fake.layoutCalls += 1
    },
    readChat: async () => {
      throw new Error('the chat is read by startChatCapture, which is faked')
    },
    sweepChat: async () => {
      throw new Error('the chat is read by startChatCapture, which is faked')
    },
    sharedScreenRegion: async () => null,
    participantCount: async () => {
      rec('participantCount')
      return opts.participantCount ? opts.participantCount() : 5
    },
    meetingState: async () => {
      stateCalls += 1
      await opts.onState?.(stateCalls)
      return nextState()
    },
    dismissNotices: async () => {
      rec('dismissNotices')
      return opts.dismissNotices ? opts.dismissNotices() : []
    },
    leave: async () => {
      rec('leave')
      fake.leftAt = clock()
      await opts.leave?.()
    }
  }

  const stage = page()
  const deps: RunDeps = {
    loadProfileKey: () => Buffer.alloc(32, 7),
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
      await opts.onLaunch?.()
      return {
        context: {
          close: async () => {
            rec('context.close')
            await opts.contextClose?.()
          }
        } as never,
        stage,
        desk: page()
      }
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
      await opts.checkpoint?.()
      return 'checkpoint'
    },
    checkFormProviders: async () => {
      rec('checkFormProviders')
      return typeof opts.signedOut === 'function' ? opts.signedOut() : (opts.signedOut ?? [])
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
      await opts.joinRecording?.()
      return 'meeting.mkv'
    },
    adapterFor: () => adapter,
    startChatCapture: async (_page, _adapter, _file, onMessage, chatOpts) => {
      rec('startChatCapture')
      if (opts.startFails?.chat) throw opts.startFails.chat
      fake.hooks.chat.onMessage = onMessage
      fake.hooks.chat.opts = chatOpts
      return { loaded: [], sweepNow: async () => rec('sweepNow'), stop: async () => rec('chat.stop') }
    },
    startFrameLoop: (_screen, handler) => {
      rec('startFrameLoop')
      if (opts.startFails?.frames) throw opts.startFails.frames
      fake.hooks.frames.handler = handler
      return {
        onFatal: (cb) => void fake.hooks.frames.fatal.push(cb),
        stop: async () => rec('frames.stop')
      }
    },
    startLiveAsr: async (_audio, _ai, _out, asrOpts) => {
      rec('startLiveAsr')
      if (opts.startFails?.asr) throw opts.startFails.asr
      fake.hooks.asr.opts = asrOpts
      return { stop: async () => rec('asr.stop') }
    },
    startFormDispatcher: async () => {
      rec('startFormDispatcher')
      if (opts.dispatcherStartFails) throw opts.dispatcherStartFails
      const offers: ResolvedForm[] = []
      const dispatcher = {
        offers,
        offer: (f: ResolvedForm) => void offers.push(f),
        close: async () => {
          rec('forms.close')
          await opts.formsClose?.()
          return []
        }
      }
      fake.forms = dispatcher
      return dispatcher
    },
    resolveFormLink:
      opts.resolve ??
      (async (c) => {
        const provider = formProviderOf(c.url)
        return provider === null ? null : { ...c, finalUrl: c.url, provider }
      }),
    startVnc: async (display, desk, secret) => {
      rec('startVnc')
      fake.vnc.push({ display, desk, secret })
      return { stop: async () => void fake.vnc.pop() }
    },
    idleMs: async () => fake.idle,
    restoreDeskAnchor: async (desk) => {
      rec('restoreDeskAnchor')
      return desk
    },
    openSigninTabs: async (_desk, urls, _report, tabOpts = {}) => {
      rec('openSigninTabs')
      fake.signinOptions.push(tabOpts)
      fake.tabs.push(...signinUrlsFor(urls, tabOpts.exclude))
      return async () => void fake.tabs.splice(0)
    },
    openDeskTab: (async () => {
      rec('openDeskTab')
      const tab = { closed: false }
      fake.watcherTabs.push(tab)
      return {
        isClosed: () => tab.closed,
        close: async () => void (tab.closed = true),
        bringToFront: async () => undefined
      } as unknown as Page
    }) as RunDeps['openDeskTab'],
    startWatcher: () =>
      opts.watcher === undefined
        ? null
        : async (desk, src, onLink) => {
            rec('startWatcher')
            fake.watcherStarts.push(src)
            const failure = opts.watcher?.fails?.(fake.watcherStarts.length) ?? null
            if (failure !== null) throw failure
            const stopper = await runChatWatcher(desk, opts.watcher?.reader ?? EMPTY_CHAT, onLink)
            return {
              stop: async () => {
                rec('watcher.stop')
                await stopper.stop()
              }
            }
          },
    ...(opts.teardownBudgetMs === undefined ? {} : { teardownBudgetMs: opts.teardownBudgetMs }),
    sendPing: async (_cfg, ping) => void pings.push(ping),
    now: clock,
    sleep: async (ms) => {
      t += ms
    }
  }
  return Object.assign(fake, deps) as FakeDeps
}
