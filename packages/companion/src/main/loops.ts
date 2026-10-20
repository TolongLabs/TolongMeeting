import { existsSync } from 'node:fs'
import type { CompanionJob } from '@tm/core'
import { CompanionApi, DeviceRevokedError, type CompanionApiOptions } from '../api'
import { reconnectDelayMs } from '../backoff'
import { handleRevoked } from '../pairing'
import type { KeepAwake } from '../keep-awake'
import { startNtfySubscriber, toDisplay, type NtfySubscriberDeps } from '../ntfy'
import type { DesktopNotifier } from '../notifier'
import type { SecretStore } from '../secrets'
import { startCommandStream, type CommandStreamDeps } from '../sse'
import type { Settings } from '../settings'
import type { StateStore } from '../state'
import { showSummaryNotification, syncSummaries, type SummarySyncDeps } from '../summaries'
import { NativeRunner, type NativeRunnerDeps } from '../jobs/native-runner'
import { startJobPoller, type JobPollerDeps } from '../jobs/poller'
import { nodeSpawn, type SpawnLike } from '../jobs/whisper'
import type { DockerLike } from '../local/docker'
import { resumeLocalRuns } from '../local/resume'
import { localAfter } from '../local/run'
import type { ShellPort } from './ports'

/** Something that runs until it is stopped. The runner's `stop` waits for its job to let go. */
interface Stoppable {
  stop(): void | Promise<void>
}

/** What the loops use of the native runner. */
type NativeRunnerLike = Stoppable & Pick<NativeRunner, 'busy' | 'offer' | 'pause' | 'resume'>

/** The loops and helpers this module wires. Tests replace them with fakes; the app uses the real ones. */
export interface LoopImpl {
  makeApi(o: CompanionApiOptions): CompanionApi
  startNtfy(d: NtfySubscriberDeps): Stoppable
  startStream(d: CommandStreamDeps): Stoppable
  startPoller(d: JobPollerDeps): Stoppable & { trigger(): void }
  makeRunner(d: NativeRunnerDeps): NativeRunnerLike
  sync(d: SummarySyncDeps): Promise<string[]>
}

const REAL: LoopImpl = {
  makeApi: (o) => new CompanionApi(o),
  startNtfy: startNtfySubscriber,
  startStream: startCommandStream,
  startPoller: startJobPoller,
  makeRunner: (d) => new NativeRunner(d),
  sync: syncSummaries
}

export interface LoopsDeps {
  settings: Settings
  state: StateStore
  secrets: SecretStore
  notifier: DesktopNotifier
  keepAwake: KeepAwake
  shell: ShellPort
  /** The folder for per-job scratch space, under the app's own data. */
  jobsDir: string
  /** Opens the pairing window. TODO(figma-gate): until the window exists the caller logs instead. */
  openPairing(): void
  /** Opens the settings window. TODO(figma-gate): until the window exists the caller logs instead. */
  openSettings(): void
  /** Reports a crash or a failure. Never gets a token or a transcript. Default: `console.error`. */
  onError?(error: Error): void
  spawn?: SpawnLike
  /**
   * Local runs (plan 08). When set, the first poll after a start finishes the local meetings a restart cut off
   * (`resumeLocalRuns`). Nothing of this runs before the PC is paired.
   */
  local?: {
    docker: DockerLike
    /** The data root: the folder that holds `occurrences/`. */
    dataDir: string
    /** Only a worker image under this repository cuts the audio (the app's `TM_WORKER_IMAGE_PREFIX`). */
    imagePrefix: string
    /** Wait between tries of a failed upload request. Default 60000. */
    retryMs?: number
    chunkBytes?: number
  }
  impl?: Partial<LoopImpl>
  /** Test seam: the wait before restarting a loop that crashed on start, by attempt. Default `reconnectDelayMs`. */
  restartDelayMs?: (attempt: number) => number
}

type LoopName = 'ntfy' | 'stream' | 'poller'

/**
 * Runs the companion's headless loops: the ntfy subscriber, the command stream, the job poller and the native runner,
 * plus the summary sync. Start order: ntfy, command stream, runner, poller (the poller needs the runner at once, so it
 * starts last). Stop order is the reverse. A 401 "revoked" from any call stops every loop, clears the secrets and says
 * so once. A loop that throws while starting is reported and started again with backoff; the others keep running.
 */
export class Loops {
  private readonly impl: LoopImpl
  private readonly report: (e: Error) => void
  private api: CompanionApi | null = null
  private ntfy: Stoppable | null = null
  private stream: Stoppable | null = null
  private runner: NativeRunnerLike | null = null
  /** Aborted when the loops stop (quit or unpair): an upload in progress ends and its files stay. */
  private halt = new AbortController()
  private resumed = false
  private resuming: Promise<void> | null = null
  private poller: (Stoppable & { trigger(): void }) | null = null
  private readonly restarts = new Map<LoopName, ReturnType<typeof setTimeout>>()
  private readonly attempts = new Map<LoopName, number>()
  private running = false
  private revokedOnce = false
  private stopping: Promise<void> | null = null
  private syncing = false
  private syncAgain = false

  constructor(private readonly d: LoopsDeps) {
    this.impl = { ...REAL, ...d.impl }
    this.report = d.onError ?? ((e) => console.error(e))
  }

  /** Whether this PC holds a device token. */
  async paired(): Promise<boolean> {
    return (await this.d.secrets.get('deviceToken')) !== null
  }

  /** Starts every loop when this PC is paired. Returns whether it did. */
  async start(): Promise<boolean> {
    if (this.running || !(await this.paired())) return false
    this.running = true
    this.revokedOnce = false
    this.stopping = null
    this.halt = new AbortController()
    this.resumed = false
    this.resuming = null
    this.api = this.impl.makeApi({
      serverUrl: this.d.settings.serverUrl,
      token: () => this.d.secrets.get('deviceToken'),
      onRevoked: () => this.revoked()
    })
    await this.launch('ntfy')
    await this.launch('stream')
    this.runner = this.impl.makeRunner({
      api: this.api,
      settings: () => this.d.settings,
      jobsDir: this.d.jobsDir,
      keepAwake: this.d.keepAwake,
      spawn: this.d.spawn ?? nodeSpawn,
      notifier: this.d.notifier,
      openSettings: () => this.d.openSettings(),
      onError: (e) => this.fail('the native runner', e)
    })
    await this.launch('poller')
    this.requestSync()
    return true
  }

  /** Stops every loop in reverse order and waits until the runner has let go of its job and the PC may sleep. */
  stop(): Promise<void> {
    this.running = false
    this.halt.abort()
    this.stopping ??= this.stopAll()
    return this.stopping
  }

  /** Asks for a summary sync now. Calls made during a sync run it again once, never two at a time. */
  requestSync(): void {
    if (!this.running || this.api === null) return
    if (this.syncing) {
      this.syncAgain = true
      return
    }
    this.syncing = true
    void this.syncLoop(this.api).finally(() => {
      this.syncing = false
    })
  }

  private fail(what: string, e: unknown): void {
    if (e instanceof DeviceRevokedError) return void this.revoked()
    this.report(new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** The website unpaired this PC: forget the tokens, stop every loop, say so once. */
  private revoked(): void {
    if (this.revokedOnce) return
    this.revokedOnce = true
    this.running = false
    handleRevoked({
      secrets: this.d.secrets,
      stopAll: () => void this.stop(),
      notifier: this.d.notifier,
      openPairing: () => this.d.openPairing()
    }).catch((e: unknown) => this.fail('could not handle the unpairing', e))
  }

  private async syncLoop(api: CompanionApi): Promise<void> {
    do {
      this.syncAgain = false
      try {
        const written = await this.impl.sync({ api, dir: this.d.settings.summariesDir, state: this.d.state })
        for (const path of written) {
          showSummaryNotification(path, this.d.settings.summariesDir, {
            notifier: this.d.notifier,
            openPath: async (p) => {
              try {
                await this.d.shell.openPath(p)
                return ''
              } catch (e) {
                this.fail('could not open a summary', e)
                return 'failed'
              }
            },
            exists: existsSync
          })
        }
      } catch (e) {
        this.fail('the summary sync failed', e)
      }
    } while (this.syncAgain && this.running)
  }

  /** Starts one loop. A throw on start is reported and retried after a backoff wait. */
  private async launch(name: LoopName): Promise<void> {
    if (!this.running || this.api === null) return
    try {
      await this.begin(name, this.api)
      this.attempts.set(name, 0)
    } catch (e) {
      this.fail(`the ${name} loop crashed`, e)
      const attempt = this.attempts.get(name) ?? 0
      this.attempts.set(name, attempt + 1)
      const wait = this.d.restartDelayMs ?? ((n: number) => reconnectDelayMs(n))
      const timer = setTimeout(() => {
        this.restarts.delete(name)
        void this.launch(name)
      }, wait(attempt))
      this.restarts.set(name, timer)
    }
  }

  private async begin(name: LoopName, api: CompanionApi): Promise<void> {
    const onError = (e: Error) => this.fail(`the ${name} loop`, e)
    if (name === 'ntfy') {
      const ntfy = this.d.state.get().ntfy
      const token = await this.d.secrets.get('ntfyToken')
      if (ntfy === undefined || token === null) throw new Error('this PC has no ntfy address or token; pair it again')
      this.ntfy = this.impl.startNtfy({
        cfg: { url: ntfy.url, topic: ntfy.topic, token },
        state: this.d.state,
        onMessage: (m) => this.show(toDisplay(m, new Date())),
        onError
      })
    } else if (name === 'stream') {
      this.stream = this.impl.startStream({
        api,
        state: this.d.state,
        onEvent: (e) => {
          // `open_signin` and `local_identities_changed` belong to local mode (plan 08).
          if (e.command.type === 'job_available') this.poller?.trigger()
        },
        // A reconnect may have missed a summary, so sync after every open.
        onStatus: (open) => {
          if (open) this.requestSync()
        },
        onError,
        onRevoked: () => this.revoked()
      })
    } else {
      const runner = this.runner
      if (runner === null) throw new Error('the native runner is not ready')
      this.poller = this.impl.startPoller({
        api,
        onJobs: (jobs) => {
          this.resumeLocal(api, runner, jobs)
          runner.offer(jobs)
        },
        busy: () => runner.busy,
        onError,
        onRevoked: () => this.revoked()
      })
    }
  }

  /**
   * Once per start, with the first jobs list that works: finishes the local meetings a restart cut off. It runs beside
   * the poller, so a long upload never blocks the job list. It takes the native runner first (ASR-02).
   */
  private resumeLocal(api: CompanionApi, runner: NativeRunnerLike, jobs: CompanionJob[]): void {
    const local = this.d.local
    if (local === undefined || this.resumed || this.resuming !== null || !this.running) return
    const signal = this.halt.signal
    const after = localAfter({
      api,
      docker: local.docker,
      imagePrefix: local.imagePrefix,
      settings: () => this.d.settings,
      spawn: this.d.spawn ?? nodeSpawn,
      retryMs: local.retryMs,
      chunkBytes: local.chunkBytes,
      signal
    })
    this.resuming = resumeLocalRuns({
      jobs,
      docker: local.docker,
      dataDir: local.dataDir,
      after,
      keepAwake: this.d.keepAwake,
      native: runner,
      signal,
      onError: (_job, e) => this.fail('a local meeting could not be sent', e)
    })
      .then((done) => {
        this.resumed = done
      })
      .catch((e: unknown) => this.fail('the local meetings could not be resumed', e))
      .finally(() => {
        this.resuming = null
      })
  }

  /** Shows a ntfy message. A click or button opens its link only if it is still an https link. */
  private show(display: ReturnType<typeof toDisplay>): void {
    if (display.kind === 'sync_summaries') return this.requestSync()
    if (display.kind === 'ignore') return
    const open = (url: string | null) => {
      if (url === null || new URL(url).protocol !== 'https:') return
      this.d.shell.openExternal(url).catch((e: unknown) => this.fail('could not open a link', e))
    }
    this.d.notifier.show(
      {
        title: display.title,
        body: display.body,
        sticky: display.sticky,
        buttons: display.buttons.map((b) => b.label)
      },
      { click: () => open(display.clickUrl), action: (i) => open(display.buttons[i]?.url ?? null) }
    )
  }

  private async stopAll(): Promise<void> {
    for (const timer of this.restarts.values()) clearTimeout(timer)
    this.restarts.clear()
    const loops = [this.runner, this.poller, this.stream, this.ntfy]
    this.runner = this.poller = this.stream = this.ntfy = null
    // The runner is asked first and waited for last: it ends its job and lets the PC sleep again meanwhile.
    const runnerDone = (async () => loops[0]?.stop())().catch((e: unknown) => this.fail('the runner did not stop', e))
    for (const loop of loops.slice(1)) {
      try {
        await loop?.stop()
      } catch (e) {
        this.fail('a loop did not stop cleanly', e)
      }
    }
    await runnerDone
    await this.resuming
  }
}
