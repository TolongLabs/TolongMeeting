import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DEVICE_ONLINE_WINDOW_MS } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionEvents, deviceTokens, identities, type Db } from '../db'
import { listCompanionEvents } from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { createTestDb, dropAllTestDbs } from '../db/testing'
import { handleOpenSigninRequest, openSignin } from '../lib/run-locations/signin'
import { createScope, type MemberScope } from '../lib/scope'
import { POST } from '../app/api/identities/[id]/open-signin/route'

afterAll(dropAllTestDbs, 60_000)

const t0 = new Date('2026-10-21T08:00:00Z')

let db: Db
let f: Awaited<ReturnType<typeof seedCompanionFixture>>
let scopeA: MemberScope
let identityA: string
let identityB: string
let previousUrl: string | undefined

beforeAll(async () => {
  db = await createTestDb()
  previousUrl = process.env.TM_PUBLIC_URL
  process.env.TM_PUBLIC_URL = 'https://tm.example/'
}, 60_000)

afterAll(() => {
  if (previousUrl === undefined) delete process.env.TM_PUBLIC_URL
  else process.env.TM_PUBLIC_URL = previousUrl
})

// Each case gets two new members, so the cases share one database.
beforeEach(async () => {
  f = await seedCompanionFixture(db)
  scopeA = createScope(db, f.a1.memberId)
  identityA = (await db.select().from(identities).where(eq(identities.memberId, f.a1.memberId)))[0]!.id
  identityB = (await db.select().from(identities).where(eq(identities.memberId, f.b1.memberId)))[0]!.id
}, 60_000)

const bindLocal = (identityId: string, deviceId: string) =>
  db.update(identities).set({ runLocation: 'local', localDeviceId: deviceId }).where(eq(identities.id, identityId))
const seen = (deviceId: string, at: Date) =>
  db.update(deviceTokens).set({ lastUsedAt: at }).where(eq(deviceTokens.id, deviceId))
const commands = async (device: typeof f.a1) => (await listCompanionEvents(db, device, 0)).map((e) => e.command)
const allEvents = (memberId: string) => db.select().from(companionEvents).where(eq(companionEvents.memberId, memberId))

describe('open-signin', () => {
  test('open-signin reaches only the bound PC', async () => {
    await bindLocal(identityA, f.a1.deviceId)
    await seen(f.a1.deviceId, t0)
    await seen(f.a2.deviceId, t0)
    const res = await handleOpenSigninRequest(scopeA, identityA, t0)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ opened: true, pcName: 'DESKTOP-ABC' })
    expect(await commands(f.a1)).toContainEqual({ type: 'open_signin', identityId: identityA })
    expect(await commands(f.a2)).toEqual([])
    expect(await allEvents(f.b1.memberId)).toEqual([])
  })

  test('open-signin explains an offline PC or a server identity', async () => {
    await bindLocal(identityA, f.a1.deviceId)
    // Never seen, then seen too long ago, then revoked: each is "offline", and nothing is queued.
    expect(await (await handleOpenSigninRequest(scopeA, identityA, t0)).json()).toEqual({
      opened: false,
      reason: 'pc_offline'
    })
    await seen(f.a1.deviceId, t0)
    const late = new Date(t0.getTime() + DEVICE_ONLINE_WINDOW_MS + 1)
    expect(await openSignin(scopeA, identityA, late)).toEqual({ opened: false, reason: 'pc_offline' })
    await db.update(deviceTokens).set({ revokedAt: t0 }).where(eq(deviceTokens.id, f.a1.deviceId))
    expect(await openSignin(scopeA, identityA, t0)).toEqual({ opened: false, reason: 'pc_offline' })
    expect(await allEvents(f.a1.memberId)).toEqual([])

    await db.update(identities).set({ runLocation: 'server', localDeviceId: null }).where(eq(identities.id, identityA))
    expect(await (await handleOpenSigninRequest(scopeA, identityA, t0)).json()).toEqual({
      opened: false,
      reason: 'not_local'
    })
    expect(await allEvents(f.a1.memberId)).toEqual([])
  })

  test("another member's identity, a missing one and a malformed id are the same 404", async () => {
    await bindLocal(identityB, f.b1.deviceId)
    await seen(f.b1.deviceId, t0)
    for (const id of [identityB, randomUUID(), 'not-a-uuid']) {
      const res = await handleOpenSigninRequest(scopeA, id, t0)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'identity_not_found' })
    }
    expect(await allEvents(f.b1.memberId)).toEqual([])
    expect(await allEvents(f.a1.memberId)).toEqual([])
  })

  test('the route refuses a request that is not from the site itself, before it looks at a session', async () => {
    const ctx = { params: Promise.resolve({ id: identityA }) }
    const none: Record<string, string> = {}
    for (const headers of [none, { origin: 'https://evil.example' }, { origin: 'null' }]) {
      const res = await POST(new Request('https://tm.example/x', { method: 'POST', headers }), ctx)
      expect(res.status).toBe(403)
    }
  })
})
