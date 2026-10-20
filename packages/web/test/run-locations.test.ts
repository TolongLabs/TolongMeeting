import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DEVICE_ONLINE_WINDOW_MS, type LocalRunPayload } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionEvents, companionJobs, deviceTokens, identities, occurrences, profiles, type Db } from '../db'
import { claimJob, createCompanionJob, listCompanionEvents } from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { dbHomeNodeStore } from '../db/home-route'
import { deviceName, isDeviceOnline, listLocalIdentities } from '../db/local-runs'
import { QUEUES } from '../db/queues'
import { createTestDb, dropAllTestDbs, FakeQueue, testDbUrl } from '../db/testing'
import { newDeviceToken, revokeDevice } from '../lib/companion/tokens'
import { updateIdentity, type IdentityRow } from '../lib/identities'
import {
  handleCompanionIdentities,
  handleRunLocationRequest,
  setRunLocation,
  type RunLocationChoice
} from '../lib/run-locations/settings'
import { createScope, type MemberScope } from '../lib/scope'
import { GET as companionIdentities } from '../app/api/companion/identities/route'

afterAll(dropAllTestDbs, 60_000)

const t0 = new Date('2026-10-21T08:00:00Z')
const plus = (ms: number) => new Date(t0.getTime() + ms)

const localRun = (occurrenceId: string, identityId: string): LocalRunPayload => ({
  occurrenceId,
  identityId,
  identityName: 'Main',
  image: 'ghcr.io/org/worker:1',
  job: {
    occurrenceId,
    attempt: 1,
    entry: {
      name: 'Data Mining',
      type: 'lecture',
      start: '2026-10-21T14:00:00+08:00',
      end: '2026-10-21T16:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'paste' },
      trustedSenders: [],
      transcription: 'live',
      formDetails: {},
      attendanceKeywords: []
    },
    identity: { id: identityId, name: 'Main', zoomGuestName: 'Main', formProviders: ['google'], organisation: null },
    member: { id: 'm1', displayName: 'Alice', mentionNames: [] },
    ai: {
      baseUrl: 'https://ai.example/v1',
      asrUrl: 'wss://ai.example/asr',
      models: { summary: 'a', vision: 'b', formMatch: 'c', asr: 'd' }
    },
    ntfy: { url: 'https://ntfy.example', topic: 't' },
    dataDir: '/data/occ_1',
    profileDir: '/profiles/i1'
  }
})

let db: Db
let f: Awaited<ReturnType<typeof seedCompanionFixture>>
let scope: MemberScope
let identityA: string
let queue: FakeQueue

beforeAll(async () => {
  db = await createTestDb()
}, 60_000)

// Each case gets two new members, so the cases share one database.
beforeEach(async () => {
  f = await seedCompanionFixture(db)
  scope = createScope(db, f.a1.memberId)
  const [identity] = await db.select().from(identities).where(eq(identities.memberId, f.a1.memberId))
  identityA = identity!.id
  queue = new FakeQueue()
  // The fixture's meeting is still to come; most cases start from an identity with nothing unfinished.
  await db.update(occurrences).set({ state: 'completed' }).where(eq(occurrences.id, f.occA))
}, 60_000)

const local = (deviceId: string): RunLocationChoice => ({ location: 'local', deviceId })
const identityRow = async (): Promise<IdentityRow> =>
  (await db.select().from(identities).where(eq(identities.id, identityA)))[0]!
const profileRow = async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityA)))[0]!
const eventsFor = async (device: typeof f.a1) => (await listCompanionEvents(db, device, 0)).map((e) => e.command)
const allEvents = () => db.select().from(companionEvents).where(eq(companionEvents.memberId, f.a1.memberId))
const seen = (deviceId: string, at: Date) =>
  db.update(deviceTokens).set({ lastUsedAt: at }).where(eq(deviceTokens.id, deviceId))

/** Nothing changed: the row, the profile, the events and the queue are as they were. */
async function expectUntouched() {
  expect(await identityRow()).toMatchObject({ runLocation: 'server', localDeviceId: null })
  expect((await profileRow()).location).toBe('server')
  expect(await allEvents()).toEqual([])
  expect(queue.sent).toEqual([])
}

describe('setRunLocation', () => {
  test("My PC needs one of the member's own unrevoked devices", async () => {
    expect(await setRunLocation(scope, queue, identityA, local(f.b1.deviceId))).toEqual({
      ok: false,
      error: 'device_not_found'
    })
    expect(await setRunLocation(scope, queue, identityA, local(randomUUID()))).toEqual({
      ok: false,
      error: 'device_not_found'
    })
    await revokeDevice(scope, f.a2.deviceId)
    expect(await setRunLocation(scope, queue, identityA, local(f.a2.deviceId))).toEqual({
      ok: false,
      error: 'device_not_found'
    })
    await expectUntouched()
    expect(await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).toEqual({ ok: true })
  })

  test("another member's identity is not found", async () => {
    const other = createScope(db, f.b1.memberId)
    expect(await setRunLocation(other, queue, identityA, { location: 'server_via_home' })).toEqual({
      ok: false,
      error: 'identity_not_found'
    })
    expect(await setRunLocation(scope, queue, 'not-a-uuid', { location: 'server' })).toEqual({
      ok: false,
      error: 'identity_not_found'
    })
    await expectUntouched()
  })

  test('refused while a meeting of the identity is unfinished, and nothing changes', async () => {
    await db.update(occurrences).set({ state: 'scheduled' }).where(eq(occurrences.id, f.occA))
    await expect(setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).rejects.toThrow(
      'meeting or sign-in that has not finished'
    )
    await expectUntouched()
    await db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, f.occA))
    await expect(setRunLocation(scope, queue, identityA, { location: 'server_via_home' })).rejects.toThrow(
      'not finished'
    )
    await db.update(occurrences).set({ state: 'failed' }).where(eq(occurrences.id, f.occA))
    expect(await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).toEqual({ ok: true })
  })

  test('refused while a sign-in or a meeting holds the profile', async () => {
    await db.update(profiles).set({ heldBy: 'signin:abc' }).where(eq(profiles.identityId, identityA))
    await expect(setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).rejects.toThrow('in use')
    expect(await identityRow()).toMatchObject({ runLocation: 'server', localDeviceId: null })
    expect(await allEvents()).toEqual([])
    expect(queue.sent).toEqual([])
    await db.update(profiles).set({ heldBy: null }).where(eq(profiles.identityId, identityA))
    expect(await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).toEqual({ ok: true })
  })

  test('the home route needs a stored home device', async () => {
    expect(await setRunLocation(scope, queue, identityA, { location: 'server_via_home' })).toEqual({
      ok: false,
      error: 'home_route_not_set_up'
    })
    await expectUntouched()
    await dbHomeNodeStore(db, f.a1.memberId).save({
      nodeId: 'n1',
      hostname: 'tm-home-x',
      ipv4: '100.64.0.7',
      checkedAt: t0
    })
    expect(await setRunLocation(scope, queue, identityA, { location: 'server_via_home' })).toEqual({ ok: true })
    expect(await identityRow()).toMatchObject({ runLocation: 'server_via_home', localDeviceId: null })
    expect((await profileRow()).location).toBe('server')
    expect(queue.sent).toEqual([]) // the profile stays on the server
  })

  test('another member’s home device does not count', async () => {
    await dbHomeNodeStore(db, f.b1.memberId).save({ nodeId: 'n1', hostname: 'h', ipv4: '100.64.0.7', checkedAt: t0 })
    expect(await setRunLocation(scope, queue, identityA, { location: 'server_via_home' })).toEqual({
      ok: false,
      error: 'home_route_not_set_up'
    })
  })

  test('switching to My PC binds the PC, queues the server profile delete and tells that PC', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    expect(await identityRow()).toMatchObject({ runLocation: 'local', localDeviceId: f.a1.deviceId })
    expect((await profileRow()).location).toBe('local')
    expect(queue.sent.map((s) => [s.name, s.data])).toEqual([[QUEUES.profileDelete, { identityId: identityA }]])
    expect(await eventsFor(f.a1)).toContainEqual({ type: 'local_identities_changed' })
    expect(await eventsFor(f.a2)).toEqual([])
    expect(await listLocalIdentities(db, f.a1)).toEqual([{ id: identityA, name: 'Main' }])
    expect(await listLocalIdentities(db, f.a2)).toEqual([])
    expect(await listLocalIdentities(db, f.b1)).toEqual([])
  })

  test('the delete is queued only after the move commits: a refused move queues nothing', async () => {
    await db.update(profiles).set({ heldBy: 'occ:x' }).where(eq(profiles.identityId, identityA))
    await expect(setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).rejects.toThrow()
    expect(queue.sent).toEqual([])
  })

  test('asking again for the same PC changes nothing but queues the delete again', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    const before = (await allEvents()).length
    expect(await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).toEqual({ ok: true })
    expect((await allEvents()).length).toBe(before)
    expect(queue.sent).toHaveLength(2)
  })

  test('moving to another PC tells both PCs; moving away from My PC tells the old one', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    await setRunLocation(scope, queue, identityA, local(f.a2.deviceId))
    expect(await identityRow()).toMatchObject({ runLocation: 'local', localDeviceId: f.a2.deviceId })
    expect(await eventsFor(f.a1)).toHaveLength(2)
    expect(await eventsFor(f.a2)).toHaveLength(1)
    await setRunLocation(scope, queue, identityA, { location: 'server' })
    expect(await identityRow()).toMatchObject({ runLocation: 'server', localDeviceId: null })
    expect((await profileRow()).location).toBe('server')
    expect(await eventsFor(f.a2)).toHaveLength(2)
    expect(queue.sent).toHaveLength(2) // only the moves to My PC queue a delete
  })

  test('editing an identity that runs on My PC keeps where it runs', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    await updateIdentity(scope, identityA, { name: 'Renamed', zoomGuestName: 'Someone' })
    expect(await identityRow()).toMatchObject({ name: 'Renamed', runLocation: 'local', localDeviceId: f.a1.deviceId })
    expect((await profileRow()).location).toBe('local')
  })
})

describe('revoking the PC', () => {
  test('clears the binding but leaves the identity on My PC', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    expect(await revokeDevice(scope, f.a1.deviceId)).toBe(true)
    expect(await identityRow()).toMatchObject({ runLocation: 'local', localDeviceId: null })
    expect((await profileRow()).location).toBe('local')
    expect(await listLocalIdentities(db, f.a1)).toEqual([])
    // Nothing can put it back on the server, or on a PC, without the member choosing.
    expect(await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))).toEqual({
      ok: false,
      error: 'device_not_found'
    })
  })

  test('never leaves a local_run job claimable, pending or already claimed', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    await seen(f.a1.deviceId, t0)
    const pending = await createCompanionJob(db, {
      memberId: f.a1.memberId,
      occurrenceId: f.occA,
      kind: 'local_run',
      payload: localRun(f.occA, identityA),
      targetDeviceId: f.a1.deviceId
    })
    const claimed = await createCompanionJob(db, {
      memberId: f.a1.memberId,
      occurrenceId: f.occA,
      kind: 'local_run',
      payload: localRun(f.occA, identityA),
      targetDeviceId: f.a1.deviceId
    })
    await claimJob(db, f.a1, claimed, t0)
    const other = await createCompanionJob(db, {
      memberId: f.a1.memberId,
      occurrenceId: f.occA,
      kind: 'local_run',
      payload: localRun(f.occA, identityA),
      targetDeviceId: f.a2.deviceId
    })

    await revokeDevice(scope, f.a1.deviceId, plus(1000))

    const state = async (id: string) => (await db.select().from(companionJobs).where(eq(companionJobs.id, id)))[0]!
    expect(await state(pending)).toMatchObject({ state: 'cancelled', leaseUntil: null })
    expect(await state(claimed)).toMatchObject({ state: 'cancelled', leaseUntil: null })
    expect((await state(other)).state).toBe('pending')
    for (const device of [f.a1, f.a2]) {
      await seen(device.deviceId, plus(2000))
      for (const id of [pending, claimed]) {
        const result = await claimJob(db, device, id, plus(2000))
        expect(result === null || result === 'conflict').toBe(true)
      }
    }
    expect(await claimJob(db, f.a2, other, plus(2000))).toMatchObject({ state: 'claimed' })
  })

  test('a repeat or a foreign revoke changes nothing', async () => {
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))
    expect(await revokeDevice(createScope(db, f.b1.memberId), f.a1.deviceId)).toBe(false)
    expect((await identityRow()).localDeviceId).toBe(f.a1.deviceId)
    expect(await revokeDevice(scope, f.a1.deviceId)).toBe(true)
    expect(await revokeDevice(scope, f.a1.deviceId)).toBe(false)
  })
})

describe('device queries', () => {
  test('a device counts as online for 90 seconds after it was last seen', async () => {
    expect(await isDeviceOnline(db, f.a1.deviceId, t0)).toBe(false) // never seen
    await seen(f.a1.deviceId, t0)
    expect(await isDeviceOnline(db, f.a1.deviceId, plus(DEVICE_ONLINE_WINDOW_MS))).toBe(true)
    expect(await isDeviceOnline(db, f.a1.deviceId, plus(DEVICE_ONLINE_WINDOW_MS + 1))).toBe(false)
    await revokeDevice(scope, f.a1.deviceId)
    expect(await isDeviceOnline(db, f.a1.deviceId, t0)).toBe(false)
  })

  test('deviceName answers the name, or null for an unknown device', async () => {
    expect(await deviceName(db, f.a1.deviceId)).toBe('DESKTOP-ABC')
    expect(await deviceName(db, randomUUID())).toBeNull()
  })
})

describe('PUT /api/identities/<id>/run-location', () => {
  const put = (body: unknown, headers: Record<string, string> = {}, id = identityA) =>
    handleRunLocationRequest(
      new Request('https://tm.example/api/identities/x/run-location', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      }),
      scope,
      queue,
      id
    )

  test('answers each refusal with its own status and a fixed body', async () => {
    const answer = async (res: Response) => [res.status, await res.json(), res.headers.get('cache-control')]
    expect(await answer(await put({ location: 'server' }, { 'sec-fetch-site': 'cross-site' }))).toEqual([
      403,
      { error: 'forbidden' },
      'no-store'
    ])
    for (const bad of [
      'not json',
      { location: 'moon' },
      { location: 'local' },
      { location: 'local', deviceId: 'x' },
      { location: 'server', extra: 1 }
    ]) {
      expect(await answer(await put(bad))).toEqual([400, { error: 'invalid_body' }, 'no-store'])
    }
    expect(await answer(await put({ location: 'local', deviceId: f.b1.deviceId }))).toEqual([
      404,
      { error: 'device_not_found' },
      'no-store'
    ])
    expect(await answer(await put({ location: 'server' }, {}, randomUUID()))).toEqual([
      404,
      { error: 'identity_not_found' },
      'no-store'
    ])
    expect(await answer(await put({ location: 'server_via_home' }))).toEqual([
      409,
      { error: 'home_route_not_set_up' },
      'no-store'
    ])
    await db.update(occurrences).set({ state: 'scheduled' }).where(eq(occurrences.id, f.occA))
    expect(await answer(await put({ location: 'local', deviceId: f.a1.deviceId }))).toEqual([
      409,
      { error: 'identity_in_use' },
      'no-store'
    ])
    await expectUntouched()
  })

  test('moves the identity', async () => {
    const res = await put({ location: 'local', deviceId: f.a1.deviceId })
    expect([res.status, await res.json()]).toEqual([200, { ok: true }])
    expect((await identityRow()).localDeviceId).toBe(f.a1.deviceId)
  })

  test('a body over the cap is refused', async () => {
    expect((await put({ location: 'server', pad: 'x'.repeat(2000) })).status).toBe(400)
  })
})

describe('GET /api/companion/identities', () => {
  const real = process.env.DATABASE_URL
  const image = process.env.TM_WORKER_IMAGE_REF
  afterAll(() => {
    if (real === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = real
    if (image === undefined) delete process.env.TM_WORKER_IMAGE_REF
    else process.env.TM_WORKER_IMAGE_REF = image
  })

  async function pairedPc() {
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, f.a1.deviceId))
    return token
  }
  const get = (token: string | null) =>
    companionIdentities(
      new Request('https://tm.example/api/companion/identities', {
        headers: token ? { authorization: `Bearer ${token}` } : {}
      }),
      undefined as never
    )

  test('lists the PC’s own identities with the worker image, and refuses a revoked or unknown token', async () => {
    process.env.DATABASE_URL = testDbUrl(db)
    process.env.TM_WORKER_IMAGE_REF = 'ghcr.io/org/tolongmeeting-worker:1.2.3'
    const token = await pairedPc()
    await setRunLocation(scope, queue, identityA, local(f.a1.deviceId))

    const ok = await get(token)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.json()).toEqual({
      identities: [{ id: identityA, name: 'Main' }],
      image: 'ghcr.io/org/tolongmeeting-worker:1.2.3'
    })

    for (const res of [await get(null), await get(newDeviceToken().token)]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'device_revoked_or_unknown' })
    }
    await revokeDevice(scope, f.a1.deviceId)
    const revoked = await get(token)
    expect([revoked.status, await revoked.json()]).toEqual([401, { error: 'device_revoked_or_unknown' }])
  })

  test('an unset image is an error, not a default', async () => {
    await expect(handleCompanionIdentities(db, f.a1, {})).rejects.toThrow('TM_WORKER_IMAGE_REF is not set')
  })
})
