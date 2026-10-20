import { JOB_LEASE_MS, meetingUrl, type SpecEnv } from '@tm/core'
import { pings } from '@tm/notify'
import { eq } from 'drizzle-orm'
import { companionJobs, occurrences } from '@tm/web/db'
import { getJob, markPcPingSent, releaseExpiredLeases } from '@tm/web/db/companion'
import { QUEUES } from '@tm/web/db/queues'
import { applyTrigger } from '@tm/web/db/transitions'
import { z } from 'zod'
import type { LaunchDeps } from './launch'

const CheckData = z.strictObject({ jobId: z.uuid() })

/** What the check uses of `LaunchDeps`. */
export type NativeCheckDeps = Pick<LaunchDeps, 'db' | 'queue' | 'notifier'> & { env: Pick<SpecEnv, 'publicUrl'> }

/** `stale` is a job or occurrence that is gone or no longer waiting for a PC; the others are the job's own state. */
export type NativeCheckResult = 'done' | 'failed' | 'claimed' | 'waiting_for_pc' | 'stale'

/**
 * One look at a native transcription job, from `native-job-check` (sent when the job is created and by this function
 * itself, so one chain of checks follows each job):
 *
 * - A `done` or `failed` job ends the chain.
 * - Leases that lapsed are released first (`releaseExpiredLeases`): a PC that went quiet has its job back.
 * - A `pending` job (no PC has it) moves a `transcribing` occurrence to `waiting_for_pc` and, the first time only,
 *   pings the member (`pings.waitingForPc`; the job's `pc_ping_sent_at` is set only after the ping went out, so a ping
 *   that fails is tried again by the next check and one that succeeded is never repeated, also when a lapsed lease brings
 *   the job back later).
 * - A `claimed` job whose occurrence still says `waiting_for_pc` (the PC claimed it between this check's read and its
 *   move) takes the occurrence back to `transcribing` (`pc_claimed`), as the claim route does.
 * - While the job is `pending` or `claimed` the next check is queued `JOB_LEASE_MS` later.
 *
 * Throws for a bad job body, so the queue retries it and then dead-letters it. A job, or an occurrence in any other
 * state (deleted, or already past the transcript), is `stale`: the chain ends.
 */
export async function checkNativeJob(deps: NativeCheckDeps, jobId: string, now: Date): Promise<NativeCheckResult> {
  const { db } = deps
  const first = await getJob(db, jobId)
  if (first === null) {
    console.error(`native-job-check: ${jobId}: no such job; the check is dropped`)
    return 'stale'
  }
  if (first.state === 'done' || first.state === 'failed') return first.state
  await releaseExpiredLeases(db, now)
  const job = (await getJob(db, jobId))!
  const [occ] = await db.select().from(occurrences).where(eq(occurrences.id, job.occurrenceId))
  if (!occ || (occ.state !== 'transcribing' && occ.state !== 'waiting_for_pc')) {
    console.error(`native-job-check: ${jobId}: the occurrence is ${occ ? occ.state : 'gone'}; the check is dropped`)
    return 'stale'
  }

  let result: NativeCheckResult
  if (job.state === 'pending') {
    if (occ.state === 'transcribing') await applyTrigger(db, occ.id, 'wait_for_pc')
    const [row] = await db
      .select({ sent: companionJobs.pcPingSentAt })
      .from(companionJobs)
      .where(eq(companionJobs.id, jobId))
    if (row!.sent === null) {
      const url = meetingUrl(deps.env.publicUrl, occ.id)
      if (await deps.notifier.notify(occ.memberId, pings.waitingForPc({ entry: occ.entryName, meetingUrl: url }))) {
        await markPcPingSent(db, jobId, now)
      }
    }
    result = 'waiting_for_pc'
  } else {
    if (occ.state === 'waiting_for_pc') await applyTrigger(db, occ.id, 'pc_claimed')
    result = 'claimed'
  }
  await deps.queue.send(QUEUES.nativeJobCheck, { jobId }, { startAfter: new Date(now.getTime() + JOB_LEASE_MS) })
  return result
}

/**
 * The `native-job-check` handler: sent at +120 s after a native transcription job is created, it moves a recording that
 * no PC has claimed to `waiting_for_pc`. Returns the outcome for the log.
 */
export async function handleNativeJobCheck(deps: NativeCheckDeps, data: unknown, now: Date): Promise<string> {
  return checkNativeJob(deps, CheckData.parse(data).jobId, now)
}

/**
 * The `native-job-dead` handler: a check whose retries are spent (a database that was down for a while) must not
 * strand the recording in `transcribing`. It does what the check does, which also starts the chain of checks again; if
 * it throws too (ntfy down is not a throw, a database error is), the dead-letter queue tries it again for an hour.
 */
export async function handleNativeJobDead(deps: NativeCheckDeps, data: unknown, now: Date): Promise<string> {
  return checkNativeJob(deps, CheckData.parse(data).jobId, now)
}
