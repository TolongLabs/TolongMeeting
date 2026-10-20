import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { LocalRunPayload } from '@tm/core'
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { deviceTokens, occurrences, type Db } from '../db'
import { createCompanionJob, emitCompanionEvent } from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember, TEST_MASTER } from '../db/testing'
import { proxy } from '../proxy'
import { createAuth } from '../lib/auth'
import {
  guardDeviceToken,
  isCompanionPath,
  misplacedDeviceToken,
  withDevice,
  type DeviceScope
} from '../lib/companion/scope'
import { hashSecret, newDeviceToken, revokeDevice } from '../lib/companion/tokens'
import { authoriseVncRequest } from '../lib/control'
import { createScope } from '../lib/scope'

afterAll(dropAllTestDbs, 60_000)

const ORIGIN = 'https://tm.example'
const NOW = new Date('2026-10-21T08:00:00Z')

describe('isCompanionPath', () => {
  test.each([
    ['/api/companion/jobs', true],
    ['/api/companion/events', true],
    ['/api/companion/jobs/6f1c0a9e-1111-4222-8333-944455556666/claim', true],
    ['/api/companion/jobs/', true],
    ['/api/companionx/jobs', false],
    ['/api/companion', false],
    ['/api/companion/', false],
    ['/api/companion/../profiles/x', false],
    ['/api/companion/%2e%2e/profiles/x', false],
    ['/api/companion/%2E%2E/profiles/x', false],
    ['/api/companion/%252e%252e/profiles/x', false],
    ['/api/companion%2f..%2fidentities', false],
    ['/api/companion/jobs%2f..%2f..%2fmeetings/abc', false],
    ['/api/companion/./jobs', false],
    ['/api/companion//jobs', false],
    ['//api/companion/jobs', false],
    ['/API/companion/jobs', false],
    ['/api/Companion/jobs', false],
    ['/api/companion/jobs.', false],
    ['/api/companion./jobs', false],
    ['/api/companion/jobs%20', false],
    ['/api/companion/jobs\\..\\x', false],
    ['/api/companion/jobs%00', false],
    ['/api/companion/%zz', false],
    ['/api/meetings/abc', false],
    ['/api/exports/google', false],
    ['/devices', false],
    ['/', false]
  ])('isCompanionPath(%s) is %p', (path, ok) => expect(isCompanionPath(path)).toBe(ok))
})

describe('the proxy', () => {
  const TOKEN = 'tmd_' + 'A'.repeat(43)
  const send = (path: string, headers: Record<string, string>) =>
    proxy(new NextRequest(`${ORIGIN}${path}`, { headers }))

  test('a device token outside /api/companion/ is refused with 403, whatever the path looks like', async () => {
    for (const path of [
      '/api/meetings/abc',
      '/api/profiles/p1',
      '/api/exports/github',
      '/api/vnc/authorize',
      '/api/devices/pairing-code',
      '/api/auth/get-session',
      '/',
      '/devices',
      '/api/companion/../identities',
      '/api/companion/%2e%2e/identities',
      '/api/companion%2f..%2fidentities',
      '//api/companion/jobs',
      '/API/companion/jobs',
      '/api/companion./jobs',
      '/api/companionx/jobs'
    ]) {
      const res = send(path, { authorization: `Bearer ${TOKEN}` })
      expect([path, res.status]).toEqual([path, 403])
      expect(await res.json()).toEqual({ error: 'device_token_not_allowed' })
    }
  })

  test('the refusal does not depend on the token being real, and catches other spellings of the header', () => {
    for (const authorization of [
      `bearer ${TOKEN}`,
      `BEARER   ${TOKEN}`,
      'Bearer tmd_x',
      `Basic abc, Bearer ${TOKEN}`
    ]) {
      expect(send('/api/meetings/abc', { authorization }).status).toBe(403)
    }
    expect(misplacedDeviceToken('/api/meetings/abc', 'Bearer tmd_x')).toBe(true)
  })

  test('requests without a device token pass: a member cookie, a worker token, no header, a companion path', () => {
    const next = (res: Response) => res.headers.get('x-middleware-next') === '1'
    expect(next(send('/api/meetings/abc', { cookie: 'better-auth.session_token=abc.def' }))).toBe(true)
    expect(next(send('/api/control/heartbeat', { authorization: 'Bearer tmw_abcdef' }))).toBe(true)
    expect(next(send('/', {}))).toBe(true)
    expect(next(send('/api/companion/jobs', { authorization: `Bearer ${TOKEN}` }))).toBe(true)
    expect(next(send('/api/companion/pair', {}))).toBe(true)
    expect(
      guardDeviceToken(new Request(`${ORIGIN}/api/companion/jobs`, { headers: { authorization: TOKEN } }))
    ).toBeNull()
  })
})

describe('device routes', () => {
  let db: Db
  let fx: Awaited<ReturnType<typeof seedCompanionFixture>>
  const tokens = {} as Record<'a1' | 'a2' | 'b1', string>

  const local = (occurrenceId: string): LocalRunPayload => ({
    occurrenceId,
    identityId: 'i1',
    identityName: 'Alice',
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
      identity: { id: 'i1', name: 'Alice', zoomGuestName: 'Alice', formProviders: ['google'], organisation: null },
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
  let jobForA2: string
  let jobForB1: string
  let jobForAnyA: string

  /** The route under test: it hands the scope back as JSON of what the device can see. */
  const route = withDevice(
    async (request, scope: DeviceScope) => {
      const jobId = new URL(request.url).searchParams.get('job')
      return Response.json({
        device: scope.device,
        jobs: (await scope.listJobs()).map((j) => j.id),
        events: (await scope.listEvents(0)).length,
        claim: jobId ? await scope.claimJob(jobId).then((r) => (r && r !== 'conflict' ? r.id : r)) : undefined,
        held: jobId ? ((await scope.getClaimedJob(jobId))?.id ?? null) : undefined,
        renewed: jobId ? await scope.renewLease(jobId) : undefined
      })
    },
    () => ({ db })
  )

  const call = (token: string | null, query = '', headers: Record<string, string> = {}) =>
    route(
      new Request(`${ORIGIN}/api/companion/jobs${query}`, {
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }
      }),
      {}
    )

  beforeAll(async () => {
    db = await createTestDb()
    fx = await seedCompanionFixture(db)
    // A native job is live only while its meeting is in the transcript wait.
    await db.update(occurrences).set({ state: 'transcribing' })
    // Give each fixture device a real token: the fixture stores a random hash.
    for (const key of ['a1', 'a2', 'b1'] as const) {
      const { token, hash } = newDeviceToken()
      await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx[key].deviceId))
      tokens[key] = token
    }
    jobForA2 = await createCompanionJob(db, {
      memberId: fx.a2.memberId,
      occurrenceId: fx.occA,
      kind: 'local_run',
      payload: local(fx.occA),
      targetDeviceId: fx.a2.deviceId
    })
    jobForB1 = await createCompanionJob(db, {
      memberId: fx.b1.memberId,
      occurrenceId: fx.occB,
      kind: 'local_run',
      payload: local(fx.occB),
      targetDeviceId: fx.b1.deviceId
    })
    jobForAnyA = await createCompanionJob(db, {
      memberId: fx.a1.memberId,
      occurrenceId: fx.occA,
      kind: 'native_transcription',
      payload: {
        occurrenceId: fx.occA,
        entryName: 'Data Mining',
        start: '2026-10-21T14:00:00+08:00',
        timeZone: 'Asia/Kuala_Lumpur',
        durationSec: 5400,
        flacBytes: 1000
      }
    })
  }, 60_000)

  test('the handler gets the device its token names, and nothing else', async () => {
    const res = await call(tokens.a1)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { device: unknown }).device).toEqual({
      deviceId: fx.a1.deviceId,
      memberId: fx.a1.memberId
    })
  })

  test('a missing, malformed, unknown or revoked token gets one fixed 401 that says nothing', async () => {
    const { token: unknown } = newDeviceToken()
    const { token: revoked, hash } = newDeviceToken()
    const [row] = await db
      .insert(deviceTokens)
      .values({ memberId: fx.a1.memberId, name: 'Old PC', tokenHash: hash, revokedAt: NOW })
      .returning({ id: deviceTokens.id })
    expect(row).toBeDefined()
    const bodies = new Set<string>()
    for (const res of [
      await call(null),
      await call('not-a-token'),
      await call(unknown),
      await call(revoked),
      await call(tokens.a1 + 'x'),
      await route(new Request(`${ORIGIN}/api/companion/jobs`, { headers: { authorization: `Basic ${tokens.a1}` } }), {})
    ]) {
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('no-store')
      bodies.add(await res.text())
    }
    expect(bodies.size).toBe(1)
    // The companion clears its stored token on exactly this body (preflight N14).
    expect(JSON.parse([...bodies][0]!)).toEqual({ error: 'device_revoked_or_unknown' })
  })

  test('a revoked token is refused on the very next request', async () => {
    const { token, hash } = newDeviceToken()
    const [row] = await db
      .insert(deviceTokens)
      .values({ memberId: fx.a1.memberId, name: 'Soon revoked', tokenHash: hash })
      .returning({ id: deviceTokens.id })
    expect((await call(token)).status).toBe(200)
    expect(await revokeDevice(createScope(db, fx.a1.memberId), row!.id, NOW)).toBe(true)
    expect((await call(token)).status).toBe(401)
    expect((await call(token, `?job=${jobForAnyA}`)).status).toBe(401)
    const [stored] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, row!.id))
    expect(stored?.tokenHash).toBe(hashSecret(token))
  })

  test('device A cannot see, claim, renew or read the job of a device of the same member', async () => {
    const res = await call(tokens.a1, `?job=${jobForA2}`)
    const body = (await res.json()) as { jobs: string[]; claim: unknown; held: unknown; renewed: unknown }
    expect(body.jobs).toEqual([jobForAnyA])
    expect(body.claim).toBeNull()
    expect(body.held).toBeNull()
    expect(body.renewed).toBe(false)
  })

  test('device A cannot see, claim, renew or read the job of another member', async () => {
    const res = await call(tokens.a1, `?job=${jobForB1}`)
    const body = (await res.json()) as { jobs: string[]; claim: unknown; held: unknown; renewed: unknown }
    expect(body.jobs).not.toContain(jobForB1)
    expect(body.claim).toBeNull()
    expect(body.held).toBeNull()
    expect(body.renewed).toBe(false)
    // ... and the other way round: B sees none of member A's jobs.
    const other = (await (await call(tokens.b1, `?job=${jobForA2}`)).json()) as typeof body
    expect(other.jobs).toEqual([jobForB1])
    expect(other.claim).toBeNull()
  })

  test('the target device reads its own job, and after it claims it the sibling still cannot', async () => {
    const own = (await (await call(tokens.a2, `?job=${jobForA2}`)).json()) as { jobs: string[]; claim: string }
    expect(own.jobs).toContain(jobForA2)
    expect(own.claim).toBe(jobForA2)
    const sibling = (await (await call(tokens.a1, `?job=${jobForA2}`)).json()) as {
      jobs: string[]
      claim: unknown
      held: unknown
      renewed: unknown
    }
    expect(sibling.jobs).not.toContain(jobForA2)
    expect(sibling.claim).toBeNull()
    expect(sibling.held).toBeNull()
    expect(sibling.renewed).toBe(false)
  })

  test("events: a device sees those for all its member's devices and for itself, never another device's or member's", async () => {
    const all = await emitCompanionEvent(db, fx.a1.memberId, { type: 'local_identities_changed' }, undefined, NOW)
    const mine = await emitCompanionEvent(db, fx.a1.memberId, { type: 'local_identities_changed' }, fx.a1.deviceId, NOW)
    const sibling = await emitCompanionEvent(
      db,
      fx.a1.memberId,
      { type: 'local_identities_changed' },
      fx.a2.deviceId,
      NOW
    )
    const stranger = await emitCompanionEvent(db, fx.b1.memberId, { type: 'local_identities_changed' }, undefined, NOW)
    const seenBy = async (key: 'a1' | 'a2' | 'b1') => {
      let ids: number[] = []
      await withDevice(
        async (_request, scope) => {
          ids = (await scope.listEvents(0)).map((e) => e.id)
          return new Response('ok')
        },
        () => ({ db })
      )(new Request(`${ORIGIN}/api/companion/events`, { headers: { authorization: `Bearer ${tokens[key]}` } }), {})
      return ids
    }
    expect(await seenBy('a1')).toEqual([all, mine])
    expect(await seenBy('a2')).toEqual([all, sibling])
    expect(await seenBy('b1')).toEqual([stranger])
  })

  test('a job id that is not a uuid is "not found", not a server error', async () => {
    const res = await call(tokens.a1, '?job=1%27%20or%201%3D1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { claim: unknown; held: unknown; renewed: unknown }
    expect([body.claim, body.held, body.renewed]).toEqual([null, null, false])
  })
})

describe('the two kinds of sign-in stay apart', () => {
  let db: Db
  let auth: ReturnType<typeof createAuth>
  let cookie: string
  const token = newDeviceToken().token

  beforeAll(async () => {
    db = await createTestDb()
    auth = createAuth({
      db,
      master: TEST_MASTER,
      publicUrl: ORIGIN,
      clientId: 'client-id',
      clientSecret: 'client-secret-value',
      org: 'tolonglabs',
      github: { user: async () => ({ id: 42, login: 'Octo-Member' }), orgMembership: async () => 'active' }
    })
    const ctx = await auth.$context
    await seedMember(db, { githubLogin: 'octo-member', full: false })
    const userId = await seedAuthUser(db, { githubToken: 'gho_member' })
    const session = await ctx.internalAdapter.createSession(userId)
    // Better Auth's signed cookie: the token, a dot and the base64 HMAC-SHA256 of the token under the secret.
    const signature = createHmac('sha256', ctx.secret).update(session.token).digest('base64')
    cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  }, 60_000)

  test('a member session cookie is not a device credential', async () => {
    const route = withDevice(
      async () => new Response('ok'),
      () => ({ db })
    )
    const res = await route(new Request(`${ORIGIN}/api/companion/jobs`, { headers: { cookie } }), {})
    expect(res.status).toBe(401)
  })

  test('the same cookie really is a member session (so the refusal above means something)', async () => {
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull()
  })

  test('a device token is not a member credential', async () => {
    expect(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) })).toBeNull()
    const res = await authoriseVncRequest(
      new Request(`${ORIGIN}/api/vnc/authorize`, {
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-uri': '/vnc/x/websockify' }
      }),
      {
        db,
        getSession: async (headers) => {
          const session = await auth.api.getSession({ headers })
          return session ? { userId: session.user.id } : null
        }
      }
    )
    expect(res.status).toBe(401)
  })
})
