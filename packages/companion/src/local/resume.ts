import type { CompanionJob } from '@tm/core'
import type { KeepAwake } from '../keep-awake'
import type { NativeRunner } from '../jobs/native-runner'
import { resumeOutcome, type LocalJob } from './after'
import { workerName } from './containers'
import type { DockerLike } from './docker'
import type { LocalRunnerDeps } from './run'

export interface ResumeDeps {
  /** The jobs the website lists for this PC. Only `local_run` jobs in the state `claimed` are looked at. */
  jobs: CompanionJob[]
  docker: Pick<DockerLike, 'info' | 'running'>
  /** The data root (the folder that holds `occurrences/`). */
  dataDir: string
  /** `localAfter(...)`: sends the run, then deletes it. */
  after: LocalRunnerDeps['after']
  keepAwake: Pick<KeepAwake, 'acquire'>
  /** A native transcription must not run next to the transcriber of a resumed local run (ASR-02). */
  native: Pick<NativeRunner, 'pause' | 'resume'>
  /**
   * Gives a claimed job that has no local folder and no running worker back to the website (`CompanionApi.release`), so
   * it is offered again: a restart cut it off before anything started. The website refuses once the meeting has begun.
   */
  release(job: CompanionJob): Promise<void>
  /** Told about a job that could not be finished. Its local files stay. */
  onError(job: CompanionJob, error: unknown): void
  /** Stops the work between steps and chunks. */
  signal?: AbortSignal
}

const isClaimedLocal = (j: CompanionJob): j is LocalJob => j.kind === 'local_run' && j.state === 'claimed'

/** Occurrence ids being finished now, so a second call never starts the same upload again. */
const inFlight = new Set<string>()

/**
 * Finishes the local meetings a restart cut off, and gives back those that never started. A run needs this when the website says this PC holds it (`claimed`),
 * its worker container (`tm-run-<occurrence>-*`) is gone, and its folder is still on disk. The outcome is `ended` when
 * the worker joined its recording (`resumeOutcome`), else `crashed`. The upload carries on from the offsets the website
 * reports and the folder goes only after `complete` or `fail` was accepted, so a run is sent whole once. Jobs go one at
 * a time, and the same job is never started twice at once. A claimed job with no worker and no folder was cut off
 * before it began: it is released, which the website allows only while the meeting has not started.
 *
 * Returns false when Docker cannot be asked yet or a release failed (try again later), else true. A job that fails is
 * passed to `onError` and the others go on; a stop through `signal` ends the loop quietly.
 */
export async function resumeLocalRuns(d: ResumeDeps): Promise<boolean> {
  const candidates = d.jobs.filter(isClaimedLocal).filter((j) => !inFlight.has(j.payload.occurrenceId))
  if (candidates.length === 0) return true
  // Marked before the first await, so a call that starts meanwhile skips them.
  for (const j of candidates) inFlight.add(j.payload.occurrenceId)
  try {
    if ((await d.docker.info()) === null) return false
    const names = (await d.docker.running()).map((c) => c.name)
    const todo: { job: LocalJob; outcome: NonNullable<Awaited<ReturnType<typeof resumeOutcome>>> }[] = []
    let retry = false
    for (const job of candidates) {
      const prefix = workerName(job.payload.occurrenceId, 0).slice(0, -1) // `tm-run-<occurrence>-`
      if (names.some((n) => n.startsWith(prefix))) continue
      const outcome = await resumeOutcome(job, d.dataDir)
      if (outcome !== null) todo.push({ job, outcome })
      else {
        try {
          await d.release(job)
        } catch (e) {
          d.onError(job, e)
          retry = true
        }
      }
    }
    if (todo.length === 0) return !retry

    await d.native.pause()
    try {
      for (const { job, outcome } of todo) {
        if (d.signal?.aborted) break
        const release = d.keepAwake.acquire(job.payload.occurrenceId)
        try {
          await d.after(job, d.dataDir, outcome)
        } catch (e) {
          d.onError(job, e)
        } finally {
          release()
        }
      }
    } finally {
      d.native.resume()
    }
    return !retry
  } finally {
    for (const j of candidates) inFlight.delete(j.payload.occurrenceId)
  }
}
