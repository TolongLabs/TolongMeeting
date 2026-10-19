import { AiKeyError } from '@tm/ai'
import type { JobConfig, SpecEnv } from '@tm/core'
import { pings } from '@tm/notify'
import { and, eq, sql } from 'drizzle-orm'
import { occurrences, type Db } from '@tm/web/db'
import { registerArtefacts } from '@tm/web/db/artefacts'
import { loadJobConfig } from '@tm/web/db/job-config'
import type { Notifier } from '@tm/web/db/notifier'
import { applyTrigger } from '@tm/web/db/transitions'
import { describeError } from './errors'
import type { PipelineResult } from './pipeline'

export interface PipelineDeps {
  db: Db
  notifier: Notifier
  master: Buffer
  env: SpecEnv
  run: (cfg: JobConfig) => Promise<PipelineResult>
  remux: (dir: string) => Promise<void>
}

export type PipelineJobOutcome = 'waiting_for_pc' | 'completed' | 'key_error' | 'failed' | 'stale'

/** What a `post_processing` occurrence may carry when its job starts: nothing, or a re-run after a rejected key. */
const RUNNABLE_REASONS: ReadonlySet<string | null> = new Set([null, 'ai_key_error', 'rerun_queued'])

const dataDirOf = (env: SpecEnv, id: string): string => `${env.dataRoot}/occurrences/${id}`

type OccurrenceRow = typeof occurrences.$inferSelect

/**
 * Runs the pipeline for one occurrence from the queue (the job carries only the occurrence id).
 *
 * - One job per occurrence at a time: the whole call holds a Postgres advisory lock, and a second job that cannot take it
 *   is dropped. A job for an occurrence that is not waiting for the pipeline is dropped too (`stale`).
 * - `transcribing`: a `native` occurrence waits for the member's PC (`waiting_for_pc`); a `live` one moves on to
 *   `post_processing`. A job that dies in `post_processing` is run again by pg-boss and starts from there.
 * - The pipeline runs with the member's AI config built here (`loadJobConfig`), then the recording is remuxed and the
 *   artefacts are registered; `summary_done` makes it `completed`.
 * - A rejected key (`AiKeyError`) keeps the occurrence in `post_processing` with the reason `ai_key_error` and pings once;
 *   the member's re-run queues a new job. Any other error fails the occurrence (`pipeline_error`) and pings once.
 */
export async function handlePipelineJob(deps: PipelineDeps, occurrenceId: string): Promise<PipelineJobOutcome> {
  // The transaction only holds the lock (its connection is idle until the run ends); the work uses the pool.
  return deps.db.transaction(async (lock) => {
    const result = await lock.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${'pipeline:' + occurrenceId}, 0)) as locked`
    )
    if (result.rows[0]?.locked !== true) {
      console.error(`pipeline: ${occurrenceId}: another job is running it; this job is dropped`)
      return 'stale'
    }
    return handleLocked(deps, occurrenceId)
  })
}

async function handleLocked(deps: PipelineDeps, id: string): Promise<PipelineJobOutcome> {
  const { db, env } = deps
  const [occ] = await db.select().from(occurrences).where(eq(occurrences.id, id))
  if (!occ) {
    console.error(`pipeline: ${id}: no such occurrence; this job is dropped`)
    return 'stale'
  }
  const meetingUrl = `${new URL(env.publicUrl).origin}/meetings/${id}`

  if (occ.state === 'transcribing') {
    if (occ.transcription === 'native') {
      await applyTrigger(db, id, 'wait_for_pc')
      await deps.notifier.notify(occ.memberId, pings.waitingForPc({ entry: occ.entryName, meetingUrl }))
      return 'waiting_for_pc'
    }
    await applyTrigger(db, id, 'transcript_ready')
  } else if (occ.state === 'post_processing' && RUNNABLE_REASONS.has(occ.stateReason)) {
    // The reasons of an earlier stop are cleared as the run starts, so a run that dies leaves a plain `post_processing`.
    if (occ.stateReason !== null) await setReason(db, id, null)
  } else {
    console.error(
      `pipeline: ${id}: in ${occ.state}${occ.stateReason ? ` (${occ.stateReason})` : ''}; this job is dropped`
    )
    return 'stale'
  }

  const dir = dataDirOf(env, id)
  try {
    const cfg = await loadJobConfig(db, deps.master, id, { attempt: occ.attempt, control: null, env })
    await deps.run(cfg)
    await deps.remux(cfg.dataDir)
  } catch (e) {
    return stopped(deps, occ, dir, meetingUrl, e)
  }
  await registerArtefacts(db, occ, dir)
  await applyTrigger(db, id, 'summary_done')
  return 'completed'
}

/** Sets `state_reason` of an occurrence that is in `post_processing`; throws when it is not (it changed during the run). */
async function setReason(db: Db, id: string, reason: 'ai_key_error' | null): Promise<void> {
  const updated = await db
    .update(occurrences)
    .set({ stateReason: reason })
    .where(and(eq(occurrences.id, id), eq(occurrences.state, 'post_processing')))
    .returning({ id: occurrences.id })
  if (updated.length !== 1) throw new Error(`Occurrence ${id} left post_processing during its pipeline run`)
}

/** The run threw: a rejected key waits for the member, anything else fails the occurrence. The artefacts that exist are kept. */
async function stopped(
  deps: PipelineDeps,
  occ: OccurrenceRow,
  dir: string,
  meetingUrl: string,
  e: unknown
): Promise<'key_error' | 'failed'> {
  const { db, env } = deps
  await registerArtefacts(db, occ, dir)
  if (e instanceof AiKeyError) {
    console.error(`pipeline: ${occ.id}: the AI key was rejected (${e.status}); waiting for a re-run`)
    await setReason(db, occ.id, 'ai_key_error')
    await deps.notifier.notify(
      occ.memberId,
      pings.aiKeyProblem({
        entry: occ.entryName,
        status: e.status,
        meetingUrl,
        aiKeysUrl: `${new URL(env.publicUrl).origin}/ai-keys`
      })
    )
    return 'key_error'
  }
  console.error(`pipeline: ${occ.id}: failed: ${describeError(e)}`)
  await applyTrigger(db, occ.id, 'fail', { reason: 'pipeline_error' })
  await deps.notifier.notify(occ.memberId, pings.pipelineFailed({ entry: occ.entryName, meetingUrl }))
  return 'failed'
}
