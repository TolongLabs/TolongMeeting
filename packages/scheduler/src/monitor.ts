import { stat } from 'node:fs/promises'
import { ACTIVE_STATES, IllegalTransition, WORKER_STATES, type OccurrenceState } from '@tm/core'
import { pings, type WorkerFailureReason } from '@tm/notify'
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import { events, occurrences, profiles } from '@tm/web/db'
import { registerArtefacts } from '@tm/web/db/artefacts'
import { applyTrigger, hashEventData } from '@tm/web/db/transitions'
import { jobFileBase, resolveEnv } from './container-spec'
import { DockerError, type DockerClient } from './docker'
import { removeJobFiles } from './job-files'
import { startAttempt, type LaunchDeps } from './launch'
import { releaseProfile } from './locks'
import { checkpointFiles } from './retention'
import { monitorSignins } from './signin'

/** A worker whose last heartbeat is older than this has crashed. */
export const HEARTBEAT_TIMEOUT_MS = 30_000
/** A crashed worker is restarted at most this many times per occurrence. */
export const MAX_RESTARTS = 3
/** Past `scheduled_end` by this long, a worker is told to stop. */
export const STOP_AFTER_END_MS = 35 * 60_000
/** Past `scheduled_end` by this long, a worker is stopped and the occurrence fails. */
export const KILL_AFTER_END_MS = 45 * 60_000

/** A worker that can't be checked (stale heartbeat while Docker is unknown, or stop fails) this long gets one ping. */
export const UNREACHABLE_PING_MS = 5 * 60_000
/** ... and this long, the occurrence fails with `worker_unreachable`; the profile stays held until Docker says it's gone. */
export const UNREACHABLE_FAIL_MS = 15 * 60_000

/** No restart once the meeting ended this long ago: there is nothing left to rejoin. */
const RESTART_UNTIL_END_MS = 30 * 60_000
/** A worker that has been quiet this long and whose container is gone has died (not just finished its last beat). */
const GONE_GRACE_MS = 10_000
const STOP_TIMEOUT_S = 5
/** A Docker problem is logged at most this often per occurrence. */
const LOG_EVERY_MS = 60_000
/** A tick that has run this long is declared stuck, and the next tick runs anyway. */
const TICK_STUCK_MS = 60_000
/** Job and key files are deleted this long after launch even if the worker never sent a heartbeat. */
const JOB_FILES_MAX_AGE_MS = 120_000

type OccurrenceRow = typeof occurrences.$inferSelect

export type MonitorResult = { restarted: string[]; failed: string[]; released: string[] }

const isWorkerState = (s: OccurrenceState): boolean => (WORKER_STATES as ReadonlySet<string>).has(s)

const meetingUrl = (deps: LaunchDeps, row: OccurrenceRow): string =>
  `${resolveEnv(deps.env).publicUrl}/meetings/${row.id}`

// Per scheduler process. A quiet worker's clock starts 30 seconds after its last heartbeat, which the database keeps, so
// a scheduler restart does not delay the ping or the failure, and an `error` event marks the ping as sent. (A worker past
// its hard stop has no such anchor: its clock restarts with the scheduler, which is then one ceiling late at most.)
const unreachable = new Map<string, { since: number; pinged: boolean }>()
const lastLogged = new Map<string, number>()

/** Logs a Docker problem for an occurrence at most once a minute. */
function logDocker(occurrenceId: string, now: Date, message: string): void {
  const last = lastLogged.get(occurrenceId)
  if (last !== undefined && now.getTime() - last < LOG_EVERY_MS) return
  lastLogged.set(occurrenceId, now.getTime())
  console.error(`monitor: ${message}`)
}

/**
 * What Docker says about a container; with `removeStopped` a stopped one is removed first. `unknown` (Docker
 * unreachable or refusing) is never treated as `gone`.
 */
async function containerView(
  docker: DockerClient,
  name: string | null,
  log: { id: string; now: Date },
  removeStopped = false
): Promise<'running' | 'gone' | 'unknown'> {
  if (name === null) return 'gone'
  try {
    const state = await docker.inspect(name)
    if (state?.running) return 'running'
    // Exists but is not running (created and never started: AutoRemove only covers one that ran and exited). It is
    // `gone` once removed; a removal that fails leaves it `unknown`, so the profile stays held and the next pass retries.
    if (state !== null && removeStopped) await docker.remove(name)
    return 'gone'
  } catch (e) {
    if (!(e instanceof DockerError)) throw e
    logDocker(log.id, log.now, e.message)
    return 'unknown'
  }
}

/** Whether the occurrence is still on the attempt and in the state a function read it in (a stuck tick may wake late). */
async function unchanged(deps: LaunchDeps, row: OccurrenceRow): Promise<boolean> {
  const [now] = await deps.db
    .select({ attempt: occurrences.attempt, state: occurrences.state })
    .from(occurrences)
    .where(eq(occurrences.id, row.id))
  return now?.attempt === row.attempt && now.state === row.state
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
  // A tick that was stuck in the stop may wake up after another tick restarted or failed this occurrence.
  if (!(await unchanged(deps, row))) return false
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

/**
 * Crashes the worker, stops its container and starts the next attempt; `failed` when that attempt could not start,
 * `skipped` when the occurrence changed while the old container was being stopped.
 */
async function restart(deps: LaunchDeps, occurrenceId: string, now: Date): Promise<'restarted' | 'failed' | 'skipped'> {
  const { db } = deps
  const [row] = await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!row) throw new Error(`No occurrence ${occurrenceId}`)
  // Two workers must never run for one identity, so the old one is stopped before anything else changes.
  await stopContainer(deps.docker, row.containerName)
  if (!(await unchanged(deps, row))) return 'skipped'
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
 *
 * For one caller at a time: it takes no claim, so two concurrent calls for the same occurrence would crash it twice
 * (the second one is skipped only if the first has finished crashing it by the time the old container is stopped).
 * `monitorTick` takes its own claim before it restarts anything.
 */
export async function restartOccurrence(deps: LaunchDeps, occurrenceId: string, now: Date): Promise<void> {
  await restart(deps, occurrenceId, now)
}

// --- monitorTick ---------------------------------------------------------------------------------------------------

// The tick that holds the guard for a database, and when (by the tick clock) it started.
const ticking = new WeakMap<object, { startedAt: number }>()

/**
 * One pass, every 5 seconds from the scheduler:
 * - a worker quiet for 30 seconds, or whose container is gone, crashed: it is restarted up to 3 times while the meeting
 *   ended less than 30 minutes ago, else it fails with `worker_unresponsive`;
 * - a worker still running 35 minutes after the meeting end is told to stop, and at 45 minutes it is stopped and failed;
 * - a worker that can't be checked (quiet for 30 seconds while Docker can't be asked, or its container can't be stopped)
 *   gets one ping after 5 minutes and fails with `worker_unreachable` after 15, with its profile still held;
 * - the container of an occurrence that is no longer active frees the profile once it is gone, and the newest
 *   checkpoint on disk is recorded;
 * - the job and key files of a running worker go once it has sent a heartbeat, or after 120 seconds.
 * Docker that can't be asked is never read as "gone": nothing is restarted, failed or released on it. A pass that starts
 * while the last one runs does nothing, unless the last one has run for 60 seconds: that one is logged as stuck and
 * this pass runs. The stuck pass's later writes are guarded (claims, state checks), so they can't undo this one's.
 */
export async function monitorTick(deps: LaunchDeps, now: Date): Promise<MonitorResult> {
  const result: MonitorResult = { restarted: [], failed: [], released: [] }
  const running = ticking.get(deps.db)
  if (running !== undefined) {
    if (now.getTime() - running.startedAt < TICK_STUCK_MS) return result
    console.error(
      `monitor: STUCK: a tick has run for ${Math.round((now.getTime() - running.startedAt) / 1000)} seconds; running the next one anyway`
    )
  }
  const mine = { startedAt: now.getTime() }
  ticking.set(deps.db, mine)
  try {
    // The sign-in sessions are their own step: a throw while watching workers can't leave a session unhandled.
    const errors: unknown[] = []
    try {
      await watchWorkers(deps, now, result)
    } catch (e) {
      errors.push(e)
    }
    try {
      await monitorSignins(deps, now)
    } catch (e) {
      errors.push(e)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'monitor: the pass failed in more than one step')
    return result
  } finally {
    if (ticking.get(deps.db) === mine) ticking.delete(deps.db)
  }
}

/** The worker half of a tick: watch every active occurrence, delete launch files, release finished containers. */
async function watchWorkers(deps: LaunchDeps, now: Date, result: MonitorResult): Promise<void> {
  const active = await deps.db
    .select()
    .from(occurrences)
    .where(inArray(occurrences.state, [...ACTIVE_STATES]))
  const handled = new Set<string>()
  const keys = new Set(active.map(trackKey))
  for (const key of unreachable.keys()) if (!keys.has(key)) unreachable.delete(key)
  for (const [id, at] of lastLogged) if (now.getTime() - at > 10 * LOG_EVERY_MS) lastLogged.delete(id)
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
      logDocker(row.id, now, e.message)
      if ((await noteUnreachable(deps, row, now)) === 'failed') {
        handled.add(row.id)
        result.failed.push(row.id)
      }
    }
  }
  for (const row of active) if (!handled.has(row.id)) await removeLaunchFiles(deps, row, now)
  result.released.push(...(await releaseFinished(deps, now)))
}

const trackKey = (row: OccurrenceRow): string => `${row.id}:${row.attempt}`

const quietFor = (row: OccurrenceRow, now: Date): number =>
  row.lastHeartbeatAt === null ? Infinity : now.getTime() - row.lastHeartbeatAt.getTime()
const isStale = (row: OccurrenceRow, now: Date): boolean => quietFor(row, now) > HEARTBEAT_TIMEOUT_MS
const hasOverrun = (row: OccurrenceRow, now: Date): boolean =>
  isWorkerState(row.state) && now.getTime() >= row.scheduledEnd.getTime() + KILL_AFTER_END_MS

/**
 * Called when a worker that needs attention (quiet for 30 seconds, or past its hard stop) can't be dealt with because
 * Docker can't be asked or won't stop it. The clock starts 30 seconds after the last heartbeat (at the first call for a
 * worker past its hard stop); 5 minutes later the member gets one ping, and 15 minutes later the occurrence fails with
 * `worker_unreachable`. The container name and the profile are kept, so `releaseFinished` frees the profile only once Docker says the container is gone. A worker that comes back is sent
 * `stop` in its next reply.
 */
async function noteUnreachable(deps: LaunchDeps, row: OccurrenceRow, now: Date): Promise<'failed' | null> {
  const stale = isStale(row, now)
  if (!stale && !hasOverrun(row, now)) return null
  const key = trackKey(row)
  const t = now.getTime()
  let entry = unreachable.get(key)
  if (entry === undefined) {
    const since = stale && row.lastHeartbeatAt !== null ? row.lastHeartbeatAt.getTime() + HEARTBEAT_TIMEOUT_MS : t
    entry = { since, pinged: false }
    unreachable.set(key, entry)
  }
  const age = t - entry.since
  const url = meetingUrl(deps, row)
  if (age >= UNREACHABLE_FAIL_MS) {
    // A heartbeat since the clock started means the worker is alive after all.
    const [fresh] = await deps.db
      .select({ at: occurrences.lastHeartbeatAt })
      .from(occurrences)
      .where(eq(occurrences.id, row.id))
    if (stale && fresh?.at != null && fresh.at.getTime() > entry.since) {
      unreachable.delete(key)
      return null
    }
    try {
      await applyTrigger(deps.db, row.id, 'fail', { reason: 'worker_unreachable' })
    } catch (e) {
      if (!(e instanceof IllegalTransition)) throw e
      unreachable.delete(key)
      return null
    }
    await deps.db
      .update(occurrences)
      .set({ pendingCommands: sql`array_append(${occurrences.pendingCommands}, 'stop')` })
      .where(and(eq(occurrences.id, row.id), sql`not ('stop' = any(${occurrences.pendingCommands}))`))
    unreachable.delete(key)
    await deps.notifier.notify(
      row.memberId,
      pings.workerFailed({ entry: row.entryName, reason: 'worker_unreachable', meetingUrl: url })
    )
    return 'failed'
  }
  if (age >= UNREACHABLE_PING_MS && !entry.pinged) {
    entry.pinged = true
    // The event row (same time, same data) is the once-marker, so a scheduler restart does not ping again.
    const data = { reason: 'worker_unchecked_pinged' }
    const marked = await deps.db
      .insert(events)
      .values({
        occurrenceId: row.id,
        memberId: row.memberId,
        attempt: row.attempt,
        at: new Date(entry.since + UNREACHABLE_PING_MS),
        type: 'error',
        data,
        dataHash: hashEventData(data)
      })
      .onConflictDoNothing()
      .returning({ id: events.id })
    if (marked.length > 0)
      await deps.notifier.notify(row.memberId, pings.workerUnchecked({ entry: row.entryName, meetingUrl: url }))
  }
  return null
}

/** The crash, hard-stop and stop-command checks for one active occurrence. */
async function watch(deps: LaunchDeps, row: OccurrenceRow, now: Date): Promise<'restarted' | 'failed' | null> {
  const { db } = deps
  const t = now.getTime()
  const end = row.scheduledEnd.getTime()
  const isWorker = isWorkerState(row.state)
  // Healthy again (or never unreachable): the unreachable clock starts over next time.
  if (!isStale(row, now) && !hasOverrun(row, now)) unreachable.delete(trackKey(row))

  if (isWorker && t >= end + KILL_AFTER_END_MS) {
    return (await failWorker(deps, row, 'overran_hard_stop', 'it ran past the hard stop')) ? 'failed' : null
  }

  const quietMs = quietFor(row, now)
  if (quietMs >= GONE_GRACE_MS) {
    const view = await containerView(deps.docker, row.containerName, { id: row.id, now })
    const stale = quietMs > HEARTBEAT_TIMEOUT_MS
    if (view === 'unknown' && stale) return noteUnreachable(deps, row, now)
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
      try {
        if (row.restarts < MAX_RESTARTS && t < end + RESTART_UNTIL_END_MS) {
          const outcome = await restart(deps, row.id, now)
          return outcome === 'skipped' ? null : outcome
        }
        return (await failWorker(deps, row, 'worker_unresponsive', 'it crashed 3 times')) ? 'failed' : null
      } catch (e) {
        // The old container couldn't be stopped, so nothing changed: hand the claim back, or the worker would look
        // alive for 30 more seconds on every try and the unreachable clock could never run.
        if (e instanceof DockerError)
          await db
            .update(occurrences)
            .set({ lastHeartbeatAt: row.lastHeartbeatAt })
            .where(
              and(
                eq(occurrences.id, row.id),
                eq(occurrences.attempt, row.attempt),
                eq(occurrences.state, row.state),
                eq(occurrences.lastHeartbeatAt, now)
              )
            )
        throw e
      }
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

/** The end states a meeting can reach without the pipeline: their recording and form screenshots are registered here. */
const WITHOUT_PIPELINE: ReadonlySet<OccurrenceState> = new Set(['no_link', 'denied', 'left_by_member', 'failed'])
/** One remux may take this long; a recording is copied, not re-encoded, so a long lecture still takes minutes at most. */
const REMUX_TIMEOUT_MS = 10 * 60_000

/**
 * Makes the MP4 of a meeting that ended without the pipeline (bounded by `REMUX_TIMEOUT_MS`), then registers its files.
 * A remux that fails is logged and recorded as the `remux_failed` event; the other files are registered anyway, and the
 * meeting page has no player.
 */
async function registerFinished(deps: LaunchDeps, row: OccurrenceRow): Promise<void> {
  const dir = `${deps.env.dataRoot}/occurrences/${row.id}`
  let recording = false
  try {
    recording = await deps.remux(dir, AbortSignal.timeout(REMUX_TIMEOUT_MS))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`monitor: ${row.id}: REMUX FAILED, the meeting page will have no player: ${message}`)
    const data = { reason: 'remux_failed', message }
    await deps.db
      .insert(events)
      .values({
        occurrenceId: row.id,
        memberId: row.memberId,
        attempt: row.attempt,
        at: new Date(),
        type: 'error',
        data,
        dataHash: hashEventData(data)
      })
      .onConflictDoNothing()
  }
  await registerArtefacts(deps.db, row, dir, { recording })
}

/**
 * An occurrence that is no longer active but still names a container: once Docker says the container is gone (a
 * container that exists but is not running, created and never started, is removed first; a running one never is), forget
 * it, give the profile back and record the newest checkpoint. The recording of an occurrence that ends without the
 * pipeline is remuxed and its files are registered as artefacts (so they show on the meeting page) by a detached task:
 * the tick does not wait for it, a later tick skips the row while the task runs, and the container name is cleared and
 * the profile released only when the task is done (so those rows are not in the returned list). A row that throws is
 * logged and left as it was (its container name is still set), and the next pass tries it again; the other rows go on.
 */
async function releaseFinished(deps: LaunchDeps, now: Date): Promise<string[]> {
  const { db } = deps
  const rows = await db
    .select()
    .from(occurrences)
    .where(and(notInArray(occurrences.state, [...ACTIVE_STATES]), isNotNull(occurrences.containerName)))
  const released: string[] = []
  for (const row of rows) {
    try {
      if (await releaseOne(deps, row, now)) released.push(row.id)
    } catch (e) {
      console.error(`monitor: ${row.id}: not released, will retry: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return released
}

/** Rows whose recording is being remuxed right now (by occurrence id), so a later tick leaves them alone. Per process. */
const remuxing = new Map<string, Promise<void>>()

/** Waits for every remux the monitor has started (graceful shutdown, tests). */
export async function settleRemuxes(): Promise<void> {
  while (remuxing.size > 0) await Promise.allSettled([...remuxing.values()])
}

async function releaseOne(deps: LaunchDeps, row: OccurrenceRow, now: Date): Promise<boolean> {
  const { db } = deps
  if (remuxing.has(row.id)) return false
  if ((await containerView(deps.docker, row.containerName, { id: row.id, now }, true)) !== 'gone') return false
  // The checkpoint is recorded first: if this pass dies half way, the container name is still set and the next pass
  // does it again.
  const newest = (await checkpointFiles(deps.env.profileRoot, row.identityId)).at(-1)
  if (newest !== undefined) {
    const path = `${deps.env.profileRoot}/${row.identityId}/checkpoints/${newest}`
    // A pruner may remove the file between the listing and here: then there is nothing to record.
    const info = await stat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (info !== null)
      await db
        .update(profiles)
        .set({ latestCheckpoint: path, checkpointAt: info.mtime })
        .where(and(eq(profiles.identityId, row.identityId), eq(profiles.memberId, row.memberId)))
  }
  if (WITHOUT_PIPELINE.has(row.state)) {
    // The remux can take minutes, so it runs off the tick: the container name and the profile stay until it is done.
    // A scheduler restart forgets this map; the row is then selected again and the remux (idempotent) runs again.
    const task = registerFinished(deps, row)
      .then(() => forget(deps, row))
      .catch((e) =>
        console.error(`monitor: ${row.id}: not released, will retry: ${e instanceof Error ? e.message : String(e)}`)
      )
      .finally(() => remuxing.delete(row.id))
    remuxing.set(row.id, task)
    return false
  }
  await forget(deps, row)
  return true
}

/** Clears the container name of a finished occurrence and gives its profile back. */
async function forget(deps: LaunchDeps, row: OccurrenceRow): Promise<void> {
  await deps.db
    .update(occurrences)
    .set({ containerName: null })
    .where(and(eq(occurrences.id, row.id), eq(occurrences.containerName, row.containerName!)))
  await releaseProfile(deps.db, row.identityId, `occ:${row.id}`)
}
