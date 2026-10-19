import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { AiKeyError, AsrDisconnected, AsrProtocolError } from '@tm/ai'
import { localParts, type ChatMessage, type EventType, type JobConfig } from '@tm/core'
import { joinedPing, type Ping } from '@tm/notify'
import { z } from 'zod'
import { DevicesOnError } from './adapters'
import type { JoinResult, MeetingState, PlatformAdapter, Rect } from './adapters/types'
import { createAlerter, createLimiter, type Alerter } from './alerts'
import type { AudioSource } from './audio/source'
import type { ChatCapture } from './chat/capture'
import { createEventLog, type EventLog } from './events'
import type { FormPinger } from './forms/pinger'
import { writeFileAtomic } from './forms/store'
import { createFrameHandler, type FrameHandler } from './frames/handler'
import type { FrameLoop } from './frames/frames'
import type { LiveAsr } from './asr/live'
import { setupProfile, type ProfileSetup } from './profile-setup'
import { closeQr } from './qr/qr'
import type { Recorder } from './recorder/recorder'
import { defaultDeps, type OccurrenceOutcome, type RunDeps } from './run-deps'
import type { Screen, Stopper } from './types'

export type { OccurrenceOutcome, RunDeps } from './run-deps'

const MINUTE = 60_000
const TICK_MS = 5_000
const REFRESH_MS = 10_000
/** A meeting that shows nothing we know for this long has dropped us. */
const UNKNOWN_MS = 30_000
const JOIN_LEAD_MS = 10 * MINUTE
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

// The most each teardown step may take; the time left in the budget cuts it shorter. A step that overruns is reported
// and the next one still runs.
const BOUND = {
  sweep: 10_000,
  leave: 10_000,
  stopChat: 5_000,
  stopFrames: 5_000,
  stopQr: 3_000,
  stopAsr: 5_000,
  pinger: 8_000,
  stopRecorder: 15_000,
  stopAudio: 5_000,
  closeBrowser: 10_000,
  stopCheckpoints: 5_000,
  checkpoint: 120_000,
  alerts: 5_000,
  stopScreen: 5_000,
  join: 300_000
}

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

class OccurrenceRun {
  private readonly events: EventLog
  private readonly alerter: Alerter
  private readonly aborted: Promise<void>
  private readonly tickLimit: ReturnType<typeof createLimiter>
  private readonly start: number
  private readonly end: number
  private readonly hardStop: number
  private readonly lecture: boolean

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
  private pinger: FormPinger | null = null
  private chat: ChatCapture | null = null
  private frames: FrameLoop | null = null
  private asr: LiveAsr | null = null
  private handler: FrameHandler | null = null

  // Teardown clock (real time, ms since the epoch): the end of the whole budget, and the end of the part the steps
  // before the final checkpoint may use. Both are unlimited until teardown starts.
  private teardownEnd = Number.POSITIVE_INFINITY
  private preEnd = Number.POSITIVE_INFINITY
  private minSlice = 0
  private contextClosed = false

  private inMeeting = false
  private joinedAt: Date | null = null
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
    this.events = createEventLog(join(cfg.dataDir, 'events.jsonl'), cfg.occurrenceId, cfg.attempt)
    this.alerter = createAlerter({
      entry: cfg.entry.name,
      send: (p) => deps.sendPing(cfg.ntfy, p),
      emit: (type, data) => this.events.emit(type, data),
      now: () => deps.now()
    })
    this.tickLimit = createLimiter(() => deps.now())
    this.start = Date.parse(cfg.entry.start)
    this.end = Date.parse(cfg.entry.end)
    this.hardStop = this.end + HARD_STOP_AFTER_END_MS
    this.lecture = cfg.entry.type === 'lecture'
    const { signal } = deps
    this.aborted = new Promise<void>((resolve) => {
      if (signal?.aborted) resolve()
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  async run(): Promise<OccurrenceOutcome> {
    const { dataDir } = this.cfg
    for (const dir of ['recording', 'frames', 'errors', 'transcript'])
      await mkdir(join(dataDir, dir), { recursive: true })
    let verdict: Verdict
    try {
      verdict = await this.main()
    } catch (error) {
      verdict = await this.runFailed(error)
    }
    await this.teardown()
    const outcome: OccurrenceOutcome = {
      ...verdict,
      joinedAt: this.joinedAt?.toISOString() ?? null,
      endedAt: this.deps.now().toISOString()
    }
    await writeFileAtomic(join(dataDir, 'outcome.json'), `${JSON.stringify(outcome, null, 2)}\n`)
    // Last: the pipeline can join the segments later, so this is the one step that may be skipped for lack of time.
    await this.finishRecording()
    return outcome
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
    const run = this.step(name, fn)
    run.catch(() => undefined)
    return Promise.race([run, this.aborted.then((): typeof ABORTED => ABORTED)])
  }

  private terminated(): Verdict {
    return { result: this.joinedAt === null ? 'failed' : 'completed', endedBy: 'terminated', reason: 'terminated' }
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

  // Runs one teardown or cleanup action with a time limit and says whether it finished. The limit is the step's own,
  // cut to the time left: a step before the final checkpoint (phase 'pre') may not use the checkpoint's reserve, but
  // always gets a short slice; a later step (phase 'end') may use all that is left. A failure, a timeout or no time
  // left is reported; it never throws.
  private async bounded(
    name: string,
    ms: number,
    fn: () => Promise<unknown>,
    phase: 'pre' | 'end' = 'pre'
  ): Promise<boolean> {
    const now = Date.now()
    const endLeft = this.teardownEnd - now
    const limit = Math.min(ms, phase === 'pre' ? Math.max(this.preEnd - now, this.minSlice) : endLeft, endLeft)
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

  private get isAborted(): boolean {
    return this.deps.signal?.aborted === true
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
    if (entry.link.kind !== 'fixed') return failed('link_source_unsupported')
    const adapter = deps.adapterFor(entry.link.url)
    const url = adapter?.normaliseLink(entry.link.url) ?? null
    if (adapter === null || url === null) return failed('unsupported_link')
    this.adapter = adapter
    this.url = url

    const profile = await this.step('prepareProfile', () => setupProfile(cfg, deps))
    this.profile = profile
    const screen = await this.step('startScreen', () => deps.startScreen())
    this.screen = screen
    const browser = await this.step('launchBrowser', () => deps.launchBrowser(cfg.profileDir, screen))
    this.context = browser.context
    this.stage = browser.stage
    this.desk = browser.desk
    this.checkpoints = await this.step('startCheckpoints', () =>
      deps.startCheckpoints(cfg.profileDir, profile.checkpointsDir, profile.key, (e) =>
        this.fault('profile checkpoint', e)
      )
    )

    if (this.lecture) await this.checkFormSignIns(browser.desk)

    await this.waitUntil(this.start - JOIN_LEAD_MS)
    if (this.isAborted) return this.terminated()
    if (this.now() >= this.hardStop) return failed('past_hard_stop')

    const audio = await this.step('startAudioSource', () => deps.startAudioSource())
    this.audio = audio
    audio.onFatal((e) => this.fault('audio capture', e))
    const recorder = await this.step('startRecorder', () =>
      deps.startRecorder(screen, join(cfg.dataDir, 'recording'), cfg.attempt)
    )
    this.recorder = recorder
    this.watchRecorder(recorder)
    this.recordingStart = await this.firstRecordingStart(recorder)

    // From here the bot is in the meeting: only the join checks below are fatal. The rest is optional (see `optional`).
    const entered = await this.enter()
    if (entered) return entered
    if (this.isAborted) return this.terminated()
    const set = await this.afterJoin()
    if (set) return set
    if (this.isAborted) return this.terminated()
    await this.dismiss()
    this.participants = await this.optional('participant count', () => adapter.participantCount(this.stage!))
    await this.sendQuiet(joinedPing(entry.name, this.participants))
    await this.ev('joined', { participants: this.participants })

    if (this.isAborted) return this.terminated()
    await this.startComponents()
    return this.supervise()
  }

  private async checkFormSignIns(desk: Page): Promise<void> {
    const { cfg, deps } = this
    try {
      for (const provider of await deps.checkFormProviders(desk, cfg.identity.formProviders)) {
        this.alerter.alert('signin_forms', provider === 'google' ? 'Google' : 'Microsoft')
      }
    } catch (error) {
      // Not fatal: a meeting is worth recording without it. The ping says what is unchecked.
      this.fault('form sign-in check', error)
    }
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
    let result = await this.gotoAndJoin()
    for (;;) {
      if (result === ABORTED) return this.terminated()
      switch (result.kind) {
        case 'in_meeting':
          return this.entered()
        case 'signin_required':
          this.alerter.alert('zoom_signin')
          return failed('signin_required')
        case 'account_busy':
          this.alerter.alert('join_failed', 'the account is busy')
          return failed('account_busy')
        case 'failed':
          await this.saveFailure('join')
          this.alerter.alert('join_failed', result.reason)
          return failed(result.reason)
        case 'lobby': {
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

  private entered(): null {
    this.inMeeting = true
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
    if (this.lecture) {
      this.pinger = await this.optional('form pinger', () => {
        const pinger = deps.createFormPinger({
          cfg,
          send: (p) => deps.sendPing(cfg.ntfy, p),
          emit: async (type, data) => {
            // The pinger reports a form it could not ping as an `alert` event; the ping follows from it.
            if (type === 'alert' && data.kind === 'form_ping_failed')
              this.alerter.alert('form_ping_failed', undefined, { recorded: true })
            await this.ev(type, data)
          }
        })
        pinger.ready.catch((e: unknown) => {
          void this.report('form pinger', e)
          this.alerter.alert('form_ping_failed')
        })
        return pinger
      })
    }
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
      pinger: this.pinger
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
    else if (error instanceof AsrDisconnected || error instanceof AsrProtocolError)
      this.fault('live transcription', error)
    else void this.report('live transcription', error)
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

  // After the guest browser took over, chat capture reads the new stage. Its file keeps the rows; the pinger dedupes.
  private async restartChat(): Promise<void> {
    if (this.chat === null) return
    const old = this.chat
    this.chat = null
    await this.bounded('chat.stop', BOUND.stopChat, () => old.stop())
    // Only a rejoin gets here, and the bot is in the meeting by then: a chat that does not restart is a fault.
    this.chat = await this.optional('chat capture', () => this.openChat())
  }

  // Awaited one link at a time. A failure pings and is rethrown, so chat capture retries the delivery.
  private async offerLinks(m: ChatMessage): Promise<void> {
    const pinger = this.pinger
    if (pinger === null) return
    for (const url of m.links) {
      try {
        await pinger.offer({
          url,
          source: 'meeting_chat',
          sender: m.sender,
          senderRole: m.senderRole,
          seenAt: m.seenAt
        })
      } catch (error) {
        this.alerter.alert('form_ping_failed')
        throw error
      }
    }
  }

  // --- watching ---

  private async supervise(): Promise<Verdict> {
    for (;;) {
      if (this.isAborted) return this.terminated()
      if (this.now() >= this.hardStop) return ended('hard_stop')
      const verdict = await this.tick()
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

  // Always runs, inside the stop timeout: 50 s in all, counted from now. Order: chat sweep, leave, chat, frames, live ASR,
  // forms, recorder, audio, browser, checkpoint timer, final checkpoint, held-back alerts, screen. The checkpoint comes
  // before the work the pipeline can redo later (joining the segments, `finishRecording`), and the steps before it
  // leave it a share of the budget. It is skipped only when the browser would not close: a profile that is still open
  // could be copied half-written. A step that fails or overruns is reported without stopping the later ones.
  private async teardown(): Promise<void> {
    const budget = this.deps.teardownBudgetMs ?? TEARDOWN_BUDGET_MS
    this.teardownEnd = Date.now() + budget
    this.preEnd = this.teardownEnd - Math.min(CHECKPOINT_RESERVE_MS, budget * 0.3)
    this.minSlice = Math.min(1000, budget / 20)

    if (this.inMeeting) {
      const chat = this.chat
      if (chat) await this.bounded('chat.sweepNow', BOUND.sweep, () => chat.sweepNow())
      await this.leave()
    }
    if (this.chat) await this.bounded('chat.stop', BOUND.stopChat, () => this.chat!.stop())
    if (this.frames) await this.bounded('frames.stop', BOUND.stopFrames, () => this.frames!.stop())
    this.handler?.stop()
    await this.bounded('qr bridge', BOUND.stopQr, () => closeQr())
    if (this.asr) await this.bounded('asr.stop', BOUND.stopAsr, () => this.asr!.stop())
    if (this.pinger) await this.bounded('pinger.idle', BOUND.pinger, () => this.pinger!.idle())
    if (this.recorder) await this.bounded('recorder.stop', BOUND.stopRecorder, () => this.recorder!.stop())
    if (this.audio) await this.bounded('audio.stop', BOUND.stopAudio, () => this.audio!.stop())
    await this.closeBrowser()
    if (this.checkpoints) await this.bounded('checkpoints.stop', BOUND.stopCheckpoints, () => this.checkpoints!.stop())
    if (this.context && this.profile) {
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

  // Joins the recording's segments into the final file. The pipeline can do this later if the run has no time left.
  private async finishRecording(): Promise<void> {
    if (!this.recorder) return
    await this.bounded(
      'joinRecording',
      BOUND.join,
      () => this.deps.joinRecording(join(this.cfg.dataDir, 'recording')),
      'end'
    )
  }
}
