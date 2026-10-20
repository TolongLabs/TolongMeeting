import { writeFileSync } from 'node:fs'
import { watchGateFromEnv, type SpecEnv } from '@tm/core'
import { closeDb, getDb } from '@tm/web/db'
import { runMigrations } from '@tm/web/db/migrate'
import { memberNotifier } from '@tm/web/db/notifier'
import { syncOccurrences } from '@tm/web/db/occurrences'
import { QUEUES, bossQueue } from '@tm/web/db/queues'
import { loadMasterKey } from '@tm/web/db/secrets'
import { githubApi } from '@tm/web/lib/github'
import { PgBoss } from 'pg-boss'
import { z } from 'zod'
import { remuxRecording } from '../../pipeline/src/remux'
import { runBackup } from './backup'
import { assertRoot, parseOrigin } from './container-spec'
import { dockerClient } from './docker'
import { WORKER_UID } from './job-files'
import { createQueues, jobKeyOfQueue, registerJobs, startLoop, type JobHandlers, type JobKey } from './jobs'
import {
  handleDeadLaunchJob,
  launchOccurrence,
  resumeJobFileWatchers,
  stopJobFileWatchers,
  type LaunchDeps
} from './launch'
import { monitorTick, settleRemuxes } from './monitor'
import { runOrgCheck } from './org-check'
import { deleteOccurrenceData, retentionTick } from './retention'
import { startSigninContainer } from './signin'

/** The monitor looks at every running worker and sign-in session this often. */
export const MONITOR_INTERVAL_MS = 5_000
/** Touched after every monitor tick; the Compose health check fails when it is older than a minute. */
export const HEALTH_FILE = '/tmp/tm-scheduler-alive'
/** How long a shutdown waits for running jobs, and then for running remuxes (each; both below Compose's grace period). */
const DRAIN_MS = 30_000
/** How long a shutdown waits for the monitor tick in flight (a tick can be stuck on a Docker call). */
const MONITOR_STOP_MS = 15_000
/**
 * The hard stop: monitor 15 s, jobs 35 s and remuxes 30 s add up to 80 s, which is below Compose's 90 s grace period.
 * If anything past that is still running, the process exits instead of waiting for SIGKILL.
 */
export const SHUTDOWN_DEADLINE_MS = 80_000

// --- Environment -----------------------------------------------------------------------------------------------------

export type SchedulerEnv = {
  databaseUrl: string
  spec: SpecEnv
  dockerProxyUrl: string
  masterKeyFile: string
  githubOrg: string
  backupRemote: string
  rcloneConfig: string
}

/** A start-up refusal whose message is safe to print: it holds names and numbers, never a value from the environment. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartupError'
  }
}

/** The error of `readSchedulerEnv`. It names variables only: a value can be a password or a path to a secret. */
export class EnvError extends StartupError {
  constructor(readonly names: string[]) {
    super(`Missing or invalid environment variables: ${names.join(', ')}`)
    this.name = 'EnvError'
  }
}

const passes = (check: () => unknown): boolean => {
  try {
    check()
    return true
  } catch {
    // The check threw on a bad value; the caller reports the variable's name, never the value or the message.
    return false
  }
}

const isUrl = (value: string, protocols: string[]): boolean => {
  const url = URL.parse(value)
  return url !== null && protocols.includes(url.protocol)
}

/** One entry per variable: the check that makes its value usable. */
const CHECKS: Record<string, (value: string) => boolean> = {
  DATABASE_URL: (v) => isUrl(v, ['postgres:', 'postgresql:']),
  TM_DATA_ROOT: (v) => passes(() => assertRoot('TM_DATA_ROOT', v)),
  TM_PROFILE_ROOT: (v) => passes(() => assertRoot('TM_PROFILE_ROOT', v)),
  TM_PUBLIC_URL: (v) => passes(() => parseOrigin('TM_PUBLIC_URL', v)),
  NTFY_URL: (v) => passes(() => parseOrigin('NTFY_URL', v)),
  DOCKER_PROXY_URL: (v) => isUrl(v, ['http:', 'https:']),
  TM_MASTER_KEY_FILE: (v) => v.startsWith('/'),
  GITHUB_ORG: (v) => v.trim() !== '',
  TM_BACKUP_REMOTE: (v) => v.trim() !== '',
  RCLONE_CONFIG: (v) => v.startsWith('/')
}

/**
 * Reads the scheduler's variables from `source` and checks each. Every bad or missing variable is named in one
 * `EnvError`; no value is ever put in the error.
 */
export function readSchedulerEnv(source: Record<string, string | undefined>): SchedulerEnv {
  const bad = Object.entries(CHECKS)
    .filter(([name, ok]) => {
      const value = source[name]
      return value === undefined || value === '' || !ok(value)
    })
    .map(([name]) => name)
  if (bad.length > 0) throw new EnvError(bad)
  const v = (name: string) => source[name]!
  return {
    databaseUrl: v('DATABASE_URL'),
    spec: {
      dataRoot: v('TM_DATA_ROOT'),
      profileRoot: v('TM_PROFILE_ROOT'),
      publicUrl: v('TM_PUBLIC_URL'),
      ntfyUrl: v('NTFY_URL')
    },
    dockerProxyUrl: v('DOCKER_PROXY_URL'),
    masterKeyFile: v('TM_MASTER_KEY_FILE'),
    githubOrg: v('GITHUB_ORG'),
    backupRemote: v('TM_BACKUP_REMOTE'),
    rcloneConfig: v('RCLONE_CONFIG')
  }
}

/**
 * The scheduler writes files that the worker (uid 1000, or `TM_WORKER_UID`) reads and the other way round, and it never
 * chowns, so it must run as that uid. Checked before anything else touches the disk or the database.
 */
export function assertWorkerUid(source: Record<string, string | undefined>, actual: number | undefined): void {
  const raw = source.TM_WORKER_UID
  const want = raw === undefined || raw === '' ? WORKER_UID : Number(raw)
  if (!Number.isInteger(want) || want < 0) throw new EnvError(['TM_WORKER_UID'])
  if (actual !== want)
    throw new StartupError(`the scheduler must run as uid ${want} (the worker uid); it runs as uid ${actual}`)
}

// --- Handlers --------------------------------------------------------------------------------------------------------

const Uuid = z.uuid()
const LaunchData = z.object({ occurrenceId: Uuid, scheduledStart: z.string().min(1) })
const SigninData = z.object({ sessionId: Uuid })
const DeleteData = z.object({ occurrenceId: Uuid })

/**
 * The handler of each job, over the shared dependencies. Job bodies are checked with zod before use. A scheduled job
 * carries `{}` and ignores its body.
 */
export function buildHandlers(deps: LaunchDeps, env: SchedulerEnv, now: () => Date = () => new Date()): JobHandlers {
  return {
    expand: async () => {
      const done = await syncOccurrences(deps.db, deps.queue, now())
      console.log(`expand: ${done.created} created, ${done.removed} removed`)
    },
    launch: async (data) => {
      const job = LaunchData.parse(data)
      console.log(`launch: ${job.occurrenceId}: ${await launchOccurrence(deps, job, now())}`)
    },
    launchDead: async (data) => {
      const job = LaunchData.parse(data)
      console.log(`launch-dead: ${job.occurrenceId}: ${await handleDeadLaunchJob(deps, job, now())}`)
    },
    signinStart: async (data) => {
      const { sessionId } = SigninData.parse(data)
      console.log(`signin-start: ${sessionId}: ${await startSigninContainer(deps, sessionId, now())}`)
    },
    deleteOccurrence: async (data) => {
      const { occurrenceId } = DeleteData.parse(data)
      await deleteOccurrenceData(deps, occurrenceId, now())
      console.log(`delete-occurrence: ${occurrenceId}: done`)
    },
    retention: async () => {
      console.log(`retention: ${JSON.stringify(await retentionTick(deps, now()))}`)
    },
    backup: async () => {
      await runBackup({ ...deps, remote: env.backupRemote, databaseUrl: env.databaseUrl }, now())
      console.log('backup: done')
    },
    orgCheck: async () => {
      const { ended } = await runOrgCheck(githubApi(), deps.master)
      console.log(`org-check: ${ended.length} member(s) ended`)
    }
  }
}

/** `--run <queue> [json]`: the queue to run once and the job body (default `{}`), or `null` for a normal start. */
export function parseRunArgs(argv: string[]): { key: JobKey; data: unknown } | null {
  const at = argv.indexOf('--run')
  if (at < 0) return null
  const queue = argv[at + 1]
  const key = queue === undefined ? undefined : jobKeyOfQueue(queue)
  if (key === undefined) {
    throw new Error(
      `--run needs one of: ${Object.values(QUEUES)
        .filter((q) => jobKeyOfQueue(q))
        .join(', ')}`
    )
  }
  const json = argv[at + 2]
  return { key, data: json === undefined ? {} : JSON.parse(json) }
}

// --- Start-up and shutdown -------------------------------------------------------------------------------------------

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')

/** The name of an error and its `code` (a Postgres or errno code), never its message: a query error can quote values. */
const errorBrief = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? `${errorName(e)} ${code}` : errorName(e)
}

/** Resolves when `work` ends or after `ms`, whichever is first; says which in the log. */
async function bounded(label: string, ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), ms)))
  if ((await Promise.race([work.then(() => 'done' as const), late])) === 'late') {
    console.error(`shutdown: ${label} did not finish within ${ms / 1000} s`)
  }
  clearTimeout(timer)
}

async function main(): Promise<void> {
  const run = parseRunArgs(process.argv.slice(2))
  // 1. The environment. A bad variable stops the process before anything is opened.
  const env = readSchedulerEnv(process.env)
  // 2. The uid.
  assertWorkerUid(process.env, process.getuid?.())
  const db = getDb()
  // Applied here, by the one process that owns the schema; the website and the pipeline wait for this one to be healthy.
  if (!run) await runMigrations(db)

  // The daemon is the one instance that supervises the queues and runs the cron schedules; a `--run` instance does neither.
  const boss = new PgBoss({ connectionString: env.databaseUrl, ...(run ? { supervise: false, schedule: false } : {}) })
  // Only the error's name is logged: a message can quote a connection string.
  boss.on('error', (e) => console.error(`queue error: ${e.name}`))
  await boss.start()

  const master = loadMasterKey(env.masterKeyFile)
  const deps: LaunchDeps = {
    db,
    queue: bossQueue(boss),
    docker: dockerClient(env.dockerProxyUrl),
    notifier: memberNotifier(db, master, env.spec.ntfyUrl),
    master,
    env: env.spec,
    watchGate: watchGateFromEnv(process.env),
    // The monitor makes the browser MP4 of a meeting that ends without the pipeline; the host runs ffmpeg for it.
    remux: remuxRecording
  }
  const handlers = buildHandlers(deps, env)

  if (run) {
    // `main.ts --run <queue>`: one job here and now, without workers or schedules (the acceptance steps use it).
    try {
      // The queues must exist for a handler that sends jobs (`expand`, `launch`).
      await createQueues(boss)
      await handlers[run.key](run.data, new AbortController().signal)
    } finally {
      await boss.stop({ graceful: false, close: true })
      await closeDb()
    }
    return
  }

  // 3-5. Queues, then the job-file watchers (before the first launch job is taken), then the workers and schedules.
  await registerJobs(boss, handlers, {
    beforeWorkers: async () => {
      const resumed = await resumeJobFileWatchers(deps)
      console.log(`job files: ${resumed.removed} removed, ${resumed.watching} watched`)
    }
  })
  // One pass at start-up, as a job: it is retried like any other and the hourly run does not wait for it.
  await boss.send(QUEUES.expand, {})

  // 6. The monitor loop.
  const monitor = startLoop({
    intervalMs: MONITOR_INTERVAL_MS,
    tick: async () => {
      const r = await monitorTick(deps, new Date())
      if (r.restarted.length + r.failed.length + r.released.length > 0) {
        console.log(
          `monitor: restarted ${r.restarted.length}, failed ${r.failed.length}, released ${r.released.length}`
        )
      }
    },
    onError: (e) => console.error(`monitor: tick failed (${errorName(e)})`),
    onBeat: () => writeFileSync(HEALTH_FILE, new Date().toISOString())
  })
  writeFileSync(HEALTH_FILE, new Date().toISOString())
  console.log('scheduler running')

  // SIGTERM drains: no new monitor tick, jobs in flight finish (bounded), remuxes finish (bounded), then exit.
  let stopping = false
  const drain = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    // If the steps below hang, this ends the process before Compose's SIGKILL. It never keeps a finished process alive.
    setTimeout(() => {
      console.error(`shutdown: not finished within ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting`)
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS).unref()
    await bounded('monitor', MONITOR_STOP_MS, monitor.stop())
    await bounded('jobs', DRAIN_MS + 5_000, boss.stop({ graceful: true, timeout: DRAIN_MS, close: true }))
    await bounded('remuxes', DRAIN_MS, settleRemuxes())
    await stopJobFileWatchers()
    await closeDb()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      drain().then(
        () => process.exit(0),
        (e) => {
          console.error(`shutdown failed (${errorBrief(e)})`)
          process.exit(1)
        }
      )
    })
  }
}

if (import.meta.main) {
  main().catch((e) => {
    // A start-up refusal has a safe message. Any other error is logged by name and code only.
    console.error(e instanceof StartupError ? e.message : `scheduler stopped: ${errorBrief(e)}`)
    process.exit(1)
  })
}
