import { mkdir } from 'node:fs/promises'
import {
  controlTokenHash,
  vncSecret,
  type CompanionJob,
  type ControlCommand,
  type LocalSecrets,
  type NtfyConfig
} from '@tm/core'
import { CompanionApiError, type CompanionApi } from '../api'
import { writeFileAtomic } from '../atomic'
import type { KeepAwake } from '../keep-awake'
import type { NativeRunner } from '../jobs/native-runner'
import type { SecretStore } from '../secrets'
import type { StateStore } from '../state'
import {
  holderArgs,
  holderName,
  LOCAL_NETWORK,
  localJobConfig,
  machineIdFile,
  machineIdFor,
  NOVNC_PORT,
  workerArgs,
  workerName
} from './containers'
import { finishLocalRun, localReporter, type AfterApi, type AfterDeps } from './after'
import type { DockerLike } from './docker'
import { removeAfterFirstHeartbeat, writeEphemeral, type Ephemeral } from './ephemeral'
import { preflight } from './preflight'
import type { Relay } from './relay'
import {
  checkpointsDir,
  checkpointVolume,
  ensureProfileKey,
  identityKeyFile,
  profileVolume,
  type LocalPaths
} from './vault'

export { LOCAL_NETWORK } from './containers'
export const MAX_LOCAL_ATTEMPTS = 4 // the first run and up to 3 restarts
export const SILENCE_RESTART_MS = 30_000
/** `docker stop -t` for a worker: it stops its recording and checkpoints the profile. */
export const WORKER_STOP_SECONDS = 60
/** `docker stop -t` for a worker that went quiet: it is not answering, so it is not given long. */
export const SILENT_STOP_SECONDS = 10
const RESTART_NOTICE_MS = 5000
/** The one line `deny-private.sh --hold` prints to stdout, after every rule is in and checked and just before it sleeps. */
export const HOLDER_READY_LINE = 'deny-private: ready'
const HOLDER_READY_MS = 30_000
const HOLDER_POLL_MS = 200
const PREFLIGHT_RETRY_MS = 30_000
const HOST_PREFIX = 'tm-net-'

export type LocalOutcome = 'ended' | 'crashed'

/** What `localAfter` needs; `report` is made per job. */
export type LocalAfterDeps = Omit<AfterDeps, 'report' | 'api'> & { api: AfterApi }

/**
 * The runner's `after` hook: send the finished run to the website, transcribe it when it is a native meeting, and
 * delete the local copy (`finishLocalRun`). `dataDir` is the data root (the folder that holds `occurrences/`). A stop
 * through `signal` (the app is quitting or unpaired) ends it quietly and leaves the files for the next start.
 */
export function localAfter(d: LocalAfterDeps): LocalRunnerDeps['after'] {
  return async (job, dataDir, outcome) => {
    if (job.kind !== 'local_run') throw new Error('Not a local run job')
    try {
      await finishLocalRun({ ...d, report: localReporter(d.api, job, dataDir) }, job, dataDir, outcome)
    } catch (e) {
      if (d.signal?.aborted && e instanceof DOMException && e.name === 'AbortError') return
      throw e
    }
  }
}

/** What a local run asks of the website. `CompanionApi` gains `secrets` with the local-run endpoints (08 Task 3). */
export type LocalRunApi = Pick<CompanionApi, 'claim' | 'preflight' | 'fail'> & {
  secrets(jobId: string): Promise<LocalSecrets>
}

export interface LocalRunnerDeps {
  api: LocalRunApi
  docker: DockerLike
  secrets: SecretStore
  state: StateStore
  paths: LocalPaths
  keepAwake: Pick<KeepAwake, 'acquire'>
  native: Pick<NativeRunner, 'pause' | 'resume'>
  ntfy: () => Promise<NtfyConfig>
  /** Starts the loopback relay for one run (`startRelay` over `serverHeartbeatApi`). */
  relay: (o: { jobId: string; occurrenceId: string }) => Promise<Relay>
  /** Gets the data root (`paths.data`); the run's files are in `<dataDir>/occurrences/<occurrenceId>`. */
  after: (job: CompanionJob, dataDir: string, outcome: LocalOutcome) => Promise<void>
  /** Retry wait while Docker is not ready. Default 30000. */
  preflightRetryMs?: number
  /** Only images under this repository run (the app's `TM_WORKER_IMAGE_PREFIX`). */
  imagePrefix?: string
  /** No heartbeat for this long counts as a crash. Default `SILENCE_RESTART_MS`. */
  silenceMs?: number
  /** How often the silence check looks. Default 1000. */
  tickMs?: number
  /** How long a new network holder has to print `HOLDER_READY_LINE` before the run fails. Default 30000. */
  holderReadyMs?: number
  /** How often the holder's logs are read while waiting for that line. Default 200. */
  holderPollMs?: number
  /** Time between "restarting" reports. Default 5000. */
  restartNoticeMs?: number
  /** How long the short-lived files may stay when no heartbeat arrives. Default 120000. */
  ephemeralMaxMs?: number
  now?: () => number
  /** Gets what the runner cannot act on. Default: `console.error`. */
  onError?: (error: unknown) => void
}

interface Active {
  job: CompanionJob & { kind: 'local_run' }
  identityId: string
  stop: AbortController
  stopRequested: boolean
  relay: Relay | null
  vncPort: number | null
  holder: string | null
  holderGen: number
  holderGone: boolean
  holderExit: Promise<void>
  worker: string | null
  eph: Ephemeral | null
  resumedAt: number | null
  volumeUsed: boolean
}

type Ended = { kind: 'exit'; code: number } | { kind: 'error'; error: unknown }

/** Resolves after `ms`, or at once when `signal` aborts. The timer is always cleared. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** The website no longer wants this run: the job is gone (404). */
const isCancelled = (e: unknown): boolean => e instanceof CompanionApiError && e.status === 404

/**
 * Runs a local meeting in Docker Desktop: claim, preflight, secrets, a network holder with the egress rules, the worker
 * (restarted up to three times after a crash), then the profile checkpoint when the run did not end cleanly and the
 * removal of everything it made. The control token, the AI key and the profile key reach the worker only as files in a
 * per-run folder that is deleted at the first heartbeat; the job itself is told by the relay, never by argv.
 */
export class LocalRunner {
  private active: Active | null = null
  private current: Promise<void> = Promise.resolve()

  constructor(private readonly d: LocalRunnerDeps) {}

  /** The identity whose profile a run is using now. */
  activeIdentity(): string | null {
    return this.active?.identityId ?? null
  }

  /** Queues a command for the running worker (delivered in its next heartbeat reply). False when no run holds it. */
  inject(identityId: string, c: ControlCommand): boolean {
    const a = this.active
    if (a === null || a.relay === null || a.identityId !== identityId) return false
    // A member who stops the meeting or leaves it must not see it rejoin as a "restart".
    if (c === 'stop' || c === 'leave_now') a.stopRequested = true
    a.relay.inject(c)
    return true
  }

  /** The loopback port that serves the worker's noVNC desk, once the holder is up. */
  noVncPort(identityId: string): number | null {
    const a = this.active
    return a !== null && a.identityId === identityId ? a.vncPort : null
  }

  /** The password of the running meeting's desk view (the worker derives the same one), or null when no run of this identity is up. */
  deskPassword(identityId: string): string | null {
    const a = this.active
    return a !== null && a.relay !== null && a.identityId === identityId
      ? vncSecret(controlTokenHash(a.relay.token))
      : null
  }

  /** The PC woke from sleep: the workers get a fresh silence window before they count as crashed. */
  resumed(): void {
    if (this.active !== null) this.active.resumedAt = this.now()
  }

  /** Stops the run (app quit): the worker gets `docker stop -t 60`, no restart follows, cleanup finishes. */
  async stop(): Promise<void> {
    this.active?.stop.abort()
    await this.current
  }

  /** Runs one claimed or claimable `local_run` job to the end. Rejects after cleanup when something broke. */
  run(job: CompanionJob): Promise<void> {
    if (job.kind !== 'local_run') return Promise.reject(new Error('Not a local run job'))
    if (this.active !== null) return Promise.reject(new Error('A local run is already active'))
    const a: Active = {
      job,
      identityId: job.payload.identityId,
      stop: new AbortController(),
      stopRequested: false,
      relay: null,
      vncPort: null,
      holder: null,
      holderGen: 0,
      holderGone: false,
      holderExit: Promise.resolve(),
      worker: null,
      eph: null,
      resumedAt: null,
      volumeUsed: false
    }
    this.active = a
    const done = this.execute(a)
    this.current = done.catch(() => {})
    return done
  }

  private now(): number {
    return (this.d.now ?? Date.now)()
  }

  private onError(e: unknown): void {
    ;(this.d.onError ?? ((err) => console.error(err)))(e)
  }

  private async execute(a: Active): Promise<void> {
    const { api, docker } = this.d
    const errors: unknown[] = []
    const step = async (f: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        await f()
      } catch (e) {
        errors.push(e)
      }
    }
    // Held in one object: the steps below assign it from inside `body`, and the cleanup reads it after.
    const st: {
      nativePaused: boolean
      releaseAwake: (() => void) | null
      notices: { stop(): Promise<void> } | null
      lastCode: number | null
      completed: boolean
      localKey: Buffer | null
    } = { nativePaused: false, releaseAwake: null, notices: null, lastCode: null, completed: false, localKey: null }
    let failure: { error: unknown } | null = null
    const body = async (): Promise<void> => {
      const claimed = await api.claim(a.job.id)
      if (claimed === null || claimed.kind !== 'local_run') return
      const job = claimed
      a.job = job
      if (!(await this.dockerReady(job, a.stop.signal))) return

      const secrets = await api.secrets(job.id)
      const ntfy = await this.d.ntfy()
      st.localKey = await ensureProfileKey(this.d.secrets)
      st.nativePaused = true
      await this.d.native.pause()
      st.releaseAwake = this.d.keepAwake.acquire(job.payload.occurrenceId)
      await this.clearIdentity(a.identityId)
      await docker.ensureNetwork(LOCAL_NETWORK)
      const paths = this.d.paths
      await mkdir(paths.data, { recursive: true })
      await mkdir(paths.runs, { recursive: true })
      await mkdir(checkpointsDir(paths, a.identityId), { recursive: true })
      await writeFileAtomic(machineIdFile(paths, a.identityId), `${machineIdFor(a.identityId)}\n`, 0o644)
      a.relay = await this.d.relay({ jobId: job.id, occurrenceId: job.payload.occurrenceId })
      await this.startHolder(a)

      for (let attempt = 1; attempt <= MAX_LOCAL_ATTEMPTS; attempt++) {
        if (a.holderGone) await this.startHolder(a)
        st.lastCode = await this.attempt(a, attempt, secrets, ntfy, st.localKey)
        await st.notices?.stop()
        st.notices = null
        if (st.lastCode === 0 || a.stopRequested || a.stop.signal.aborted || attempt === MAX_LOCAL_ATTEMPTS) break
        st.notices = await this.restartNotices(a, attempt + 1)
      }
      st.completed = true
    }
    try {
      await body()
    } catch (e) {
      failure = { error: e }
    }

    // Cleanup runs on every way out. Each step is tried even when an earlier one failed; the failures are thrown after.
    const job = a.job
    await step(() => st.notices?.stop())
    if (a.worker !== null) {
      const name = a.worker
      await step(() => docker.stop(name, WORKER_STOP_SECONDS))
      await step(() => docker.rm(name))
    }
    const clean = st.completed && st.lastCode === 0
    let saved = true
    if (a.volumeUsed && !clean && st.localKey !== null) {
      saved = false
      const key = st.localKey
      await step(async () => {
        await checkpointVolume({ docker, image: job.payload.image, paths: this.d.paths, localKey: key }, a.identityId)
        saved = true
      })
    }
    const holder = a.holder
    if (holder !== null) await step(() => docker.rm(holder))
    if (a.volumeUsed && saved) await step(() => docker.volumeRm(profileVolume(a.identityId)))
    const relay = a.relay
    if (relay !== null) await step(() => relay.close())
    await step(() => a.eph?.remove())
    if (st.completed) {
      await step(() => this.d.after(job, this.d.paths.data, st.lastCode === 0 ? 'ended' : 'crashed'))
    }
    if (failure !== null) {
      await step(() => api.fail(job.id, 'The PC could not run the meeting'))
    }
    st.releaseAwake?.()
    if (st.nativePaused) await step(() => Promise.resolve(this.d.native.resume()))
    this.active = null

    if (failure !== null) {
      for (const e of errors) this.onError(e)
      throw failure.error
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'The local run could not clean up')
  }

  /**
   * Asks Docker whether a worker can start and tells the website. Not ready yet (Docker off, image missing): ask again
   * after `preflightRetryMs`. Too little memory, a cancelled job or a stop request: give up.
   */
  private async dockerReady(job: CompanionJob & { kind: 'local_run' }, signal: AbortSignal): Promise<boolean> {
    const retryMs = this.d.preflightRetryMs ?? PREFLIGHT_RETRY_MS
    while (!signal.aborted) {
      const report = await preflight(
        this.d.docker,
        job.payload.image,
        this.d.imagePrefix === undefined ? {} : { imagePrefix: this.d.imagePrefix }
      )
      try {
        await this.d.api.preflight(job.id, report)
      } catch (e) {
        if (isCancelled(e)) return false
        throw e
      }
      if (report.reason === 'ok') return true
      if (report.reason === 'docker_memory_low') return false
      await sleep(retryMs, signal)
    }
    return false
  }

  /**
   * One container per identity may hold the profile. Anything of this identity that is still up (an open sign-in view,
   * or what an earlier crash of this app left behind) is stopped first: a worker gets its 60 seconds to checkpoint, a
   * network holder only sleeps and is removed at once.
   */
  private async clearIdentity(identityId: string): Promise<void> {
    const { docker } = this.d
    for (const c of await docker.running()) {
      if (c.identityId !== identityId) continue
      if (!c.name.startsWith(HOST_PREFIX)) await docker.stop(c.name, WORKER_STOP_SECONDS)
      await docker.rm(c.name)
    }
  }

  /**
   * Starts the network holder and waits until it says its rules are in: `deny-private.sh --hold` prints
   * `HOLDER_READY_LINE` to stdout only after every rule is installed and read back, and exits non-zero (printing
   * nothing to stdout) when any step fails. A worker joins the namespace only after this line. If the holder exits,
   * the logs cannot be read, or the deadline passes, this throws: the run fails closed, the cleanup removes the
   * holder, and no worker starts.
   */
  private async startHolder(a: Active): Promise<void> {
    const { docker } = this.d
    const relay = a.relay
    if (relay === null) throw new Error('The relay must be up before the holder starts')
    const scope = a.job.payload.occurrenceId
    const name = holderName(scope)
    await docker.rm(name)
    a.holder = name
    a.holderGone = false
    const gen = ++a.holderGen
    await docker.run(
      holderArgs({
        scope,
        identityId: a.identityId,
        image: a.job.payload.image,
        allowTcp: [`host.docker.internal:${relay.port}`]
      })
    )
    // A wait that fails is read as "gone": the worker must not trust a holder it cannot see.
    a.holderExit = docker.wait(name).then(
      () => undefined,
      () => undefined
    )
    void a.holderExit.then(() => {
      if (gen === a.holderGen) a.holderGone = true
    })
    await this.holderReady(a, name)
    a.vncPort = await docker.port(name, NOVNC_PORT)
  }

  /**
   * Polls the holder's stdout for `HOLDER_READY_LINE` as a whole line. Nothing else can put that line there: the
   * holder's only process is `deny-private.sh` (then `sleep`), the worker is not started yet and does not share its
   * stdout, `docker logs` hands over the container's stdout only (its stderr, where every error goes, is not read),
   * and no value in the script's input (host names, ports) is ever echoed to stdout.
   */
  private async holderReady(a: Active, name: string): Promise<void> {
    const { docker } = this.d
    const pollMs = this.d.holderPollMs ?? HOLDER_POLL_MS
    const deadline = Date.now() + (this.d.holderReadyMs ?? HOLDER_READY_MS)
    for (;;) {
      if (a.holderGone) throw new Error('The network holder stopped before it was ready')
      const out = await docker.logs(name)
      // Re-check after the read: a holder that died while we read is not trusted even if the line was already out.
      if (a.holderGone) throw new Error('The network holder stopped before it was ready')
      if (out.split(/\r?\n/).includes(HOLDER_READY_LINE)) return
      if (Date.now() >= deadline) throw new Error('The network holder did not report its rules in time')
      const wake = new AbortController()
      await Promise.race([a.holderExit, sleep(pollMs, wake.signal)])
      wake.abort()
    }
  }

  /** One worker container, from its files to its exit. Returns the exit code, or null when it was stopped as crashed. */
  private async attempt(
    a: Active,
    attempt: number,
    secrets: LocalSecrets,
    ntfy: NtfyConfig,
    localKey: Buffer
  ): Promise<number | null> {
    const { docker, paths } = this.d
    const relay = a.relay!
    const payload = a.job.payload
    const cfg = localJobConfig(
      payload,
      secrets,
      ntfy,
      { containerUrl: relay.containerUrl, token: relay.token },
      attempt
    )
    const eph = await writeEphemeral(paths.runs, {
      'job.json': JSON.stringify(cfg),
      'profile.key': identityKeyFile(localKey, a.identityId)
    })
    a.eph = eph
    // The files go at this attempt's first heartbeat, 120 s after the start, or when the attempt ends: whichever is first.
    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const removed = removeAfterFirstHeartbeat(
      eph,
      Promise.race([relay.firstHeartbeat(attempt), finished]),
      this.d.ephemeralMaxMs
    )
    const name = workerName(payload.occurrenceId, attempt)
    try {
      a.worker = name
      a.volumeUsed = true
      await docker.run(
        workerArgs({
          occurrenceId: payload.occurrenceId,
          identityId: a.identityId,
          attempt,
          image: payload.image,
          mounts: {
            dataDir: paths.data,
            checkpointsDir: checkpointsDir(paths, a.identityId),
            ephemeralDir: eph.dir,
            machineIdFile: machineIdFile(paths, a.identityId)
          }
        })
      )
      return await this.supervise(a, name)
    } finally {
      finish()
      await removed
      a.eph = null
      await docker.rm(name)
      a.worker = null
    }
  }

  /**
   * Waits for the worker to exit. It is stopped (60 s) and read as a crash when the network holder dies first or the
   * silence limit passes; a stop request ends it the same way but with its own exit code. A PC that slept is not
   * silence: a long gap between two checks restarts the window.
   */
  private async supervise(a: Active, name: string): Promise<number | null> {
    const { docker } = this.d
    const exited: Promise<Ended> = docker.wait(name).then(
      (code) => ({ kind: 'exit', code }),
      (error: unknown) => ({ kind: 'error', error })
    )
    const watch = new AbortController()
    const stopped = new Promise<'stopped'>((resolve) => {
      if (a.stop.signal.aborted) resolve('stopped')
      else a.stop.signal.addEventListener('abort', () => resolve('stopped'), { once: true })
    })
    let first: Ended | 'silent' | 'holder' | 'stopped'
    try {
      first = await Promise.race([
        exited,
        this.silence(a, watch.signal).then(() => 'silent' as const),
        a.holderExit.then(() => 'holder' as const),
        stopped
      ])
    } finally {
      watch.abort()
    }
    if (typeof first !== 'string') {
      if (first.kind === 'error') throw first.error
      return first.code
    }
    await docker.stop(name, first === 'silent' ? SILENT_STOP_SECONDS : WORKER_STOP_SECONDS)
    const end = await exited
    if (end.kind === 'error') throw end.error
    return first === 'stopped' ? end.code : null
  }

  /** Resolves when no heartbeat came for `silenceMs`. Never resolves on its own after `signal` aborts. */
  private silence(a: Active, signal: AbortSignal): Promise<void> {
    const silenceMs = this.d.silenceMs ?? SILENCE_RESTART_MS
    const tickMs = this.d.tickMs ?? 1000
    const sleepGap = Math.max(tickMs * 5, 10_000)
    return new Promise((resolve) => {
      let lastTick = this.now()
      let quietFrom = lastTick
      const timer = setInterval(() => {
        const t = this.now()
        if (t - lastTick > sleepGap) quietFrom = t // the timers were frozen: the PC slept
        lastTick = t
        if (a.resumedAt !== null) quietFrom = Math.max(quietFrom, a.resumedAt)
        const beat = a.relay?.lastHeartbeatAt() ?? 0
        if (t - Math.max(quietFrom, beat) >= silenceMs) {
          clearInterval(timer)
          resolve()
        }
      }, tickMs)
      signal.addEventListener('abort', () => clearInterval(timer), { once: true })
    })
  }

  /**
   * Tells the website, now and every few seconds, that the next attempt is coming, until its first heartbeat. The first
   * report goes out before this returns, so it is sent before the next container starts.
   */
  private async restartNotices(a: Active, next: number): Promise<{ stop(): Promise<void> }> {
    const relay = a.relay!
    const ac = new AbortController()
    const send = async (): Promise<void> => {
      try {
        const reply = await relay.synthetic({
          occurrenceId: a.job.payload.occurrenceId,
          attempt: next,
          state: 'restarting',
          recording: false,
          participants: null,
          events: []
        })
        // The website says this attempt is no longer wanted: do not start another one.
        if (reply.commands.includes('stop')) a.stopRequested = true
      } catch (e) {
        this.onError(e)
      }
    }
    await send()
    const loop = (async () => {
      while (!ac.signal.aborted) {
        await sleep(this.d.restartNoticeMs ?? RESTART_NOTICE_MS, ac.signal)
        if (!ac.signal.aborted) await send()
      }
    })()
    void relay.firstHeartbeat(next).then(() => ac.abort())
    return {
      stop: async () => {
        ac.abort()
        await loop
      }
    }
  }
}
