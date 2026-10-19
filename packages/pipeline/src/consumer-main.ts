import type { SpecEnv } from '@tm/core'
import { QUEUES } from '@tm/web/db/queues'
import { PgBoss } from 'pg-boss'
import { z } from 'zod'
import { getDb } from '@tm/web/db'
import { memberNotifier } from '@tm/web/db/notifier'
import { loadMasterKey } from '@tm/web/db/secrets'
import { handlePipelineJob, type PipelineDeps } from './consumer'
import { runPipeline } from './pipeline'
import { remuxRecording } from './remux'

const JobData = z.object({ occurrenceId: z.uuid() })

/** A pipeline run can take a while on a long lecture; pg-boss's 15 minute default would hand a live job to a second worker. */
const PIPELINE_QUEUE = { expireInSeconds: 2 * 3600, retryLimit: 3, retryDelay: 60, retryBackoff: true }

/**
 * Starts the one worker of the `pipeline` queue: `localConcurrency: 1`, so only one heavy job runs at a time. The job
 * carries only the occurrence id; the member's keys are read from the database inside `handlePipelineJob`. A bad job
 * body or an error thrown by the handler fails the job, and pg-boss retries it. The job's abort signal (it expired) is
 * passed down, so an expired handler stops instead of racing its retry.
 */
export async function workPipeline(boss: PgBoss, deps: PipelineDeps): Promise<void> {
  await boss.createQueue(QUEUES.pipeline)
  await boss.updateQueue(QUEUES.pipeline, PIPELINE_QUEUE)
  await boss.work(QUEUES.pipeline, { localConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { occurrenceId } = JobData.parse(job.data)
      console.log(`pipeline: ${occurrenceId}: ${await handlePipelineJob(deps, occurrenceId, job.signal)}`)
    }
  })
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

if (import.meta.main) {
  const env: SpecEnv = {
    dataRoot: required('TM_DATA_ROOT'),
    profileRoot: required('TM_PROFILE_ROOT'),
    publicUrl: required('TM_PUBLIC_URL'),
    ntfyUrl: required('NTFY_URL')
  }
  const db = getDb()
  const master = loadMasterKey()
  const boss = new PgBoss(required('DATABASE_URL'))
  // Only the error's name is logged: a message can quote a connection string.
  boss.on('error', (e) => console.error(`queue error: ${e.name}`))
  await boss.start()
  await workPipeline(boss, {
    db,
    master,
    env,
    notifier: memberNotifier(db, master, env.ntfyUrl),
    // The consumer sends the key-problem ping itself, so the pipeline does not.
    run: (cfg, signal) => runPipeline(cfg, { pingOnKeyError: false, signal }),
    remux: remuxRecording
  })
  console.log('pipeline consumer running')
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void boss.stop({ graceful: true, timeout: 60_000, close: true }).then(() => process.exit(0))
    })
  }
}
