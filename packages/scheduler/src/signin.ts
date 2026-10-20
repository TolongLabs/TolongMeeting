import { createHash, randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { SigninJobSchema, WORKER_STATES, controlTokenHash, profileKey } from '@tm/core'
import { and, eq, like, ne, sql } from 'drizzle-orm'
import { occurrences, profiles, signinSessions, type Db } from '@tm/web/db'
import { QUEUES } from '@tm/web/db/queues'
import { containerName, containerSpec, jobFileBase, resolveEnv, type SpecParams } from './container-spec'
import { DockerError, type DockerClient } from './docker'
import { prepareSigninDirs, removeJobFiles, removeStaleJobFiles, writeJobFiles } from './job-files'
import {
  LAUNCH_LOCK,
  describeFailure,
  isLaunchFailure,
  removeFilesWhenExited,
  removeRefused,
  startMayHaveSucceeded,
  type LaunchDeps
} from './launch'
import { releaseProfile } from './locks'

/** A started session that has sent nothing for this long never got going (queue, image start, profile restore). */
export const SIGNIN_START_MS = 120_000
/** A session quiet for this long is lost: a container that stopped reporting, or a worker that stopped heartbeating. */
export const SIGNIN_SILENT_MS = 30_000
/** A session whose container Docker can't be asked about ends as lost after this long; the profile stays held. */
export const SIGNIN_UNREACHABLE_FAIL_MS = 15 * 60_000
/** No session lasts longer than this, however active: a view left open does not hold the profile all day. */
export const SIGNIN_MAX_MS = 60 * 60_000

/** The sign-in job is retried this long after the profile turned out to be busy. */
const BUSY_RETRY_MS = 5_000
const STOP_TIMEOUT_S = 5
/** A container still running this long after its session ended is stopped. */
const ENDED_STOP_AFTER_MS = 60_000
/** Job and key files are deleted this long after the start even if the container never reported. */
const JOB_FILES_MAX_AGE_MS = 120_000
/** A logged Docker problem is forgotten after this long. */
const LOG_PRUNE_MS = 10 * 60_000

type SessionRow = typeof signinSessions.$inferSelect

const sha256hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Ends the session unless it has ended already. True when this call ended it. */
async function endSession(db: Db, id: string, reason: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(signinSessions)
    .set({ state: 'ended', endedAt: now, endReason: reason })
    .where(and(eq(signinSessions.id, id), ne(signinSessions.state, 'ended')))
    .returning({ id: signinSessions.id })
  return rows.length === 1
}

type Decision = { kind: 'ended' | 'worker' | 'started' } | { kind: 'busy' } | { kind: 'start'; identityId: string }

/**
 * The `signin-start` job: starts the sign-in container of a `container` session.
 *
 * The decision runs in one transaction under the launcher's advisory lock, so it can't interleave with a launch:
 * - the session is gone from the queue's view (ended, or already started) or the member pressed Done before it began:
 *   nothing starts (`ended`; a started one answers `started`);
 * - the profile is free: it is taken as `signin:<sessionId>` and the container starts (`started`);
 * - a meeting worker took it meanwhile: the session becomes a worker one and the worker is asked to pause (`worker`);
 * - anything else holds it (a worker not yet running, an earlier sign-in not yet released): the job is sent again in 5
 *   seconds (`deferred`) until the session ends, which the monitor does after `SIGNIN_START_MS`.
 *
 * A Docker or filesystem failure ends the session (`launch_failed`) and answers `ended`. The job and key files never
 * outlive a failed start. The profile goes back at once unless the container may be running (the start got no answer):
 * then it stays held, and the monitor frees it once Docker says the container is gone.
 */
export async function startSigninContainer(
  deps: LaunchDeps,
  sessionId: string,
  now: Date
): Promise<'started' | 'worker' | 'ended' | 'deferred'> {
  const { db, env } = deps
  const decision = await db.transaction(async (tx): Promise<Decision> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LAUNCH_LOCK})`)
    const [session] = await tx.select().from(signinSessions).where(eq(signinSessions.id, sessionId)).for('update')
    if (!session) throw new Error(`No sign-in session ${sessionId}`)
    if (session.state === 'ended') return { kind: 'ended' }
    if (session.mode === 'worker') return { kind: 'worker' }
    if (session.upstream !== null) return { kind: 'started' }
    if (session.doneRequested) {
      await endSession(tx, sessionId, 'done', now)
      return { kind: 'ended' }
    }
    const [profile] = await tx
      .select({ heldBy: profiles.heldBy })
      .from(profiles)
      .where(and(eq(profiles.identityId, session.identityId), eq(profiles.memberId, session.memberId)))
    if (!profile) {
      await endSession(tx, sessionId, 'profile_missing', now)
      return { kind: 'ended' }
    }
    const holder = `signin:${sessionId}`
    // Held by this very session: an earlier run of this job took it and failed before the container started.
    if (profile.heldBy === null || profile.heldBy === holder) {
      await tx
        .update(profiles)
        .set({ heldBy: holder, heldSince: now })
        .where(and(eq(profiles.identityId, session.identityId), eq(profiles.memberId, session.memberId)))
      return { kind: 'start', identityId: session.identityId }
    }
    const worker = /^occ:([0-9a-f-]{36})$/.exec(profile.heldBy)
    const [occurrence] = worker
      ? await tx
          .select()
          .from(occurrences)
          .where(
            and(
              eq(occurrences.id, worker[1]!),
              eq(occurrences.identityId, session.identityId),
              eq(occurrences.memberId, session.memberId)
            )
          )
      : []
    if (occurrence && (WORKER_STATES as ReadonlySet<string>).has(occurrence.state)) {
      await tx
        .update(signinSessions)
        .set({
          mode: 'worker',
          occurrenceId: occurrence.id,
          upstream: `tm-worker-${occurrence.id}-a${occurrence.attempt}:6080`
        })
        .where(eq(signinSessions.id, sessionId))
      await appendCommand(tx, occurrence.id, 'pause_for_signin')
      return { kind: 'worker' }
    }
    return { kind: 'busy' }
  })

  if (decision.kind === 'busy') {
    await deps.queue.send(QUEUES.signinStart, { sessionId }, { startAfter: new Date(now.getTime() + BUSY_RETRY_MS) })
    return 'deferred'
  }
  if (decision.kind !== 'start') return decision.kind

  const { identityId } = decision
  const spec: SpecParams = { kind: 'signin', sessionId, identityId, env }
  const name = containerName(spec)
  const base = jobFileBase(spec)
  const { publicUrl } = resolveEnv(env)
  const token = `s.${randomBytes(32).toString('base64url')}`

  /** The start failed: the files are gone and the session is over; the profile is back unless `mayRun`. */
  const failStart = async (error: unknown, mayRun: boolean): Promise<'ended'> => {
    // Only the error's name (and Docker's own message) is logged: other messages can carry paths or values.
    console.error(`sign-in start failed for ${sessionId}: ${describeFailure(error)}`)
    await removeJobFiles(base)
    await endSession(db, sessionId, 'launch_failed', new Date())
    if (!mayRun) await releaseProfile(db, identityId, `signin:${sessionId}`)
    return 'ended'
  }

  await db
    .update(signinSessions)
    .set({ controlTokenHash: controlTokenHash(token), upstream: `${name}:6080` })
    .where(eq(signinSessions.id, sessionId))
  let created: string | null = null
  try {
    const job = SigninJobSchema.parse({
      sessionId,
      identityId,
      profileDir: `${env.profileRoot}/${identityId}/work`,
      checkpointsDir: `${env.profileRoot}/${identityId}/checkpoints`,
      control: { url: `${publicUrl}/api/control`, token }
    })
    const jobDir = await prepareSigninDirs(env, identityId)
    // The profile is ours alone, so files of earlier containers (a crashed scheduler's leftovers) can go.
    await removeStaleJobFiles(jobDir, base)
    await writeJobFiles(base, job, profileKey(deps.master, identityId))
    created = await deps.docker.create(name, containerSpec(spec))
    await deps.docker.start(created)
  } catch (error) {
    if (isLaunchFailure(error)) {
      const mayRun = created !== null && (startMayHaveSucceeded(error) || !(await removeRefused(deps.docker, created)))
      return failStart(error, mayRun)
    }
    await removeJobFiles(base) // the key never outlives a failed start, whatever the failure
    throw error
  }
  removeFilesWhenExited(deps, name, base)
  return 'started'
}

/**
 * Appends `command` to the occurrence's pending commands unless it is queued already. One statement, so a heartbeat can't
 * lose it. A `pause_for_signin` replaces a `resume_after_signin` waiting at the end (it belongs to an earlier sign-in),
 * and a `resume_after_signin` removes a pause the worker never received.
 */
async function appendCommand(db: Db, occurrenceId: string, command: 'pause_for_signin' | 'resume_after_signin') {
  const queue = occurrences.pendingCommands
  const next =
    command === 'pause_for_signin'
      ? sql`case when ${queue}[cardinality(${queue})] = 'resume_after_signin'
          then array_append(${queue}[1:cardinality(${queue}) - 1], ${command}) else array_append(${queue}, ${command}) end`
      : sql`array_append(array_remove(${queue}, 'pause_for_signin'), ${command})`
  await db
    .update(occurrences)
    .set({ pendingCommands: next })
    .where(and(eq(occurrences.id, occurrenceId), sql`not (${command} = any(${queue}))`))
}

// --- Monitor -------------------------------------------------------------------------------------------------------

// Per scheduler process: when Docker first couldn't be asked about a silent session's container.
const unreachable = new Map<string, number>()
const lastLogged = new Map<string, number>()

/** Logs a Docker problem for a session at most once a minute. */
function logDocker(sessionId: string, now: Date, message: string): void {
  const last = lastLogged.get(sessionId)
  if (last !== undefined && now.getTime() - last < 60_000) return
  lastLogged.set(sessionId, now.getTime())
  console.error(`monitor: sign-in ${sessionId}: ${message}`)
}

/** Stops a container and waits. A container that is already gone is fine; any other Docker failure is thrown. */
async function stopContainer(docker: DockerClient, name: string): Promise<void> {
  try {
    await docker.stop(name, STOP_TIMEOUT_S)
  } catch (e) {
    if (e instanceof DockerError && e.status === 404) return
    throw e
  }
}

/** Why an open session is over (it went quiet, or its desk is gone), or null when it is fine. */
async function lostReason(db: Db, row: SessionRow, now: Date): Promise<'lost' | null> {
  const t = now.getTime()
  if (t - row.startedAt.getTime() > SIGNIN_MAX_MS) return 'lost'
  const starting = row.state === 'starting' && t - row.startedAt.getTime() > SIGNIN_START_MS
  if (row.mode === 'container') {
    if (row.lastHeartbeatAt === null) return starting ? 'lost' : null
    return t - row.lastHeartbeatAt.getTime() > SIGNIN_SILENT_MS ? 'lost' : null
  }
  const [worker] =
    row.occurrenceId === null
      ? []
      : await db
          .select({
            id: occurrences.id,
            attempt: occurrences.attempt,
            state: occurrences.state,
            at: occurrences.lastHeartbeatAt
          })
          .from(occurrences)
          .where(eq(occurrences.id, row.occurrenceId))
  // The desk the session was opened on is gone: the worker crashed (and a restart is another attempt on another
  // container), the meeting moved on, or the occurrence was removed.
  if (!worker || !(WORKER_STATES as ReadonlySet<string>).has(worker.state)) return 'lost'
  if (row.upstream !== `tm-worker-${worker.id}-a${worker.attempt}:6080`) return 'lost'
  const beat = (worker.at ?? row.startedAt).getTime()
  return starting || t - beat > SIGNIN_SILENT_MS ? 'lost' : null
}

/** Ends one quiet session. False when a container that can't be stopped keeps it open for now. */
async function endLost(deps: LaunchDeps, row: SessionRow, now: Date): Promise<boolean> {
  const { db } = deps
  if (row.mode === 'container') {
    try {
      await stopContainer(deps.docker, `tm-signin-${row.id}`)
    } catch (e) {
      // Docker that can't be asked is never read as "gone": the session stays open until the ceiling, and the profile
      // stays held until a later pass sees the container gone.
      if (!(e instanceof DockerError)) throw e
      const since = unreachable.get(row.id) ?? now.getTime()
      unreachable.set(row.id, since)
      logDocker(row.id, now, e.message)
      if (now.getTime() - since < SIGNIN_UNREACHABLE_FAIL_MS) return false
    }
    unreachable.delete(row.id)
    lastLogged.delete(row.id)
  } else if (row.occurrenceId !== null) {
    // A pause that is still pending, or a worker that comes back, must not stay paused.
    await appendCommand(db, row.occurrenceId, 'resume_after_signin')
  }
  return endSession(db, row.id, 'lost', now)
}

/** Deletes the container's job and key files once it has reported since they were written, or after 120 seconds. */
async function removeSigninFiles(deps: LaunchDeps, row: SessionRow, now: Date): Promise<void> {
  const base = jobFileBase({ kind: 'signin', sessionId: row.id, identityId: row.identityId, env: deps.env })
  const info = await stat(`${base}.json`).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (info === null) return
  const beat = row.lastHeartbeatAt !== null && row.lastHeartbeatAt.getTime() > info.mtimeMs
  if (beat || now.getTime() - info.mtimeMs >= JOB_FILES_MAX_AGE_MS) await removeJobFiles(base)
}

/**
 * One pass over the sign-in sessions, from `monitorTick`:
 * - a session quiet for 30 seconds (a container that stopped reporting, or the worker of a desk pause that stopped
 *   heartbeating), one that has not become ready within 2 minutes, or one older than an hour ends as `lost`; a container
 *   session's container is stopped first, and Docker that can't be asked leaves it open (up to 15 minutes) rather than
 *   reading "unknown" as "gone"; a worker session also queues `resume_after_signin`, so a worker that returns does not
 *   stay paused;
 * - the job and key files of a running container go once it has reported, or after 120 seconds;
 * - the profile of a sign-in that has ended is released once its container is gone (its files go with it; a container that
 *   exists but is not running is removed first); a container
 *   still running a minute after its session ended is stopped.
 * A session or a held profile that throws does not stop the others: every one is handled, then the errors are thrown
 * together as an `AggregateError`. Returns the ids of the sessions it ended.
 */
export async function monitorSignins(deps: LaunchDeps, now: Date): Promise<string[]> {
  const { db } = deps
  const ended: string[] = []
  const errors: unknown[] = []
  const open = await db.select().from(signinSessions).where(ne(signinSessions.state, 'ended'))
  const openIds = new Set(open.map((row) => row.id))
  for (const id of unreachable.keys()) if (!openIds.has(id)) unreachable.delete(id)
  for (const [id, at] of lastLogged) if (now.getTime() - at > LOG_PRUNE_MS) lastLogged.delete(id)
  for (const row of open) {
    try {
      if ((await lostReason(db, row, now)) !== null) {
        if (await endLost(deps, row, now)) ended.push(row.id)
      } else if (row.mode === 'container') await removeSigninFiles(deps, row, now)
    } catch (e) {
      errors.push(e)
    }
  }

  const held = await db
    .select({ identityId: profiles.identityId, heldBy: profiles.heldBy })
    .from(profiles)
    .where(like(profiles.heldBy, 'signin:%'))
  for (const { identityId, heldBy } of held) {
    try {
      await releaseSignin(deps, identityId, heldBy!, now)
    } catch (e) {
      errors.push(e)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `monitor: ${errors.length} sign-in step(s) failed`)
  return ended
}

/** Frees a profile held by an ended (or missing) session once its container is gone, and deletes the job files. */
async function releaseSignin(deps: LaunchDeps, identityId: string, heldBy: string, now: Date): Promise<void> {
  const { db } = deps
  const sessionId = heldBy.slice('signin:'.length)
  const [session] = await db.select().from(signinSessions).where(eq(signinSessions.id, sessionId))
  // The container of an open session is expected (or about to be created): its profile is not released.
  if (session && session.state !== 'ended') return
  const name = `tm-signin-${sessionId}`
  let running: boolean
  try {
    const state = await deps.docker.inspect(name)
    running = state?.running === true
    if (running && session?.endedAt && now.getTime() - session.endedAt.getTime() >= ENDED_STOP_AFTER_MS)
      await stopContainer(deps.docker, name)
    // Exists but is not running: created and never started (AutoRemove only covers a container that ran and exited).
    else if (state !== null && !running) await deps.docker.remove(name)
  } catch (e) {
    if (!(e instanceof DockerError)) throw e
    logDocker(sessionId, now, e.message)
    return
  }
  if (running) return
  await removeJobFiles(jobFileBase({ kind: 'signin', sessionId, identityId, env: deps.env }))
  await releaseProfile(db, identityId, heldBy)
  lastLogged.delete(sessionId)
}
