import {
  ACTIVE_STATES,
  IllegalTransition,
  LOCAL_HEARTBEAT_TIMEOUT_MS,
  LocalRunPayloadSchema,
  meetingUrl,
  shortTime,
  type JobConfig,
  type LocalRunPayload,
  type OccurrenceState
} from '@tm/core'
import { pings, type Ping, type WorkerFailureReason } from '@tm/notify'
import { and, eq, inArray } from 'drizzle-orm'
import { companionJobs, identities, occurrences } from '@tm/web/db'
import { createCompanionJob, emitCompanionEvent } from '@tm/web/db/companion'
import { deviceName, isDeviceOnline } from '@tm/web/db/local-runs'
import { QUEUES, queueDbOf } from '@tm/web/db/queues'
import { applyTrigger } from '@tm/web/db/transitions'
import { z } from 'zod'
import { resolveEnv } from '../container-spec'
import type { LaunchDeps } from '../launch'

// A member's local identity runs on their own PC (plan 08 T2). At T-60 the scheduler writes a `local_run` job aimed at
// the PC bound to the identity and tells that PC; the PC claims it, runs the meeting in Docker Desktop and reports
// through the website. Nothing here starts a container on the server, takes the identity's profile lock or counts
// against the server's worker cap: the profile lives on the PC, and an identity cannot change where it runs while a
// meeting of it is unfinished (`setRunLocation`). So a server launch and a PC run can never both run one meeting.

/** The PC has this long (seconds) to claim an offered job before the occurrence is skipped. */
export const LOCAL_CLAIM_SECONDS = 120
/** An occurrence that has not started on the PC this long before its start fails. */
export const LOCAL_START_DEADLINE_MS = 10 * 60_000

export type LocalDeps = Pick<LaunchDeps, 'db' | 'queue' | 'notifier' | 'env'> & {
  /** The registry reference the PC pulls. Default `TM_WORKER_IMAGE_REF`; unset is an error, never a default. */
  image?: string
}
type Outbox = Array<() => Promise<unknown>>

const JobData = z.strictObject({ jobId: z.uuid() })

const imageOf = (deps: LocalDeps): string => {
  const image = deps.image ?? process.env.TM_WORKER_IMAGE_REF
  if (!image) throw new Error('TM_WORKER_IMAGE_REF is not set')
  return image
}

/**
 * The job a PC is offered: the full job config without the AI key, the ntfy token, the member's saved details and the
 * control block. The PC fetches the secrets itself when it runs (`GET /api/companion/jobs/<id>/secrets`).
 */
export function toLocalPayload(cfg: JobConfig, identityName: string, image: string): LocalRunPayload {
  const { ai, ntfy, member, control: _control, ...rest } = cfg
  const { apiKey: _apiKey, ...aiPublic } = ai
  const { token: _token, ...ntfyPublic } = ntfy
  const { details: _details, ...memberPublic } = member
  return LocalRunPayloadSchema.parse({
    occurrenceId: cfg.occurrenceId,
    identityId: cfg.identity.id,
    identityName,
    image,
    job: { ...rest, ai: aiPublic, ntfy: ntfyPublic, member: memberPublic }
  })
}

/**
 * Whether a local run that has been quiet for `silentForMs` has lost its PC. Only the states in which the worker beats
 * count: `starting` belongs to the start check (the PC has until T-10), and from `uploading` on the PC sends files, not
 * heartbeats, for as long as the upload takes.
 */
export function localHeartbeatTimeout(state: OccurrenceState, silentForMs: number): 'none' | 'pc_lost' {
  if (!ACTIVE_STATES.has(state) || state === 'starting' || state === 'uploading') return 'none'
  return silentForMs > LOCAL_HEARTBEAT_TIMEOUT_MS ? 'pc_lost' : 'none'
}

const FAILURE_PHRASE: Record<string, WorkerFailureReason> = {
  docker_unavailable: "Docker Desktop wasn't running",
  docker_memory_low: 'Docker Desktop had too little memory',
  image_unavailable: "Docker couldn't download the bot software"
}
const phraseOf = (code: string): WorkerFailureReason => FAILURE_PHRASE[code] ?? 'your PC stopped responding'

type OccurrenceRow = typeof occurrences.$inferSelect

/**
 * Fails a local occurrence that is still running or starting: its `local_run` job (if still open) fails with `code`,
 * the occurrence applies `fail` with that reason, and the member gets the worker-failed ping once. `false` when the
 * occurrence had moved on (nothing changes, no ping). The job and the state change commit together.
 */
export async function failLocalOccurrence(
  deps: Pick<LocalDeps, 'db' | 'notifier' | 'env'>,
  occurrenceId: string,
  code: string
): Promise<boolean> {
  const row = await deps.db.transaction(async (tx): Promise<OccurrenceRow | null> => {
    const [current] = await tx.select().from(occurrences).where(eq(occurrences.id, occurrenceId)).for('update')
    if (!current || !ACTIVE_STATES.has(current.state)) return null
    await tx
      .update(companionJobs)
      .set({ state: 'failed', error: code, updatedAt: new Date() })
      .where(
        and(
          eq(companionJobs.occurrenceId, occurrenceId),
          eq(companionJobs.kind, 'local_run'),
          inArray(companionJobs.state, ['pending', 'claimed'])
        )
      )
    try {
      await applyTrigger(tx, occurrenceId, 'fail', { reason: code })
    } catch (e) {
      if (e instanceof IllegalTransition) return null
      throw e
    }
    return current
  })
  if (row === null) return false
  await deps.notifier.notify(
    row.memberId,
    pings.workerFailed({
      entry: row.entryName,
      reason: phraseOf(code),
      meetingUrl: meetingUrl(resolveEnv(deps.env).publicUrl, row.id)
    })
  )
  return true
}

/** The ping and the way out for a PC that cannot take the meeting: `skip_pc_offline`, with the member told once. */
function offlinePing(deps: LocalDeps, cfg: JobConfig, device: string | null): Ping {
  const entry = cfg.entry.name
  const when = shortTime(cfg.entry.start, cfg.entry.timeZone)
  const url = meetingUrl(resolveEnv(deps.env).publicUrl, cfg.occurrenceId)
  return device === null
    ? pings.pcNotPaired({ entry, when, runsOn: 'My PC', account: cfg.identity.name, meetingUrl: url })
    : pings.pcOffline({ entry, when, pcName: device, meetingUrl: url })
}

/**
 * Offers an occurrence that is still `scheduled` to the PC bound to its identity, in the caller's transaction (the
 * launcher's, under the launch lock; `deps.db` must be that transaction). `cfg` is the occurrence's job config for
 * attempt 1 (its entry snapshot is already stored).
 *
 * - The PC exists and was seen within `DEVICE_ONLINE_WINDOW_MS`: the occurrence moves to `starting`, a `local_run` job
 *   aimed at that device only is created with the stripped payload, the PC gets `job_available`, and two checks are
 *   queued: `local-claim-check` after 120 s and `local-start-check` at T-10.
 * - No PC is bound or it is offline: the occurrence goes `starting` then `skipped_pc_offline`, the member's ping
 *   (`pcNotPaired` or `pcOffline`) goes out through `outbox` once the transaction commits, and nothing runs elsewhere.
 */
export async function startLocalRun(
  deps: LocalDeps,
  cfg: JobConfig,
  now: Date,
  outbox: Outbox
): Promise<'offered' | 'skipped_pc_offline'> {
  const { db } = deps
  const [identity] = await db
    .select({ name: identities.name, deviceId: identities.localDeviceId })
    .from(identities)
    .where(and(eq(identities.id, cfg.identity.id), eq(identities.memberId, cfg.member.id)))
  if (!identity) throw new Error(`No identity ${cfg.identity.id} for member ${cfg.member.id}`)
  const device = identity.deviceId === null ? null : await deviceName(db, identity.deviceId)
  const online = identity.deviceId !== null && (await isDeviceOnline(db, identity.deviceId, now))

  await applyTrigger(db, cfg.occurrenceId, 'launch')
  if (identity.deviceId === null || !online) {
    await applyTrigger(db, cfg.occurrenceId, 'skip_pc_offline')
    outbox.push(() => deps.notifier.notify(cfg.member.id, offlinePing(deps, cfg, device)))
    return 'skipped_pc_offline'
  }

  // `lastHeartbeatAt` starts the clock of the start check; the attempt is the one the PC is told to run.
  await db.update(occurrences).set({ attempt: 1, lastHeartbeatAt: now }).where(eq(occurrences.id, cfg.occurrenceId))
  const jobId = await createCompanionJob(db, {
    memberId: cfg.member.id,
    occurrenceId: cfg.occurrenceId,
    kind: 'local_run',
    payload: toLocalPayload(cfg, identity.name, imageOf(deps)),
    targetDeviceId: identity.deviceId
  })
  await emitCompanionEvent(db, cfg.member.id, { type: 'job_available', jobId }, identity.deviceId, now)
  const inTx = queueDbOf(db)
  await deps.queue.send(
    QUEUES.localClaimCheck,
    { jobId },
    { startAfter: new Date(now.getTime() + LOCAL_CLAIM_SECONDS * 1000), db: inTx }
  )
  const deadline = new Date(new Date(cfg.entry.start).getTime() - LOCAL_START_DEADLINE_MS)
  await deps.queue.send(
    QUEUES.localStartCheck,
    { jobId },
    { startAfter: deadline.getTime() > now.getTime() ? deadline : now, db: inTx }
  )
  return 'offered'
}

async function loadJob(db: LocalDeps['db'], jobId: string) {
  const [job] = await db
    .select({
      id: companionJobs.id,
      state: companionJobs.state,
      error: companionJobs.error,
      occurrenceId: companionJobs.occurrenceId,
      memberId: companionJobs.memberId,
      targetDeviceId: companionJobs.targetDeviceId
    })
    .from(companionJobs)
    .where(and(eq(companionJobs.id, jobId), eq(companionJobs.kind, 'local_run')))
  return job ?? null
}

/**
 * Runs 120 s after the offer. A job that no PC has claimed is cancelled, the occurrence is skipped
 * (`skip_pc_offline`) and the member is pinged once. A job already claimed (or finished some other way) is left alone.
 * The cancel and the state change commit together, so a repeat of this check finds nothing to do.
 */
export async function checkLocalClaim(
  deps: LocalDeps,
  jobId: string,
  now: Date
): Promise<'claimed' | 'skipped_pc_offline' | 'stale'> {
  const job = await loadJob(deps.db, jobId)
  if (job === null) return 'stale'
  if (job.state !== 'pending') return job.state === 'claimed' || job.state === 'done' ? 'claimed' : 'stale'
  const ping = await deps.db.transaction(async (tx): Promise<Ping | null> => {
    const [occ] = await tx.select().from(occurrences).where(eq(occurrences.id, job.occurrenceId)).for('update')
    if (!occ || occ.state !== 'starting') return null
    const cancelled = await tx
      .update(companionJobs)
      .set({ state: 'cancelled', updatedAt: now })
      .where(and(eq(companionJobs.id, jobId), eq(companionJobs.state, 'pending')))
      .returning({ id: companionJobs.id })
    if (cancelled.length === 0) return null
    await applyTrigger(tx, occ.id, 'skip_pc_offline')
    const device = job.targetDeviceId === null ? null : await deviceName(tx, job.targetDeviceId)
    return pings.pcOffline({
      entry: occ.entryName,
      when: shortTime(occ.scheduledStart.toISOString(), occ.entrySnapshot?.timeZone ?? 'UTC'),
      pcName: device ?? 'your PC',
      meetingUrl: meetingUrl(resolveEnv(deps.env).publicUrl, occ.id)
    })
  })
  if (ping === null) {
    const again = await loadJob(deps.db, jobId)
    return again?.state === 'claimed' ? 'claimed' : 'stale'
  }
  await deps.notifier.notify(job.memberId, ping)
  return 'skipped_pc_offline'
}

/**
 * Runs at T-10. An occurrence still `starting` has not heard from its PC (or the PC reported a problem it could not
 * fix): the occurrence and the job fail, with the job's `error` (the last preflight reason) or `pc_lost`, and the member
 * gets the worker-failed ping. The companion then gets 404s and stops retrying. An occurrence that is already running
 * is `running`; one that ended some other way is `stale`.
 */
export async function checkLocalStart(
  deps: LocalDeps,
  jobId: string,
  _now: Date
): Promise<'running' | 'failed' | 'stale'> {
  const job = await loadJob(deps.db, jobId)
  if (job === null) return 'stale'
  const [occ] = await deps.db.select().from(occurrences).where(eq(occurrences.id, job.occurrenceId))
  if (!occ) return 'stale'
  if (occ.state !== 'starting') return ACTIVE_STATES.has(occ.state) ? 'running' : 'stale'
  return (await failLocalOccurrence(deps, occ.id, job.error ?? 'pc_lost')) ? 'failed' : 'stale'
}

// --- The queue handlers --------------------------------------------------------------------------------------------

/** The `local-claim-check` handler. Returns the outcome for the log. */
export async function handleLocalClaimCheck(deps: LaunchDeps, data: unknown, now: Date): Promise<string> {
  const { jobId } = JobData.parse(data)
  return checkLocalClaim(deps, jobId, now)
}

/** The `local-start-check` handler. Returns the outcome for the log. */
export async function handleLocalStartCheck(deps: LaunchDeps, data: unknown, now: Date): Promise<string> {
  const { jobId } = JobData.parse(data)
  return checkLocalStart(deps, jobId, now)
}

/**
 * The `local-start-dead` handler: a start check whose retries are spent must not strand the occurrence in `starting`.
 * It does what the check does, without waiting.
 */
export async function handleLocalStartDead(deps: LaunchDeps, data: unknown, now: Date): Promise<string> {
  const { jobId } = JobData.parse(data)
  const outcome = await checkLocalStart(deps, jobId, now)
  if (outcome === 'failed') console.error(`local-start-dead: ${jobId}: the start check never succeeded; failed the run`)
  return outcome
}
