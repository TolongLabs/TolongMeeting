import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { PgBoss, type QueueResult as Queue } from 'pg-boss'
import { QUEUES } from '@tm/web/db/queues'
import { createTestDb, dropAllTestDbs, testDbUrl } from '@tm/web/db/testing'
import { migrationsFolder, runMigrations } from '@tm/web/db/migrate'
import { PIPELINE_DEAD_QUEUE, PIPELINE_QUEUE, workPipeline } from '../../pipeline/src/consumer-main'
import type { PipelineDeps } from '../../pipeline/src/consumer'
import {
  JOBS,
  PIPELINE_DEAD_OPTIONS,
  jobKeyOfQueue,
  registerJobs,
  startLoop,
  type JobHandlers,
  type JobKey
} from '../src/jobs'
import { EnvError, assertWorkerUid, parseRunArgs, readSchedulerEnv } from '../src/main'

afterAll(dropAllTestDbs, 60_000)

/** A started pg-boss on its own new database, stopped after `run`, so no worker from one test takes another's job. */
async function withBoss(run: (boss: PgBoss, url: string) => Promise<void>): Promise<void> {
  const url = testDbUrl(await createTestDb())
  const boss = new PgBoss(url)
  boss.on('error', (error) => {
    throw error
  })
  await boss.start()
  try {
    await run(boss, url)
  } finally {
    await boss.stop({ graceful: false, close: true })
  }
}

/** A queue's settings, without its counts and timestamps. */
const settings = (q: Queue | null) => {
  const { name, policy, expireInSeconds, retentionSeconds, deleteAfterSeconds } = q!
  const { retryLimit, retryDelay, retryBackoff, retryDelayMax, deadLetter, heartbeatSeconds } = q!
  return {
    name,
    policy,
    expireInSeconds,
    retentionSeconds,
    deleteAfterSeconds,
    retryLimit,
    retryDelay,
    retryBackoff,
    retryDelayMax,
    deadLetter,
    heartbeatSeconds
  }
}

const KEYS = Object.keys(JOBS) as JobKey[]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(done: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(25)
  }
}

/** Handlers that record the job body they were given, in the order they ran. */
function recordingHandlers(seen: { key: JobKey; data: unknown }[]): JobHandlers {
  const handlers = {} as JobHandlers
  for (const key of KEYS) handlers[key] = async (data) => void seen.push({ key, data })
  return handlers
}

test(
  'registerJobs creates every queue with its settings and schedules the recurring jobs in UTC',
  () =>
    withBoss(async (boss) => {
      const seen: { key: JobKey; data: unknown }[] = []
      const events: string[] = []
      const handlers = recordingHandlers(seen)
      handlers.launch = async (data) => void (events.push('launch'), seen.push({ key: 'launch', data }))
      await registerJobs(boss, handlers, {
        beforeWorkers: async () => {
          // The queues exist by now, and no worker is running yet: a job sent here waits for the workers.
          await boss.send(QUEUES.launch, { occurrenceId: 'o1', scheduledStart: 's' })
          events.push('hook')
        }
      })

      const names = (await boss.getQueues())
        .map((q) => q.name)
        .filter((n) => !n.startsWith('__pgboss__'))
        .sort()
      expect(names).toEqual(
        [
          'backup',
          'delete-occurrence',
          'expand',
          'launch',
          'org-check',
          'pipeline',
          'pipeline-dead',
          'retention',
          'signin-start'
        ].sort()
      )
      for (const key of KEYS) {
        expect(await boss.getQueue(JOBS[key].queue)).toMatchObject({ policy: 'standard', ...JOBS[key].queueOptions })
      }
      // Settings that matter to behaviour, written out so a change to the table is a visible change here too.
      expect(await boss.getQueue('launch')).toMatchObject({ expireInSeconds: 600, retryLimit: 3, retryBackoff: true })
      expect(await boss.getQueue('backup')).toMatchObject({ expireInSeconds: 14400, retryLimit: 2, retryDelay: 600 })
      expect(await boss.getQueue('retention')).toMatchObject({ retryLimit: 0 })

      const schedules = (await boss.getSchedules()).map((s) => ({ name: s.name, cron: s.cron, tz: s.timezone }))
      expect(schedules.sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
        { name: 'backup', cron: '0 19 * * *', tz: 'UTC' },
        { name: 'expand', cron: '0 * * * *', tz: 'UTC' },
        { name: 'org-check', cron: '30 18 * * *', tz: 'UTC' },
        { name: 'retention', cron: '7 * * * *', tz: 'UTC' }
      ])

      // The job sent before the workers started is handled afterwards, with its body.
      await until(() => seen.some((s) => s.key === 'launch'), 15_000)
      expect(events).toEqual(['hook', 'launch'])
      expect(seen.find((s) => s.key === 'launch')?.data).toEqual({ occurrenceId: 'o1', scheduledStart: 's' })
    }),
  60_000
)

test(
  'every queue has a worker that passes the job body to its handler, and a restart adds no schedule',
  () =>
    withBoss(async (boss) => {
      const seen: { key: JobKey; data: unknown }[] = []
      await registerJobs(boss, recordingHandlers(seen))
      await registerJobs(boss, recordingHandlers(seen))
      for (const key of KEYS) await boss.send(JOBS[key].queue, { for: key })
      const got = (key: JobKey) => seen.some((s) => s.key === key && (s.data as { for?: string }).for === key)
      await until(() => KEYS.every(got), 30_000)
      expect(await boss.getSchedules()).toHaveLength(4)
    }),
  60_000
)

test(
  'a job that throws is retried by pg-boss, and one handler failing does not stop the others',
  () =>
    withBoss(async (boss) => {
      let attempts = 0
      const seen: { key: JobKey; data: unknown }[] = []
      const handlers = recordingHandlers(seen)
      handlers.signinStart = async () => {
        attempts++
        if (attempts === 1) throw new Error('first try fails')
      }
      await registerJobs(boss, handlers)
      await boss.send(QUEUES.signinStart, { sessionId: 'x' })
      await boss.send(QUEUES.deleteOccurrence, { occurrenceId: 'y' })
      await until(() => seen.some((s) => s.key === 'deleteOccurrence'), 30_000)
      await until(() => attempts >= 2, 30_000)
    }),
  60_000
)

test(
  'the scheduler makes the pipeline queues exactly as the pipeline consumer does',
  () =>
    withBoss(async (boss, url) => {
      await registerJobs(boss, recordingHandlers([]))
      const before = {
        dead: await boss.getQueue(PIPELINE_DEAD_QUEUE),
        pipeline: await boss.getQueue(QUEUES.pipeline)
      }
      expect(before.pipeline).toMatchObject({ ...PIPELINE_QUEUE, deadLetter: PIPELINE_DEAD_QUEUE })
      expect(before.dead).toMatchObject(PIPELINE_DEAD_OPTIONS)
      // The consumer applies its own settings on start; they must change nothing the scheduler set.
      const consumer = new PgBoss(url)
      consumer.on('error', (error) => {
        throw error
      })
      await consumer.start()
      try {
        // Only the queue set-up is used: no job is sent to the pipeline, so its dependencies are never touched.
        await workPipeline(consumer, {} as PipelineDeps)
        expect(settings(await consumer.getQueue(QUEUES.pipeline))).toEqual(settings(before.pipeline))
        expect(settings(await consumer.getQueue(PIPELINE_DEAD_QUEUE))).toEqual(settings(before.dead))
      } finally {
        await consumer.stop({ graceful: false, close: true })
      }
    }),
  60_000
)

test('two schedulers booting at once apply each migration once', async () => {
  const db = await createTestDb()
  // Back to an empty database, as a first boot finds it.
  await db.execute(sql`drop schema drizzle cascade`)
  await db.execute(sql`drop schema public cascade`)
  await db.execute(sql`create schema public`)
  const journal = (await Bun.file(join(migrationsFolder, 'meta', '_journal.json')).json()) as { entries: unknown[] }
  await Promise.all([runMigrations(db), runMigrations(db), runMigrations(db)])
  const applied = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
  expect(applied.rows[0]).toEqual({ n: journal.entries.length })
  // And a boot after them finds nothing to do.
  await runMigrations(db)
}, 60_000)

test('queue names map to their handlers, and pipeline queues have none here', () => {
  expect(KEYS.map((key) => JOBS[key].queue).sort()).toEqual(
    Object.values(QUEUES)
      .filter((q) => q !== QUEUES.pipeline)
      .sort()
  )
  expect(jobKeyOfQueue('signin-start')).toBe('signinStart')
  expect(jobKeyOfQueue('pipeline')).toBeUndefined()
})

test('the monitor loop skips a tick while the last one runs, keeps going after an error and drains on stop', async () => {
  let started = 0
  let finished = 0
  const errors: string[] = []
  let beats = 0
  const loop = startLoop({
    intervalMs: 10,
    tick: async () => {
      started++
      await sleep(55)
      if (started === 1) throw new Error('boom')
      finished++
    },
    onError: (e) => errors.push((e as Error).message),
    onBeat: () => void beats++
  })
  await until(() => finished >= 2, 5_000)
  // About 5 intervals passed during each 55 ms tick, yet ticks never overlapped.
  expect(started).toBeLessThanOrEqual(finished + 2)
  expect(errors).toEqual(['boom'])
  await loop.stop()
  const after = started
  expect(beats).toBe(finished + 1)
  await sleep(40)
  expect(started).toBe(after)
})

const GOOD_ENV = {
  DATABASE_URL: 'postgres://tm:s3cretpw@postgres:5432/tm',
  TM_DATA_ROOT: '/srv/tolongmeeting/data',
  TM_PROFILE_ROOT: '/srv/tolongmeeting/profiles',
  TM_PUBLIC_URL: 'https://tm.example',
  NTFY_URL: 'https://ntfy.tm.example',
  DOCKER_PROXY_URL: 'http://docker-proxy:2375',
  TM_MASTER_KEY_FILE: '/run/secrets/tm_master_key',
  GITHUB_ORG: 'tolonglabs',
  TM_BACKUP_REMOTE: 'tm-backup:',
  RCLONE_CONFIG: '/run/secrets/rclone_conf'
}

test('a good environment is read; a bad one is refused with variable names and no values', () => {
  expect(readSchedulerEnv(GOOD_ENV)).toMatchObject({
    databaseUrl: GOOD_ENV.DATABASE_URL,
    spec: { dataRoot: '/srv/tolongmeeting/data', ntfyUrl: 'https://ntfy.tm.example' },
    backupRemote: 'tm-backup:'
  })

  const { DATABASE_URL: _unused, ...withoutDb } = GOOD_ENV
  const bad = { ...withoutDb, TM_DATA_ROOT: 'relative/../secret-value', NTFY_URL: 'not a url', GITHUB_ORG: '' }
  let message = ''
  try {
    readSchedulerEnv(bad)
  } catch (e) {
    expect(e).toBeInstanceOf(EnvError)
    message = (e as Error).message
  }
  expect(message).toBe('Missing or invalid environment variables: DATABASE_URL, TM_DATA_ROOT, NTFY_URL, GITHUB_ORG')
  for (const value of ['secret-value', 'not a url', 's3cretpw']) expect(message).not.toContain(value)

  // A password inside an otherwise bad URL does not reach the message either.
  expect(() => readSchedulerEnv({ ...GOOD_ENV, DATABASE_URL: 'mysql://tm:s3cretpw@db/tm' })).toThrow(
    'Missing or invalid environment variables: DATABASE_URL'
  )
})

test('the scheduler runs only as the worker uid', () => {
  expect(() => assertWorkerUid({}, 1000)).not.toThrow()
  expect(() => assertWorkerUid({}, 0)).toThrow('must run as uid 1000')
  expect(() => assertWorkerUid({ TM_WORKER_UID: '2000' }, 2000)).not.toThrow()
  expect(() => assertWorkerUid({ TM_WORKER_UID: '2000' }, 1000)).toThrow('must run as uid 2000')
  expect(() => assertWorkerUid({ TM_WORKER_UID: 'abc' }, 1000)).toThrow(EnvError)
})

test('--run takes a queue name and an optional JSON body', () => {
  expect(parseRunArgs([])).toBeNull()
  expect(parseRunArgs(['--run', 'backup'])).toEqual({ key: 'backup', data: {} })
  expect(parseRunArgs(['--run', 'launch', '{"occurrenceId":"a"}'])).toEqual({
    key: 'launch',
    data: { occurrenceId: 'a' }
  })
  expect(() => parseRunArgs(['--run', 'pipeline'])).toThrow('--run needs one of')
  expect(() => parseRunArgs(['--run'])).toThrow('--run needs one of')
})
