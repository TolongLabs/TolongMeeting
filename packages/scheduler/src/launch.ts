import { createHash, randomBytes } from 'node:crypto'
import {
  ACTIVE_STATES,
  formatWhen,
  gateLinkSource,
  profileKey,
  stripPasscode,
  watchGateFromEnv,
  type SpecEnv,
  type WatchGate
} from '@tm/core'
import { pings, type WorkerFailureReason } from '@tm/notify'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { identities, members, occurrences, profiles, signinSessions, timetableEntries, type Db } from '@tm/web/db'
import { DbError, safeDbError } from '@tm/web/db/errors'
import { buildEntrySnapshot, loadJobConfig } from '@tm/web/db/job-config'
import type { Notifier } from '@tm/web/db/notifier'
import { identityClashes } from '@tm/web/db/occurrences'
import { QUEUES, queueDbOf, type Queue } from '@tm/web/db/queues'
import { applyTrigger } from '@tm/web/db/transitions'
import { containerName, containerSpec, jobFileBase, resolveEnv, type SpecParams } from './container-spec'
import { DockerError, type DockerClient } from './docker'
import {
  HostDirError,
  findJobFileBases,
  prepareHostDirs,
  removeJobFiles,
  removeStaleJobFiles,
  writeJobFiles
} from './job-files'
import { acquireProfile, releaseProfile } from './locks'

/** At most this many server workers run at once (revised only from spike 6's report). */
export const SERVER_WORKER_CAP = 2
/** One transaction at a time decides who launches, so the capacity and identity checks see each other's writes. */
export const LAUNCH_LOCK = 4242
const DEFAULT_WATCH_GATE = watchGateFromEnv({})
const DEFER_MS = 15_000
const EXIT_POLL_MS = 5_000

export type LaunchDeps = {
  db: Db
  queue: Queue
  docker: DockerClient
  notifier: Notifier
  master: Buffer
  env: SpecEnv
  /**
   * Which chat apps a server identity may watch (`watchGateFromEnv(process.env)` in `main.ts`). It lives here and not in
   * `SpecEnv`, which is also the Docker gate's config. Unset means the defaults (WhatsApp `home_only`, Discord `allowed`).
   */
  watchGate?: WatchGate
  /**
   * Makes the browser MP4 of a recording in an occurrence's data directory (`remuxRecording` of `@tm/pipeline`); true when
   * a checked `meeting.mp4` is in place. The monitor calls it for a meeting that ends without the pipeline, once the
   * worker container is gone.
   */
  remux: (dir: string, signal?: AbortSignal) => Promise<boolean>
  /** How often to ask Docker whether a worker has exited, to delete its job files. Default 5000. */
  exitPollMs?: number
}

export type LaunchJob = { occurrenceId: string; scheduledStart: string }
export type LaunchDeadResult = 'failed' | 'deferred' | 'stale'
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
export function removeFilesWhenExited(
  deps: Pick<LaunchDeps, 'docker' | 'exitPollMs'>,
  container: string,
  base: string
): void {
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

/**
 * Call once when the scheduler starts, before the first launch. A restart forgets the exit watchers, so this scans
 * `<profileRoot>/*\/job/` for job and key files, deletes the ones whose container is gone or stopped, and watches the
 * others. It also deletes `.tmp.<hex>` files left by a crash, which can hold the profile key. A Docker that can't be
 * asked now leaves the files to the watcher, which retries.
 */
export async function resumeJobFileWatchers(
  deps: Pick<LaunchDeps, 'docker' | 'env' | 'exitPollMs'>
): Promise<{ removed: number; watching: number }> {
  const found = { removed: 0, watching: 0 }
  for (const base of await findJobFileBases(deps.env.profileRoot)) {
    const container = base.slice(base.lastIndexOf('/') + 1)
    const state = await deps.docker.inspect(container).catch((e: unknown) => {
      console.error(`job file resume: inspect failed (${e instanceof Error ? e.name : 'unknown'})`)
      return { running: true }
    })
    if (state === null || !state.running) {
      await removeJobFiles(base)
      found.removed++
    } else {
      removeFilesWhenExited(deps, container, base)
      found.watching++
    }
  }
  return found
}

// --- startAttempt --------------------------------------------------------------------------------------------------

/** What is safe to log about a failure: Docker's or the directory check's own short message, else the error's name. */
export const describeFailure = (e: unknown): string =>
  e instanceof DockerError || e instanceof HostDirError ? e.message : e instanceof Error ? e.name : 'unknown'

const ERRNO_CODE = /^E[A-Z0-9]+$/

/**
 * Whether `e` is a Docker or host-filesystem failure: a refused or timed-out Docker call, a refused directory, or an
 * errno such as `EACCES`. Those fail the launch. Anything else (a Postgres error above all, which would leave the
 * transaction aborted) is not this function's to hide.
 */
export function isLaunchFailure(e: unknown): boolean {
  if (e instanceof DockerError || e instanceof HostDirError) return true
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' && ERRNO_CODE.test(code)
}

/**
 * Whether a container may be running after `docker.start` failed with `e`: Docker gave no answer (a timeout, an abort or
 * an unreachable proxy), so the start may have gone through. An answer that refuses the start means it did not.
 */
export const startMayHaveSucceeded = (e: unknown): boolean => !(e instanceof DockerError) || e.status === 0

/**
 * Removes a container that Docker created but refused to start, so it does not linger. True when it is gone. A removal
 * that fails (Docker unreachable, or the gate says the container is not stopped) returns false: the caller keeps the
 * profile held, and the monitor removes the container once Docker says it is not running.
 */
export async function removeRefused(docker: DockerClient, id: string): Promise<boolean> {
  try {
    await docker.remove(id)
    return true
  } catch (e) {
    if (!(e instanceof DockerError)) throw e
    console.error(`remove after a refused start failed: ${e.message}`)
    return false
  }
}

/** Starts attempt `attempt` of an occurrence. Resolves `false` after failing the occurrence when it can't start. */
async function startAttemptIn(
  deps: LaunchDeps,
  occurrenceId: string,
  attempt: number,
  now: Date,
  outbox: Outbox,
  via?: { sidecar: string }
): Promise<boolean> {
  const { db, env } = deps
  const [row] = await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!row) throw new Error(`No occurrence ${occurrenceId}`)
  const spec: SpecParams = {
    kind: 'worker',
    occurrenceId,
    attempt,
    identityId: row.identityId,
    env,
    ...(via ? { via } : {})
  }
  const name = containerName(spec)
  const base = jobFileBase(spec)
  const { publicUrl } = resolveEnv(env)

  /**
   * Fails the occurrence with `launch_failed` and queues the ping. The profile goes back at once, except when the
   * container may be running (`mayRun`): then it stays held, and `releaseFinished` frees it once Docker says the
   * container is gone.
   */
  const failLaunch = async (e: unknown, mayRun = false): Promise<false> => {
    // Only the error's name (and Docker's own message) is logged: other messages can carry paths or values.
    console.error(`launch failed for ${occurrenceId} attempt ${attempt}: ${describeFailure(e)}`)
    await removeJobFiles(base)
    await applyTrigger(db, occurrenceId, 'fail', { reason: 'launch_failed' })
    if (!mayRun) await releaseProfile(db, row.identityId, `occ:${occurrenceId}`)
    outbox.push(() => failedPing(deps, row, "it couldn't start"))
    return false
  }

  const token = `${attempt}.${randomBytes(32).toString('base64url')}`
  await db
    .update(occurrences)
    .set({ controlTokenHash: sha256hex(token), attempt, containerName: name, lastHeartbeatAt: now })
    .where(eq(occurrences.id, occurrenceId))
  let job: Awaited<ReturnType<typeof loadJobConfig>>
  try {
    job = await loadJobConfig(db, deps.master, occurrenceId, {
      attempt,
      control: { url: `${publicUrl}/api/control`, token },
      env
    })
  } catch (e) {
    // A database error stays one: the transaction is aborted and fail() could not run in it.
    const safe = safeDbError(e)
    if (safe instanceof DbError) throw safe
    return failLaunch(e)
  }
  const key = profileKey(deps.master, row.identityId)

  let created: string | null = null
  try {
    const jobDir = await prepareHostDirs(env, row.identityId, occurrenceId)
    // The profile is ours alone, so files of earlier containers (a crashed scheduler's leftovers) can go.
    await removeStaleJobFiles(jobDir, base)
    await writeJobFiles(base, job, key)
    created = await deps.docker.create(name, containerSpec(spec))
    await deps.docker.start(created)
  } catch (e) {
    if (isLaunchFailure(e)) {
      const mayRun = created !== null && (startMayHaveSucceeded(e) || !(await removeRefused(deps.docker, created)))
      return failLaunch(e, mayRun)
    }
    await removeJobFiles(base) // the key never outlives a failed launch, whatever the failure
    throw e
  }
  removeFilesWhenExited(deps, name, base)
  return true
}

/**
 * Makes the control token, writes the job and key files, creates and starts the container and records the attempt.
 * When that fails the occurrence fails with reason `launch_failed`, the profile is released and the member is pinged.
 * With `via`, the worker joins the network namespace of that home-route sidecar (`sidecarName`), which must be running.
 * Resolves `true` when the container started, `false` when the launch failed (the occurrence is then failed).
 */
export async function startAttempt(
  deps: LaunchDeps,
  occurrenceId: string,
  attempt: number,
  now: Date,
  via?: { sidecar: string }
): Promise<boolean> {
  const outbox: Outbox = []
  const started = await startAttemptIn(deps, occurrenceId, attempt, now, outbox, via)
  for (const send of outbox) await send()
  return started
}

// --- Pings ---------------------------------------------------------------------------------------------------------

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

/**
 * Handles a `launch` job whose retries are spent (the `launch-dead` queue; it mirrors `handleDeadPipelineJob`). An
 * occurrence that is still `scheduled` with the same start is failed with `launch_failed` and its member is pinged once;
 * anything else is `stale` (a launch got through, or the occurrence moved or went). Before the start the job is put back
 * for the start time, so the member isn't told off early while the next hourly pass could still change the occurrence.
 * The ping goes first, as in `pipeline-dead`: a ping that throws leaves the occurrence scheduled and the queue runs this
 * again.
 */
export async function handleDeadLaunchJob(deps: LaunchDeps, job: LaunchJob, now: Date): Promise<LaunchDeadResult> {
  const { db } = deps
  const [occ] = await db.select().from(occurrences).where(eq(occurrences.id, job.occurrenceId))
  if (!occ || occ.state !== 'scheduled' || occ.scheduledStart.toISOString() !== job.scheduledStart) {
    console.warn(
      `launch-dead: ${job.occurrenceId}: dropped; the occurrence is ${occ ? occ.state : 'gone'} or has moved`
    )
    return 'stale'
  }
  if (now.getTime() < occ.scheduledStart.getTime()) {
    await deps.queue.send(QUEUES.launchDead, job, { startAfter: occ.scheduledStart })
    return 'deferred'
  }
  console.error(`launch-dead: ${job.occurrenceId}: the launch job never succeeded; its retries are spent`)
  await failedPing(deps, occ, "it couldn't start")
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LAUNCH_LOCK})`)
    const [current] = await tx.select().from(occurrences).where(eq(occurrences.id, occ.id)).for('update')
    if (current?.state === 'scheduled') await launchThen(tx, occ.id, 'fail', 'launch_failed')
  })
  return 'failed'
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
  /** Fails an occurrence that can't launch, so a past or due one never stays `scheduled`. */
  const refuse = async (reason: string, ping = true): Promise<LaunchResult> => {
    await launchThen(db, occ.id, 'fail', reason)
    if (ping) outbox.push(() => failedPing(deps, occ, "it couldn't start"))
    return 'failed'
  }

  const [member] = await db.select({ timeZone: members.timeZone }).from(members).where(eq(members.id, occ.memberId))
  // Nobody to ping, and no time zone to word the pings in.
  if (!member) return refuse('member_missing', false)
  const when = formatWhen(occ.scheduledStart, member.timeZone)

  // A job that runs after the meeting has ended never leaves a past occurrence in `scheduled`.
  if (now.getTime() >= occ.scheduledEnd.getTime()) return refuse('launch_missed')

  const [identity] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.id, occ.identityId), eq(identities.memberId, occ.memberId)))
  // The gate can't tell whose identity this is, so the launcher refuses it.
  if (!identity) return refuse('identity_not_owned')

  // The entry was deleted after the occurrence was made: there is nothing to attend.
  const [entry] = occ.entryId
    ? await db
        .select({ id: timetableEntries.id, link: timetableEntries.link })
        .from(timetableEntries)
        .where(and(eq(timetableEntries.id, occ.entryId), eq(timetableEntries.memberId, occ.memberId)))
    : []
  if (!entry) return refuse('entry_missing')

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

  // Plan 08 replaces this step.
  if (identity.runLocation !== 'server') return refuse('run_location_unavailable')

  // A chat the gate refuses is never watched, and a paste entry can't be told from one with no link, so the launch fails
  // with one ping (a gate tightened after the entry was saved lands here). A link pasted for this occurrence skips the gate.
  const gate = deps.watchGate ?? DEFAULT_WATCH_GATE
  const { blockedApp } = occ.pastedLink ? { blockedApp: null } : gateLinkSource(entry.link, identity.runLocation, gate)
  if (blockedApp !== null && blockedApp !== 'teams') {
    await launchThen(db, occ.id, 'fail', 'watching_not_allowed')
    outbox.push(() =>
      deps.notifier.notify(
        occ.memberId,
        pings.watchingOff({
          entry: occ.entryName,
          app: blockedApp,
          gate: gate[blockedApp] === 'none' ? 'none' : 'home_only',
          meetingUrl: `${publicUrl}/meetings/${occ.id}`,
          accountsUrl: `${publicUrl}/accounts`
        })
      )
    )
    return 'failed'
  }

  const [profile] = await db
    .select({ heldBy: profiles.heldBy })
    .from(profiles)
    .where(and(eq(profiles.identityId, occ.identityId), eq(profiles.memberId, occ.memberId)))
  if (!profile) return refuse('profile_missing')
  if (profile.heldBy !== null) return defer(deps, job, occ, profile.heldBy, now, refuse)

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
    return taken ? defer(deps, job, occ, taken.heldBy, now, refuse) : refuse('profile_missing')
  }
  try {
    const entrySnapshot = await buildEntrySnapshot(db, occ.id)
    await db
      .update(occurrences)
      .set({
        entrySnapshot,
        linkUsed: entrySnapshot.link.kind === 'fixed' ? stripPasscode(entrySnapshot.link.url) : null
      })
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
  now: Date,
  refuse: (reason: string) => Promise<LaunchResult>
): Promise<LaunchResult> {
  const { db } = deps
  const holder = heldBy === null ? null : /^(signin|occ):([0-9a-f-]{36})$/.exec(heldBy)
  // Waiting would never end: the profile is held by something this launcher can't ask to finish.
  if (heldBy !== null && !holder) return refuse('holder_unknown')
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
