import { WORKER_STATES, vncSecret } from '@tm/core'
import { and, eq, ne } from 'drizzle-orm'
import { identities, occurrences, profiles, signinSessions } from '../db/schema'
import { QUEUES, type Queue } from '../db/queues'
import { scopeHomeNodeStore } from '../db/home-route'
import { checkHomeRoute, homeRouteDeps, TailscaleApiError, type HomeRouteDeps } from './home-route'
import type { MemberScope } from './scope'

export type SigninMode = 'worker' | 'container'
export type SigninState = 'starting' | 'ready' | 'ended'

export type StartSigninDeps = {
  queue: Queue
  homeRoute?:
    | {
        check(scope: MemberScope): Promise<{ status: string }>
      }
    | HomeRouteDeps
}

/** A refused sign-in call. The message is fixed and safe to show the member: it names no id, token or path. */
export class SigninError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigninError'
  }
}

const NOT_FOUND = 'This sign-in session was not found.'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OCCURRENCE_HOLDER = /^occ:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Where noVNC of a worker's desk listens, on the worker network: `tm-worker-<occurrenceId>-a<attempt>:6080`. */
export const workerUpstream = (occurrenceId: string, attempt: number): string =>
  `tm-worker-${occurrenceId}-a${attempt}:6080`

type SessionRow = typeof signinSessions.$inferSelect

/** The member's own session, or a `SigninError`: another member's session looks exactly like a missing one. */
async function ownSession(scope: MemberScope, sessionId: string): Promise<SessionRow> {
  if (!UUID.test(sessionId)) throw new SigninError(NOT_FOUND)
  const [row] = await scope.select(signinSessions, eq(signinSessions.id, sessionId))
  if (!row) throw new SigninError(NOT_FOUND)
  return row
}

const OFFLINE_HOME_ROUTE = 'Your home connection is offline. Turn on your home device, then try again.'

async function checkHomeRouteReady(scope: MemberScope, homeRouteDep?: StartSigninDeps['homeRoute']): Promise<void> {
  let status: string
  if (homeRouteDep && 'check' in homeRouteDep) {
    status = (await homeRouteDep.check(scope)).status
  } else if (homeRouteDep && 'api' in homeRouteDep) {
    status = (
      await checkHomeRoute(
        scopeHomeNodeStore(scope),
        homeRouteDep.api,
        homeRouteDep.master,
        scope.memberId,
        homeRouteDep.now()
      )
    ).status
  } else {
    const deps = homeRouteDeps()
    if (!deps) throw new SigninError(OFFLINE_HOME_ROUTE)
    try {
      status = (await checkHomeRoute(scopeHomeNodeStore(scope), deps.api, deps.master, scope.memberId, deps.now()))
        .status
    } catch (e) {
      if (e instanceof TailscaleApiError || (e instanceof Error && e.name === 'TailscaleApiError')) {
        throw new SigninError(OFFLINE_HOME_ROUTE)
      }
      throw e
    }
  }
  if (status !== 'ready') {
    throw new SigninError(OFFLINE_HOME_ROUTE)
  }
}

/**
 * Starts a sign-in for one of the member's identities, or returns the one that is already open.
 *
 * - A meeting worker holds the identity (it is in a worker state): the session is in `worker` mode. The worker is told
 *   to pause (`pause_for_signin`) and the member signs in on the worker's own desk. It is `ready` when the worker
 *   reports the pause.
 * - Nothing holds it: the session is in `container` mode and the scheduler is asked to start a sign-in container
 *   (`signin-start`). The scheduler takes the profile; if a worker takes it first, the session becomes a worker one.
 *
 * Throws a `SigninError` for an identity that isn't the member's or doesn't run on the server.
 */
export async function startSignin(
  scope: MemberScope,
  identityId: string,
  deps: StartSigninDeps
): Promise<{ sessionId: string; mode: SigninMode }> {
  if (!UUID.test(identityId)) throw new SigninError('This identity was not found.')
  const [identity] = await scope.select(identities, eq(identities.id, identityId))
  if (!identity) throw new SigninError('This identity was not found.')
  if (identity.runLocation !== 'server' && identity.runLocation !== 'server_via_home')
    throw new SigninError('Remote sign-in is only for identities that run on the server.')

  if (identity.runLocation === 'server_via_home') {
    const [open] = await scope.select(
      signinSessions,
      and(eq(signinSessions.identityId, identityId), ne(signinSessions.state, 'ended'))
    )
    if (!open) {
      const [profile] = await scope.select(profiles, eq(profiles.identityId, identityId))
      const holder = profile?.heldBy === null ? null : OCCURRENCE_HOLDER.exec(profile?.heldBy ?? '')
      const [worker] = holder ? await scope.select(occurrences, eq(occurrences.id, holder[1]!)) : []
      const workerActive = worker && (WORKER_STATES as ReadonlySet<string>).has(worker.state)
      if (!workerActive) {
        await checkHomeRouteReady(scope, deps.homeRoute)
      }
    }
  }

  const started = await scope.transaction(async (s) => {
    // One start at a time per identity, so two clicks can't open two sessions.
    await s.lock(`signin:${identityId}`)
    const [idRow] = await s.select(identities, eq(identities.id, identityId))
    if (!idRow) throw new SigninError('This identity was not found.')
    if (idRow.runLocation !== 'server' && idRow.runLocation !== 'server_via_home')
      throw new SigninError('Remote sign-in is only for identities that run on the server.')

    const [open] = await s.select(
      signinSessions,
      and(eq(signinSessions.identityId, identityId), ne(signinSessions.state, 'ended'))
    )
    if (open) return { sessionId: open.id, mode: open.mode, queue: false }

    const [profile] = await s.select(profiles, eq(profiles.identityId, identityId))
    if (!profile) throw new SigninError('This identity has no browser profile yet.')
    const holder = profile.heldBy === null ? null : OCCURRENCE_HOLDER.exec(profile.heldBy)
    const [worker] = holder ? await s.select(occurrences, eq(occurrences.id, holder[1]!)) : []
    if (worker && (WORKER_STATES as ReadonlySet<string>).has(worker.state)) {
      const session = await s.insert(signinSessions, {
        identityId,
        mode: 'worker',
        occurrenceId: worker.id,
        upstream: workerUpstream(worker.id, worker.attempt)
      })
      await s.sendCommand(worker.id, 'pause_for_signin')
      return { sessionId: session.id, mode: 'worker' as const, queue: false }
    }
    const session = await s.insert(signinSessions, { identityId, mode: 'container' })
    return { sessionId: session.id, mode: 'container' as const, queue: true }
  })

  if (started.queue) {
    try {
      await deps.queue.send(QUEUES.signinStart, { sessionId: started.sessionId })
    } catch (error) {
      // No job means no container will ever start: end the session instead of leaving it to time out.
      await scope.update(
        signinSessions,
        { state: 'ended', endedAt: new Date(), endReason: 'queue_failed' },
        and(eq(signinSessions.id, started.sessionId), ne(signinSessions.state, 'ended'))!
      )
      throw error
    }
  }
  return { sessionId: started.sessionId, mode: started.mode }
}

/**
 * The member pressed "Done". A container session is told to stop in its next heartbeat reply; a worker session makes the
 * worker resume the meeting (`resume_after_signin`). The session ends when the container or worker reports it. A session
 * that has ended already is left as it is.
 */
export async function finishSignin(scope: MemberScope, sessionId: string): Promise<void> {
  await scope.transaction(async (s) => {
    const row = await ownSession(s, sessionId)
    if (row.state === 'ended') return
    if (row.mode === 'worker' && row.occurrenceId !== null) await s.sendCommand(row.occurrenceId, 'resume_after_signin')
    await s.update(signinSessions, { doneRequested: true }, eq(signinSessions.id, row.id))
  })
}

/** Where the member's session stands: `starting`, `ready` (the view can open) or `ended`. */
export async function signinStatus(scope: MemberScope, sessionId: string): Promise<SigninState> {
  return (await ownSession(scope, sessionId)).state
}

/**
 * The password of the member's remote view, for the viewer to hand to noVNC. Only a `ready` session of this member has
 * one; it comes from the stored hash of the control token (a container's own, or the running worker's) and is never
 * put in a URL, a log or an event. The caller must return it only to the signed-in member who asked.
 */
export async function vncPassword(scope: MemberScope, sessionId: string): Promise<string> {
  const row = await ownSession(scope, sessionId)
  if (row.state !== 'ready') throw new SigninError(NOT_FOUND)
  let hash = row.controlTokenHash
  if (row.mode === 'worker') {
    if (row.occurrenceId === null) throw new SigninError(NOT_FOUND)
    const [occurrence] = await scope.select(occurrences, eq(occurrences.id, row.occurrenceId))
    hash = occurrence?.controlTokenHash ?? null
  }
  if (hash === null) throw new SigninError(NOT_FOUND)
  return vncSecret(hash)
}
