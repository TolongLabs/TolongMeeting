import { QUEUES } from '@tm/web/db/queues'
import type { PgBoss, QueueOptions, ScheduleOptions, WorkOptions } from 'pg-boss'
// The pipeline package exposes only `runPipeline`; its queue settings live next to the consumer that works them, and
// the scheduler creates those queues with the same settings so a job sent before the consumer starts is not different.
import { PIPELINE_DEAD_QUEUE, PIPELINE_QUEUE } from '../../pipeline/src/consumer-main'

/** The handler keys of `JobHandlers`. Each has a queue in `QUEUES` and a row in `JOBS`. */
export type JobKey = 'expand' | 'launch' | 'signinStart' | 'deleteOccurrence' | 'retention' | 'backup' | 'orgCheck'

/** One job's work. `data` is the job body (`{}` for a scheduled job); `signal` aborts when the job expires. */
export type JobHandler = (data: unknown, signal: AbortSignal) => Promise<void>

export type JobHandlers = Record<JobKey, JobHandler>

type JobSpec = {
  queue: string
  /** pg-boss queue settings. Every job on the queue inherits them. All are set, so no default decides anything. */
  queueOptions: Required<Pick<QueueOptions, 'expireInSeconds' | 'retentionSeconds' | 'deleteAfterSeconds'>> &
    Pick<QueueOptions, 'retryLimit' | 'retryDelay' | 'retryBackoff' | 'retryDelayMax'>
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
  // Sent at T-60 minutes (or 15 s after a deferral). A Docker failure is handled inside the handler; a throw is a
  // Postgres error, which a short backoff retry usually clears. A job that waited past the meeting is `launch_missed`.
  launch: {
    queueOptions: {
      expireInSeconds: 10 * MINUTE,
      retentionSeconds: 7 * DAY,
      deleteAfterSeconds: DAY,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: MINUTE
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
