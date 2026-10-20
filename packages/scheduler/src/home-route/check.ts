import { meetingUrl, shortTime, type JobConfig } from '@tm/core'
import { pings, type WorkerFailureReason } from '@tm/notify'
import { and, eq, sql } from 'drizzle-orm'
import { events, occurrences } from '@tm/web/db'
import { dbHomeNodeStore } from '@tm/web/db/home-route'
import { loadJobConfig } from '@tm/web/db/job-config'
import { QUEUES } from '@tm/web/db/queues'
import { hashEventData, applyTrigger } from '@tm/web/db/transitions'
import {
  checkHomeRoute,
  TailscaleApi,
  TailscaleApiError,
  tailscaleConfigFromEnv,
  type HomeRouteStatus
} from '@tm/web/lib/home-route'
import { z } from 'zod'
import { resolveEnv } from '../container-spec'
import { startAttempt, type LaunchDeps } from '../launch'
import { releaseProfile } from '../locks'
import { launchViaHome } from './sidecar'
import { HomeRouteUnavailable, type HomeDeps } from './types'

/** How long after a check that did not launch the next one runs. */
export const RECHECK_SECONDS = 60
/** From this long before the start on, a home device that is still not ready fails the occurrence (T-10). */
export const HOME_DEADLINE_MS = 10 * 60_000

const RecheckData = z.strictObject({ occurrenceId: z.uuid() })
const LIVE_STATES = new Set(['scheduled', 'starting'])

// --- The Tailscale client ------------------------------------------------------------------------------------------

let shared: { id: string; secret: string; tailnet: string; api: TailscaleApi } | null = null

/**
 * The scheduler's Tailscale client, made once per process so its OAuth token is reused between checks. The client
 * secret comes from the environment only (`TM_TAILSCALE_CLIENT_SECRET`); it is never stored, logged or put in a job.
 */
export function tailscaleApi(env: Record<string, string | undefined>): TailscaleApi {
  const cfg = tailscaleConfigFromEnv(env)
  if (!cfg) throw new Error('The Tailscale OAuth client is not configured (TM_TAILSCALE_CLIENT_ID and _SECRET)')
  if (!shared || shared.id !== cfg.clientId || shared.secret !== cfg.clientSecret || shared.tailnet !== cfg.tailnet) {
    shared = { id: cfg.clientId, secret: cfg.clientSecret, tailnet: cfg.tailnet, api: new TailscaleApi(cfg) }
  }
  return shared.api
}

/**
 * The launch of plan 08 T13: the sidecar pins the node that `checkHomeRoute` has just stored for the member (its stable
 * node id and keyed hostname, never a name or address the worker could supply) and the worker joins its namespace.
 * `TAILSCALE_VERSION` (the pin in `docker/worker/versions.env`) is read at launch and its absence is an error.
 */
function sidecarLauncher(
  deps: LaunchDeps,
  api: TailscaleApi,
  env: Record<string, string | undefined>
): HomeDeps['launchViaHome'] {
  return async (cfg, exitNodeIp) => {
    const tailscaleVersion = env.TAILSCALE_VERSION
    if (!tailscaleVersion) throw new Error('TAILSCALE_VERSION is not set; the home route has no sidecar image')
    const node = await dbHomeNodeStore(deps.db, cfg.member.id).get()
    // The check stores the node it found ready a moment ago; a different or missing one means the tunnel can't be trusted.
    if (!node || node.ipv4 !== exitNodeIp) throw new HomeRouteUnavailable('The stored home node changed.')
    await launchViaHome(cfg, node, {
      api,
      docker: deps.docker,
      env: deps.env,
      tailscaleVersion,
      launchWorker: (c, via) => startAttempt(deps, c.occurrenceId, c.attempt, new Date(), via)
    })
  }
}

/** `HomeDeps` from the launcher's dependencies and the environment. `launchViaHome` defaults to the sidecar launch. */
export function homeDepsOf(
  deps: LaunchDeps,
  env: Record<string, string | undefined> = process.env,
  launchViaHome?: HomeDeps['launchViaHome']
): HomeDeps {
  const api = tailscaleApi(env)
  return {
    db: deps.db,
    queue: deps.queue,
    notifier: deps.notifier,
    master: deps.master,
    env: deps.env,
    api,
    launchViaHome: launchViaHome ?? sidecarLauncher(deps, api, env)
  }
}

// --- The check -----------------------------------------------------------------------------------------------------

/** An error's name, and the HTTP status of a Tailscale one. Never its message or any response body. */
function describeError(e: unknown): string {
  if (e instanceof TailscaleApiError) return e.status === undefined ? e.name : `${e.name} HTTP ${e.status}`
  return e instanceof Error ? e.name : 'unknown'
}

/**
 * Fails an occurrence that is still waiting to start, frees its profile and tells the member once. `code` is the raw
 * reason kept in `state_reason`; `phrase` is its member-facing words. An occurrence that already moved is left alone.
 */
async function failOccurrence(
  home: Pick<HomeDeps, 'db' | 'notifier' | 'env'>,
  occurrenceId: string,
  code: string,
  phrase: WorkerFailureReason
): Promise<void> {
  const [occ] = await home.db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!occ || !LIVE_STATES.has(occ.state)) {
    console.warn(`home-route: ${occurrenceId}: not failed; the occurrence is ${occ ? occ.state : 'gone'}`)
    return
  }
  await applyTrigger(home.db, occurrenceId, 'fail', { reason: code })
  await releaseProfile(home.db, occ.identityId, `occ:${occurrenceId}`)
  // Not retried, as in launch.ts: the occurrence has left the live states, so nothing reaches here again; the notifier logs a failed ping by its title and the error's name only.
  const { publicUrl } = resolveEnv(home.env)
  await home.notifier.notify(
    occ.memberId,
    pings.workerFailed({ entry: occ.entryName, reason: phrase, meetingUrl: meetingUrl(publicUrl, occurrenceId) })
  )
}

/**
 * Pings the member about their home device once per occurrence. The ping is an `alert` event with
 * `{ kind: 'home_route_offline' }`. The event is recorded first, under a per-occurrence advisory lock, and the ping goes
 * out after the commit (the outbox order of `launch.ts`): two checks at once, or a crash between the two steps, can lose
 * the ping but never send it twice. A ping that reports failure removes its event again, so the next check tries once more.
 */
async function pingOnce(
  home: HomeDeps,
  cfg: JobConfig,
  device: string,
  problem: Exclude<HomeRouteStatus, 'ready'>,
  deadline: Date,
  now: Date
): Promise<void> {
  const data = { kind: 'home_route_offline', problem }
  const recorded = await home.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`home-route-ping:${cfg.occurrenceId}`}, 0))`)
    const sent = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.occurrenceId, cfg.occurrenceId),
          eq(events.type, 'alert'),
          sql`${events.data}->>'kind' = 'home_route_offline'`
        )
      )
      .limit(1)
    if (sent.length > 0) return null
    const [row] = await tx
      .insert(events)
      .values({
        occurrenceId: cfg.occurrenceId,
        memberId: cfg.member.id,
        attempt: cfg.attempt,
        at: now,
        type: 'alert',
        data,
        dataHash: hashEventData(data)
      })
      .returning({ id: events.id })
    return row!.id
  })
  if (recorded === null) return
  const tz = cfg.entry.timeZone
  const ping = pings.homeConnectionOffline({
    entry: cfg.entry.name,
    when: shortTime(cfg.entry.start, tz),
    device,
    problem,
    deadline: shortTime(deadline.toISOString(), tz),
    meetingUrl: meetingUrl(resolveEnv(home.env).publicUrl, cfg.occurrenceId)
  })
  let delivered = false
  try {
    delivered = await home.notifier.notify(cfg.member.id, ping)
  } finally {
    if (!delivered) await home.db.delete(events).where(eq(events.id, recorded))
  }
}

/**
 * One look at the member's home exit node for an occurrence that runs `server_via_home`:
 *
 * - Ready: `home.launchViaHome(cfg, ipv4)` and `launched`. A tunnel that does not come up (`HomeRouteUnavailable`)
 *   counts as an offline device.
 * - Not ready: `waiting`. The member is pinged once (`pingOnce`), and the next look is queued in 60 s.
 * - Not ready from T-10 on: the occurrence fails (`home_exit_node_offline`) and the member gets the worker-failed
 *   ping. The worker never starts without the exit node.
 * - Tailscale can't be asked (its API is down or its answer is wrong): only the error's name and HTTP status are
 *   logged. This is not the member's fault, so there is no "offline" ping; the look is queued again, and from T-10 on
 *   the occurrence fails with `launch_failed`.
 *
 * Any other error is a real fault (a database error) and is thrown, so the queue retries it.
 */
export async function startViaHomeWith(
  home: HomeDeps,
  cfg: JobConfig,
  now: Date
): Promise<'launched' | 'waiting' | 'failed'> {
  const deadline = new Date(new Date(cfg.entry.start).getTime() - HOME_DEADLINE_MS)
  const late = now.getTime() >= deadline.getTime()
  const again = async (): Promise<'waiting'> => {
    await home.queue.send(
      QUEUES.homeRouteRecheck,
      { occurrenceId: cfg.occurrenceId },
      { startAfter: new Date(now.getTime() + RECHECK_SECONDS * 1000) }
    )
    return 'waiting'
  }

  let route: Awaited<ReturnType<typeof checkHomeRoute>>
  try {
    route = await checkHomeRoute(dbHomeNodeStore(home.db, cfg.member.id), home.api, home.master, cfg.member.id, now)
  } catch (e) {
    if (!(e instanceof TailscaleApiError || e instanceof z.ZodError)) throw e
    console.error(`home-route: ${cfg.occurrenceId}: the Tailscale lookup failed (${describeError(e)})`)
    if (!late) return again()
    await failOccurrence(home, cfg.occurrenceId, 'launch_failed', "it couldn't start")
    return 'failed'
  }

  let problem: Exclude<HomeRouteStatus, 'ready'> = 'offline'
  if (route.status === 'ready') {
    try {
      await home.launchViaHome(cfg, route.ipv4!)
      return 'launched'
    } catch (e) {
      if (!(e instanceof HomeRouteUnavailable)) throw e
      console.error(`home-route: ${cfg.occurrenceId}: the tunnel did not come up (${describeError(e)})`)
    }
  } else {
    problem = route.status
  }

  if (late) {
    await failOccurrence(home, cfg.occurrenceId, 'home_exit_node_offline', 'your home connection was offline')
    return 'failed'
  }
  await pingOnce(home, cfg, route.hostname, problem, deadline, now)
  return again()
}

/**
 * `startViaHomeWith` over the launcher's dependencies and the environment. Plan 08 T2's launch hook calls it, outside
 * the launch lock, for a `server_via_home` occurrence.
 */
export function startViaHome(deps: LaunchDeps, cfg: JobConfig, now: Date): Promise<'launched' | 'waiting' | 'failed'> {
  return startViaHomeWith(homeDepsOf(deps), cfg, now)
}

// --- The jobs ------------------------------------------------------------------------------------------------------

/**
 * The `home-route-recheck` handler: rebuilds the job config of the occurrence and looks at the home route again. A
 * job for an occurrence that is gone or no longer waiting to start (deleted, skipped, failed) is `stale` and ends the
 * chain. It writes nothing to the occurrence: the attempt number and the control token are made by `startAttempt`.
 */
export async function handleHomeRouteRecheck(deps: LaunchDeps, data: unknown, now: Date): Promise<string> {
  const { occurrenceId } = RecheckData.parse(data)
  const [occ] = await deps.db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!occ || !LIVE_STATES.has(occ.state)) {
    console.warn(`home-route-recheck: ${occurrenceId}: dropped; the occurrence is ${occ ? occ.state : 'gone'}`)
    return 'stale'
  }
  // The config is only read by the check and the sidecar launch; `startAttempt` makes the real token and attempt.
  const cfg = await loadJobConfig(deps.db, deps.master, occurrenceId, {
    attempt: Math.max(occ.attempt, 1),
    control: null,
    env: deps.env
  })
  return startViaHome(deps, cfg, now)
}

/**
 * The `home-route-dead` handler: a recheck whose retries are spent (a database that was down, a Tailscale client that
 * is not configured) must not strand the occurrence in `scheduled`. Before T-10 it queues a fresh recheck; from T-10 on
 * it fails the occurrence with `launch_failed`. An occurrence that moved on is `stale`.
 */
export async function handleHomeRouteDead(deps: LaunchDeps, data: unknown, now: Date): Promise<string> {
  const { occurrenceId } = RecheckData.parse(data)
  const [occ] = await deps.db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!occ || !LIVE_STATES.has(occ.state)) {
    console.warn(`home-route-dead: ${occurrenceId}: dropped; the occurrence is ${occ ? occ.state : 'gone'}`)
    return 'stale'
  }
  if (now.getTime() < occ.scheduledStart.getTime() - HOME_DEADLINE_MS) {
    await deps.queue.send(
      QUEUES.homeRouteRecheck,
      { occurrenceId },
      { startAfter: new Date(now.getTime() + RECHECK_SECONDS * 1000) }
    )
    return 'deferred'
  }
  console.error(`home-route-dead: ${occurrenceId}: the rechecks never succeeded; their retries are spent`)
  await failOccurrence(deps, occurrenceId, 'launch_failed', "it couldn't start")
  return 'failed'
}
