import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompanionJob, NativeJobPayload } from '@tm/core'
import { CompanionApiError, DeviceRevokedError, MAX_AUDIO_BYTES, type CompanionApi } from '../api'
import type { KeepAwake } from '../keep-awake'
import type { DesktopNotifier } from '../notifier'
import type { Settings } from '../settings'
import { buildWhisperArgv, collectOutputs, runWhisper, whisperTimeoutMs, type SpawnLike } from './whisper'

/** FLAC audio of one second takes far less than this (48 kHz mono, 16 bit, uncompressed, is 96 000 bytes). */
const AUDIO_BYTES_PER_SECOND = 192_000
const AUDIO_SLACK_BYTES = 16 * 1024 ** 2

/** The most a recording of `durationSec` may weigh when downloaded: its length at a generous rate, never above the ceiling. */
export function audioLimitBytes(durationSec: number): number {
  return Math.min(MAX_AUDIO_BYTES, Math.ceil(durationSec * AUDIO_BYTES_PER_SECOND) + AUDIO_SLACK_BYTES)
}

type NativeJob = CompanionJob & { kind: 'native_transcription'; payload: NativeJobPayload }

export interface NativeRunnerDeps {
  api: Pick<CompanionApi, 'claim' | 'progress' | 'fail' | 'downloadAudio' | 'uploadTranscript'> & {
    /** Hands a claimed job back at once (08 Task 3's endpoint). Without it a paused job returns when its lease lapses. */
    release?(jobId: string): Promise<void>
  }
  settings: () => Settings
  /** Under the app's own data folder. Each job gets a fresh folder here, deleted when the job ends. */
  jobsDir: string
  keepAwake: KeepAwake
  spawn: SpawnLike
  notifier: DesktopNotifier
  openSettings(): void
  /** How often the job lease is renewed. Default 60000. */
  progressMs?: number
  /** Wait between upload attempts. Default 60000. */
  uploadRetryMs?: number
  /** Time allowed for the transcriber. Default `whisperTimeoutMs`. */
  timeoutMs?: (durationSec: number) => number
  /** Gets anything the runner did not expect. Default: `console.error`. */
  onError?: (error: unknown) => void
}

const isNative = (job: CompanionJob): job is NativeJob => job.kind === 'native_transcription'

/** The website no longer lets this PC work on the job, or no longer knows this PC. */
function isLost(e: unknown): boolean {
  return e instanceof DeviceRevokedError || (e instanceof CompanionApiError && (e.status === 404 || e.status === 409))
}

/** A failure worth trying again: the network, a timeout, or a server error. */
function isTransient(e: unknown): boolean {
  if (e instanceof CompanionApiError) return e.status >= 500 || e.status === 408 || e.status === 429
  return (
    e instanceof TypeError || (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'NetworkError'))
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Runs one native transcription job at a time: claim, keep the PC awake, download the FLAC, run the member's
 * transcriber, upload `txt`, `srt` and `json`, delete the job folder. Reports carry fixed sentences and the last line
 * of the transcriber's error with paths removed; never a path or transcript text.
 */
export class NativeRunner {
  private working = false
  private stopped = false
  private paused = false
  private claimedJob: NativeJob | null = null
  private notified = false
  private current: Promise<void> = Promise.resolve()
  private abort: AbortController | null = null

  constructor(private readonly d: NativeRunnerDeps) {}

  get busy(): boolean {
    return this.working
  }

  /** Claims one pending native job from `jobs` when idle. Does nothing while a job runs. */
  offer(jobs: CompanionJob[]): void {
    if (this.working || this.stopped || this.paused) return
    const pending = jobs.filter((j): j is NativeJob => isNative(j) && j.state === 'pending')
    if (pending.length === 0) return
    if (this.d.settings().whisper.cwd === null) {
      this.notifyOnce()
      return
    }
    this.working = true
    const ctl = new AbortController()
    this.abort = ctl
    this.current = this.claimAndRun(pending, ctl)
      .catch((e: unknown) => (this.d.onError ?? ((err) => console.error(err)))(e))
      .finally(() => {
        this.working = false
        this.abort = null
      })
  }

  /** Stops the running job, if any: the transcriber and its children end, the folder goes, the PC may sleep again. */
  async stop(): Promise<void> {
    this.stopped = true
    this.abort?.abort()
    await this.current
  }

  /**
   * Makes room for a local meeting (ASR-02: never both at once): the transcriber and its children end, the job folder
   * goes, the claimed job is handed back, and `offer` takes no new job until `resume`. Nothing is reported as failed.
   */
  async pause(): Promise<void> {
    this.paused = true
    this.abort?.abort()
    await this.current
    const job = this.claimedJob
    this.claimedJob = null
    if (job === null || this.d.api.release === undefined) return
    try {
      await this.d.api.release(job.id)
    } catch (e) {
      if (!isLost(e)) throw e
    }
  }

  /** Lets `offer` take jobs again. The job paused earlier is offered again by the next poll. */
  resume(): void {
    this.paused = false
  }

  private notifyOnce(): void {
    if (this.notified) return
    this.notified = true
    this.d.notifier.show(
      {
        title: 'Set up native transcription',
        body: 'A meeting is waiting to be transcribed. Click to choose your whisper-transcriber folder.',
        sticky: false,
        buttons: []
      },
      { click: () => this.d.openSettings(), action: () => {} }
    )
  }

  private async claimAndRun(candidates: NativeJob[], ctl: AbortController): Promise<void> {
    let job: NativeJob | null = null
    for (const candidate of candidates) {
      if (ctl.signal.aborted) return
      const claimed = await this.d.api.claim(candidate.id)
      if (claimed !== null && isNative(claimed)) {
        job = claimed
        break
      }
    }
    if (job === null) return
    this.claimedJob = job

    const release = this.d.keepAwake.acquire(job.id)
    try {
      const dir = join(this.d.jobsDir, job.id)
      const ticker = setInterval(() => void this.renew(job, ctl), this.d.progressMs ?? 60_000)
      try {
        await this.runJob(job, dir, ctl)
        // Done or reported: nothing to hand back. A run cut short by `pause` or `stop` keeps its claim.
        if (!ctl.signal.aborted) this.claimedJob = null
      } finally {
        clearInterval(ticker)
        await rm(dir, { recursive: true, force: true })
      }
    } finally {
      release()
    }
  }

  private renewing = false
  /** Renews the lease. A job the website took back, or an unpaired PC, ends the run without a report. */
  private async renew(job: NativeJob, ctl: AbortController): Promise<void> {
    if (this.renewing) return
    this.renewing = true
    try {
      await this.d.api.progress(job.id)
    } catch (e) {
      if (isLost(e)) ctl.abort()
      else (this.d.onError ?? ((err) => console.error(err)))(e)
    } finally {
      this.renewing = false
    }
  }

  /** Tells the website the job failed. A job it no longer gives us needs no report. */
  private async report(job: NativeJob, error: string): Promise<void> {
    try {
      await this.d.api.fail(job.id, error)
    } catch (e) {
      if (!isLost(e)) throw e
    }
  }

  private async runJob(job: NativeJob, dir: string, ctl: AbortController): Promise<void> {
    const { signal } = ctl
    const settings = this.d.settings()
    const cwd = settings.whisper.cwd
    if (cwd === null) return await this.report(job, 'The whisper folder is not set')

    // A fresh folder, private to this app.
    await rm(dir, { recursive: true, force: true })
    await mkdir(this.d.jobsDir, { recursive: true, mode: 0o700 })
    await mkdir(dir, { mode: 0o700 })
    const outDir = join(dir, 'out')
    await mkdir(outDir, { mode: 0o700 })
    const audio = join(dir, 'audio.flac')

    try {
      await this.d.api.downloadAudio(job.id, audio, signal, audioLimitBytes(job.payload.durationSec))
    } catch (e) {
      if (signal.aborted || isLost(e)) return
      ;(this.d.onError ?? ((err) => console.error(err)))(e)
      return await this.report(job, 'The PC could not download the recording')
    }
    if (signal.aborted) return

    let argv: string[]
    try {
      argv = buildWhisperArgv(settings.whisper.command, { audio, model: settings.whisper.model, outDir })
    } catch (e) {
      if (!(e instanceof Error)) throw e
      return await this.report(job, e.message)
    }
    const ran = await runWhisper({
      argv,
      cwd,
      timeoutMs: (this.d.timeoutMs ?? whisperTimeoutMs)(job.payload.durationSec),
      spawn: this.d.spawn,
      signal
    })
    if (signal.aborted) return
    if (!ran.ok) return await this.report(job, ran.error)

    const outputs = await collectOutputs(outDir)
    if (!outputs.ok) return await this.report(job, outputs.error)
    await this.upload(job, outputs.files, signal)
  }

  /** Uploads until the website accepts it, the job is lost, or the runner stops. The FLAC stays until then. */
  private async upload(
    job: NativeJob,
    files: { txt: string; srt: string; json: string },
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const sent = this.d.api.uploadTranscript(job.id, files)
        sent.catch(() => {})
        const aborted = new Promise<'aborted'>((resolve) =>
          signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        )
        await Promise.race([sent, aborted])
        return
      } catch (e) {
        if (signal.aborted || isLost(e)) return
        if (!isTransient(e)) {
          if (e instanceof CompanionApiError) return await this.report(job, 'The website refused the transcript')
          throw e
        }
      }
      await sleep(this.d.uploadRetryMs ?? 60_000, signal)
    }
  }
}
