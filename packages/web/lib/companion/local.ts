import { LocalSecretsSchema, type DeviceAuth, type LocalSecrets, type SpecEnv } from '@tm/core'
import { eq } from 'drizzle-orm'
import { getClaimedJob, releaseJob, type Db } from '../../db/companion'
import { loadJobConfig } from '../../db/job-config'
import { occurrences } from '../../db/schema'
import { loadMasterKey } from '../../db/secrets'
import { companionDeps } from './deps'
import type { DeviceScope } from './scope'

// The server side of a local run's secrets (plan 08 T2). The job a PC is offered holds no AI key and no saved details;
// the PC asks for them here, once per attempt, and only while the meeting is close. Every answer is a fixed body.

const NO_STORE = { 'cache-control': 'no-store' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A PC may ask for the secrets from this long before the meeting starts ... */
export const SECRETS_BEFORE_START_MS = 70 * 60_000
/** ... until this long after it ends. */
export const SECRETS_AFTER_END_MS = 30 * 60_000

/** What the secrets and release routes run on. */
export interface LocalDeps {
  db: Db
  master: Buffer
  /** Only `ntfyUrl` and the roots' shapes are read; none of the paths in the job config reaches the answer. */
  env: SpecEnv
}

/** The database, the master key and the server's paths and addresses, read from the environment per request. */
export function localDeps(env: Record<string, string | undefined> = process.env): LocalDeps {
  const need = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
  }
  return {
    ...companionDeps(),
    master: loadMasterKey(),
    env: {
      dataRoot: need('TM_DATA_ROOT'),
      profileRoot: '/tm/profiles',
      publicUrl: need('TM_PUBLIC_URL'),
      ntfyUrl: need('NTFY_URL')
    }
  }
}

/**
 * The AI key and the member's saved details for a `local_run` job this device holds, read the way the server's own
 * launcher does (`loadJobConfig`). `null` (a 404 to the caller) for anything else: another job kind, a job another
 * device holds, a job that is not `claimed`, and any time outside the window from 70 minutes before the meeting's
 * start to 30 minutes after its end.
 */
export async function localSecrets(
  deps: LocalDeps,
  device: DeviceAuth,
  jobId: string,
  now: Date = new Date()
): Promise<LocalSecrets | null> {
  if (!UUID.test(jobId)) return null
  const job = await getClaimedJob(deps.db, device, jobId, now)
  if (job === null || job.kind !== 'local_run') return null
  const [occ] = await deps.db
    .select({ start: occurrences.scheduledStart, end: occurrences.scheduledEnd, attempt: occurrences.attempt })
    .from(occurrences)
    .where(eq(occurrences.id, job.occurrenceId))
  if (!occ) return null
  const t = now.getTime()
  if (t < occ.start.getTime() - SECRETS_BEFORE_START_MS || t > occ.end.getTime() + SECRETS_AFTER_END_MS) return null
  const cfg = await loadJobConfig(deps.db, deps.master, job.occurrenceId, {
    attempt: Math.max(occ.attempt, 1),
    control: null,
    env: deps.env
  })
  return LocalSecretsSchema.parse({ apiKey: cfg.ai.apiKey, details: cfg.member.details })
}

/** `GET /api/companion/jobs/<id>/secrets`: 200 with the secrets (never cached), 404 outside the active window. */
export async function handleSecretsRequest(
  scope: DeviceScope,
  deps: LocalDeps,
  jobId: string,
  now?: Date
): Promise<Response> {
  const secrets = await localSecrets(deps, scope.device, jobId, now)
  if (secrets === null) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE })
  return Response.json(secrets, { headers: NO_STORE })
}

/** `POST /api/companion/jobs/<id>/release`: the holder gives the job back (204), anyone else gets 404. */
export async function handleReleaseRequest(scope: DeviceScope, deps: Pick<LocalDeps, 'db'>, jobId: string) {
  if (!UUID.test(jobId) || !(await releaseJob(deps.db, scope.device, jobId))) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE })
  }
  return new Response(null, { status: 204, headers: NO_STORE })
}
