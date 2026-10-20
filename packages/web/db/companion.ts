import {
  CompanionCommandSchema,
  CompanionEventSchema,
  CompanionJobSchema,
  DEVICE_ONLINE_WINDOW_MS,
  JOB_LEASE_MS,
  LocalRunPayloadSchema,
  MAX_LIST_ITEMS,
  NativeJobPayloadSchema,
  NATIVE_MAX_ATTEMPTS,
  type CompanionCommand,
  type CompanionEvent,
  type CompanionJob,
  type CompanionJobKind,
  type DeviceAuth
} from '@tm/core'
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { safeDbError } from './errors'
import { companionEvents, companionJobs, deviceTokens, occurrences, type Db } from './index'
import { applyTrigger } from './transitions'

export type { Db, DeviceAuth }

/** How long a member's companion events are kept: older ones are pruned whenever the member gets a new one. */
const EVENT_KEEP_MS = 24 * 3_600_000

/**
 * Companion tables hold only ids, states and job payloads: never a device token or a pairing code (those are stored
 * as hashes in `device_tokens` and `device_pairings`, by plan 03 task 3). A failed query is mapped by `safeDbError`.
 *
 * Every function that takes a `DeviceAuth` acts for that device's member only. `getJob`, `markPcPingSent` and
 * `releaseExpiredLeases` take no device: server-side callers (the scheduler and the routes) use them. `completeJob` and
 * `failJobAttempt` take the device and check in their own `UPDATE` that it holds the job with a live lease.
 */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw safeDbError(e)
  }
}

const jobColumns = {
  id: companionJobs.id,
  memberId: companionJobs.memberId,
  kind: companionJobs.kind,
  state: companionJobs.state,
  occurrenceId: companionJobs.occurrenceId,
  attempts: companionJobs.attempts,
  payload: companionJobs.payload
}
type JobRow = { [K in keyof typeof jobColumns]: (typeof jobColumns)[K]['_']['data'] }

/** A row's payload is jsonb: parse it with the schema of its kind, never cast it. */
function toJob(row: JobRow): CompanionJob {
  const { memberId: _memberId, ...job } = row
  return CompanionJobSchema.parse(job)
}

/**
 * Creates a `pending` job and returns its id. The occurrence (and the target device) must belong to the member: the
 * composite foreign keys refuse anything else. A `local_run` needs a target device.
 */
export async function createCompanionJob(
  db: Db,
  j: {
    memberId: string
    occurrenceId: string
    kind: CompanionJobKind
    payload: CompanionJob['payload']
    targetDeviceId?: string
  }
): Promise<string> {
  const payload =
    j.kind === 'native_transcription' ? NativeJobPayloadSchema.parse(j.payload) : LocalRunPayloadSchema.parse(j.payload)
  if (payload.occurrenceId !== j.occurrenceId) throw new Error('The job payload names a different occurrence.')
  if (j.kind === 'local_run' && !j.targetDeviceId) throw new Error('A local_run job needs a target device.')
  return guarded(async () => {
    const [row] = await db
      .insert(companionJobs)
      .values({
        memberId: j.memberId,
        occurrenceId: j.occurrenceId,
        kind: j.kind,
        payload,
        targetDeviceId: j.targetDeviceId ?? null
      })
      .returning({ id: companionJobs.id })
    return row!.id
  })
}

/**
 * Appends a command to the member's event stream (for one device, or every device when `deviceId` is omitted) and
 * returns its id. Events of the member older than 24 hours go in the same transaction.
 */
export async function emitCompanionEvent(
  db: Db,
  memberId: string,
  command: CompanionCommand,
  deviceId?: string,
  now: Date = new Date()
): Promise<number> {
  const checked = CompanionCommandSchema.parse(command)
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx
        .delete(companionEvents)
        .where(
          and(
            eq(companionEvents.memberId, memberId),
            lt(companionEvents.createdAt, new Date(now.getTime() - EVENT_KEEP_MS))
          )
        )
      const [row] = await tx
        .insert(companionEvents)
        .values({ memberId, deviceId: deviceId ?? null, command: checked, createdAt: now })
        .returning({ id: companionEvents.id })
      return row!.id
    })
  )
}

/**
 * The device's events after `afterId`, oldest first: those for every device of its member and those for it alone. An
 * event is visible only from the moment the device was paired (`device_tokens.created_at`) until it was revoked, so a
 * newly paired PC never replays what was said before it existed (a stale `open_signin`, say). The bounds are part of
 * the query, so they hold whatever cursor the caller sends.
 */
export async function listCompanionEvents(db: Db, device: DeviceAuth, afterId: number): Promise<CompanionEvent[]> {
  const whileDeviceLived = sql`exists (
    select 1 from device_tokens d
    where d.id = ${device.deviceId} and d.member_id = ${device.memberId}
      and ${companionEvents.createdAt} >= d.created_at
      and (d.revoked_at is null or ${companionEvents.createdAt} <= d.revoked_at)
  )`
  const rows = await guarded(() =>
    db
      .select({ id: companionEvents.id, command: companionEvents.command })
      .from(companionEvents)
      .where(
        and(
          eq(companionEvents.memberId, device.memberId),
          gt(companionEvents.id, afterId),
          or(isNull(companionEvents.deviceId), eq(companionEvents.deviceId, device.deviceId)),
          whileDeviceLived
        )
      )
      .orderBy(asc(companionEvents.id))
      .limit(MAX_LIST_ITEMS)
  )
  return rows.map((r) => CompanionEventSchema.parse(r))
}

/** The member's `pending` jobs this device may claim (untargeted, or aimed at it) and the jobs it holds. */
export async function listJobsForDevice(db: Db, device: DeviceAuth): Promise<CompanionJob[]> {
  const rows = await guarded(() =>
    db
      .select(jobColumns)
      .from(companionJobs)
      .where(
        and(
          eq(companionJobs.memberId, device.memberId),
          or(
            and(
              eq(companionJobs.state, 'pending'),
              or(isNull(companionJobs.targetDeviceId), eq(companionJobs.targetDeviceId, device.deviceId))
            ),
            and(eq(companionJobs.state, 'claimed'), eq(companionJobs.deviceId, device.deviceId))
          )
        )
      )
      .orderBy(asc(companionJobs.createdAt), asc(companionJobs.id))
      .limit(MAX_LIST_ITEMS)
  )
  return rows.map(toJob)
}

/**
 * Claims a `pending` job for the device with one guarded `UPDATE ... RETURNING`, so two devices claiming at once can
 * never both win: the loser's `WHERE` is re-checked after the winner commits and matches nothing. The lease runs
 * `JOB_LEASE_MS` from `now`. A `local_run` is claimable only by its target device while that device is online (seen
 * within `DEVICE_ONLINE_WINDOW_MS`). Returns `'conflict'` when the job is visible to the device but cannot be claimed
 * now, and `null` when it does not exist for the device (another member's job, another device's target, a revoked
 * device).
 */
export async function claimJob(
  db: Db,
  device: DeviceAuth,
  jobId: string,
  now: Date = new Date()
): Promise<CompanionJob | 'conflict' | null> {
  const liveDevice = sql`exists (
    select 1 from device_tokens d
    where d.id = ${device.deviceId} and d.member_id = ${device.memberId} and d.revoked_at is null
  )`
  const onlineDevice = sql`exists (
    select 1 from device_tokens d
    where d.id = ${device.deviceId} and d.member_id = ${device.memberId}
      and d.last_used_at >= ${new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS)}
  )`
  return guarded(async () => {
    const [claimed] = await db
      .update(companionJobs)
      .set({
        state: 'claimed',
        deviceId: device.deviceId,
        leaseUntil: new Date(now.getTime() + JOB_LEASE_MS),
        updatedAt: now
      })
      .where(
        and(
          eq(companionJobs.id, jobId),
          eq(companionJobs.memberId, device.memberId),
          eq(companionJobs.state, 'pending'),
          or(isNull(companionJobs.targetDeviceId), eq(companionJobs.targetDeviceId, device.deviceId)),
          or(ne(companionJobs.kind, 'local_run'), and(eq(companionJobs.targetDeviceId, device.deviceId), onlineDevice)),
          liveDevice
        )
      )
      .returning(jobColumns)
    if (claimed) return toJob(claimed)

    const [visible] = await db
      .select({ id: companionJobs.id })
      .from(companionJobs)
      .where(
        and(
          eq(companionJobs.id, jobId),
          eq(companionJobs.memberId, device.memberId),
          or(isNull(companionJobs.targetDeviceId), eq(companionJobs.targetDeviceId, device.deviceId)),
          liveDevice
        )
      )
    return visible ? 'conflict' : null
  })
}

/**
 * `claimJob`, and for a `native_transcription` job whose occurrence waits for a PC (`waiting_for_pc`) the move back to
 * `transcribing` (`pc_claimed`), in one transaction: when the move fails the job stays unclaimed. An occurrence in any
 * other state is left alone.
 */
export async function claimJobAndResume(
  db: Db,
  device: DeviceAuth,
  jobId: string,
  now: Date = new Date()
): Promise<CompanionJob | 'conflict' | null> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const result = await claimJob(tx, device, jobId, now)
      if (result === null || result === 'conflict' || result.kind !== 'native_transcription') return result
      const [occ] = await tx
        .select({ state: occurrences.state })
        .from(occurrences)
        .where(eq(occurrences.id, result.occurrenceId))
      if (occ?.state === 'waiting_for_pc') await applyTrigger(tx, result.occurrenceId, 'pc_claimed')
      return result
    })
  )
}

/** Marks the device as seen. `false` when its token is revoked (or gone). */
export async function touchDevice(db: Db, device: DeviceAuth, now: Date = new Date()): Promise<boolean> {
  const rows = await guarded(() =>
    db
      .update(deviceTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(deviceTokens.id, device.deviceId),
          eq(deviceTokens.memberId, device.memberId),
          isNull(deviceTokens.revokedAt)
        )
      )
      .returning({ id: deviceTokens.id })
  )
  return rows.length === 1
}

/**
 * Extends the lease of a job the device holds to `JOB_LEASE_MS` from `now`. An `native_transcription` lease that has
 * already lapsed cannot be renewed (the job is the scheduler's to release): the device claims it again. A `local_run`
 * lease is not a liveness lease (`releaseExpiredLeases` skips it, R13), so it renews whenever the device holds it.
 */
export async function renewLease(db: Db, device: DeviceAuth, jobId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await guarded(() =>
    db
      .update(companionJobs)
      .set({ leaseUntil: new Date(now.getTime() + JOB_LEASE_MS), updatedAt: now })
      .where(
        and(
          eq(companionJobs.id, jobId),
          eq(companionJobs.memberId, device.memberId),
          eq(companionJobs.deviceId, device.deviceId),
          eq(companionJobs.state, 'claimed'),
          or(eq(companionJobs.kind, 'local_run'), gt(companionJobs.leaseUntil, now))
        )
      )
      .returning({ id: companionJobs.id })
  )
  return rows.length === 1
}

/**
 * Returns claimed `native_transcription` jobs whose lease ended before `now` to `pending` and returns their ids: those
 * of every member, or only of `memberId` when it is given (a device request passes its own member). A `local_run` is
 * never released here (R13): its PC may be offline for a while and the run goes on; the monitor ends it after
 * `LOCAL_HEARTBEAT_TIMEOUT_MS`.
 */
export async function releaseExpiredLeases(db: Db, now: Date = new Date(), memberId?: string): Promise<string[]> {
  const rows = await guarded(() =>
    db
      .update(companionJobs)
      .set({ state: 'pending', deviceId: null, leaseUntil: null, updatedAt: now })
      .where(
        and(
          eq(companionJobs.state, 'claimed'),
          ne(companionJobs.kind, 'local_run'),
          lt(companionJobs.leaseUntil, now),
          memberId === undefined ? undefined : eq(companionJobs.memberId, memberId)
        )
      )
      .returning({ id: companionJobs.id })
  )
  return rows.map((r) => r.id)
}

/** The job this device holds (`claimed`, lease not lapsed unless it is a `local_run`), else `null`. */
export async function getClaimedJob(
  db: Db,
  device: DeviceAuth,
  jobId: string,
  now: Date = new Date()
): Promise<CompanionJob | null> {
  const [row] = await guarded(() =>
    db
      .select(jobColumns)
      .from(companionJobs)
      .where(heldBy(device, jobId, now))
  )
  return row ? toJob(row) : null
}

/** A job by id, for the server side only (callers have authorised the request): the job and its member. */
export async function getJob(db: Db, jobId: string): Promise<(CompanionJob & { memberId: string }) | null> {
  const [row] = await guarded(() => db.select(jobColumns).from(companionJobs).where(eq(companionJobs.id, jobId)))
  return row ? { ...toJob(row), memberId: row.memberId } : null
}

/** The job rows this device holds right now: claimed by it, for its member, with a live lease (a `local_run` has none to lapse). */
function heldBy(device: DeviceAuth, jobId: string, now: Date) {
  return and(
    eq(companionJobs.id, jobId),
    eq(companionJobs.memberId, device.memberId),
    eq(companionJobs.deviceId, device.deviceId),
    eq(companionJobs.state, 'claimed'),
    or(eq(companionJobs.kind, 'local_run'), gt(companionJobs.leaseUntil, now))
  )
}

/**
 * Marks a `claimed` job `done`, in one guarded `UPDATE`: only the device that holds it, with a lease that has not
 * lapsed, can. Returns `false` (and changes nothing) otherwise, so a repeat, a device that lost the job and a holder whose
 * lease lapsed are all no-ops.
 */
export async function completeJob(db: Db, device: DeviceAuth, jobId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await guarded(() =>
    db
      .update(companionJobs)
      .set({ state: 'done', leaseUntil: null, updatedAt: now })
      .where(heldBy(device, jobId, now))
      .returning({ id: companionJobs.id })
  )
  return rows.length === 1
}

/**
 * Counts a failed attempt of a job the device holds (see `completeJob`) in one statement. Under `NATIVE_MAX_ATTEMPTS`
 * the job returns to `pending` for another try; at the limit it becomes `failed`. `error` is a short reason for the
 * member.
 */
export async function failJobAttempt(
  db: Db,
  device: DeviceAuth,
  jobId: string,
  error: string,
  now: Date = new Date()
): Promise<'retry' | 'failed'> {
  const exhausted = sql`${companionJobs.attempts} + 1 >= ${NATIVE_MAX_ATTEMPTS}`
  const [row] = await guarded(() =>
    db
      .update(companionJobs)
      .set({
        attempts: sql`${companionJobs.attempts} + 1`,
        state: sql`case when ${exhausted} then 'failed' else 'pending' end`,
        deviceId: null,
        leaseUntil: null,
        error,
        updatedAt: now
      })
      .where(heldBy(device, jobId, now))
      .returning({ state: companionJobs.state })
  )
  if (!row) throw new Error('The device does not hold the job.')
  return row.state === 'failed' ? 'failed' : 'retry'
}

/** Marks that the "start your PC" ping went out. `true` only for the first call. */
export async function markPcPingSent(db: Db, jobId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await guarded(() =>
    db
      .update(companionJobs)
      .set({ pcPingSentAt: now, updatedAt: now })
      .where(and(eq(companionJobs.id, jobId), isNull(companionJobs.pcPingSentAt)))
      .returning({ id: companionJobs.id })
  )
  return rows.length === 1
}
