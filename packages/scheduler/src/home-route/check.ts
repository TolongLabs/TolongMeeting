import { createHash, randomBytes } from 'node:crypto'
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
import type { LaunchDeps } from '../launch'
import { releaseProfile } from '../locks'
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
function tailscaleApi(env: Record<string, string | undefined>): TailscaleApi {
  const cfg = tailscaleConfigFromEnv(env)
  if (!cfg) throw new Error('The Tailscale OAuth client is not configured (TM_TAILSCALE_CLIENT_ID and _SECRET)')
  if (!shared || shared.id !== cfg.clientId || shared.secret !== cfg.clientSecret || shared.tailnet !== cfg.tailnet) {
    shared = { id: cfg.clientId, secret: cfg.clientSecret, tailnet: cfg.tailnet, api: new TailscaleApi(cfg) }
  }
  return shared.api
}

/** Until plan 08 T13 wires the sidecar, a launch through the home route fails loudly, never as a silent no-op. */
const notWired: HomeDeps['launchViaHome'] = async () => {
  throw new Error('launchViaHome: not wired yet (plan 08 T13)')
}

/** `HomeDeps` from the launcher's dependencies and the environment. T13 passes its `launchViaHome` here. */
export function homeDepsOf(
  deps: LaunchDeps,
  env: Record<string, string | undefined> = process.env,
  launchViaHome: HomeDeps['launchViaHome'] = notWired
): HomeDeps {
  return {
    db: deps.db,
    queue: deps.queue,
    notifier: deps.notifier,
    master: deps.master,
    env: deps.env,
    api: tailscaleApi(env),
    launchViaHome
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
  const { publicUrl } = resolveEnv(home.env)
  await home.notifier.notify(
    occ.memberId,
    pings.workerFailed({ entry: occ.entryName, reason: phrase, meetingUrl: meetingUrl(publicUrl, occurrenceId) })
  )
}

/**
 * Pings the member about their home device once per occurrence. The ping is an `alert` event with
 * `{ kind: 'home_route_offline' }`, written after the ping went out: a ping that fails is tried again by the next
 * check, and one that was sent is never repeated by a later check.
 */
async function pingOnce(
  home: HomeDeps,
  cfg: JobConfig,
  device: string,
  problem: Exclude<HomeRouteStatus, 'ready'>,
  deadline: Date,
  now: Date
): Promise<void> {
  const sent = await home.db
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
  if (sent.length > 0) return
  const tz = cfg.entry.timeZone
  const ping = pings.homeConnectionOffline({
    entry: cfg.entry.name,
    when: shortTime(cfg.entry.start, tz),
    device,
    problem,
    deadline: shortTime(deadline.toISOString(), tz),
    meetingUrl: meetingUrl(resolveEnv(home.env).publicUrl, cfg.occurrenceId)
  })
  if (!(await home.notifier.notify(cfg.member.id, ping))) return
  const data = { kind: 'home_route_offline', problem }
  await home.db.insert(events).values({
    occurrenceId: cfg.occurrenceId,
    memberId: cfg.member.id,
    attempt: cfg.attempt,
    at: now,
    type: 'alert',
    data,
    dataHash: hashEventData(data)
  })
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
 * chain. The control token is made here and only its hash is stored, as the launcher does.
 */
export async function handleHomeRouteRecheck(deps: LaunchDeps, data: unknown, now: Date): Promise<string> {
  const { occurrenceId } = RecheckData.parse(data)
  const [occ] = await deps.db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!occ || !LIVE_STATES.has(occ.state)) {
    console.warn(`home-route-recheck: ${occurrenceId}: dropped; the occurrence is ${occ ? occ.state : 'gone'}`)
    return 'stale'
  }
  const attempt = Math.max(occ.attempt, 1)
  const token = `${attempt}.${randomBytes(32).toString('base64url')}`
  await deps.db
    .update(occurrences)
    .set({ controlTokenHash: createHash('sha256').update(token).digest('hex'), attempt })
    .where(eq(occurrences.id, occurrenceId))
  const cfg = await loadJobConfig(deps.db, deps.master, occurrenceId, {
    attempt,
    control: { url: `${resolveEnv(deps.env).publicUrl}/api/control`, token },
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
