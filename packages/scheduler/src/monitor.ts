import { stat } from 'node:fs/promises'
import { ACTIVE_STATES, IllegalTransition, WORKER_STATES, type OccurrenceState } from '@tm/core'
import { pings, type WorkerFailureReason } from '@tm/notify'
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import { events, occurrences, profiles } from '@tm/web/db'
import { applyTrigger, hashEventData } from '@tm/web/db/transitions'
import { jobFileBase, resolveEnv } from './container-spec'
import { DockerError, type DockerClient } from './docker'
import { removeJobFiles } from './job-files'
import { startAttempt, type LaunchDeps } from './launch'
import { releaseProfile } from './locks'
import { checkpointFiles } from './retention'

/** A worker whose last heartbeat is older than this has crashed. */
export const HEARTBEAT_TIMEOUT_MS = 30_000
/** A crashed worker is restarted at most this many times per occurrence. */
export const MAX_RESTARTS = 3
/** Past `scheduled_end` by this long, a worker is told to stop. */
export const STOP_AFTER_END_MS = 35 * 60_000
/** Past `scheduled_end` by this long, a worker is stopped and the occurrence fails. */
export const KILL_AFTER_END_MS = 45 * 60_000

/** No restart once the meeting ended this long ago: there is nothing left to rejoin. */
const RESTART_UNTIL_END_MS = 30 * 60_000
/** A worker that has been quiet this long and whose container is gone has died (not just finished its last beat). */
const GONE_GRACE_MS = 10_000
const STOP_TIMEOUT_S = 5
/** Job and key files are deleted this long after launch even if the worker never sent a heartbeat. */
const JOB_FILES_MAX_AGE_MS = 120_000

type OccurrenceRow = typeof occurrences.$inferSelect

export type MonitorResult = { restarted: string[]; failed: string[]; released: string[] }

const isWorkerState = (s: OccurrenceState): boolean => (WORKER_STATES as ReadonlySet<string>).has(s)

const meetingUrl = (deps: LaunchDeps, row: OccurrenceRow): string =>
  `${resolveEnv(deps.env).publicUrl}/meetings/${row.id}`

/** What Docker says about a container. `unknown` (Docker unreachable or refusing) is never treated as `gone`. */
async function containerView(docker: DockerClient, name: string | null): Promise<'running' | 'gone' | 'unknown'> {
  if (name === null) return 'gone'
  try {
    const state = await docker.inspect(name)
    return state === null || !state.running ? 'gone' : 'running'
  } catch (e) {
    if (!(e instanceof DockerError)) throw e
    console.error(`monitor: ${e.message}`)
    return 'unknown'
  }
}

/** Stops the container and waits. A container that is already gone is fine; any other Docker failure is thrown. */
async function stopContainer(docker: DockerClient, name: string | null): Promise<void> {
  if (name === null) return
  try {
    await docker.stop(name, STOP_TIMEOUT_S)
  } catch (e) {
    if (e instanceof DockerError && e.status === 404) return
    throw e
  }
}

/**
 * Stops the container, fails the occurrence, gives the profile back and pings the member. The container is stopped
 * first: if Docker can't do that, nothing changes, so a worker that may still run never loses its profile.
 */
async function failWorker(
  deps: LaunchDeps,
  row: OccurrenceRow,
  reason: 'worker_unresponsive' | 'overran_hard_stop',
  ping: WorkerFailureReason
): Promise<boolean> {
  await stopContainer(deps.docker, row.containerName)
  try {
    await applyTrigger(deps.db, row.id, 'fail', { reason })
  } catch (e) {
    // The occurrence ended some other way since it was read.
    if (e instanceof IllegalTransition) return false
    throw e
  }
  await releaseProfile(deps.db, row.identityId, `occ:${row.id}`)
  await deps.notifier.notify(
    row.memberId,
    pings.workerFailed({ entry: row.entryName, reason: ping, meetingUrl: meetingUrl(deps, row) })
  )
  return true
}

/** Crashes the worker, stops its container and starts the next attempt; `failed` when that attempt could not start. */
async function restart(deps: LaunchDeps, occurrenceId: string, now: Date): Promise<'restarted' | 'failed'> {
  const { db } = deps
  const [row] = await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!row) throw new Error(`No occurrence ${occurrenceId}`)
  // Two workers must never run for one identity, so the old one is stopped before anything else changes.
  await stopContainer(deps.docker, row.containerName)
  const { restarts } = await applyTrigger(db, occurrenceId, 'crash')
  if (restarts > MAX_RESTARTS) {
    // Another crash was counted since the caller looked.
    await applyTrigger(db, occurrenceId, 'fail', { reason: 'worker_unresponsive' })
    await releaseProfile(db, row.identityId, `occ:${row.id}`)
    await deps.notifier.notify(
      row.memberId,
      pings.workerFailed({ entry: row.entryName, reason: 'it crashed 3 times', meetingUrl: meetingUrl(deps, row) })
    )
    return 'failed'
  }
  await startAttempt(deps, occurrenceId, row.attempt + 1, now)
  const [after] = await db
    .select({ state: occurrences.state })
    .from(occurrences)
    .where(eq(occurrences.id, occurrenceId))
  // startAttempt already failed the occurrence and pinged the member.
  if (after?.state === 'failed') return 'failed'
  await deps.notifier.notify(
    row.memberId,
    pings.workerRestarted({ entry: row.entryName, n: restarts, meetingUrl: meetingUrl(deps, row) })
  )
  return 'restarted'
}

/**
 * Applies `crash` to an occurrence, stops its old container (5 seconds to stop), and starts the next attempt. The restart
 * count is incremented by `crash` itself; the member is pinged after the new container started. Throws a `DockerError`,
 * before anything changes, when the old container can't be stopped.
 */
export async function restartOccurrence(deps: LaunchDeps, occurrenceId: string, now: Date): Promise<void> {
  await restart(deps, occurrenceId, now)
}

// --- monitorTick ---------------------------------------------------------------------------------------------------

const ticking = new WeakSet<object>()

/**
 * One pass, every 5 seconds from the scheduler:
 * - a worker quiet for 30 seconds, or whose container is gone, crashed: it is restarted up to 3 times while the meeting
 *   ended less than 30 minutes ago, else it fails with `worker_unresponsive`;
 * - a worker still running 35 minutes after the meeting end is told to stop, and at 45 minutes it is stopped and failed;
 * - the container of an occurrence that is no longer active frees the profile once it is gone, and the newest
 *   checkpoint on disk is recorded;
 * - the job and key files of a running worker go once it has sent a heartbeat, or after 120 seconds.
 * Docker that can't be asked is never read as "gone": nothing is restarted, failed or released on it. A pass that starts
 * while the last one runs does nothing.
 */
export async function monitorTick(deps: LaunchDeps, now: Date): Promise<MonitorResult> {
  const result: MonitorResult = { restarted: [], failed: [], released: [] }
  if (ticking.has(deps.db)) return result
  ticking.add(deps.db)
  try {
    const active = await deps.db
      .select()
      .from(occurrences)
      .where(inArray(occurrences.state, [...ACTIVE_STATES]))
    const handled = new Set<string>()
    for (const row of active) {
      try {
        const outcome = await watch(deps, row, now)
        if (outcome === 'restarted' || outcome === 'failed') {
          handled.add(row.id)
          result[outcome].push(row.id)
        }
      } catch (e) {
        // A Docker failure for one occurrence leaves it as it was; the next pass looks again.
        if (!(e instanceof DockerError)) throw e
        console.error(`monitor: ${e.message}`)
      }
    }
    for (const row of active) if (!handled.has(row.id)) await removeLaunchFiles(deps, row, now)
    result.released.push(...(await releaseFinished(deps)))
    return result
  } finally {
    ticking.delete(deps.db)
  }
}

/** The crash, hard-stop and stop-command checks for one active occurrence. */
async function watch(deps: LaunchDeps, row: OccurrenceRow, now: Date): Promise<'restarted' | 'failed' | null> {
  const { db } = deps
  const t = now.getTime()
  const end = row.scheduledEnd.getTime()
  const isWorker = isWorkerState(row.state)

  if (isWorker && t >= end + KILL_AFTER_END_MS) {
    return (await failWorker(deps, row, 'overran_hard_stop', 'it ran past the hard stop')) ? 'failed' : null
  }

  const quietMs = row.lastHeartbeatAt === null ? Infinity : t - row.lastHeartbeatAt.getTime()
  if (quietMs >= GONE_GRACE_MS) {
    const view = await containerView(deps.docker, row.containerName)
    const stale = quietMs > HEARTBEAT_TIMEOUT_MS
    if (view !== 'unknown' && (stale || view === 'gone')) {
      // Claim the crash: a heartbeat that landed since the read keeps the worker alive.
      const cutoff = new Date(t - (stale ? HEARTBEAT_TIMEOUT_MS : GONE_GRACE_MS))
      const claimed = await db
        .update(occurrences)
        .set({ lastHeartbeatAt: now })
        .where(
          and(
            eq(occurrences.id, row.id),
            eq(occurrences.attempt, row.attempt),
            eq(occurrences.state, row.state),
            sql`(${occurrences.lastHeartbeatAt} is null or ${occurrences.lastHeartbeatAt} < ${cutoff.toISOString()}::timestamptz)`
          )
        )
        .returning({ id: occurrences.id })
      if (claimed.length === 0) return null
      if (row.restarts < MAX_RESTARTS && t < end + RESTART_UNTIL_END_MS) return restart(deps, row.id, now)
      return (await failWorker(deps, row, 'worker_unresponsive', 'it crashed 3 times')) ? 'failed' : null
    }
  }

  if (isWorker && t >= end + STOP_AFTER_END_MS) await requestStop(deps, row, end + STOP_AFTER_END_MS)
  return null
}

/** Appends `stop` to the pending commands once per attempt; the event row (same time, same data) is the once-marker. */
async function requestStop(deps: LaunchDeps, row: OccurrenceRow, at: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const data = { reason: 'stop_requested_after_end' }
    const marked = await tx
      .insert(events)
      .values({
        occurrenceId: row.id,
        memberId: row.memberId,
        attempt: row.attempt,
        at: new Date(at),
        type: 'error',
        data,
        dataHash: hashEventData(data)
      })
      .onConflictDoNothing()
      .returning({ id: events.id })
    if (marked.length === 0) return
    await tx
      .update(occurrences)
      .set({ pendingCommands: sql`array_append(${occurrences.pendingCommands}, 'stop')` })
      .where(and(eq(occurrences.id, row.id), sql`not ('stop' = any(${occurrences.pendingCommands}))`))
  })
}

/** Deletes the attempt's job and key files once the worker has sent a heartbeat since the launch, or after 120 seconds. */
async function removeLaunchFiles(deps: LaunchDeps, row: OccurrenceRow, now: Date): Promise<void> {
  if (row.containerName === null) return
  const base = jobFileBase({
    kind: 'worker',
    occurrenceId: row.id,
    attempt: row.attempt,
    identityId: row.identityId,
    env: deps.env
  })
  // The job file's age is the time since the launch wrote it.
  const info = await stat(`${base}.json`).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (info === null) return
  const beat = row.lastHeartbeatAt !== null && row.lastHeartbeatAt.getTime() > info.mtimeMs
  if (beat || now.getTime() - info.mtimeMs >= JOB_FILES_MAX_AGE_MS) await removeJobFiles(base)
}

/**
 * An occurrence that is no longer active but still names a container: once Docker says the container is gone, forget
 * it, give the profile back and record the newest checkpoint.
 */
async function releaseFinished(deps: LaunchDeps): Promise<string[]> {
  const { db } = deps
  const rows = await db
    .select()
    .from(occurrences)
    .where(and(notInArray(occurrences.state, [...ACTIVE_STATES]), isNotNull(occurrences.containerName)))
  const released: string[] = []
  for (const row of rows) {
    if ((await containerView(deps.docker, row.containerName)) !== 'gone') continue
    await db
      .update(occurrences)
      .set({ containerName: null })
      .where(and(eq(occurrences.id, row.id), eq(occurrences.containerName, row.containerName!)))
    await releaseProfile(db, row.identityId, `occ:${row.id}`)
    const newest = (await checkpointFiles(deps.env.profileRoot, row.identityId)).at(-1)
    if (newest !== undefined) {
      const path = `${deps.env.profileRoot}/${row.identityId}/checkpoints/${newest}`
      await db
        .update(profiles)
        .set({ latestCheckpoint: path, checkpointAt: (await stat(path)).mtime })
        .where(and(eq(profiles.identityId, row.identityId), eq(profiles.memberId, row.memberId)))
    }
    released.push(row.id)
  }
  return released
}
