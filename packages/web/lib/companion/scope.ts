import type { CompanionEvent, CompanionJob, DeviceAuth, SummaryListItem } from '@tm/core'
import {
  claimJobAndResume,
  getClaimedJob,
  listCompanionEvents,
  listJobsForDevice,
  releaseExpiredLeases,
  renewLease,
  touchDevice,
  type Db
} from '../../db/companion'
import { listSummaries, readSummary } from './summaries'
import { companionDeps } from './deps'
import { authenticateDevice } from './tokens'

export { guardDeviceToken, isCompanionPath, misplacedDeviceToken } from './guard'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The only way a device request touches the database. It is not a `MemberScope`: it holds no table access at all, only
 * the few operations a PC may do, each fixed to this device and its member. A job aimed at another device (of the same
 * member or another), another member's job and a revoked device's anything come back as "not found" (`null` or `false`).
 */
export interface DeviceScope {
  readonly device: DeviceAuth
  /** The member's `pending` jobs this device may claim (untargeted or aimed at it) and the jobs it holds. */
  listJobs(): Promise<CompanionJob[]>
  /** Events after `afterId` for every device of the member or for this device alone. */
  listEvents(afterId: number): Promise<CompanionEvent[]>
  /**
   * Claims a job for this device. A claimed `native_transcription` job whose occurrence waits for a PC takes the
   * occurrence back to `transcribing` (`pc_claimed`) in the same transaction, so a failure leaves the job unclaimed.
   */
  claimJob(jobId: string, now?: Date): Promise<CompanionJob | 'conflict' | null>
  renewLease(jobId: string, now?: Date): Promise<boolean>
  /** The job this device holds, else `null`. */
  getClaimedJob(jobId: string, now?: Date): Promise<CompanionJob | null>
  /** Returns jobs whose lease lapsed to `pending` (any member's: it is housekeeping, and the answer carries nothing). */
  releaseLapsedLeases(now?: Date): Promise<void>
  /** The member's finished summaries after `after`, oldest first (see `listSummaries`). */
  listSummaries(after: Date): Promise<SummaryListItem[]>
  /** One of the member's summaries, else `null` (see `readSummary`). */
  readSummary(occurrenceId: string): Promise<{ fileName: string; text: string } | null>
  /** Marks this device as seen. `false` when its token was revoked since the request began. */
  touch(now?: Date): Promise<boolean>
}

/** What `withDevice` runs on. */
export interface DeviceDeps {
  db: Db
}

/** A scope for an already authenticated device. Ids that are not UUIDs are "not found" instead of a database error. */
export function createDeviceScope(db: Db, device: DeviceAuth): DeviceScope {
  const known = { deviceId: device.deviceId, memberId: device.memberId }
  return Object.freeze({
    device: Object.freeze(known),
    listJobs: () => listJobsForDevice(db, known),
    listEvents: (afterId: number) => listCompanionEvents(db, known, afterId),
    claimJob: async (jobId: string, now?: Date) => (UUID.test(jobId) ? claimJobAndResume(db, known, jobId, now) : null),
    renewLease: async (jobId: string, now?: Date) => UUID.test(jobId) && (await renewLease(db, known, jobId, now)),
    getClaimedJob: async (jobId: string, now?: Date) =>
      UUID.test(jobId) ? getClaimedJob(db, known, jobId, now) : null,
    listSummaries: (after: Date) => listSummaries(db, known.memberId, after),
    readSummary: (occurrenceId: string) => readSummary(db, known.memberId, occurrenceId),
    releaseLapsedLeases: async (now?: Date) => {
      await releaseExpiredLeases(db, now)
    },
    touch: (now?: Date) => touchDevice(db, known, now)
  })
}

const unauthorised = () =>
  Response.json({ error: 'device_revoked_or_unknown' }, { status: 401, headers: { 'cache-control': 'no-store' } })

/**
 * Wraps a `/api/companion/*` handler. The request is authenticated by its `Authorization: Bearer tmd_...` header and
 * nothing else: cookies are never read, so a member's session proves nothing here. The token is checked against its
 * stored hash on every request (a revoke bites at once). A missing, malformed, unknown or revoked token all get the
 * same fixed 401. `deps` is read per request, so building the app needs no database.
 */
export function withDevice<C>(
  handler: (request: Request, scope: DeviceScope, ctx: C) => Promise<Response>,
  deps: () => DeviceDeps = companionDeps
): (request: Request, ctx: C) => Promise<Response> {
  return async (request, ctx) => {
    const { db } = deps()
    const device = await authenticateDevice(db, request.headers.get('authorization'))
    if (!device) return unauthorised()
    return handler(request, createDeviceScope(db, device), ctx)
  }
}
