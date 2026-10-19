import { createHash, randomBytes } from 'node:crypto'
import { ACTIVE_STATES, formatWhen, profileKey, type SpecEnv } from '@tm/core'
import { pings, type WorkerFailureReason } from '@tm/notify'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { identities, members, occurrences, profiles, signinSessions, type Db } from '@tm/web/db'
import { safeDbError } from '@tm/web/db/errors'
import { buildEntrySnapshot, loadJobConfig } from '@tm/web/db/job-config'
import type { Notifier } from '@tm/web/db/notifier'
import { identityClashes } from '@tm/web/db/occurrences'
import { QUEUES, queueDbOf, type Queue } from '@tm/web/db/queues'
import { applyTrigger } from '@tm/web/db/transitions'
import { containerName, containerSpec, jobFileBase, resolveEnv, type SpecParams } from './container-spec'
import type { DockerClient } from './docker'
import { prepareHostDirs, removeJobFiles, removeStaleJobFiles, writeJobFiles } from './job-files'
import { acquireProfile, releaseProfile } from './locks'

/** At most this many server workers run at once (revised only from spike 6's report). */
export const SERVER_WORKER_CAP = 2
/** One transaction at a time decides who launches, so the capacity and identity checks see each other's writes. */
export const LAUNCH_LOCK = 4242
const DEFER_MS = 15_000
const EXIT_POLL_MS = 5_000

export type LaunchDeps = {
  db: Db
  queue: Queue
  docker: DockerClient
  notifier: Notifier
  master: Buffer
  env: SpecEnv
  /** How often to ask Docker whether a worker has exited, to delete its job files. Default 5000. */
  exitPollMs?: number
}

export type LaunchJob = { occurrenceId: string; scheduledStart: string }
export type LaunchResult = 'launched' | 'stale' | 'deferred' | 'skipped_identity_clash' | 'skipped_capacity' | 'failed'

type Outbox = Array<() => Promise<unknown>>
type OccurrenceRow = typeof occurrences.$inferSelect

const sha256hex = (text: string): string => createHash('sha256').update(text).digest('hex')

// --- Deleting job files once the container has exited -------------------------------------------------------------

const watchers = new Set<{ stop: AbortController; done: Promise<void> }>()

/** Stops every exit watcher and waits for it (graceful shutdown, tests). Files of still-running workers stay. */
export async function stopJobFileWatchers(): Promise<void> {
  const all = [...watchers]
  for (const w of all) w.stop.abort()
  await Promise.all(all.map((w) => w.done))
}

/** Waits for the next poll or the abort, whichever comes first. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

/** Polls Docker until the container is gone or stopped, then deletes its job and key files. */
function removeFilesWhenExited(deps: LaunchDeps, container: string, base: string): void {
  const stop = new AbortController()
  const poll = deps.exitPollMs ?? EXIT_POLL_MS
  const done = (async () => {
    while (!stop.signal.aborted) {
      try {
        const state = await deps.docker.inspect(container)
        if (state === null || !state.running) {
          await removeJobFiles(base)
          return
        }
      } catch (e) {
        // Docker may be briefly unreachable; the next launch of this identity also deletes leftovers.
        console.error(`job file cleanup: inspect failed (${e instanceof Error ? e.name : 'unknown'})`)
      }
      await sleep(poll, stop.signal)
    }
  })()
  const entry = { stop, done }
  watchers.add(entry)
  void done.finally(() => watchers.delete(entry))
}

// --- startAttempt --------------------------------------------------------------------------------------------------

/** What is safe to log about a failure: Docker's own short message, or else only the error's name. */
const describe = (e: unknown): string =>
  e instanceof Error ? (e.name === 'DockerError' ? e.message : e.name) : 'unknown'

/** Starts attempt `attempt` of an occurrence. Resolves `false` after failing the occurrence when it can't start. */
async function startAttemptIn(
  deps: LaunchDeps,
  occurrenceId: string,
  attempt: number,
  now: Date,
  outbox: Outbox
): Promise<boolean> {
  const { db, env } = deps
  const [row] = await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!row) throw new Error(`No occurrence ${occurrenceId}`)
  const spec: SpecParams = { kind: 'worker', occurrenceId, attempt, identityId: row.identityId, env }
  const name = containerName(spec)
  const base = jobFileBase(spec)
  const { publicUrl } = resolveEnv(env)

  try {
    const token = `${attempt}.${randomBytes(32).toString('base64url')}`
    await db
      .update(occurrences)
      .set({ controlTokenHash: sha256hex(token), attempt, containerName: name, lastHeartbeatAt: now })
      .where(eq(occurrences.id, occurrenceId))
    const job = await loadJobConfig(db, deps.master, occurrenceId, {
      attempt,
      control: { url: `${publicUrl}/api/control`, token },
      env
    })
    const jobDir = await prepareHostDirs(env, row.identityId, occurrenceId)
    // The profile is ours alone, so files of earlier containers (a crashed scheduler's leftovers) can go.
    await removeStaleJobFiles(jobDir, base)
    await writeJobFiles(base, job, profileKey(deps.master, row.identityId))
    const id = await deps.docker.create(name, containerSpec(spec))
    await deps.docker.start(id)
    removeFilesWhenExited(deps, name, base)
    return true
  } catch (e) {
    // Only the error's name (and Docker's own message) is logged: other messages can carry paths or values.
    console.error(`launch failed for ${occurrenceId} attempt ${attempt}: ${describe(e)}`)
    await removeJobFiles(base)
    await applyTrigger(db, occurrenceId, 'fail', { reason: 'launch_failed' })
    await releaseProfile(db, row.identityId, `occ:${occurrenceId}`)
    outbox.push(() => failedPing(deps, row, "it couldn't start"))
    return false
  }
}

/**
 * Makes the control token, writes the job and key files, creates and starts the container and records the attempt.
 * When that fails the occurrence fails with reason `launch_failed`, the profile is released and the member is pinged.
 */
export async function startAttempt(deps: LaunchDeps, occurrenceId: string, attempt: number, now: Date): Promise<void> {
  const outbox: Outbox = []
  await startAttemptIn(deps, occurrenceId, attempt, now, outbox)
  for (const send of outbox) await send()
}

// --- Pings ---------------------------------------------------------------------------------------------------------

async function memberOf(db: Db, memberId: string) {
  const [member] = await db.select({ timeZone: members.timeZone }).from(members).where(eq(members.id, memberId))
  if (!member) throw new Error(`No member ${memberId}`)
  return member
}

async function identityName(db: Db, identityId: string): Promise<string> {
  const [row] = await db.select({ name: identities.name }).from(identities).where(eq(identities.id, identityId))
  if (!row) throw new Error(`No identity ${identityId}`)
  return row.name
}

async function failedPing(deps: LaunchDeps, row: OccurrenceRow, reason: WorkerFailureReason): Promise<void> {
  const { publicUrl } = resolveEnv(deps.env)
  await deps.notifier.notify(
    row.memberId,
    pings.workerFailed({ entry: row.entryName, reason, meetingUrl: `${publicUrl}/meetings/${row.id}` })
  )
}

// --- launchOccurrence ----------------------------------------------------------------------------------------------

/**
 * Handles the `launch` job of one occurrence, at T-60 or when a back-to-back meeting asks again. It runs in one
 * transaction under an advisory lock, so two launches never decide on stale capacity or identity facts.
 */
export async function launchOccurrence(deps: LaunchDeps, job: LaunchJob, now: Date): Promise<LaunchResult> {
  const outbox: Outbox = []
  const result = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LAUNCH_LOCK})`)
    return decide({ ...deps, db: tx }, job, now, outbox)
  })
  // Pings go out after the commit, so a slow ntfy server never holds the launch lock.
  for (const send of outbox) await send()
  return result
}

/** Applies `launch` and then `trigger`, so the occurrence leaves `scheduled` and the move is recorded as an event. */
async function launchThen(
  db: Db,
  id: string,
  trigger: 'skip_identity_clash' | 'skip_capacity' | 'fail',
  reason?: string
) {
  await applyTrigger(db, id, 'launch')
  await applyTrigger(db, id, trigger, reason === undefined ? {} : { reason })
}

async function decide(deps: LaunchDeps, job: LaunchJob, now: Date, outbox: Outbox): Promise<LaunchResult> {
  const { db, env } = deps
  const [occ] = await db.select().from(occurrences).where(eq(occurrences.id, job.occurrenceId)).for('update')
  if (!occ || occ.state !== 'scheduled' || occ.scheduledStart.toISOString() !== job.scheduledStart) {
    console.warn(`stale launch job ignored: occurrence ${job.occurrenceId}`)
    return 'stale'
  }
  const { publicUrl } = resolveEnv(env)
  const member = await memberOf(db, occ.memberId)
  const when = formatWhen(occ.scheduledStart, member.timeZone)

  // A job that runs after the meeting has ended never leaves a past occurrence in `scheduled`.
  if (now.getTime() >= occ.scheduledEnd.getTime()) {
    await launchThen(db, occ.id, 'fail', 'launch_missed')
    outbox.push(() => failedPing(deps, occ, "it couldn't start"))
    return 'failed'
  }

  const [identity] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.id, occ.identityId), eq(identities.memberId, occ.memberId)))
  if (!identity) {
    // The gate can't tell whose identity this is, so the launcher refuses it.
    await launchThen(db, occ.id, 'fail', 'identity_not_owned')
    outbox.push(() => failedPing(deps, occ, "it couldn't start"))
    return 'failed'
  }

  const clash = (await identityClashes(db, occ.identityId, occ.scheduledStart, occ.scheduledEnd, occ.memberId)).find(
    (c) => c.loser.id === occ.id
  )
  if (clash) {
    await launchThen(db, occ.id, 'skip_identity_clash')
    outbox.push(() =>
      deps.notifier.notify(
        occ.memberId,
        pings.identityClashSkipped({
          entry: occ.entryName,
          when,
          winner: clash.winner.entryName,
          identity: identity.name,
          timetableUrl: `${publicUrl}/timetable`
        })
      )
    )
    return 'skipped_identity_clash'
  }

  if (identity.runLocation !== 'server') {
    // Plan 08 replaces this step.
    await launchThen(db, occ.id, 'fail', 'run_location_unavailable')
    outbox.push(() => failedPing(deps, occ, "it couldn't start"))
    return 'failed'
  }

  const [profile] = await db
    .select({ heldBy: profiles.heldBy })
    .from(profiles)
    .where(and(eq(profiles.identityId, occ.identityId), eq(profiles.memberId, occ.memberId)))
  if (!profile) throw new Error(`Identity ${occ.identityId} has no profile`)
  if (profile.heldBy !== null) return defer(deps, job, occ, profile.heldBy, now)

  const [{ active }] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(occurrences)
    .where(inArray(occurrences.state, [...ACTIVE_STATES]))
  if (active! >= SERVER_WORKER_CAP) {
    await launchThen(db, occ.id, 'skip_capacity')
    outbox.push(() =>
      deps.notifier.notify(
        occ.memberId,
        pings.capacityClash({
          entry: occ.entryName,
          when,
          identity: identity.name,
          accountsUrl: `${publicUrl}/accounts`
        })
      )
    )
    return 'skipped_capacity'
  }

  if (!(await acquireProfile(db, occ.identityId, `occ:${occ.id}`))) {
    // A sign-in took the profile since the check above.
    const [taken] = await db
      .select({ heldBy: profiles.heldBy })
      .from(profiles)
      .where(eq(profiles.identityId, occ.identityId))
    return defer(deps, job, occ, taken?.heldBy ?? null, now)
  }
  try {
    const entrySnapshot = await buildEntrySnapshot(db, occ.id)
    await db
      .update(occurrences)
      .set({ entrySnapshot, linkUsed: entrySnapshot.link.kind === 'fixed' ? entrySnapshot.link.url : null })
      .where(eq(occurrences.id, occ.id))
  } catch (e) {
    throw safeDbError(e)
  }
  await applyTrigger(db, occ.id, 'launch')
  return (await startAttemptIn(deps, occ.id, 1, now, outbox)) ? 'launched' : 'failed'
}

/** The profile is busy. Ask its holder to finish, and look again in 15 seconds. */
async function defer(
  deps: LaunchDeps,
  job: LaunchJob,
  occ: OccurrenceRow,
  heldBy: string | null,
  now: Date
): Promise<LaunchResult> {
  const { db } = deps
  const holder = heldBy === null ? null : /^(signin|occ):([0-9a-f-]{36})$/.exec(heldBy)
  if (heldBy !== null && !holder) throw new Error(`Profile of identity ${occ.identityId} has an unknown holder`)
  if (holder?.[1] === 'signin') {
    await db
      .update(signinSessions)
      .set({ doneRequested: true })
      .where(and(eq(signinSessions.id, holder[2]!), eq(signinSessions.identityId, occ.identityId)))
  } else if (holder && now.getTime() >= occ.scheduledStart.getTime()) {
    // A back-to-back meeting: the earlier worker is told to stop once this meeting is due.
    await db
      .update(occurrences)
      .set({ pendingCommands: sql`array_append(${occurrences.pendingCommands}, 'stop')` })
      .where(
        and(
          eq(occurrences.id, holder[2]!),
          eq(occurrences.identityId, occ.identityId),
          sql`not ('stop' = any(${occurrences.pendingCommands}))`
        )
      )
  }
  await deps.queue.send(
    QUEUES.launch,
    { occurrenceId: job.occurrenceId, scheduledStart: job.scheduledStart },
    { startAfter: new Date(now.getTime() + DEFER_MS), db: queueDbOf(db) }
  )
  return 'deferred'
}
