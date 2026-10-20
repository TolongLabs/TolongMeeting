import { QUEUES } from '@tm/web/db/queues'
import type { PgBoss, QueueOptions, ScheduleOptions, WorkOptions } from 'pg-boss'
// The pipeline package exposes only `runPipeline`; its queue settings live next to the consumer that works them, and
// the scheduler creates those queues with the same settings so a job sent before the consumer starts is not different.
import { PIPELINE_DEAD_QUEUE, PIPELINE_QUEUE } from '../../pipeline/src/consumer-main'

/** The handler keys of `JobHandlers`. Each has a queue in `QUEUES` and a row in `JOBS`. */
export type JobKey =
  | 'expand'
  | 'launchDead'
  | 'launch'
  | 'signinStart'
  | 'deleteOccurrence'
  | 'retention'
  | 'backup'
  | 'orgCheck'
  | 'nativeJobDead'
  | 'nativeJobCheck'
  | 'profileDelete'
  | 'localClaimCheck'
  | 'localStartDead'
  | 'localStartCheck'
  | 'homeRouteDead'
  | 'homeRouteRecheck'

/** One job's work. `data` is the job body (`{}` for a scheduled job); `signal` aborts when the job expires. */
export type JobHandler = (data: unknown, signal: AbortSignal) => Promise<void>

export type JobHandlers = Record<JobKey, JobHandler>

type JobSpec = {
  queue: string
  /** pg-boss queue settings. Every job on the queue inherits them. All are set, so no default decides anything. */
  queueOptions: Required<Pick<QueueOptions, 'expireInSeconds' | 'retentionSeconds' | 'deleteAfterSeconds'>> &
    Pick<QueueOptions, 'retryLimit' | 'retryDelay' | 'retryBackoff' | 'retryDelayMax'> & {
      /** Where a job goes when its retries are spent. */
      deadLetter?: string
    }
  /** How the one worker of the queue polls. */
  pollingIntervalSeconds: number
  /** A recurring job, in UTC. `missed: 'once'` sends one job for a slot that came due while the scheduler was down. */
  cron?: string
}

const MINUTE = 60
const HOUR = 3600
const DAY = 24 * HOUR

/**
 * The scheduler's jobs. `retentionSeconds` is how long a job may wait before it starts (counted from its start time):
 * a recurring job that waited longer than its period is dropped, because the next run does the same work. Every job runs
 * one at a time (`localConcurrency: 1`), so the launch lock and the profile locks are never contended by two jobs here.
 */
export const JOBS: Record<JobKey, JobSpec> = {
  // Hourly: turns timetable entries into occurrences. Idempotent, so a failed run waits for the next hour.
  expand: {
    queue: QUEUES.expand,
    queueOptions: {
      expireInSeconds: 10 * MINUTE,
      retentionSeconds: 30 * MINUTE,
      deleteAfterSeconds: DAY,
      retryLimit: 2,
      retryDelay: MINUTE,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5,
    cron: '0 * * * *'
  },
  // Where a `launch` job goes when its retries are spent. It comes before `launch` because `launch` names it, and its
  // handler fails an occurrence that is still `scheduled` after its start (`handleDeadLaunchJob`). The same budget as
  // `pipeline-dead`: a ping that throws (ntfy down) is tried again for about an hour.
  launchDead: {
    queue: QUEUES.launchDead,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 20,
      retryDelay: 180,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5
  },
  // Sent at T-60 minutes (or 15 s after a deferral). A Docker failure is handled inside the handler; a throw is a
  // Postgres error, which a short backoff retry usually clears. A job that waited past the meeting is `launch_missed`; one whose retries run out is dead-lettered.
  launch: {
    queueOptions: {
      expireInSeconds: 10 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: MINUTE,
      deadLetter: QUEUES.launchDead
    },
    queue: QUEUES.launch,
    pollingIntervalSeconds: 2
  },
  // The member pressed "sign in" on the website; the handler starts a sign-in container.
  signinStart: {
    queue: QUEUES.signinStart,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: HOUR,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: false
    },
    pollingIntervalSeconds: 2
  },
  // "Delete now" from the website, or the retention pass. An occurrence that is still running throws and is retried.
  deleteOccurrence: {
    queue: QUEUES.deleteOccurrence,
    queueOptions: {
      expireInSeconds: 15 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 5,
      retryDelay: MINUTE,
      retryBackoff: true,
      retryDelayMax: 30 * MINUTE
    },
    pollingIntervalSeconds: 5
  },
  // Hourly, at minute 7: warnings, expiry, orphan removal, checkpoint pruning. The next hour repeats it.
  retention: {
    queue: QUEUES.retention,
    queueOptions: {
      expireInSeconds: 30 * MINUTE,
      retentionSeconds: HOUR,
      deleteAfterSeconds: DAY,
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5,
    cron: '7 * * * *'
  },
  // 03:00 in Malaysia. A slow upload gets 4 hours; a failed run is retried twice, 10 minutes apart. A job that waited
  // 20 hours is dropped, because the next night's run is due.
  backup: {
    queue: QUEUES.backup,
    queueOptions: {
      expireInSeconds: 4 * HOUR,
      retentionSeconds: 20 * HOUR,
      deleteAfterSeconds: 2 * DAY,
      retryLimit: 2,
      retryDelay: 10 * MINUTE,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5,
    cron: '0 19 * * *'
  },
  // 02:30 in Malaysia: ends the access of members who left the GitHub organisation.
  orgCheck: {
    queue: QUEUES.orgCheck,
    queueOptions: {
      expireInSeconds: 10 * MINUTE,
      retentionSeconds: 12 * HOUR,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5 * MINUTE,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5,
    cron: '30 18 * * *'
  },
  // Plans 03 and 08 (P0-Q). The handlers are stubs that throw "not implemented yet" until the named task replaces them.
  // None of these rows has a `cron`, and no code sends to these queues until its task lands, so the stubs never run.
  // Each task that starts sending (03 T6, 08 T1, T2, T12) is the one that makes the job real; none edits this table
  // unless a setting is wrong. A dead-letter queue comes before the queue that names it, as `launchDead` does.
  //
  // Where a `native-job-check` is spent, the recording would wait in `transcribing` for ever: `native-job-dead` moves it
  // to `waiting_for_pc`. The same budget as `launch-dead`: a ping that throws (ntfy down) is tried again for an hour.
  nativeJobDead: {
    queue: QUEUES.nativeJobDead,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 20,
      retryDelay: 180,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5
  },
  // Sent at +120 s after a native transcription job is created (and again at +300 s): a job no PC has claimed moves the
  // recording to `waiting_for_pc`. A throw is a Postgres error, which a short backoff retry usually clears.
  nativeJobCheck: {
    queue: QUEUES.nativeJobCheck,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: MINUTE,
      deadLetter: QUEUES.nativeJobDead
    },
    pollingIntervalSeconds: 5
  },
  // The member moved an identity to My PC; the handler removes its server-side profile. It throws while a sign-in
  // container holds the profile lock, so it retries for hours, like `delete-occurrence`. A lost job leaves files only.
  profileDelete: {
    queue: QUEUES.profileDelete,
    queueOptions: {
      expireInSeconds: 15 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 5,
      retryDelay: MINUTE,
      retryBackoff: true,
      retryDelayMax: 30 * MINUTE
    },
    pollingIntervalSeconds: 5
  },
  // At offer +120 s: a local-run job no PC has claimed is cancelled and the occurrence is skipped. No dead letter: a
  // lost claim check leaves the occurrence `starting`, and `local-start-check` at T-10 fails it.
  localClaimCheck: {
    queue: QUEUES.localClaimCheck,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: MINUTE
    },
    pollingIntervalSeconds: 5
  },
  // Where a `local-start-check` goes when its retries are spent: the occurrence would stay `starting` for ever.
  localStartDead: {
    queue: QUEUES.localStartDead,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 20,
      retryDelay: 180,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5
  },
  // At T-10: an occurrence still `starting` on a PC fails (`running` or `failed`).
  localStartCheck: {
    queue: QUEUES.localStartCheck,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: MINUTE,
      deadLetter: QUEUES.localStartDead
    },
    pollingIntervalSeconds: 5
  },
  // Where a `home-route-recheck` goes when its retries are spent: the occurrence would stay `scheduled` for ever.
  homeRouteDead: {
    queue: QUEUES.homeRouteDead,
    queueOptions: {
      expireInSeconds: 5 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 20,
      retryDelay: 180,
      retryBackoff: false
    },
    pollingIntervalSeconds: 5
  },
  // Every 60 s while the member's home exit node is not ready (a Tailscale call, then a launch): the 10 minute expiry
  // covers both. A recheck that waited a day is for a meeting that is over.
  homeRouteRecheck: {
    queue: QUEUES.homeRouteRecheck,
    queueOptions: {
      expireInSeconds: 10 * MINUTE,
      retentionSeconds: DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: MINUTE,
      deadLetter: QUEUES.homeRouteDead
    },
    pollingIntervalSeconds: 5
  }
}

const KEYS = Object.keys(JOBS) as JobKey[]

/** The handler key of a queue name (`--run <queue>`), or `undefined` for a queue this process does not work. */
export function jobKeyOfQueue(queue: string): JobKey | undefined {
  return KEYS.find((key) => JOBS[key].queue === queue)
}

/** Dead-letter queue settings of `pipeline-dead`: the same budget as the consumer's (`consumer-main.ts`). */
export const PIPELINE_DEAD_OPTIONS = { retryLimit: 20, retryDelay: 180, retryBackoff: false } as const

/**
 * Creates every queue the system uses, with its settings. `createQueue` leaves an existing queue alone, so
 * `updateQueue` follows it and a changed setting reaches a queue made by an earlier version. The dead-letter queue
 * comes first because `pipeline` names it. `pipeline` and `pipeline-dead` are worked by the pipeline consumer
 * (`workPipeline`), not here: this process only makes sure they exist, with the consumer's settings, before the website
 * sends to them.
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(PIPELINE_DEAD_QUEUE)
  await boss.updateQueue(PIPELINE_DEAD_QUEUE, PIPELINE_DEAD_OPTIONS)
  await boss.createQueue(QUEUES.pipeline)
  await boss.updateQueue(QUEUES.pipeline, PIPELINE_QUEUE)
  for (const key of KEYS) {
    const { queue, queueOptions } = JOBS[key]
    await boss.createQueue(queue)
    await boss.updateQueue(queue, queueOptions)
  }
}

const SCHEDULE: ScheduleOptions = { tz: 'UTC', missed: 'once' }

/**
 * Starts one worker for each job (`localConcurrency: 1`, `batchSize: 1`) and registers each recurring job's schedule.
 * `schedule` upserts by queue name, so a restart does not add a second schedule.
 */
export async function startWorkers(boss: PgBoss, handlers: JobHandlers): Promise<void> {
  for (const key of KEYS) {
    const { queue, pollingIntervalSeconds } = JOBS[key]
    const options: WorkOptions = { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds }
    const handler = handlers[key]
    await boss.work(queue, options, async (jobs) => {
      for (const job of jobs) await handler(job.data, job.signal)
    })
  }
  for (const key of KEYS) {
    const { queue, cron } = JOBS[key]
    if (cron !== undefined) await boss.schedule(queue, cron, {}, SCHEDULE)
  }
}

/**
 * Registers every job: creates the queues, runs `beforeWorkers` (the scheduler resumes its job-file watchers there, so
 * they are watching before the first `launch` job is taken), then starts the workers and the schedules.
 */
export async function registerJobs(
  boss: PgBoss,
  handlers: JobHandlers,
  hooks: { beforeWorkers?: () => Promise<void> } = {}
): Promise<void> {
  await createQueues(boss)
  await hooks.beforeWorkers?.()
  await startWorkers(boss, handlers)
}

export type Loop = { stop(): Promise<void> }

/**
 * Runs `tick` every `intervalMs`, never two at once: a tick that finds the previous one still running is skipped. An
 * error from `tick` goes to `onError` and the loop goes on. `onBeat` runs after every tick that ended, with or without an
 * error, so a health check can tell a stuck loop from a working one. `stop()` waits for the tick in flight.
 */
export function startLoop(opts: {
  intervalMs: number
  tick: () => Promise<void>
  onError: (error: unknown) => void
  onBeat?: () => void
}): Loop {
  let running: Promise<void> | null = null
  const timer = setInterval(() => {
    if (running !== null) return
    running = opts
      .tick()
      .catch(opts.onError)
      .finally(() => {
        running = null
        opts.onBeat?.()
      })
  }, opts.intervalMs)
  return {
    async stop() {
      clearInterval(timer)
      await running
    }
  }
}
