import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { controlTokenHash, vncSecret } from '@tm/core'
import { eq } from 'drizzle-orm'
import { identities, occurrences, profiles, schema, signinSessions } from '../db'
import { FakeQueue, createTestDb, dropAllTestDbs, seedAuthUser, seedMember } from '../db/testing'
import {
  MAX_SIGNIN_BODY_BYTES,
  authoriseVnc,
  authoriseVncRequest,
  handleHeartbeat,
  handleSigninHeartbeat,
  handleSigninRequest
} from '../lib/control'
import { createScope } from '../lib/scope'
import { SigninError, finishSignin, signinStatus, startSignin, vncPassword } from '../lib/signin'

afterAll(dropAllTestDbs, 60_000)

const sha256hex = (t: string) => createHash('sha256').update(t).digest('hex')
const NOW = new Date('2026-10-21T05:00:10.000Z')
const HOUR = 3_600_000

interface Options {
  /** A meeting worker holds the owner's identity in this state and attempt. */
  workerHolding?: { state: 'in_meeting' | 'restarting'; attempt: number }
  /** A container session of the owner that is already ready. */
  readySession?: boolean
  /** The container session's control token. */
  token?: string
}

async function signinFixture(o: Options = {}) {
  const db = await createTestDb()
  const queue = new FakeQueue()
  const owner = await seedMember(db, { full: false })
  const other = await seedMember(db, { full: false })
  const ownerAuthUserId = await seedAuthUser(db)
  const otherAuthUserId = await seedAuthUser(db)
  await db.update(schema.members).set({ authUserId: ownerAuthUserId }).where(eq(schema.members.id, owner.memberId))
  await db.update(schema.members).set({ authUserId: otherAuthUserId }).where(eq(schema.members.id, other.memberId))

  let occurrenceId = ''
  const workerToken = `${o.workerHolding?.attempt ?? 1}.workertoken`
  if (o.workerHolding) {
    const start = new Date(NOW.getTime() - HOUR)
    const [occ] = await db
      .insert(occurrences)
      .values({
        memberId: owner.memberId,
        identityId: owner.identityId,
        entryName: 'Data Mining',
        entryType: 'lecture',
        transcription: 'live',
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * HOUR),
        deleteAfter: new Date(start.getTime() + 30 * 24 * HOUR),
        state: o.workerHolding.state,
        attempt: o.workerHolding.attempt,
        controlTokenHash: sha256hex(workerToken),
        containerName: `tm-worker-x-a${o.workerHolding.attempt}`
      })
      .returning()
    occurrenceId = occ!.id
    await db
      .update(profiles)
      .set({ heldBy: `occ:${occurrenceId}` })
      .where(eq(profiles.identityId, owner.identityId))
  }

  let sessionId = ''
  if (o.readySession) {
    const [session] = await db
      .insert(signinSessions)
      .values({
        memberId: owner.memberId,
        identityId: owner.identityId,
        mode: 'container',
        state: 'ready',
        controlTokenHash: sha256hex(o.token ?? 's.default'),
        lastHeartbeatAt: NOW
      })
      .returning()
    sessionId = session!.id
    await db
      .update(signinSessions)
      .set({ upstream: `tm-signin-${sessionId}:6080` })
      .where(eq(signinSessions.id, sessionId))
    await db
      .update(profiles)
      .set({ heldBy: `signin:${sessionId}` })
      .where(eq(profiles.identityId, owner.identityId))
  }

  const session = async (id: string) => (await db.select().from(signinSessions).where(eq(signinSessions.id, id)))[0]!
  return {
    db,
    queue,
    now: NOW,
    scope: createScope(db, owner.memberId),
    otherScope: createScope(db, other.memberId),
    identityId: owner.identityId,
    otherIdentityId: other.identityId,
    ownerAuthUserId,
    otherAuthUserId,
    occurrenceId,
    sessionId,
    session,
    occurrence: async () => (await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId)))[0]!,
    profile: async () => (await db.select().from(profiles).where(eq(profiles.identityId, owner.identityId)))[0]!,
    /** A heartbeat of the holding worker carrying one `state` event. */
    heartbeatWithEvent: (data: Record<string, unknown>) =>
      handleHeartbeat({ db, queue, now: NOW }, `Bearer ${workerToken}`, {
        occurrenceId,
        attempt: o.workerHolding!.attempt,
        state: o.workerHolding!.state,
        recording: true,
        participants: 3,
        events: [{ occurrenceId, attempt: o.workerHolding!.attempt, at: NOW.toISOString(), type: 'state', data }]
      })
  }
}

describe('start, finish and status', () => {
  test('with no worker running, sign-in asks the scheduler for a container', async () => {
    const f = await signinFixture()
    const r = await startSignin(f.scope, f.identityId, { queue: f.queue })
    expect(r.mode).toBe('container')
    expect(f.queue.sent).toEqual([{ name: 'signin-start', data: { sessionId: r.sessionId }, opts: undefined }])
    expect((await startSignin(f.scope, f.identityId, { queue: f.queue })).sessionId).toBe(r.sessionId)
    expect(f.queue.sent).toHaveLength(1)
    expect(await signinStatus(f.scope, r.sessionId)).toBe('starting')
  })

  test('with a worker running, sign-in pauses it and attaches to its desk', async () => {
    const f = await signinFixture({ workerHolding: { state: 'in_meeting', attempt: 2 } })
    const r = await startSignin(f.scope, f.identityId, { queue: f.queue })
    expect(r.mode).toBe('worker')
    expect(f.queue.sent).toEqual([])
    expect((await f.occurrence()).pendingCommands).toEqual(['pause_for_signin'])
    expect(await f.session(r.sessionId)).toMatchObject({
      state: 'starting',
      upstream: `tm-worker-${f.occurrenceId}-a2:6080`
    })
    await f.heartbeatWithEvent({ signin: 'paused' })
    expect(await signinStatus(f.scope, r.sessionId)).toBe('ready')
    await finishSignin(f.scope, r.sessionId)
    // The first heartbeat delivered `pause_for_signin` and cleared the queue.
    expect((await f.occurrence()).pendingCommands).toEqual(['resume_after_signin'])
    await f.heartbeatWithEvent({ signin: 'resumed', reason: 'command' })
    expect(await signinStatus(f.scope, r.sessionId)).toBe('ended')
    expect(await f.session(r.sessionId)).toMatchObject({ endReason: 'done' })
  })

  test('a desk pause that ends for idleness is recorded as idle', async () => {
    const f = await signinFixture({ workerHolding: { state: 'in_meeting', attempt: 1 } })
    const r = await startSignin(f.scope, f.identityId, { queue: f.queue })
    await f.heartbeatWithEvent({ signin: 'paused' })
    await f.heartbeatWithEvent({ signin: 'resumed', reason: 'idle' })
    expect(await f.session(r.sessionId)).toMatchObject({ state: 'ended', endReason: 'idle' })
  })

  test('a second start does not queue pause_for_signin twice', async () => {
    const f = await signinFixture({ workerHolding: { state: 'in_meeting', attempt: 1 } })
    await startSignin(f.scope, f.identityId, { queue: f.queue })
    await startSignin(f.scope, f.identityId, { queue: f.queue })
    expect((await f.occurrence()).pendingCommands).toEqual(['pause_for_signin'])
  })

  test('a worker between attempts does not hold the desk: the session asks for a container', async () => {
    const f = await signinFixture({ workerHolding: { state: 'restarting', attempt: 1 } })
    expect((await startSignin(f.scope, f.identityId, { queue: f.queue })).mode).toBe('container')
    expect((await f.occurrence()).pendingCommands).toEqual([])
  })

  test("a member cannot start, read, finish or open another member's session", async () => {
    const f = await signinFixture({ readySession: true })
    await expect(startSignin(f.otherScope, f.identityId, { queue: f.queue })).rejects.toThrow(SigninError)
    await expect(signinStatus(f.otherScope, f.sessionId)).rejects.toThrow(SigninError)
    await expect(finishSignin(f.otherScope, f.sessionId)).rejects.toThrow(SigninError)
    await expect(vncPassword(f.otherScope, f.sessionId)).rejects.toThrow(SigninError)
    expect((await f.session(f.sessionId)).doneRequested).toBe(false)
    expect(f.queue.sent).toEqual([])
  })

  test('only identities that run on the server can sign in remotely', async () => {
    const f = await signinFixture()
    await f.db.update(identities).set({ runLocation: 'local' }).where(eq(identities.id, f.identityId))
    await expect(startSignin(f.scope, f.identityId, { queue: f.queue })).rejects.toThrow(SigninError)
    await expect(startSignin(f.scope, 'not-a-uuid', { queue: f.queue })).rejects.toThrow(SigninError)
  })

  test('a queue that fails ends the session instead of leaving it to time out', async () => {
    const f = await signinFixture()
    const broken = {
      send: async () => {
        throw new Error('queue down')
      }
    }
    await expect(startSignin(f.scope, f.identityId, { queue: broken })).rejects.toThrow('queue down')
    const [row] = await f.db.select().from(signinSessions).where(eq(signinSessions.identityId, f.identityId))
    expect(row).toMatchObject({ state: 'ended', endReason: 'queue_failed' })
    // The next start is a fresh session.
    expect((await startSignin(f.scope, f.identityId, { queue: f.queue })).sessionId).not.toBe(row!.id)
  })

  test('the view password is the one the worker derives from its token, and only for a ready session', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    expect(await vncPassword(f.scope, f.sessionId)).toBe(vncSecret(controlTokenHash('s.abc')))
    await f.db.update(signinSessions).set({ state: 'ended' }).where(eq(signinSessions.id, f.sessionId))
    await expect(vncPassword(f.scope, f.sessionId)).rejects.toThrow(SigninError)

    const w = await signinFixture({ workerHolding: { state: 'in_meeting', attempt: 2 } })
    const r = await startSignin(w.scope, w.identityId, { queue: w.queue })
    await expect(vncPassword(w.scope, r.sessionId)).rejects.toThrow(SigninError)
    await w.heartbeatWithEvent({ signin: 'paused' })
    expect(await vncPassword(w.scope, r.sessionId)).toBe(vncSecret(controlTokenHash('2.workertoken')))
  })
})

describe('forward auth', () => {
  const uri = (id: string) => new Headers({ 'x-forwarded-uri': `/vnc/${id}/websockify` })

  test('forward auth lets only the owner reach a ready session', async () => {
    const f = await signinFixture({ readySession: true })
    const as = (userId: string | null) => ({ db: f.db, getSession: async () => (userId ? { userId } : null) })
    const h = uri(f.sessionId)
    expect(await authoriseVnc(as(f.ownerAuthUserId), h)).toEqual({
      status: 200,
      upstream: `tm-signin-${f.sessionId}:6080`
    })
    expect(await authoriseVnc(as(f.otherAuthUserId), h)).toEqual({ status: 403 })
    expect(await authoriseVnc(as(null), h)).toEqual({ status: 401 })
    expect(await authoriseVnc(as(f.ownerAuthUserId), new Headers({ 'x-forwarded-uri': '/vnc/../admin' }))).toEqual({
      status: 403
    })
    expect(await authoriseVnc(as(f.ownerAuthUserId), new Headers())).toEqual({ status: 403 })
    // An auth user with no member behind it reaches nothing.
    const stranger = await seedAuthUser(f.db)
    expect(await authoriseVnc(as(stranger), h)).toEqual({ status: 403 })
  })

  test('a session that is not ready, or whose path escapes, is refused', async () => {
    const f = await signinFixture({ readySession: true })
    const as = { db: f.db, getSession: async () => ({ userId: f.ownerAuthUserId }) }
    for (const bad of [
      `/vnc/${f.sessionId}/../../admin`,
      `/vnc/${f.sessionId}/%2e%2e/admin`,
      `/vnc/${f.sessionId.toUpperCase()}x/websockify`,
      `/vncs/${f.sessionId}/websockify`
    ])
      expect(await authoriseVnc(as, new Headers({ 'x-forwarded-uri': bad }))).toEqual({ status: 403 })
    await f.db.update(signinSessions).set({ state: 'starting' }).where(eq(signinSessions.id, f.sessionId))
    expect(await authoriseVnc(as, uri(f.sessionId))).toEqual({ status: 403 })
    await f.db
      .update(signinSessions)
      .set({ state: 'ready', upstream: 'evil.example:6080' })
      .where(eq(signinSessions.id, f.sessionId))
    expect(await authoriseVnc(as, uri(f.sessionId))).toEqual({ status: 403 })
    await f.db.update(signinSessions).set({ upstream: null }).where(eq(signinSessions.id, f.sessionId))
    expect(await authoriseVnc(as, uri(f.sessionId))).toEqual({ status: 403 })
  })

  test('the route answers an empty 200 with the upstream, or a fixed body that names nothing', async () => {
    const f = await signinFixture({ readySession: true })
    const deps = (userId: string | null) => ({ db: f.db, getSession: async () => (userId ? { userId } : null) })
    const request = () => new Request('http://tm.test/api/vnc/authorize', { headers: uri(f.sessionId) })
    const ok = await authoriseVncRequest(request(), deps(f.ownerAuthUserId))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-vnc-upstream')).toBe(`tm-signin-${f.sessionId}:6080`)
    expect(await ok.text()).toBe('')
    const denied = await authoriseVncRequest(request(), deps(f.otherAuthUserId))
    expect([denied.status, await denied.json()]).toEqual([403, { error: 'forbidden' }])
    const anonymous = await authoriseVncRequest(request(), deps(null))
    expect([anonymous.status, await anonymous.json()]).toEqual([401, { error: 'unauthorized' }])
    expect(denied.headers.get('x-vnc-upstream')).toBeNull()
  })
})

describe('the sign-in heartbeat', () => {
  const beat = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    sessionId,
    idleMs: 1000,
    ended: false,
    ...extra
  })

  test('the sign-in heartbeat returns stop after Done and ends on the last beat', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    await finishSignin(f.scope, f.sessionId)
    expect(await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.abc', beat(f.sessionId))).toEqual({
      status: 200,
      body: { commands: ['stop'] }
    })
    await handleSigninHeartbeat(
      { db: f.db, now: f.now },
      'Bearer s.abc',
      beat(f.sessionId, { ended: true, reason: 'done' })
    )
    expect(await f.session(f.sessionId)).toMatchObject({ state: 'ended', endReason: 'done' })
    expect(
      (await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.wrong', { ...beat(f.sessionId), idleMs: 0 }))
        .status
    ).toBe(401)
  })

  test('the first beat makes a starting session ready, and a quiet reply carries no command', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    await f.db
      .update(signinSessions)
      .set({ state: 'starting', lastHeartbeatAt: null })
      .where(eq(signinSessions.id, f.sessionId))
    const reply = await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.abc', beat(f.sessionId))
    expect(reply).toEqual({ status: 200, body: { commands: [] } })
    expect(await f.session(f.sessionId)).toMatchObject({ state: 'ready', lastHeartbeatAt: f.now })
  })

  test('the last beat stores the account check, and nothing else about the accounts', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    await handleSigninHeartbeat(
      { db: f.db, now: f.now },
      'Bearer s.abc',
      beat(f.sessionId, {
        ended: true,
        reason: 'done',
        accounts: [
          { account: 'google', signedIn: true },
          { account: 'microsoft', signedIn: false }
        ]
      })
    )
    expect((await f.profile()).accountStatus).toEqual({
      google: { verifiedAt: f.now.toISOString(), signedIn: true },
      microsoft: { verifiedAt: f.now.toISOString(), signedIn: false }
    })
    // A beat that is not the last one never touches the accounts.
    const g = await signinFixture({ readySession: true, token: 's.abc' })
    await handleSigninHeartbeat(
      { db: g.db, now: g.now },
      'Bearer s.abc',
      beat(g.sessionId, { accounts: [{ account: 'google', signedIn: true }] })
    )
    expect((await g.profile()).accountStatus).toEqual({})
  })

  test('an ended session answers stop and keeps its end reason', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    await f.db
      .update(signinSessions)
      .set({ state: 'ended', endReason: 'lost', endedAt: f.now })
      .where(eq(signinSessions.id, f.sessionId))
    const reply = await handleSigninHeartbeat(
      { db: f.db, now: f.now },
      'Bearer s.abc',
      beat(f.sessionId, { ended: true, reason: 'done' })
    )
    expect(reply).toEqual({ status: 200, body: { commands: ['stop'] } })
    expect(await f.session(f.sessionId)).toMatchObject({ state: 'ended', endReason: 'lost' })
  })

  test("another session's token, a worker-mode session and a bad token shape are all the same fixed 401", async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    const other = await signinFixture({ readySession: true, token: 's.other' })
    const unauthorized = { status: 401, body: { error: 'unauthorized' } } as const
    for (const header of [
      null,
      '',
      'Bearer',
      'Bearer s.other',
      'Bearer 1.abc',
      'Bearer s.',
      `Bearer s.${'a'.repeat(300)}`,
      'Basic s.abc'
    ])
      expect(await handleSigninHeartbeat({ db: f.db, now: f.now }, header, beat(f.sessionId))).toEqual(unauthorized)
    // The same token on a session that doesn't exist.
    expect(await handleSigninHeartbeat({ db: other.db, now: other.now }, 'Bearer s.abc', beat(f.sessionId))).toEqual(
      unauthorized
    )
    await f.db.update(signinSessions).set({ mode: 'worker' }).where(eq(signinSessions.id, f.sessionId))
    expect(await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.abc', beat(f.sessionId))).toEqual(
      unauthorized
    )
  })

  test('a valid token with a bad body is a fixed 400 and changes nothing', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    const bad = { status: 400, body: { error: 'invalid request' } } as const
    for (const body of [
      null,
      {},
      { sessionId: 'x' },
      beat(f.sessionId, { idleMs: -1 }),
      beat(f.sessionId, { reason: 'because' }),
      beat(f.sessionId, { ended: 'yes' })
    ])
      expect(await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.abc', body)).toEqual(bad)
    expect(await f.session(f.sessionId)).toMatchObject({ state: 'ready', lastHeartbeatAt: f.now })
  })

  test('the route checks the header before reading the body, and refuses a body over the cap', async () => {
    const f = await signinFixture({ readySession: true, token: 's.abc' })
    const post = (headers: Record<string, string>, body: BodyInit | null) =>
      handleSigninRequest(
        new Request('http://tm.test/api/control/signin', { method: 'POST', headers, body }),
        { db: f.db },
        f.now
      )

    // A body stream that fails if anything reads it.
    const unread = new ReadableStream({
      pull() {
        throw new Error('the body was read')
      }
    })
    const noHeader = await post({}, unread)
    expect([noHeader.status, noHeader.headers.get('cache-control')]).toEqual([401, 'no-store'])

    const huge = JSON.stringify(beat(f.sessionId, { padding: 'x'.repeat(MAX_SIGNIN_BODY_BYTES) }))
    expect((await post({ authorization: 'Bearer s.abc' }, huge)).status).toBe(400)
    expect((await post({ authorization: 'Bearer s.abc' }, 'not json')).status).toBe(400)

    const ok = await post({ authorization: 'Bearer s.abc' }, JSON.stringify(beat(f.sessionId)))
    expect([ok.status, await ok.json()]).toEqual([200, { commands: [] }])
  })
})
