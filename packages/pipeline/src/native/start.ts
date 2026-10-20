import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { PC_CLAIM_GRACE_MS, type JobConfig } from '@tm/core'
import { and, eq, inArray } from 'drizzle-orm'
import { companionJobs, type Db } from '@tm/web/db'
import { createCompanionJob, emitCompanionEvent } from '@tm/web/db/companion'
import { QUEUES, queueDbOf, type Queue } from '@tm/web/db/queues'
import { extractFlac } from './flac'

export interface NativeStartDeps {
  db: Db
  queue: Queue
}

/** What the job needs from the occurrence; the pipeline consumer has all of it from the occurrence row. */
export interface NativeStartInput {
  occurrenceId: string
  memberId: string
  dataDir: string
  entry: Pick<JobConfig['entry'], 'name' | 'start' | 'timeZone'>
}

/**
 * True when `transcript/native/audio.json` is in the occurrence directory, that is, a PC has already uploaded the
 * transcript. Only the name is looked up (never the content, never through a link); whether the file is safe to read is
 * `readNativeTranscript`'s decision, which refuses a link or a file outside the directory loudly.
 */
export async function nativeTranscriptExists(dataDir: string): Promise<boolean> {
  const info = await lstat(join(await realpath(dataDir), 'transcript', 'native', 'audio.json')).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
  )
  return info !== null
}

/**
 * Starts the native transcription of an occurrence that is in `transcribing`, and returns the id of the companion job.
 * Returns null, doing nothing, when the transcript is already uploaded (the pipeline then carries on as for live mode).
 *
 * Called by the pipeline consumer with the pipeline lock held and after the worker container is gone. An occurrence
 * that already has an active (`pending` or `claimed`) native job gets that job's id back and nothing else happens, so a
 * pipeline job that runs twice never makes a second job or cuts the FLAC again. Otherwise the audio is cut
 * (`extractFlac`), then one transaction creates the job, announces it to the member's PCs (`job_available`) and sends
 * `native-job-check` at the end of the claim grace (`PC_CLAIM_GRACE_MS`): a job that no PC has claimed by then moves the
 * occurrence to `waiting_for_pc` (scheduler `native-check.ts`). The three commit or roll back together.
 */
export async function startNativeTranscription(
  deps: NativeStartDeps,
  input: NativeStartInput,
  signal?: AbortSignal,
  now: Date = new Date()
): Promise<string | null> {
  if (await nativeTranscriptExists(input.dataDir)) return null
  const [active] = await deps.db
    .select({ id: companionJobs.id })
    .from(companionJobs)
    .where(
      and(
        eq(companionJobs.occurrenceId, input.occurrenceId),
        eq(companionJobs.kind, 'native_transcription'),
        inArray(companionJobs.state, ['pending', 'claimed'])
      )
    )
  if (active) return active.id

  const flac = await extractFlac(input.dataDir, signal)
  signal?.throwIfAborted()
  return deps.db.transaction(async (tx) => {
    const jobId = await createCompanionJob(tx, {
      memberId: input.memberId,
      occurrenceId: input.occurrenceId,
      kind: 'native_transcription',
      payload: {
        occurrenceId: input.occurrenceId,
        entryName: input.entry.name,
        start: input.entry.start,
        timeZone: input.entry.timeZone,
        durationSec: Math.max(1, Math.ceil(flac.durationSec)),
        flacBytes: flac.bytes
      }
    })
    await emitCompanionEvent(tx, input.memberId, { type: 'job_available', jobId })
    await deps.queue.send(
      QUEUES.nativeJobCheck,
      { jobId },
      { startAfter: new Date(now.getTime() + PC_CLAIM_GRACE_MS), db: queueDbOf(tx) }
    )
    return jobId
  })
}
