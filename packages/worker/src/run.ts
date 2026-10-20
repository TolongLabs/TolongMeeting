import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { AiKeyError } from '@tm/ai'
import {
  controlTokenHash,
  formatWhen,
  localParts,
  triggerFor,
  vncSecret,
  type AccountCheckData,
  type ChatApp,
  type ChatMessage,
  type EventType,
  type FormCandidate,
  type Heartbeat,
  type HeartbeatReply,
  type JobConfig,
  type OccurrenceState,
  type StateEventData
} from '@tm/core'
import { joinedPing, pings, type Ping, type SiteLinks, type WatcherProblem } from '@tm/notify'
import { z } from 'zod'
import { DevicesOnError } from './adapters'
import type { JoinResult, MeetingState, PlatformAdapter, Rect } from './adapters/types'
import { ALERT_WINDOW_MS, createAlerter, createLimiter, type Alerter } from './alerts'
import type { AudioSource } from './audio/source'
import type { ChatCapture } from './chat/capture'
import { dispatchCommands } from './control/commands'
import { DeskPause } from './control/desk-pause'
import type { SigninTabOptions } from './control/desk-tabs'
import { startHeartbeat, type HeartbeatLoop } from './control/heartbeat'
import { LinkOverride } from './control/link-override'
import { siteLinks } from './control/links'
import { EventOutbox } from './control/outbox'
import { acknowledgedState, rememberState } from './control/resume'
import { createEventLog, type EventLog } from './events'
import { makeFormContextBase } from './forms/context'
import type { FormDispatcher } from './forms/dispatcher'
import { onFormCandidate } from './forms/intake'
import { writeFileAtomic } from './forms/store'
import { createFrameHandler, type FrameHandler } from './frames/handler'
import type { FrameLoop } from './frames/frames'
import type { LiveAsr } from './asr/live'
import { setupProfile, type ProfileSetup } from './profile-setup'
import { closeQr } from './qr/qr'
import type { Recorder } from './recorder/recorder'
import { defaultDeps, type OccurrenceOutcome, type RunDeps } from './run-deps'
import type { Screen, Stopper } from './types'
import { CHAT_HOST } from './watchers'
import { readJoinedLink, writeJoinedLink } from './watchers/joined-link'
import { decideLinkWait, GIVE_UP_AFTER_MS, JOIN_FROM_MS } from './watchers/link-wait'
import {
  configureWatchers,
  resetWatcherEnv,
  WatcherChatError,
  WatcherSigninError,
  type WatcherStatus
} from './watchers/loop'
import { chooseMeetingLink, type WatchPhase } from './watchers/rules'

export type { OccurrenceOutcome, RunDeps } from './run-deps'

type ChatLink = Extract<JobConfig['entry']['link'], { kind: 'chat' }>
type JoinedLinkSource = NonNullable<StateEventData['link']>['source']

const MINUTE = 60_000
const TICK_MS = 5_000
const REFRESH_MS = 10_000
/** A meeting that shows nothing we know for this long has dropped us. */
const UNKNOWN_MS = 30_000
const HARD_STOP_AFTER_END_MS = 30 * MINUTE
const LOBBY_ATTEMPT_MS = 10 * MINUTE
const MAX_LOBBY_RETRIES = 2
const SILENT_DB = -60
const NO_AUDIO_MS = 120_000
const GAP_WINDOW_MS = 10 * MINUTE
const GAP_LIMIT = 3
const TICK_ERROR_WINDOW_MS = MINUTE
const GOTO_TIMEOUT_MS = 30_000
const ARTEFACT_TIMEOUT_MS = 10_000

/**
 * `docker stop` gives the worker 60 s (run-job.sh --stop-timeout 60) between SIGTERM and SIGKILL. Teardown must end
 * inside that: it has this much time in all, counted from its start.
 */
const TEARDOWN_BUDGET_MS = 50_000
/** The last part of the budget belongs to the final profile checkpoint: the steps before it cannot use it. */
const CHECKPOINT_RESERVE_MS = 15_000
/** With a control channel, the last part of the budget belongs to the final heartbeat: no step before it may use it. */
const FINAL_HEARTBEAT_RESERVE_MS = 5_000
// The 50 s add up as: steps before the checkpoint 30 s (budget x 0.6), then the checkpoint, the held-back alerts, the
// screen and the join of the segments share 15 s (the checkpoint's own window), then the final heartbeat 4 s and
// stopping the heartbeat 1 s (the 5 s reserve), and the outbox file write after that in whatever is left. The
// reserves are cut to a share of the budget when the budget is small (tests).
/** The most of the budget that the two reserves together may take from the steps before the checkpoint. */
const RESERVE_SHARE = 0.4
/** The share of the final heartbeat's reserve that stopping the heartbeat keeps when the heartbeat itself overruns. */
const STOP_SHARE = 0.2
/** A watcher reads form links posted this long before the start, and later. */
const FORMS_LOOKBACK_MS = 10 * MINUTE
/** A member who must sign in again is waited for until this long before the start (PRD: join T-10 to T-5). */
const SIGNIN_DEADLINE_BEFORE_START_MS = 5 * MINUTE

// The most each teardown step may take; the time left in the budget cuts it shorter. A step that overruns is reported
// and the next one still runs.
const BOUND = {
  sweep: 10_000,
  leave: 10_000,
  stopChat: 5_000,
  stopWatcher: 5_000,
  stopFrames: 5_000,
  stopQr: 3_000,
  deskPause: 5_000,
  stopAsr: 5_000,
  formIntake: 6_000,
  forms: 10_000,
  stopRecorder: 15_000,
  stopAudio: 5_000,
  closeBrowser: 10_000,
  stopCheckpoints: 5_000,
  checkpoint: 120_000,
  alerts: 5_000,
  resume: 15_000,
  finalHeartbeat: 4_000,
  stopHeartbeat: 1_000,
  settleOutbox: 2_000,
  stopScreen: 5_000,
  join: 300_000
}

/** The pause between tries while the server has not yet taken a resumed worker's first heartbeat. */
const RESUME_RETRY_MS = 1_000

/** What a race against the abort signal returns when the signal wins. */
const ABORTED = Symbol('aborted')

interface Verdict {
  result: OccurrenceOutcome['result']
  endedBy: OccurrenceOutcome['endedBy']
  reason: string | null
}

const failed = (reason: string, endedBy: Verdict['endedBy'] = null): Verdict => ({ result: 'failed', endedBy, reason })
const ended = (endedBy: Verdict['endedBy'], reason: string | null = null): Verdict => ({
  result: 'completed',
  endedBy,
  reason
})

// A setup or join step that threw. The run reports it, saves the page, pings `join_failed` with the step's name and
// ends as failed.
class StepFailed extends Error {
  readonly step: string

  constructor(step: string, cause: unknown) {
    super(`${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'StepFailed'
    this.step = step
  }
}

// The states of a meeting that goes to the end, in order.
const PATH: OccurrenceState[] = [
  'starting',
  'verifying_accounts',
  'watching_for_link',
  'joining',
  'in_meeting',
  'leaving',
  'uploading'
]

const OutcomeSchema = z.object({
  result: z.enum(['completed', 'denied', 'not_admitted', 'failed']),
  endedBy: z.enum(['page', 'removed', 'hard_stop', 'dropped', 'terminated', 'member_left', 'stopped']).nullable(),
  reason: z.string().nullable(),
  joinedAt: z.string().nullable(),
  endedAt: z.string()
}) satisfies z.ZodType<OccurrenceOutcome>

const AttemptsSchema = z.array(z.looseObject({ startedAt: z.string() }))

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Runs one occurrence from the job file: restores the profile, starts the screen, the browser, the recorder and the
 * audio, joins the meeting, watches it until it ends or the hard stop (the scheduled end plus 30 minutes), and always
 * tears everything down in order. The result is also written to `<dataDir>/outcome.json`.
 */
export async function runOccurrence(cfg: JobConfig, deps: Partial<RunDeps> = {}): Promise<OccurrenceOutcome> {
  return new OccurrenceRun(cfg, { ...defaultDeps, ...deps }).run()
}

/** Why the run was asked to end by something other than the stop signal. */
type EndRequest = 'leave' | 'stop' | 'superseded'

class OccurrenceRun {
  private readonly events: EventLog
  private readonly alerter: Alerter
  private readonly aborted: Promise<void>
  private readonly tickLimit: ReturnType<typeof createLimiter>
  private readonly start: number
  private readonly end: number
  private readonly hardStop: number
  private readonly lecture: boolean
  private readonly links: SiteLinks | null
  /** Why the website links could not be built (a bad `TM_PUBLIC_URL`): reported once the run has started. */
  private readonly linksError: unknown = null
  private readonly linkOverride: LinkOverride
  /** The newest meeting link a chat watcher found (or an earlier attempt kept). A pasted link still beats it. */
  private readonly watched: LinkOverride
  private readonly watcherLimit: ReturnType<typeof createLimiter>
  private readonly wake: () => void

  // The control channel (absent when the job has none, and when it failed to start).
  private outbox: EventOutbox | null = null
  private heartbeat: HeartbeatLoop | null = null
  private commandChain: Promise<void> = Promise.resolve()
  /** The member's sign-in view of the desk; null without a control channel, and until the browser is up. */
  private deskPause: DeskPause | null = null
  /** `pause_for_signin` arrived before the browser was up: the pause starts as soon as it is. */
  private pauseWanted = false
  private state: OccurrenceState = 'starting'
  private recording = false
  private endRequest: EndRequest | null = null
  private verdict: Verdict | null = null
  /** An earlier attempt already ended the meeting: this one only reports and finishes the recording. */
  private resumed = false

  private profile: ProfileSetup | null = null
  private screen: Screen | null = null
  private context: { close(): Promise<void> } | null = null
  private guest: { browser: { close(): Promise<void> } } | null = null
  private stage: Page | null = null
  private desk: Page | null = null
  private checkpoints: Stopper | null = null
  private audio: AudioSource | null = null
  private recorder: Recorder | null = null
  private recordingStart: Date | null = null
  private adapter: PlatformAdapter | null = null
  private url = ''
  /** Which source supplied `url`. Only the source and the host go to the website, never the link. */
  private linkSource: JoinedLinkSource = 'fixed'
  private forms: FormDispatcher | null = null
  /** Set once teardown closed the dispatcher: a link resolved after that is pinged as "not checked" instead. */
  private formsClosed = false
  /** Links being resolved now (by trust and raw URL): a link seen twice while it resolves is offered once. */
  private readonly linksInFlight = new Set<string>()
  /** URLs pinged as "link seen, not checked" in this run: a chat replay does not ping them again. */
  private readonly linksPinged = new Set<string>()
  /** Links being resolved or offered: teardown waits for them before it closes the dispatcher. */
  private readonly intakes = new Set<Promise<void>>()
  private chat: ChatCapture | null = null
  private frames: FrameLoop | null = null
  private asr: LiveAsr | null = null
  private handler: FrameHandler | null = null

  // The chat watcher of a chat entry: its tab and what stops it. Null without one, and after it stopped.
  private watcher: { app: ChatApp; tab: Page; stopper: Stopper } | null = null
  private watchPhase: WatchPhase = 'before'
  private watchersConfigured = false
  /** The chat app signed the bot out and the watcher is not running (or the loop saw it signed out). */
  private chatSignedOut = false
  /** The "sign in again" ping for the chat app went out: a second failed start does not ping again. */
  private chatSigninPinged = false

  // Teardown clock (real time, ms since the epoch). The budget counts from the stop signal (`docker stop` starts its
  // 60 s at SIGTERM) or from the start of teardown, whichever is first. Unlimited until one of them.
  private abortAt: number | null = null
  private teardownStart: number | null = null
  private contextClosed = false

  private inMeeting = false
  private joinedAt: Date | null = null
  /** When the earlier attempt that was cut short joined (null: it never did); undefined: no such outcome was read. */
  private earlierJoinedAt: string | null | undefined = undefined
  private region: Rect | null = null
  private participants: number | null = null
  private breakoutShown = false
  private rejoins = 0
  private badSince: number | null = null
  /** Why the meeting looks gone: no known state, or a device check that cannot run. */
  private badWhy: 'state' | 'devices' = 'state'
  private lastRefresh = Number.NEGATIVE_INFINITY
  private quietSince: number | null = null
  private audioChecked = false
  private gaps: number[] = []

  constructor(
    private readonly cfg: JobConfig,
    private readonly deps: RunDeps
  ) {
    // Links are an extra: a bad `TM_PUBLIC_URL` leaves the pings without them and is reported (see `run`).
    let links: SiteLinks | null = null
    try {
      links = siteLinks(cfg)
    } catch (error) {
      this.linksError = error
    }
    this.links = links
    this.events = createEventLog(join(cfg.dataDir, 'events.jsonl'), cfg.occurrenceId, cfg.attempt, (e) =>
      this.outbox?.push(e)
    )
    this.alerter = createAlerter({
      entry: cfg.entry.name,
      send: (p) => deps.sendPing(cfg.ntfy, p),
      emit: (type, data) => this.events.emit(type, data),
      now: () => deps.now(),
      links: this.links
    })
    // A pasted link goes through the same rule as the entry's own link (for Zoom, core `normaliseZoomLink`).
    this.linkOverride = new LinkOverride({
      normalise: (url) => deps.adapterFor(url)?.normaliseLink(url) ?? null,
      onRefused: () => void this.report('pasted link', new Error('the pasted link is not a link the bot can join'))
    })
    this.tickLimit = createLimiter(() => deps.now())
    this.watcherLimit = createLimiter(() => deps.now())
    this.watched = new LinkOverride({
      normalise: (url) => deps.adapterFor(url)?.normaliseLink(url) ?? null,
      onRefused: () => void this.report('watched link', new Error('the watched link is not a link the bot can join'))
    })
    this.start = Date.parse(cfg.entry.start)
    this.end = Date.parse(cfg.entry.end)
    this.hardStop = this.end + HARD_STOP_AFTER_END_MS
    this.lecture = cfg.entry.type === 'lecture'
    const { signal } = deps
    let wake!: () => void
    this.aborted = new Promise<void>((resolve) => {
      wake = resolve
      const stop = (): void => {
        this.abortAt ??= Date.now()
        resolve()
      }
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
    })
    this.wake = wake
  }

  async run(): Promise<OccurrenceOutcome> {
    const { dataDir } = this.cfg
    for (const dir of ['recording', 'frames', 'errors', 'transcript'])
      await mkdir(join(dataDir, dir), { recursive: true })
    let verdict: Verdict
    try {
      await this.startControl()
      if (this.linksError !== null) this.fault('site links', this.linksError)
      const earlier = await this.endedEarlier()
      if (earlier !== null) return await this.finishEarlier(earlier)
      verdict = await this.main()
    } catch (error) {
      verdict = await this.runFailed(error)
    }
    this.verdict = verdict
    await this.teardown()
    const outcome: OccurrenceOutcome = {
      ...verdict,
      joinedAt: this.joinedAt?.toISOString() ?? null,
      endedAt: this.deps.now().toISOString()
    }
    // A replaced worker leaves the outcome and the recording to the attempt that replaced it.
    if (!this.superseded) {
      await writeFileAtomic(join(dataDir, 'outcome.json'), `${JSON.stringify(outcome, null, 2)}\n`)
      // The pipeline can join the segments later, so this is the one step that may be skipped for lack of time.
      await this.finishRecording()
    }
    await this.finalReport(verdict)
    return outcome
  }

  private get superseded(): boolean {
    return this.endRequest === 'superseded'
  }

  // The outcome an earlier attempt wrote when the meeting itself ended; null when there is none. An attempt that was
  // only cut short (SIGTERM, replaced) did not end the meeting: the bot goes back in.
  private async endedEarlier(): Promise<OccurrenceOutcome | null> {
    if (this.cfg.attempt === 1) return null
    let text: string
    try {
      text = await readFile(join(this.cfg.dataDir, 'outcome.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const outcome = OutcomeSchema.parse(JSON.parse(text))
    if (outcome.endedBy !== 'terminated') return outcome
    this.earlierJoinedAt = outcome.joinedAt
    return null
  }

  // The meeting is over, so the bot does not join again. The first heartbeat already carries the acknowledged state;
  // the states after it are reported once the server has taken that heartbeat, the recording is joined if it is not
  // yet (never by a replaced worker), and the hand-over is reported.
  private async finishEarlier(outcome: OccurrenceOutcome): Promise<OccurrenceOutcome> {
    const verdict: Verdict = { result: outcome.result, endedBy: outcome.endedBy, reason: outcome.reason }
    this.resumed = true
    this.verdict = verdict
    this.joinedAt = outcome.joinedAt === null ? null : new Date(outcome.joinedAt)
    this.teardownStart = Date.now()
    const taken = await this.resumeTaken()
    if (taken) {
      if (this.handsOver) await this.walkTo('uploading')
      else if (verdict.endedBy === 'member_left') {
        await this.walkTo('in_meeting')
        await this.setState('left_by_member')
      } else if (verdict.result === 'denied') {
        await this.walkTo('joining')
        await this.setState('in_lobby')
      } else if (verdict.reason === 'no_link') await this.walkTo('watching_for_link')
    }
    if (!this.superseded) await this.finishRecording()
    await this.finalReport(verdict, !taken)
    return outcome
  }

  // Waits, within the teardown budget, until the server has taken this worker's first heartbeat (the resumed state).
  // False when it never does, or when the run is replaced: the states are then left in the outbox, not sent ahead.
  private async resumeTaken(): Promise<boolean> {
    const beat = this.heartbeat
    if (beat === null) return true
    let waiting = true
    const finished = await this.bounded(
      'resume',
      BOUND.resume,
      async () => {
        while (waiting && !this.superseded && !(await beat.flush())) {
          await new Promise<void>((resolve) => setTimeout(resolve, RESUME_RETRY_MS))
        }
      },
      'pre'
    )
    // A wait the bound cut short must not go on sending in the background.
    waiting = false
    return finished && !this.superseded
  }

  // Reports each state from the one after the current state up to `target`, on the way a meeting goes. A step the
  // server has no edge for is skipped by `setState`.
  private async walkTo(target: OccurrenceState): Promise<void> {
    const from = PATH.indexOf(this.state === 'in_lobby' ? 'joining' : this.state)
    for (const next of PATH.slice(from + 1, PATH.indexOf(target) + 1)) await this.setState(next)
  }

  // --- the control channel ---

  // Starts the outbox and the heartbeat. Both are extras: if they fail, the failure is reported and pinged, and the
  // meeting is recorded all the same.
  private async startControl(): Promise<void> {
    const { cfg } = this
    if (cfg.control === null) return
    const dir = join(cfg.dataDir, 'outbox')
    if (cfg.attempt > 1) {
      // The first heartbeat of a restarted worker reports the state the server acknowledged, not where the log ended.
      const acknowledged = await this.optional('previous state', async () => {
        const state = await acknowledgedState(dir, cfg.attempt, join(cfg.dataDir, 'events.jsonl'))
        await rememberState(dir, cfg.attempt, state)
        return state
      })
      this.state = acknowledged ?? 'starting'
    }
    const opened = await this.optional('control channel', async () => {
      const outbox = await EventOutbox.open(dir, cfg.attempt)
      this.heartbeat = startHeartbeat(
        cfg,
        () => this.status(),
        (reply) => this.onReply(reply),
        {
          ...this.deps.heartbeat,
          onSuperseded: () => this.requestEnd('superseded'),
          onRefused: () => this.alerter.alert('component_failed', 'control channel'),
          onProblem: (problem) => void this.report('heartbeat', new Error(problem)),
          onRejectedEvent: (event) => {
            outbox.ack(1)
            void this.report('heartbeat', new Error(`the server refused a ${event.type} event; it was dropped`))
          }
        }
      )
      // Events are queued only once the heartbeat exists, so a failed start leaves no outbox to fill.
      this.outbox = outbox
      return outbox
    })
    if (opened !== null && opened.damaged.length > 0) {
      const names = opened.damaged.join(', ')
      this.fault('event outbox', new Error(`a damaged file was set aside as ${names}; its readable start was kept`))
    }
  }

  private status(): Heartbeat {
    return {
      occurrenceId: this.cfg.occurrenceId,
      attempt: this.cfg.attempt,
      state: this.state,
      recording: this.recording,
      participants: this.participants,
      events: this.outbox?.pending() ?? []
    }
  }

  private onReply(reply: HeartbeatReply): void {
    this.outbox?.ack(reply.ackedEvents)
    this.linkOverride.offer(reply.link)
    if (reply.commands.length === 0) return
    // Batches run in the order they came, one at a time.
    this.commandChain = this.commandChain
      .then(() => this.runCommands(reply.commands))
      .catch((error: unknown) => this.report('command', error))
  }

  private async runCommands(commands: HeartbeatReply['commands']): Promise<void> {
    await dispatchCommands(commands, {
      leave: async () => this.requestEnd('leave'),
      stop: async () => this.requestEnd('stop'),
      pause: () => this.pauseDesk(),
      resume: () => this.resumeDesk()
    })
  }

  // `pause_for_signin`: the desk goes to the member's remote view; the recording and the stage carry on. A failure is
  // reported and pinged (the member is waiting for the view), and the meeting goes on.
  private async pauseDesk(): Promise<void> {
    if (this.teardownStart !== null || this.isAborted) {
      await this.report('command', new Error('pause_for_signin was ignored: the run is ending'))
      return
    }
    this.pauseWanted = true
    const pause = this.deskPause
    if (pause === null) return
    if ((await this.optional('desk pause', () => pause.pause())) === null) this.pauseWanted = false
  }

  // `resume_after_signin`: the member pressed "Done".
  private async resumeDesk(): Promise<void> {
    this.pauseWanted = false
    const pause = this.deskPause
    if (pause !== null) await this.optional('desk pause', () => pause.resume('command'))
  }

  // The desk pause of a run with a control channel (only the channel can ask for one). The view's password comes from
  // the control token's hash, which the website also holds; it reaches no event, log or ping.
  private makeDeskPause(screen: Screen, profile: ProfileSetup): DeskPause | null {
    const { cfg, deps } = this
    if (cfg.control === null) return null
    const secret = vncSecret(controlTokenHash(cfg.control.token))
    return new DeskPause({
      startVnc: () => deps.startVnc(screen.display, screen.desk, secret),
      idleMs: () => deps.idleMs(screen.display),
      openTabs: (urls) =>
        deps.openSigninTabs(this.deskPage(), urls, (e) => void this.report('desk pause', e), this.signinTabOptions()),
      anchor: async () => void (this.desk = await deps.restoreDeskAnchor(this.deskPage())),
      checkpoint: async () => void (await deps.checkpointProfile(cfg.profileDir, profile.checkpointsDir, profile.key)),
      emit: (data) => void this.ev('state', data),
      report: (e) => this.fault('desk pause', e)
    })
  }

  // Asks the run to end: it wakes every wait, and the run takes its normal teardown. The first request stands, except
  // that being replaced by another attempt overrides all (a replaced worker reports nothing more).
  private requestEnd(kind: EndRequest): void {
    if (this.endRequest === null || kind === 'superseded') this.endRequest = kind
    this.wake()
  }

  // Reports a change of state: a `state` event, and the state the next heartbeat carries. A move the server's state
  // machine has no edge for is not sent: a restarted worker is already past the early states, and a bug elsewhere is
  // reported rather than sent.
  private async setState(next: OccurrenceState, link?: StateEventData['link']): Promise<void> {
    if (next === this.state) return
    if (triggerFor(this.state, next) === null) {
      if (this.cfg.attempt === 1)
        await this.report('state', new Error(`no move from ${this.state} to ${next}; it was not reported`))
      return
    }
    this.state = next
    await this.ev('state', { state: next, ...(link === undefined ? {} : { link }) } satisfies StateEventData)
  }

  // The states of the first join. A rejoin after a drop keeps the state `in_meeting`.
  private async joinState(next: OccurrenceState, link?: StateEventData['link']): Promise<void> {
    if (this.joinedAt === null) await this.setState(next, link)
  }

  // The last report: the state the meeting ended in, then every event still unsent, within the budget. A failure leaves
  // the events in the outbox on disk for the next attempt (or the scheduler).
  // `held`: the resumed worker's first heartbeat was never taken, so no state is reported after it.
  private async finalReport(verdict: Verdict, held = false): Promise<void> {
    const beat = this.heartbeat
    if (beat === null) return
    if (!this.superseded) {
      const state = held ? null : this.finalState(verdict)
      if (state !== null) await this.setState(state)
      // The phase 'beat' leaves the next step a share of the reserve even when the server never answers.
      await this.bounded(
        'final heartbeat',
        BOUND.finalHeartbeat,
        async () => {
          if (!(await beat.flush())) throw new Error('the server did not take it; the events stay in the outbox')
        },
        'beat'
      )
    }
    await this.bounded('heartbeat.stop', BOUND.stopHeartbeat, () => beat.stop(), 'final')
    // The outbox file is written last, in a step of its own: the acknowledgement of the final heartbeat is on disk
    // before the worker exits, and a slow write cannot cost the heartbeat or its stop their time.
    await this.bounded('outbox.settled', BOUND.settleOutbox, () => this.outbox!.settled(), 'final')
  }

  // Whether the recording goes on to the pipeline: the bot joined, and the run did not end by SIGTERM or a leave.
  private get handsOver(): boolean {
    const by = this.verdict?.endedBy
    return this.joinedAt !== null && by !== 'terminated' && by !== 'member_left'
  }

  // The state the occurrence ends in as far as the worker is concerned (`leaving` and `uploading` come earlier).
  private finalState(verdict: Verdict): OccurrenceState | null {
    if (this.handsOver) return 'transcribing'
    if (verdict.endedBy === 'terminated' || verdict.endedBy === 'member_left') return null
    if (verdict.result === 'denied') return 'denied'
    return verdict.reason === 'no_link' ? 'no_link' : 'failed'
  }

  // --- emit, report, alert ---

  // Writing an event must never end the run: a failure goes to stderr.
  private readonly ev = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
    try {
      await this.events.emit(type, data)
    } catch (error) {
      console.error(`event ${type} not written: ${messageOf(error)}`)
    }
  }

  private report(where: string, error: unknown): Promise<void> {
    return this.ev('error', { where, message: messageOf(error) })
  }

  // A component stopped: an error event and a ping. The same component pings at most once per 10 minutes.
  private fault(component: string, error: unknown): void {
    void this.report(component, error)
    this.alerter.alert('component_failed', component)
  }

  // A part of the run the meeting can do without: if it fails, the failure is reported and pinged, and the run goes on.
  private async optional<T>(component: string, fn: () => T | Promise<T>): Promise<T | null> {
    try {
      return await fn()
    } catch (error) {
      this.fault(component, error)
      return null
    }
  }

  // Waits for a step, or for the abort signal, whichever comes first. A step abandoned by the abort is left running.
  private async abortable<T>(name: string, fn: () => T | Promise<T>): Promise<T | typeof ABORTED> {
    return this.untilAborted(this.step(name, fn))
  }

  // Waits for a promise, or for the abort signal. A rejection after the abort is swallowed; one before it is thrown.
  private async untilAborted<T>(run: Promise<T>): Promise<T | typeof ABORTED> {
    run.catch(() => undefined)
    return Promise.race([run, this.aborted.then((): typeof ABORTED => ABORTED)])
  }

  // The verdict of a run that was asked to end: by the stop signal, or by a command (or the server replacing it).
  private terminated(): Verdict {
    const joined = this.joinedAt !== null
    const result = joined ? 'completed' : 'failed'
    if (this.deps.signal?.aborted !== true) {
      if (this.endRequest === 'leave') return { result, endedBy: 'member_left', reason: 'left_by_member' }
      if (this.endRequest === 'stop') return { result, endedBy: 'stopped', reason: 'stopped' }
      if (this.endRequest === 'superseded') return { result, endedBy: 'terminated', reason: 'superseded' }
    }
    return { result, endedBy: 'terminated', reason: 'terminated' }
  }

  private async sendQuiet(ping: Ping): Promise<void> {
    try {
      await this.deps.sendPing(this.cfg.ntfy, ping)
    } catch (error) {
      console.error(`ping not sent: ${messageOf(error)}`)
    }
  }

  // A per-tick step failed. One report per step per minute: a tick comes every 5 seconds.
  private async tickError(step: string, error: unknown): Promise<void> {
    if (this.tickLimit(`tick:${step}`, TICK_ERROR_WINDOW_MS)) await this.report(`tick ${step}`, error)
  }

  // Runs a per-tick step. A failure is reported and does not stop the tick.
  private async guard(step: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (error) {
      await this.tickError(step, error)
      return false
    }
  }

  private async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (cause) {
      throw new StepFailed(name, cause)
    }
  }

  private async runFailed(error: unknown): Promise<Verdict> {
    if (error instanceof StepFailed) {
      await this.report(error.step, error.cause)
      await this.saveFailure(error.step)
      this.alerter.alert('join_failed', error.step)
      return failed(`step_failed: ${error.step}`)
    }
    await this.report('run', error)
    this.alerter.alert('run_failed')
    return failed('internal_error')
  }

  // The desk page now: the anchor tab can be replaced when the member closes it, so nothing keeps the first page.
  private deskPage(): Page {
    if (this.desk === null) throw new Error('the desk is not open')
    return this.desk
  }

  // The stage's screenshot and aria snapshot, for a step that failed. Saving never throws.
  private async saveFailure(step: string): Promise<void> {
    const page = this.stage ?? this.desk
    if (!page || page.isClosed()) return
    const name = `${step.replace(/[^A-Za-z0-9_.-]/g, '_')}-${localParts(this.deps.now(), this.cfg.entry.timeZone).hhmmss}`
    const base = join(this.cfg.dataDir, 'errors', name)
    await this.bounded('failure screenshot', ARTEFACT_TIMEOUT_MS, async () =>
      writeFile(`${base}.png`, await page.screenshot())
    )
    await this.bounded('failure aria snapshot', ARTEFACT_TIMEOUT_MS, async () =>
      writeFile(`${base}.aria.yml`, await page.ariaSnapshot())
    )
  }

  private get budgetMs(): number {
    return this.deps.teardownBudgetMs ?? TEARDOWN_BUDGET_MS
  }

  // The end of the teardown budget (real time). Unlimited until the stop signal or the start of teardown.
  private get budgetEnd(): number {
    const starts = [this.abortAt, this.teardownStart].filter((t): t is number => t !== null)
    return starts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...starts) + this.budgetMs
  }

  // The end of the part of the budget that the steps before the final checkpoint may use.
  private get preEnd(): number {
    return this.budgetEnd - Math.min(CHECKPOINT_RESERVE_MS + this.finalReserve, this.budgetMs * RESERVE_SHARE)
  }

  // The part of the budget kept for the final heartbeat; none without a control channel.
  private get finalReserve(): number {
    return this.heartbeat === null ? 0 : Math.min(FINAL_HEARTBEAT_RESERVE_MS, this.budgetMs * 0.1)
  }

  // The share a pre-checkpoint step always gets, even when the reserve has been used up.
  private get minSlice(): number {
    return Math.min(1000, this.budgetMs / 20)
  }

  // Runs one teardown or cleanup action with a time limit and says whether it finished. The limit is the step's own,
  // cut to the time left: a step before the final checkpoint (phase 'pre') may not use the checkpoint's reserve, but
  // always gets a short slice; a later step (phase 'end') may use all that is left but the final heartbeat's reserve,
  // which only the last steps (phases 'beat' and 'final') may use; 'beat' keeps a share of it for the 'final' ones. A
  // failure, a timeout or no time left is reported; it never throws.
  private async bounded(
    name: string,
    ms: number,
    fn: () => Promise<unknown>,
    phase: 'pre' | 'end' | 'beat' | 'final' = 'pre'
  ): Promise<boolean> {
    const now = Date.now()
    const endLeft = this.budgetEnd - now
    const kept = phase === 'end' ? this.finalReserve : phase === 'beat' ? this.finalReserve * STOP_SHARE : 0
    const share = phase === 'pre' ? Math.max(this.preEnd - now, this.minSlice) : endLeft - kept
    const limit = Math.min(ms, share, endLeft)
    if (limit <= 0) {
      await this.report(`teardown ${name}`, new Error('skipped: no teardown time left'))
      return false
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} did not finish within ${limit / 1000} s`)), limit)
    })
    try {
      await Promise.race([Promise.resolve().then(fn), timeout])
      return true
    } catch (error) {
      await this.report(`teardown ${name}`, error)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // --- waiting ---

  private now(): number {
    return this.deps.now().getTime()
  }

  // True once the run was asked to end: by the stop signal, or by a command.
  private get isAborted(): boolean {
    return this.deps.signal?.aborted === true || this.endRequest !== null
  }

  private async wait(ms: number): Promise<void> {
    await Promise.race([this.deps.sleep(ms), this.aborted])
  }

  private async waitUntil(at: number): Promise<void> {
    while (this.now() < at && !this.isAborted) await this.wait(Math.min(at - this.now(), MINUTE))
  }

  // --- the run ---

  private async main(): Promise<Verdict> {
    const { cfg, deps } = this
    const { entry } = cfg
    // A fixed link is the entry's own; any other source brings its link through the website (a pasted link) or a chat
    // watcher. A pasted link wins until joining starts.
    if (entry.link.kind === 'fixed' && !this.useLink(entry.link.url, 'fixed')) return failed('unsupported_link')
    if (cfg.attempt > 1) await this.recallJoinedLink()

    // These steps race the stop signal: one that hangs (a restore, Xvfb, Chrome) must not outlive SIGTERM. A step
    // abandoned that way is left running, and its late failure is swallowed.
    const profile = await this.abortable('prepareProfile', () => setupProfile(cfg, deps))
    if (profile === ABORTED) return this.terminated()
    this.profile = profile
    const screen = await this.abortable('startScreen', () => deps.startScreen())
    if (screen === ABORTED) return this.terminated()
    this.screen = screen
    const browser = await this.abortable('launchBrowser', () => deps.launchBrowser(cfg.profileDir, screen))
    if (browser === ABORTED) return this.terminated()
    this.context = browser.context
    this.stage = browser.stage
    this.desk = browser.desk
    const checkpoints = await this.abortable('startCheckpoints', () =>
      deps.startCheckpoints(cfg.profileDir, profile.checkpointsDir, profile.key, (e) =>
        this.fault('profile checkpoint', e)
      )
    )
    if (checkpoints === ABORTED) return this.terminated()
    this.checkpoints = checkpoints
    this.deskPause = this.makeDeskPause(screen, profile)
    if (this.deskPause !== null && this.pauseWanted) {
      const pause = this.deskPause
      if ((await this.optional('desk pause', () => pause.pause())) === null) this.pauseWanted = false
    }

    await this.setState('verifying_accounts')
    if (this.lecture || entry.link.kind === 'chat') {
      const started = await this.untilAborted(this.verifyAccounts())
      if (started === ABORTED) return this.terminated()
    }

    await this.setState('watching_for_link')
    const linked = await this.untilLink()
    if (linked === 'no_link') {
      const until = formatWhen(new Date(this.start + GIVE_UP_AFTER_MS), entry.timeZone)
      await this.sendQuiet(
        pings.noLinkStopped({ entry: entry.name, until, meetingUrl: this.links?.meetingPage ?? null })
      )
      return failed('no_link')
    }
    if (this.isAborted) return this.terminated()
    if (this.now() >= this.hardStop) return failed('past_hard_stop')
    await this.startJoining()
    const adapter = this.adapter!

    const audio = await this.abortable('startAudioSource', () => deps.startAudioSource())
    if (audio === ABORTED) return this.terminated()
    this.audio = audio
    audio.onFatal((e) => this.fault('audio capture', e))
    const recorder = await this.abortable('startRecorder', () =>
      deps.startRecorder(screen, join(cfg.dataDir, 'recording'), cfg.attempt)
    )
    if (recorder === ABORTED) return this.terminated()
    this.recorder = recorder
    this.recording = true
    this.watchRecorder(recorder)
    const recordingStart = await this.untilAborted(this.firstRecordingStart(recorder))
    if (recordingStart === ABORTED) return this.terminated()
    this.recordingStart = recordingStart

    // From here the bot is in the meeting: only the join checks below are fatal. The rest is optional (see `optional`).
    const entered = await this.enter()
    if (entered) return entered
    if (this.isAborted) return this.terminated()
    const set = await this.afterJoin()
    if (set) return set
    if (this.isAborted) return this.terminated()
    await this.dismiss()
    this.participants = await this.optional('participant count', () => adapter.participantCount(this.stage!))
    await this.sendQuiet(joinedPing(entry.name, this.participants, this.links))
    await this.ev('joined', { participants: this.participants })

    if (this.isAborted) return this.terminated()
    await this.startComponents()
    return this.supervise()
  }

  // Takes a link as the one to join, if its platform's rule accepts it.
  private useLink(raw: string, source: JoinedLinkSource): boolean {
    const adapter = this.deps.adapterFor(raw)
    const url = adapter?.normaliseLink(raw) ?? null
    if (adapter === null || url === null) return false
    this.adapter = adapter
    this.url = url
    this.linkSource = source
    return true
  }

  // Waits for the time to join (10 minutes before the start) with a link in hand. A link pasted on the website replaces
  // a watched or fixed one at any point up to the join, and a watched one replaces the entry's own. Without a link the
  // member is pinged at the start, and the wait ends 30 minutes after it (`decideLinkWait` makes each call).
  private async untilLink(): Promise<'ready' | 'no_link' | 'aborted'> {
    const start = new Date(this.start)
    let pinged = false
    for (;;) {
      if (this.isAborted) return 'aborted'
      const pasted = this.linkOverride.current()
      const chosen = chooseMeetingLink(this.watched.current(), pasted)
      if (chosen !== null) this.useLink(chosen, pasted !== null ? 'pasted' : 'watched')
      const now = this.deps.now()
      const decision = decideLinkWait({ now, start, link: this.url === '' ? null : this.url, noLinkPinged: pinged })
      if (decision.kind === 'join') return 'ready'
      if (decision.kind === 'give_up') return 'no_link'
      if (decision.kind === 'ping_no_link') {
        pinged = true
        this.alerter.alert('no_link')
        continue
      }
      const at = now.getTime()
      const until =
        this.url !== '' ? this.start - JOIN_FROM_MS : at < this.start ? this.start : this.start + GIVE_UP_AFTER_MS
      await Promise.race([
        this.deps.sleep(Math.min(until - at, MINUTE)),
        this.aborted,
        this.linkOverride.next(),
        this.watched.next()
      ])
    }
  }

  // The form dispatcher is an extra: if it cannot start, the meeting is still recorded, the member is told, and links
  // from trusted senders reach them as "link seen, not checked" (see onFormCandidate).
  private async startForms(): Promise<void> {
    const { cfg, deps } = this
    await this.optional('form submission', async () => {
      // The meeting page links (1C) are not known yet.
      const links = { meetingPage: this.links?.meetingPage ?? null, signIn: this.links?.signIn ?? null }
      const base = makeFormContextBase(
        cfg,
        () => this.deskPage(),
        this.ev,
        links,
        (p) => deps.sendPing(cfg.ntfy, p),
        this.deskPause
      )
      const dispatcher = await deps.startFormDispatcher(base)
      this.forms = dispatcher
      // Started after the stop signal (the setup abandoned it): nothing will use it, and teardown may be past its step.
      if (this.isAborted) {
        this.formsClosed = true
        await dispatcher.close()
      }
    })
  }

  // Accounts first, then the forms: the chat watcher starts before the sign-in check, so a chat app that is signed out
  // is found by the same check as a form provider.
  private async verifyAccounts(): Promise<void> {
    await this.startWatching()
    await this.checkAccounts()
    if (this.lecture) await this.startForms()
  }

  // Checks that each form provider (a lecture's) and the chat app (a chat entry's) is signed in on the desk. One that
  // is not gets the "Sign in again" ping. With a control channel the member can sign in through the remote view: the
  // run waits in `waiting_for_signin` until they press "Done" (then checks again, and starts the watcher again), until
  // T-5, or until the run ends. Whatever is still signed out then is left for the form ping ("link seen, not checked"),
  // and a chat that is still signed out for pasted links only: a meeting is worth recording without it.
  private async checkAccounts(): Promise<void> {
    const { cfg, deps } = this
    const deadline = this.start - SIGNIN_DEADLINE_BEFORE_START_MS
    try {
      for (let round = 0; ; round += 1) {
        // The desk may be in the member's hands.
        await this.deskPause?.whenOpen()
        if (round > 0 && this.chatSignedOut) await this.startWatching()
        const signedOut = this.lecture ? await deps.checkFormProviders(this.deskPage(), cfg.identity.formProviders) : []
        // The website shows when each account was last checked and whether it was signed in.
        if (this.lecture) {
          for (const provider of cfg.identity.formProviders) {
            await this.ev('state', {
              account: provider,
              signedIn: !signedOut.includes(provider)
            } satisfies AccountCheckData)
          }
        }
        for (const provider of signedOut) {
          this.alerter.alert('signin_forms', provider === 'google' ? 'Google' : 'Microsoft')
        }
        // The chat app is waited for once: a second failed start leaves the entry with pasted links only.
        const chatWaits = this.chatSignedOut && round === 0
        if (
          (signedOut.length === 0 && !chatWaits) ||
          this.deskPause === null ||
          this.now() >= deadline ||
          this.isAborted
        )
          break
        // Registered before the state is sent: a "Done" that comes while the state goes out must still end the wait.
        const resumed = this.deskPause.nextResume()
        await this.setState('waiting_for_signin')
        if ((await this.waitForSignin(resumed, deadline)) !== 'resumed') break
      }
    } catch (error) {
      // Not fatal: a meeting is worth recording without it. The ping says what is unchecked.
      this.fault('form sign-in check', error)
    }
    if (this.state === 'waiting_for_signin' && !this.isAborted) await this.setState('verifying_accounts')
  }

  // Waits for the member's "Done" (or the end of their idle time), the deadline, or the end of the run.
  private async waitForSignin(next: Promise<unknown>, deadline: number): Promise<'resumed' | 'deadline' | 'aborted'> {
    const resumed = next.then((): 'resumed' => 'resumed')
    while (!this.isAborted) {
      const left = deadline - this.now()
      if (left <= 0) return 'deadline'
      const first = await Promise.race([resumed, this.wait(Math.min(left, MINUTE)).then(() => null)])
      if (first === 'resumed') return 'resumed'
    }
    return 'aborted'
  }

  // The recording's time origin is its first attempt's start, which attempts.json holds. A file that cannot be read
  // or parsed is reported, and the origin falls back to this attempt's start: the run must not die for a bad time origin.
  private async firstRecordingStart(recorder: Recorder): Promise<Date> {
    let text: string
    try {
      text = await readFile(join(this.cfg.dataDir, 'recording', 'attempts.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return recorder.startedAt
      await this.report('attempts.json', error)
      return recorder.startedAt
    }
    try {
      const starts = AttemptsSchema.parse(JSON.parse(text)).map((a) => Date.parse(a.startedAt))
      if (starts.some(Number.isNaN)) throw new Error('an attempt has a start time that is not a date')
      return new Date(Math.min(recorder.startedAt.getTime(), ...starts))
    } catch (error) {
      await this.report('attempts.json', error)
      return recorder.startedAt
    }
  }

  private watchRecorder(recorder: Recorder): void {
    recorder.onGap((g) => {
      const seconds = Math.round((g.to.getTime() - g.from.getTime()) / 1000)
      void this.ev('recording_gap', { from: g.from.toISOString(), to: g.to.toISOString(), seconds })
      this.alerter.alert('recording_gap', String(seconds))
      // An ffmpeg that dies every few seconds restarts for ever and never turns fatal: count the gaps.
      const now = this.now()
      this.gaps = [...this.gaps.filter((at) => now - at < GAP_WINDOW_MS), now]
      if (this.gaps.length >= GAP_LIMIT) this.alerter.alert('recording_unstable')
    })
    recorder.onFatal((e) => {
      void this.report('recorder', e)
      this.alerter.alert('recorder_failed')
    })
  }

  // --- the chat watcher ---

  private get chatLink(): ChatLink | null {
    const { link } = this.cfg.entry
    return link.kind === 'chat' ? link : null
  }

  // A desk action runs through the desk pause's busy gate: a pause waits for it, and it waits for a pause.
  private deskStep<T>(step: () => Promise<T>): Promise<T> {
    return this.deskPause === null ? step() : this.deskPause.deskStep(step)
  }

  // The tabs a sign-in pause opens. A live watcher already holds the chat app's tab, and WhatsApp Web allows one live
  // window per profile: no second tab on its host. A watcher that is signed out has its tab brought to the front.
  private signinTabOptions(): SigninTabOptions {
    const watcher = this.watcher
    if (watcher === null) return {}
    return { exclude: [CHAT_HOST[watcher.app]], ...(this.chatSignedOut ? { front: watcher.tab } : {}) }
  }

  // A restarted attempt rejoins the link an earlier attempt took from a chat: no watch wait, and a watcher that starts
  // offers form links at once.
  private async recallJoinedLink(): Promise<void> {
    const kept = await this.optional('joined link', () => readJoinedLink(this.cfg.dataDir))
    if (kept === null) return
    this.watched.offer(kept)
    if (this.watched.current() !== null) this.watchPhase = 'during'
  }

  // Joining starts: the watcher now offers form links, and a link a watcher found is kept for a restarted attempt.
  private async startJoining(): Promise<void> {
    this.watchPhase = 'during'
    if (this.linkSource === 'watched') {
      await this.optional('joined link', () => writeJoinedLink(this.cfg.dataDir, this.url))
    }
  }

  // Starts the chat watcher of a chat entry in a desk tab of its own. A watcher that cannot start leaves the entry with
  // pasted links only; the member is told why. Never throws.
  private async startWatching(): Promise<void> {
    const chat = this.chatLink
    if (chat === null || this.watcher !== null) return
    const start = this.deps.startWatcher(chat.app)
    if (start === null) return
    this.watchersConfigured = true
    configureWatchers({
      now: () => this.deps.now(),
      phase: () => this.watchPhase,
      formsSince: () => new Date(this.start - FORMS_LOOKBACK_MS),
      pastedLink: () => this.linkOverride.current(),
      deskStep: (step) => this.deskStep(step),
      onStatus: (status) => this.onWatcherStatus(chat.app, status)
    })
    let tab: Page | null = null
    try {
      const opened = await this.deskStep(() => this.deps.openDeskTab(this.deskPage()))
      tab = opened
      const stopper = await start(opened, chat, (c) => this.onWatched(c))
      this.watcher = { app: chat.app, tab: opened, stopper }
      this.chatSignedOut = false
      await this.ev('state', { account: chat.app, signedIn: true } satisfies AccountCheckData)
      // Started after the stop signal (the setup abandoned it): nothing will use it, and teardown may be past its step.
      if (this.isAborted) await this.stopWatching()
    } catch (error) {
      if (tab !== null && !tab.isClosed()) {
        const failed = tab
        await failed.close().catch((e: unknown) => this.report('watcher tab', e))
      }
      if (error instanceof WatcherSigninError) {
        this.chatSignedOut = true
        await this.ev('state', { account: chat.app, signedIn: false } satisfies AccountCheckData)
        if (!this.chatSigninPinged) {
          this.chatSigninPinged = true
          this.watcherPing(chat.app, 'signed_out')
        }
      } else if (error instanceof WatcherChatError) {
        await this.ev('error', { where: 'chat watcher', reason: `watcher_${error.reason}` })
        this.watcherPing(chat.app, error.reason)
      } else {
        this.fault('chat watcher', error)
      }
    }
  }

  // Stops the watcher and closes its tab, once. Runs when the worker leaves the meeting for any reason.
  private async stopWatching(): Promise<void> {
    const watcher = this.watcher
    this.watcher = null
    if (watcher !== null) {
      await this.bounded('watcher.stop', BOUND.stopWatcher, () => watcher.stopper.stop())
      await this.bounded('watcher tab', BOUND.stopWatcher, async () => {
        if (!watcher.tab.isClosed()) await watcher.tab.close()
      })
    }
    if (this.watchersConfigured) resetWatcherEnv()
    this.watchersConfigured = false
  }

  // What the watcher found. A meeting link goes to the wait for a link; a form link goes to the form intake, as a
  // meeting-chat link does (a work entry has no forms to fill).
  private onWatched(c: FormCandidate | { meetingUrl: string }): void {
    if ('meetingUrl' in c) this.watched.offer(c.meetingUrl)
    else if (this.lecture) void this.offerForm(c)
  }

  // A change in what the watcher can see. Every problem is an `error` event; the member is pinged for the ones that
  // cost them links.
  private onWatcherStatus(app: ChatApp, status: WatcherStatus): void {
    if (status.kind !== 'signed_in') void this.ev('error', { where: 'chat watcher', reason: `watcher_${status.kind}` })
    if (status.kind === 'signed_out') {
      this.chatSignedOut = true
      void this.ev('state', { account: app, signedIn: false } satisfies AccountCheckData)
      this.watcherPing(app, 'signed_out')
    } else if (status.kind === 'signed_in') {
      this.chatSignedOut = false
      void this.ev('state', { account: app, signedIn: true } satisfies AccountCheckData)
    } else if (status.kind === 'chat_lost') {
      this.watcherPing(app, 'lost')
    }
  }

  // The "not watching" ping, at most once per problem per 10 minutes (a watcher that flaps must not flood the member).
  private watcherPing(app: ChatApp, problem: WatcherProblem): void {
    if (!this.watcherLimit(`watcher:${app}:${problem}`, ALERT_WINDOW_MS)) return
    void this.ev('alert', { kind: 'watcher_problem', detail: problem })
    void this.sendQuiet(
      pings.watcherProblem({
        entry: this.cfg.entry.name,
        app,
        problem,
        meetingUrl: this.links?.meetingPage ?? null,
        signInUrl: this.links?.signIn ?? null
      })
    )
  }

  // --- joining ---

  // Opens the link and joins. A busy Zoom account falls back to a guest browser, once. Gives up at once when the abort
  // signal fires, even while a page call hangs.
  private async gotoAndJoin(): Promise<JoinResult | typeof ABORTED> {
    const { adapter, deps, cfg } = this
    const opts = { guestName: cfg.identity.zoomGuestName }
    const open = () =>
      this.abortable('goto', () =>
        this.stage!.goto(this.url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
      )
    if ((await open()) === ABORTED) return ABORTED
    let result = await this.abortable('join', () => adapter!.join(this.stage!, opts))
    if (result !== ABORTED && result.kind === 'account_busy' && this.guest === null) {
      // The account's own page leaves the call before the guest joins.
      const old = this.stage!
      await this.bounded('blank old stage', ARTEFACT_TIMEOUT_MS, () => old.goto('about:blank'))
      const guest = await this.step('launchGuestStage', () => deps.launchGuestStage(this.screen!))
      this.guest = guest
      this.stage = guest.stage
      await this.restartChat()
      if ((await open()) === ABORTED) return ABORTED
      result = await this.abortable('join', () => adapter!.join(this.stage!, opts))
    }
    return result
  }

  // Joins until the bot is in the meeting (null) or the run must end (a verdict).
  private async enter(): Promise<Verdict | null> {
    const { adapter } = this
    let retries = 0
    await this.joinState('joining', { source: this.linkSource, host: new URL(this.url).host })
    let result = await this.gotoAndJoin()
    for (;;) {
      if (result === ABORTED) return this.terminated()
      switch (result.kind) {
        case 'in_meeting':
          return this.entered()
        case 'signin_required':
          // Teams signs in with a Microsoft account.
          await this.ev('state', {
            account: adapter!.platform === 'teams' ? 'teams' : 'zoom',
            signedIn: false
          } satisfies AccountCheckData)
          this.alerter.alert(adapter!.platform === 'teams' ? 'teams_signin' : 'zoom_signin')
          return failed('signin_required')
        case 'account_busy':
          this.alerter.alert('join_failed', 'the account is busy')
          return failed('account_busy')
        case 'failed':
          if (await this.handOverEarlier(result.reason)) return ended('page')
          await this.saveFailure('join')
          this.alerter.alert('join_failed', result.reason)
          return failed(result.reason)
        case 'lobby': {
          await this.joinState('in_lobby')
          const deadline = new Date(Math.min(this.now() + LOBBY_ATTEMPT_MS, this.hardStop))
          const admission = await this.abortable('waitUntilAdmitted', () =>
            adapter!.waitUntilAdmitted(this.stage!, deadline)
          )
          if (admission === ABORTED) return this.terminated()
          if (admission === 'admitted') return this.entered()
          if (admission === 'lobby_denied') {
            this.alerter.alert('lobby_denied')
            return { result: 'denied', endedBy: null, reason: null }
          }
          if (this.now() >= this.hardStop || retries >= MAX_LOBBY_RETRIES) {
            this.alerter.alert('not_admitted')
            return { result: 'not_admitted', endedBy: null, reason: null }
          }
          retries += 1
          result = await this.gotoAndJoin()
        }
      }
    }
  }

  // A restarted worker whose rejoin finds the meeting over: the segments an earlier attempt recorded are all there is,
  // and they still go to the pipeline. The run then ends like a meeting that ended on its own (`teardown` walks the
  // states). False when there is nothing to hand over: the attempt is the first, the earlier one never joined, or no
  // earlier attempt left a segment.
  private async handOverEarlier(reason: string): Promise<boolean> {
    const { attempt, dataDir } = this.cfg
    if (reason !== 'meeting_ended' || attempt === 1 || this.earlierJoinedAt === null) return false
    const files = await readdir(join(dataDir, 'recording'))
    const earlier = files.some((f) => {
      const n = /^attempt_(\d+)_seg_\d+\.mkv$/.exec(f)?.[1]
      return n !== undefined && Number(n) < attempt
    })
    if (!earlier && !files.includes('meeting.mkv')) return false
    this.joinedAt ??= new Date(this.earlierJoinedAt ?? this.deps.now())
    return true
  }

  private async entered(): Promise<null> {
    this.inMeeting = true
    await this.joinState('in_meeting')
    this.joinedAt ??= this.deps.now()
    return null
  }

  // Right after a join: devices must be off, then output audio and the chat panel.
  private async afterJoin(): Promise<Verdict | null> {
    const { adapter } = this
    try {
      await adapter!.assertDevicesOff(this.stage!)
    } catch (error) {
      if (error instanceof DevicesOnError) return this.devicesOn()
      throw new StepFailed('assertDevicesOff', error)
    }
    await this.step('connectOutputAudio', () => adapter!.connectOutputAudio(this.stage!))
    await this.step('ensureLayout', () => adapter!.ensureLayout(this.stage!))
    return null
  }

  // Leave at once and close the browser right after, before anything slow.
  private async devicesOn(): Promise<Verdict> {
    await this.leave()
    await this.closeBrowser()
    this.alerter.alert('devices_on')
    return failed('devices_on')
  }

  // Leaves the meeting. A leave that failed or timed out may have left the bot in the call, so the browser is closed at
  // once: closing it is what ends the participant.
  private async leave(): Promise<void> {
    const left = await this.bounded('leave', BOUND.leave, () => this.adapter!.leave(this.stage!))
    this.inMeeting = false
    if (!left) await this.closeBrowser()
  }

  // Closes the guest browser and the main context, each once; a context that failed to close is tried again.
  private async closeBrowser(): Promise<void> {
    if (this.guest) {
      const guest = this.guest
      this.guest = null
      await this.bounded('guest browser', BOUND.closeBrowser, () => guest.browser.close())
    }
    if (this.context && !this.contextClosed) {
      const context = this.context
      this.contextClosed = await this.bounded('context.close', BOUND.closeBrowser, () => context.close())
    }
  }

  private async dismiss(): Promise<void> {
    const texts = await this.optional('notice dismissal', () => this.adapter!.dismissNotices(this.stage!))
    for (const text of texts ?? []) await this.ev('notice_dismissed', { text })
  }

  // --- capture ---

  // The parts of the recording that are extras. Each one that fails to start is reported and pinged, and the meeting goes
  // on: the recording itself does not depend on them.
  private async startComponents(): Promise<void> {
    const { cfg, deps } = this
    this.chat = await this.optional('chat capture', () => this.openChat())
    const handler = createFrameHandler({
      dataDir: cfg.dataDir,
      timeZone: cfg.entry.timeZone,
      recordingStart: this.recordingStart!,
      lecture: this.lecture,
      region: () => this.region,
      participants: () => this.participants,
      levelDb: () => this.audio!.levelDb(1000),
      emit: this.ev,
      onAlert: (kind, detail) => this.alerter.alert(kind, detail),
      onCandidate: this.lecture ? (c) => void this.offerForm(c) : null
    })
    this.handler = handler
    const frames = await this.optional('screen capture', () => deps.startFrameLoop(this.screen!, handler))
    this.frames = frames
    frames?.onFatal((e) => this.fault('screen capture', e))
    if (cfg.entry.transcription === 'live') {
      const audio = this.audio!
      this.asr = await this.optional('live transcription', () =>
        deps.startLiveAsr(audio, cfg.ai, join(cfg.dataDir, 'transcript', 'live.jsonl'), {
          baseMs: audio.startedAt.getTime() - this.recorder!.startedAt.getTime(),
          onError: (e) => this.asrError(e)
        })
      )
    }
  }

  private asrError(error: Error): void {
    if (error instanceof AiKeyError) this.alerter.alert('ai_key', String(error.status))
    else this.fault('live transcription', error)
  }

  private openChat(): Promise<ChatCapture> {
    return this.deps.startChatCapture(
      this.stage!,
      this.adapter!,
      join(this.cfg.dataDir, 'chat.jsonl'),
      (m) => this.offerLinks(m),
      {
        onReplay: (m) => this.offerLinks(m),
        emit: async (type, data) => {
          await this.ev(type, data)
          if (type === 'error') this.alerter.alert('component_failed', 'chat capture')
        }
      }
    )
  }

  // After the guest browser took over, chat capture reads the new stage. Its file keeps the rows; the dispatcher dedupes.
  private async restartChat(): Promise<void> {
    if (this.chat === null) return
    const old = this.chat
    this.chat = null
    await this.bounded('chat.stop', BOUND.stopChat, () => old.stop())
    // Only a rejoin gets here, and the bot is in the meeting by then: a chat that does not restart is a fault.
    this.chat = await this.optional('chat capture', () => this.openChat())
  }

  // A link from the shared screen or the chat. It is resolved and handed to the form dispatcher without being awaited:
  // resolving takes seconds, and the chat and frame loops must not wait for it. `onFormCandidate` never rejects.
  private offerForm(c: FormCandidate): Promise<void> {
    const dispatcher = (): FormDispatcher | null => (this.formsClosed ? null : this.forms)
    const intake = onFormCandidate(c, {
      cfg: this.cfg,
      resolve: (candidate) => this.deps.resolveFormLink(candidate),
      // Read when the link has resolved: teardown may have closed the dispatcher by then.
      get dispatcher() {
        return dispatcher()
      },
      emitEvent: this.ev,
      ping: async (p) => {
        try {
          await this.deps.sendPing(this.cfg.ntfy, p)
        } catch (error) {
          this.alerter.alert('form_ping_failed')
          throw error
        }
      },
      inFlight: this.linksInFlight,
      pinged: this.linksPinged
    }).finally(() => this.intakes.delete(intake))
    this.intakes.add(intake)
    return intake
  }

  // Chat links go to the dispatcher one message at a time. A restarted worker replays the file's rows here: the
  // dispatcher knows the forms an earlier run handled (their records are on disk) and does not handle them again.
  private async offerLinks(m: ChatMessage): Promise<void> {
    if (!this.lecture) return
    for (const url of m.links) {
      void this.offerForm({ url, source: 'meeting_chat', sender: m.sender, senderRole: m.senderRole, seenAt: m.seenAt })
    }
  }

  // --- watching ---

  private async supervise(): Promise<Verdict> {
    for (;;) {
      if (this.isAborted) return this.terminated()
      if (this.now() >= this.hardStop) return ended('hard_stop')
      // A tick still in flight at the stop signal is abandoned: teardown must not wait for its page calls.
      const verdict = await this.untilAborted(this.tick())
      if (verdict === ABORTED) return this.terminated()
      if (verdict) return verdict
      await this.wait(Math.min(TICK_MS, this.hardStop - this.now()))
    }
  }

  // One look at the meeting. Every step is caught: one bad tick never ends the meeting. A meeting that shows no known
  // state (or a device check that cannot run) for 30 seconds has dropped us.
  private async tick(): Promise<Verdict | null> {
    const { adapter } = this
    const now = this.now()
    let state: MeetingState = 'unknown'
    try {
      state = await adapter!.meetingState(this.stage!)
    } catch (error) {
      await this.tickError('meetingState', error)
    }
    if (state === 'ended') {
      this.inMeeting = false
      return ended('page')
    }
    if (state === 'removed') {
      this.inMeeting = false
      this.alerter.alert('removed')
      return ended('removed')
    }
    if (state === 'breakout_prompt') {
      if (!this.breakoutShown) this.alerter.alert('breakout')
      this.breakoutShown = true
    } else {
      this.breakoutShown = false
    }

    await this.guard('dismissNotices', async () => {
      for (const text of await adapter!.dismissNotices(this.stage!)) await this.ev('notice_dismissed', { text })
    })
    let devicesChecked = true
    try {
      await adapter!.assertDevicesOff(this.stage!)
    } catch (error) {
      if (error instanceof DevicesOnError) return this.devicesOn()
      devicesChecked = false
      await this.tickError('assertDevicesOff', error)
    }
    if (now - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = now
      await this.guard('sharedScreenRegion', async () => {
        this.region = await adapter!.sharedScreenRegion(this.stage!)
      })
      await this.guard('participantCount', async () => {
        this.participants = await adapter!.participantCount(this.stage!)
      })
      await this.guard('ensureLayout', () => adapter!.ensureLayout(this.stage!))
    }
    await this.guard('audio level', () => this.watchAudio(now))

    if (state === 'unknown' || !devicesChecked) {
      this.badSince ??= now
      this.badWhy = state === 'unknown' ? 'state' : 'devices'
    } else {
      this.badSince = null
    }
    if (this.badSince !== null && now - this.badSince >= UNKNOWN_MS) return this.drop()
    return null
  }

  // 120 s below -60 dBFS after the join (or the scheduled start): join the computer audio once more, then ping. A level
  // of null is unknown, not silent: a failed source has already raised its own alert.
  private async watchAudio(now: number): Promise<void> {
    if (this.audioChecked || this.audio === null || this.joinedAt === null) return
    if (now < Math.max(this.joinedAt.getTime(), this.start)) return
    const level = this.audio.levelDb(5000)
    if (level === null || level >= SILENT_DB) {
      this.quietSince = null
      return
    }
    this.quietSince ??= now
    if (now - this.quietSince < NO_AUDIO_MS) return
    this.audioChecked = true
    await this.guard('connectOutputAudio', () => this.adapter!.connectOutputAudio(this.stage!))
    this.alerter.alert('no_audio')
  }

  // The first drop rejoins; the second stops. A device check that cannot run is not a drop of the meeting, and its
  // alerts say so.
  private async drop(): Promise<Verdict | null> {
    // A tick abandoned by the stop signal may resume after teardown has begun: it must not start a rejoin then.
    if (this.isAborted) return this.terminated()
    const why = this.badWhy
    if (this.rejoins >= 1) return this.dropped(why)
    this.rejoins += 1
    this.badSince = null
    this.alerter.alert(why === 'devices' ? 'device_check_failed' : 'dropped')
    let verdict: Verdict | null
    try {
      verdict = (await this.enter()) ?? (await this.afterJoin())
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error
      await this.report(error.step, error.cause)
      await this.saveFailure(error.step)
      verdict = failed(`step_failed: ${error.step}`)
    }
    if (verdict === null) return null
    // SIGTERM during the rejoin is an end, not a failed rejoin: the verdict stands as it is.
    if (this.isAborted) return verdict
    return verdict.reason === 'devices_on' ? verdict : this.dropped(why)
  }

  private dropped(why: 'state' | 'devices'): Verdict {
    this.inMeeting = false
    if (why === 'devices') {
      this.alerter.alert('device_check_stopped')
      return failed('device_check_failed', 'dropped')
    }
    this.alerter.alert('rejoin_failed')
    return failed('rejoin_failed', 'dropped')
  }

  // --- teardown ---

  // Always runs, inside the stop timeout: 50 s in all, counted from the stop signal when there is one, else from now.
  // Order: chat sweep, leave, chat, frames, live ASR, links still resolving, forms (the dispatcher fails queued forms as
  // meeting_ended, unopened), recorder, audio, browser, checkpoint timer, final checkpoint, held-back alerts, screen.
  // The checkpoint comes before the work the pipeline can redo later (joining the segments, `finishRecording`), and the
  // steps before it leave it a share of the budget. It is skipped only when the browser would not close: a profile that
  // is still open could be copied half-written. A step that fails or overruns is reported without stopping the later
  // ones.
  private async teardown(): Promise<void> {
    this.teardownStart = Date.now()

    // The member's view of the desk goes first, and the desk work that waits for it is released.
    if (this.deskPause) await this.bounded('desk pause', BOUND.deskPause, () => this.deskPause!.close())
    // The recording goes on to the pipeline: leaving, then (the bot out of the meeting) uploading.
    // The rejoin that found the meeting over reports `in_meeting` on the way: the earlier attempt was in it.
    if (this.handsOver) await this.walkTo('leaving')
    if (this.inMeeting) {
      const chat = this.chat
      if (chat) await this.bounded('chat.sweepNow', BOUND.sweep, () => chat.sweepNow())
      await this.leave()
    } else if (this.isAborted) {
      // A join abandoned by the stop signal may still complete in the page: closing the browser first keeps the bot out.
      await this.closeBrowser()
    }
    if (this.verdict?.endedBy === 'member_left') await this.setState('left_by_member')
    else if (this.handsOver) await this.setState('uploading')
    await this.stopWatching()
    if (this.chat) await this.bounded('chat.stop', BOUND.stopChat, () => this.chat!.stop())
    if (this.frames) await this.bounded('frames.stop', BOUND.stopFrames, () => this.frames!.stop())
    this.handler?.stop()
    await this.bounded('qr bridge', BOUND.stopQr, () => closeQr())
    if (this.asr) await this.bounded('asr.stop', BOUND.stopAsr, () => this.asr!.stop())
    // A link still resolving gets its say first: it reaches the dispatcher, or after the close it pings "not checked".
    await this.bounded('forms.intake', BOUND.formIntake, async () => {
      while (this.intakes.size > 0) await Promise.allSettled([...this.intakes])
    })
    this.formsClosed = true
    if (this.forms) await this.bounded('forms.close', BOUND.forms, () => this.forms!.close())
    if (this.recorder) await this.bounded('recorder.stop', BOUND.stopRecorder, () => this.recorder!.stop())
    this.recording = false
    if (this.audio) await this.bounded('audio.stop', BOUND.stopAudio, () => this.audio!.stop())
    await this.closeBrowser()
    if (this.checkpoints) await this.bounded('checkpoints.stop', BOUND.stopCheckpoints, () => this.checkpoints!.stop())
    // A replaced worker takes no checkpoint: the attempt that replaced it owns the profile.
    if (this.context && this.profile && !this.superseded) {
      const { checkpointsDir, key } = this.profile
      if (this.contextClosed) {
        await this.bounded(
          'checkpointProfile',
          BOUND.checkpoint,
          () => this.deps.checkpointProfile(this.cfg.profileDir, checkpointsDir, key),
          'end'
        )
      } else {
        await this.report('teardown checkpointProfile', new Error('skipped: the browser did not close'))
      }
    }
    await this.bounded('alerts', BOUND.alerts, () => this.alerter.idle(), 'end')
    if (this.screen) await this.bounded('screen.stop', BOUND.stopScreen, () => this.screen!.stop(), 'end')
  }

  private async joined(): Promise<boolean> {
    try {
      await access(join(this.cfg.dataDir, 'recording', 'meeting.mkv'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  // Joins the recording's segments into the final file. The pipeline can do this later if the run has no time left.
  private async finishRecording(): Promise<void> {
    // An earlier attempt may have joined the segments already.
    if (this.resumed) {
      if (this.joinedAt === null || (await this.joined())) return
    } else if (!this.recorder) return
    await this.bounded(
      'joinRecording',
      BOUND.join,
      () => this.deps.joinRecording(join(this.cfg.dataDir, 'recording')),
      'end'
    )
  }
}
