import { z } from 'zod'
import { readCapped } from './tokens'
import type { DeviceScope } from './scope'

// The device routes for jobs. Every answer is a fixed body: no database error text, no id echoed back.

const NO_STORE = { 'cache-control': 'no-store' }
const fixed = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE })

/** A progress report is a heartbeat: empty, or at most this many bytes of JSON. */
export const MAX_PROGRESS_BODY_BYTES = 256

/** What a progress body may say. It is checked and then dropped: only the lease is renewed, nothing is stored. */
const JobProgressSchema = z.strictObject({ percent: z.int().min(0).max(100).optional() })

/** `GET /api/companion/jobs`: lapsed leases go back to `pending` first, then the device's jobs. */
export async function handleJobsRequest(_request: Request, scope: DeviceScope): Promise<Response> {
  await scope.releaseLapsedLeases()
  return Response.json({ jobs: await scope.listJobs() }, { headers: NO_STORE })
}

/** `POST /api/companion/jobs/<id>/claim`: 200 with the job, 409 when it is taken, 404 when it is not this device's. */
export async function handleClaimRequest(scope: DeviceScope, jobId: string): Promise<Response> {
  const result = await scope.claimJob(jobId)
  if (result === null) return fixed('not_found', 404)
  if (result === 'conflict') return fixed('already_claimed', 409)
  return Response.json(result, { headers: NO_STORE })
}

/** `POST /api/companion/jobs/<id>/progress`: renews the lease. 204, or 404 when this device does not hold the job. */
export async function handleProgressRequest(request: Request, scope: DeviceScope, jobId: string): Promise<Response> {
  const raw = await readCapped(request, MAX_PROGRESS_BODY_BYTES)
  if (raw === null) return fixed('body_too_large', 413)
  if (raw !== '') {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      return fixed('invalid_progress', 400)
    }
    if (!JobProgressSchema.safeParse(body).success) return fixed('invalid_progress', 400)
  }
  if (!(await scope.renewLease(jobId))) return fixed('not_found', 404)
  return new Response(null, { status: 204, headers: NO_STORE })
}
