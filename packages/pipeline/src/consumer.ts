import { AiKeyError } from '@tm/ai'
import type { JobConfig, SpecEnv } from '@tm/core'
import { pings } from '@tm/notify'
import { and, eq, sql } from 'drizzle-orm'
import { events, occurrences, type Db } from '@tm/web/db'
import { registerArtefacts } from '@tm/web/db/artefacts'
import { loadJobConfig } from '@tm/web/db/job-config'
import type { Notifier } from '@tm/web/db/notifier'
import { applyTrigger, hashEventData } from '@tm/web/db/transitions'
import { describeError } from './errors'
import type { PipelineResult } from './pipeline'

export interface PipelineDeps {
  db: Db
  notifier: Notifier
  master: Buffer
  env: SpecEnv
  run: (cfg: JobConfig, signal?: AbortSignal) => Promise<PipelineResult>
  /** Makes the browser MP4 in the data directory; true when a checked `meeting.mp4` is in place. */
  remux: (dir: string, signal?: AbortSignal) => Promise<boolean>
}

export type PipelineJobOutcome = 'waiting_for_pc' | 'completed' | 'key_error' | 'failed' | 'stale'

/** What a `post_processing` occurrence may carry when its job starts: nothing, or a re-run after a rejected key. */
const RUNNABLE_REASONS: ReadonlySet<string | null> = new Set([null, 'ai_key_error', 'rerun_queued'])

const dataDirOf = (env: SpecEnv, id: string): string => `${env.dataRoot}/occurrences/${id}`

type OccurrenceRow = typeof occurrences.$inferSelect

/**
 * Runs the pipeline for one occurrence from the queue (the job carries only the occurrence id).
 *
 * - One job per occurrence at a time: the whole call holds a Postgres advisory lock. A job that cannot take it throws, so
 *   pg-boss retries it later instead of completing it: the job holding the lock may still die, and then the retry does
 *   the work. The cost is that a long run uses up retries of its twin (`retryLimit` with a backoff); that twin then
 *   ends as failed in the queue, which is harmless. A job for an occurrence that is not waiting for the pipeline is
 *   dropped (`stale`).
 * - `transcribing`: a `native` occurrence waits for the member's PC (`waiting_for_pc`); a `live` one moves on to
 *   `post_processing`. A job that dies in `post_processing` is run again by pg-boss and starts from there.
 * - The recording is remuxed first, then the pipeline runs with the member's AI config built here (`loadJobConfig`),
 *   then the artefacts are registered; `summary_done` makes it `completed`. A remux that fails does not fail the
 *   meeting: the error is logged and recorded as an `error` event `remux_failed`, the summary is made anyway, and the
 *   meeting page has no player.
 * - A rejected key (`AiKeyError`) keeps the occurrence in `post_processing` with the reason `ai_key_error` and pings once;
 *   the member's re-run queues a new job. Any other error pings and then fails the occurrence (`pipeline_error`): the
 *   ping goes first, so a ping that throws leaves the occurrence in `post_processing` and the retry pings again
 *   (after running the pipeline again), where the other order would lose the ping.
 * - `signal` is the job's: when it aborts (the job expired) the handler stops and throws, and the occurrence is left as
 *   it was for the retry.
 */
export async function handlePipelineJob(
  deps: PipelineDeps,
  occurrenceId: string,
  signal?: AbortSignal
): Promise<PipelineJobOutcome> {
  // The transaction only holds the lock (its connection is idle until the run ends); the work uses the pool.
  return deps.db.transaction(async (lock) => {
    const result = await lock.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${'pipeline:' + occurrenceId}, 0)) as locked`
    )
    if (result.rows[0]?.locked !== true) throw new Error(`pipeline: ${occurrenceId}: another job is running it`)
    return handleLocked(deps, occurrenceId, signal)
  })
}

async function handleLocked(deps: PipelineDeps, id: string, signal?: AbortSignal): Promise<PipelineJobOutcome> {
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

  // The data directory the job config names is used for the remux and the artefacts alike.
  let dir = dataDirOf(env, id)
  let recording = false
  try {
    signal?.throwIfAborted()
    const cfg = await loadJobConfig(db, deps.master, id, { attempt: occ.attempt, control: null, env })
    dir = cfg.dataDir
    recording = await remuxed(deps, occ, dir, signal)
    signal?.throwIfAborted()
    await deps.run(cfg, signal)
    signal?.throwIfAborted()
  } catch (e) {
    // An expired job stops without a verdict: the occurrence stays in `post_processing` for the retry.
    if (signal?.aborted) throw e
    return stopped(deps, occ, dir, recording, meetingUrl, e)
  }
  await registerArtefacts(db, occ, dir, { recording })
  await applyTrigger(db, id, 'summary_done')
  return 'completed'
}

/**
 * Makes the MP4. A failure is logged and recorded as the `remux_failed` event, and the run goes on without a player
 * (false); an abort is rethrown.
 */
async function remuxed(deps: PipelineDeps, occ: OccurrenceRow, dir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return await deps.remux(dir, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    const message = describeError(e)
    console.error(`pipeline: ${occ.id}: REMUX FAILED, the meeting page will have no player: ${message}`)
    const data = { reason: 'remux_failed', message }
    await deps.db
      .insert(events)
      .values({
        occurrenceId: occ.id,
        memberId: occ.memberId,
        attempt: occ.attempt,
        at: new Date(),
        type: 'error',
        data,
        dataHash: hashEventData(data)
      })
      .onConflictDoNothing()
    return false
  }
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
  recording: boolean,
  meetingUrl: string,
  e: unknown
): Promise<'key_error' | 'failed'> {
  const { db, env } = deps
  await registerArtefacts(db, occ, dir, { recording })
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
  // The ping goes first: if it throws, the occurrence is not failed yet and the retry pings again.
  await deps.notifier.notify(occ.memberId, pings.pipelineFailed({ entry: occ.entryName, meetingUrl }))
  await applyTrigger(db, occ.id, 'fail', { reason: 'pipeline_error' })
  return 'failed'
}
