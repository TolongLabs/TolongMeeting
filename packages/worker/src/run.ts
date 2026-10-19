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
import { createFrameHandler } from './frames/handler'
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

// Bounds for the teardown steps. Each step that overruns is reported and the next one still runs.
const BOUND = {
  sweep: 20_000,
  leave: 15_000,
  stopChat: 10_000,
  stopFrames: 10_000,
  stopQr: 5_000,
  stopAsr: 10_000,
  pinger: 30_000,
  stopRecorder: 20_000,
  join: 300_000,
  stopAudio: 10_000,
  closeBrowser: 30_000,
  stopCheckpoints: 30_000,
  checkpoint: 120_000,
  stopScreen: 15_000
}

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

  private inMeeting = false
  private joinedAt: Date | null = null
  private region: Rect | null = null
  private participants: number | null = null
  private breakoutShown = false
  private rejoins = 0
  private badSince: number | null = null
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
    await this.alerter.idle()
    const outcome: OccurrenceOutcome = {
      ...verdict,
      joinedAt: this.joinedAt?.toISOString() ?? null,
      endedAt: this.deps.now().toISOString()
    }
    await writeFileAtomic(join(dataDir, 'outcome.json'), `${JSON.stringify(outcome, null, 2)}\n`)
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
    this.alerter.alert('component_failed', 'run supervisor')
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

  // Runs one teardown or cleanup action with a time limit. A failure or a timeout is reported; it never throws.
  private async bounded(name: string, ms: number, fn: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} did not finish within ${ms / 1000} s`)), ms)
    })
    try {
      await Promise.race([Promise.resolve().then(fn), timeout])
    } catch (error) {
      await this.report(`teardown ${name}`, error)
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
    if (this.isAborted) return failed('terminated')
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

    const entered = await this.enter()
    if (entered) return entered
    const set = await this.afterJoin()
    if (set) return set
    await this.dismiss()
    this.participants = await this.step('participantCount', () => adapter.participantCount(this.stage!))
    await this.sendQuiet(joinedPing(entry.name, this.participants))
    await this.ev('joined', { participants: this.participants })

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

  // The recording's time origin is its first attempt's start, which attempts.json holds.
  private async firstRecordingStart(recorder: Recorder): Promise<Date> {
    let text: string
    try {
      text = await readFile(join(this.cfg.dataDir, 'recording', 'attempts.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return recorder.startedAt
      throw error
    }
    const starts = AttemptsSchema.parse(JSON.parse(text)).map((a) => Date.parse(a.startedAt))
    return new Date(Math.min(recorder.startedAt.getTime(), ...starts))
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

  // Opens the link and joins. A busy Zoom account falls back to a guest browser, once.
  private async gotoAndJoin(): Promise<JoinResult> {
    const { adapter, deps, cfg } = this
    const opts = { guestName: cfg.identity.zoomGuestName }
    await this.step('goto', () =>
      this.stage!.goto(this.url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
    )
    let result = await this.step('join', () => adapter!.join(this.stage!, opts))
    if (result.kind === 'account_busy' && this.guest === null) {
      const guest = await this.step('launchGuestStage', () => deps.launchGuestStage(this.screen!))
      this.guest = guest
      this.stage = guest.stage
      await this.restartChat()
      await this.step('goto', () =>
        this.stage!.goto(this.url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
      )
      result = await this.step('join', () => adapter!.join(this.stage!, opts))
    }
    return result
  }

  // Joins until the bot is in the meeting (null) or the run must end (a verdict).
  private async enter(): Promise<Verdict | null> {
    const { adapter } = this
    let retries = 0
    let result = await this.gotoAndJoin()
    for (;;) {
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
          const admission = await Promise.race([
            this.step('waitUntilAdmitted', () => adapter!.waitUntilAdmitted(this.stage!, deadline)),
            this.aborted.then(() => 'aborted' as const)
          ])
          if (admission === 'aborted') return failed('terminated')
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

  private async devicesOn(): Promise<Verdict> {
    await this.leave()
    this.alerter.alert('devices_on')
    return failed('devices_on')
  }

  private async leave(): Promise<void> {
    await this.bounded('leave', BOUND.leave, () => this.adapter!.leave(this.stage!))
    this.inMeeting = false
  }

  private async dismiss(): Promise<void> {
    for (const text of await this.step('dismissNotices', () => this.adapter!.dismissNotices(this.stage!))) {
      await this.ev('notice_dismissed', { text })
    }
  }

  // --- capture ---

  private async startComponents(): Promise<void> {
    const { cfg, deps } = this
    if (this.lecture) {
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
      this.pinger = pinger
      pinger.ready.catch((e: unknown) => {
        void this.report('form pinger', e)
        this.alerter.alert('form_ping_failed')
      })
    }
    this.chat = await this.step('startChatCapture', () => this.openChat())
    const recordingStart = this.recordingStart!
    const handler = createFrameHandler({
      dataDir: cfg.dataDir,
      timeZone: cfg.entry.timeZone,
      recordingStart,
      lecture: this.lecture,
      region: () => this.region,
      participants: () => this.participants,
      levelDb: () => this.audio!.levelDb(1000),
      emit: this.ev,
      onAlert: (kind) => this.alerter.alert(kind),
      pinger: this.pinger
    })
    const frames = await this.step('startFrameLoop', () => deps.startFrameLoop(this.screen!, handler))
    this.frames = frames
    frames.onFatal((e) => this.fault('screen capture', e))
    if (cfg.entry.transcription === 'live') {
      const audio = this.audio!
      this.asr = await this.step('startLiveAsr', () =>
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
    this.chat = await this.step('startChatCapture', () => this.openChat())
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
      if (this.isAborted) return ended('hard_stop', 'terminated')
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

    if (state === 'unknown' || !devicesChecked) this.badSince ??= now
    else this.badSince = null
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

  // The first drop rejoins; the second stops.
  private async drop(): Promise<Verdict | null> {
    if (this.rejoins >= 1) return this.dropped()
    this.rejoins += 1
    this.badSince = null
    this.alerter.alert('dropped')
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
    return verdict.reason === 'devices_on' ? verdict : this.dropped()
  }

  private dropped(): Verdict {
    this.inMeeting = false
    this.alerter.alert('rejoin_failed')
    return failed('rejoin_failed', 'dropped')
  }

  // --- teardown ---

  // Always runs, in this order, and a step that fails or overruns is reported without stopping the later steps:
  // chat sweep, leave, chat, frames, live ASR, forms, recorder, join the segments, audio, browser, checkpoints, screen.
  private async teardown(): Promise<void> {
    if (this.inMeeting) {
      const chat = this.chat
      if (chat) await this.bounded('chat.sweepNow', BOUND.sweep, () => chat.sweepNow())
      await this.leave()
    }
    if (this.chat) await this.bounded('chat.stop', BOUND.stopChat, () => this.chat!.stop())
    if (this.frames) await this.bounded('frames.stop', BOUND.stopFrames, () => this.frames!.stop())
    await this.bounded('qr bridge', BOUND.stopQr, () => closeQr())
    if (this.asr) await this.bounded('asr.stop', BOUND.stopAsr, () => this.asr!.stop())
    if (this.pinger) await this.bounded('pinger.idle', BOUND.pinger, () => this.pinger!.idle())
    if (this.recorder) {
      await this.bounded('recorder.stop', BOUND.stopRecorder, () => this.recorder!.stop())
      await this.bounded('joinRecording', BOUND.join, () =>
        this.deps.joinRecording(join(this.cfg.dataDir, 'recording'))
      )
    }
    if (this.audio) await this.bounded('audio.stop', BOUND.stopAudio, () => this.audio!.stop())
    if (this.guest) await this.bounded('guest browser', BOUND.closeBrowser, () => this.guest!.browser.close())
    if (this.context) await this.bounded('context.close', BOUND.closeBrowser, () => this.context!.close())
    if (this.checkpoints) await this.bounded('checkpoints.stop', BOUND.stopCheckpoints, () => this.checkpoints!.stop())
    if (this.context && this.profile) {
      const { checkpointsDir, key } = this.profile
      await this.bounded('checkpointProfile', BOUND.checkpoint, () =>
        this.deps.checkpointProfile(this.cfg.profileDir, checkpointsDir, key)
      )
    }
    if (this.screen) await this.bounded('screen.stop', BOUND.stopScreen, () => this.screen!.stop())
  }
}
