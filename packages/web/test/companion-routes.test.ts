import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PairResponseSchema } from '@tm/core'
import { eq } from 'drizzle-orm'
import { GET as eventsRoute } from '../app/api/companion/events/route'
import { GET as jobsRoute } from '../app/api/companion/jobs/route'
import { GET as audioRoute } from '../app/api/companion/jobs/[id]/audio/route'
import { POST as claimRoute } from '../app/api/companion/jobs/[id]/claim/route'
import { POST as progressRoute } from '../app/api/companion/jobs/[id]/progress/route'
import { POST as transcriptRoute } from '../app/api/companion/jobs/[id]/transcript/route'
import { POST as pairRoute } from '../app/api/companion/pair/route'
import { GET as summariesRoute } from '../app/api/companion/summaries/route'
import { GET as summaryRoute } from '../app/api/companion/summaries/[occurrenceId]/route'
import { artefacts, closeDb, deviceTokens, members, occurrences, type Db } from '../db'
import { createCompanionJob } from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { sealColumn } from '../db/secrets'
import { createTestDb, dropAllTestDbs, FakeQueue, TEST_MASTER, testDbUrl } from '../db/testing'
import { newDeviceToken } from '../lib/companion/tokens'
import { createScope } from '../lib/scope'

// Each route file is imported and called the way Next.js calls it, so the wiring of `ctx.params`, the dependencies read
// from the environment and the session check are exercised, not only the handlers behind them.

const ORIGIN = 'https://tm.example'
const ENV = ['DATABASE_URL', 'TM_DATA_ROOT', 'NTFY_URL', 'TM_MASTER_KEY_FILE'] as const

let db: Db
let fx: Awaited<ReturnType<typeof seedCompanionFixture>>
let work: string
let sessionMember = ''
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {}
const tokens = {} as Record<'a1' | 'a2' | 'b1', string>
const globals = globalThis as typeof globalThis & { __tmQueue?: unknown; __tmPairLimiters?: unknown }
// The real session module, put back after the member routes ran against a fixed member.
const realSession = { ...(await import('../lib/session')) }
let devicesRoutes: {
  pairingCode: typeof import('../app/api/devices/pairing-code/route').POST
  revoke: typeof import('../app/api/devices/[id]/revoke/route').POST
}

const nativePayload = (occurrenceId: string) => ({
  occurrenceId,
  entryName: 'Data Mining',
  start: '2026-10-21T14:00:00+08:00',
  timeZone: 'Asia/Kuala_Lumpur',
  durationSec: 5400,
  flacBytes: 1000
})

beforeAll(async () => {
  db = await createTestDb()
  fx = await seedCompanionFixture(db)
  for (const key of ['a1', 'a2', 'b1'] as const) {
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx[key].deviceId))
    tokens[key] = token
  }
  // Member A has a ntfy topic, as pairing needs.
  await db
    .update(members)
    .set({
      ntfyTopic: 'tm-routes-test',
      ntfyTokenEnc: sealColumn(TEST_MASTER, fx.a1.memberId, 'members.ntfy_token', 'tk_routes_test')
    })
    .where(eq(members.id, fx.a1.memberId))

  work = await mkdtemp(join(tmpdir(), 'tm-companion-routes-'))
  const keyFile = join(work, 'master.key')
  await writeFile(keyFile, TEST_MASTER.toString('base64'))
  for (const name of ENV) saved[name] = process.env[name]
  process.env.DATABASE_URL = testDbUrl(db)
  process.env.TM_DATA_ROOT = join(work, 'data')
  process.env.NTFY_URL = 'https://ntfy.example'
  process.env.TM_MASTER_KEY_FILE = keyFile
  // The upload route asks for the process-wide queue; give it a recording one instead of starting pg-boss.
  globals.__tmQueue = { url: process.env.DATABASE_URL, queue: Promise.resolve(new FakeQueue()) }
  globals.__tmPairLimiters = undefined

  // The member routes ask the session for the member; the session is the one thing replaced.
  mock.module('../lib/session', () => ({
    ...realSession,
    requireMember: async () => createScope(db, sessionMember)
  }))
  devicesRoutes = {
    pairingCode: (await import('../app/api/devices/pairing-code/route')).POST,
    revoke: (await import('../app/api/devices/[id]/revoke/route')).POST
  }
}, 60_000)

afterAll(async () => {
  mock.module('../lib/session', () => realSession)
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  globals.__tmQueue = undefined
  globals.__tmPairLimiters = undefined
  await closeDb()
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 60_000)

const authed = (path: string, token: string, method = 'GET', body?: string) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body })
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

async function heldJob(): Promise<string> {
  const id = await createCompanionJob(db, {
    memberId: fx.a1.memberId,
    occurrenceId: fx.occA,
    kind: 'native_transcription',
    payload: nativePayload(fx.occA)
  })
  const res = await claimRoute(authed(`/api/companion/jobs/${id}/claim`, tokens.a1, 'POST'), params({ id }))
  expect(res.status).toBe(200)
  return id
}

describe('device routes', () => {
  test('GET /api/companion/jobs lists the device jobs', async () => {
    const id = await createCompanionJob(db, {
      memberId: fx.a1.memberId,
      occurrenceId: fx.occA,
      kind: 'native_transcription',
      payload: nativePayload(fx.occA)
    })
    const res = await jobsRoute(authed('/api/companion/jobs', tokens.a1), {})
    expect(res.status).toBe(200)
    expect((await res.json()).jobs).toContainEqual(expect.objectContaining({ id }))
    expect((await jobsRoute(new Request(`${ORIGIN}/api/companion/jobs`), {})).status).toBe(401)
  })

  test('POST claim reads the job id from ctx.params', async () => {
    const id = await createCompanionJob(db, {
      memberId: fx.a1.memberId,
      occurrenceId: fx.occA,
      kind: 'native_transcription',
      payload: nativePayload(fx.occA)
    })
    const path = `/api/companion/jobs/${id}/claim`
    const other = await claimRoute(authed(path, tokens.b1, 'POST'), params({ id }))
    expect(other.status).toBe(404)
    const ok = await claimRoute(authed(path, tokens.a1, 'POST'), params({ id }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ id, state: 'claimed' })
  })

  test('POST progress reads the job id from ctx.params', async () => {
    const id = await heldJob()
    const path = `/api/companion/jobs/${id}/progress`
    expect((await progressRoute(authed(path, tokens.a1, 'POST', '{"percent":10}'), params({ id }))).status).toBe(204)
    const unknown = '6f1c0a9e-1111-4222-8333-944455556666'
    expect((await progressRoute(authed(path, tokens.a1, 'POST'), params({ id: unknown }))).status).toBe(404)
  })

  test('GET audio and POST transcript read the job id from ctx.params', async () => {
    const id = await heldJob()
    const unknown = '6f1c0a9e-1111-4222-8333-944455556666'
    // No audio file was written: a held job is told it is gone, a job that is not held is not found.
    const audio = await audioRoute(authed(`/api/companion/jobs/${id}/audio`, tokens.a1), params({ id }))
    expect([audio.status, await audio.json()]).toEqual([410, { error: 'audio_gone' }])
    const notHeld = await audioRoute(authed(`/api/companion/jobs/${unknown}/audio`, tokens.a1), params({ id: unknown }))
    expect(notHeld.status).toBe(404)

    // An upload with no multipart body is refused as invalid by a held job and as not found by any other.
    const upload = await transcriptRoute(
      authed(`/api/companion/jobs/${id}/transcript`, tokens.a1, 'POST'),
      params({ id })
    )
    expect([upload.status, await upload.json()]).toEqual([400, { error: 'invalid_upload' }])
    const missing = await transcriptRoute(
      authed(`/api/companion/jobs/${unknown}/transcript`, tokens.a1, 'POST'),
      params({ id: unknown })
    )
    expect(missing.status).toBe(404)
  })

  test('GET summaries and GET summaries/<occurrenceId> read the member summaries', async () => {
    const name = '2026-10-21 1400 Data Mining.md'
    const path = join(process.env.TM_DATA_ROOT!, 'occurrences', fx.occA, 'out', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '# Summary\n\nHello')
    await db.update(occurrences).set({ state: 'completed' }).where(eq(occurrences.id, fx.occA))
    await db.insert(artefacts).values({
      occurrenceId: fx.occA,
      memberId: fx.a1.memberId,
      kind: 'summary',
      path: `out/${name}`,
      bytes: 16,
      createdAt: new Date('2026-10-21T08:00:00Z')
    })

    const list = await summariesRoute(authed('/api/companion/summaries?after=2026-10-21T07:00:00.000Z', tokens.a1), {})
    expect(list.status).toBe(200)
    expect((await list.json()).summaries).toEqual([
      { occurrenceId: fx.occA, fileName: name, readyAt: '2026-10-21T08:00:00.000Z' }
    ])
    const one = await summaryRoute(
      authed(`/api/companion/summaries/${fx.occA}`, tokens.a1),
      params({ occurrenceId: fx.occA })
    )
    expect(one.status).toBe(200)
    expect(await one.text()).toBe('# Summary\n\nHello')
    const foreign = await summaryRoute(
      authed(`/api/companion/summaries/${fx.occA}`, tokens.b1),
      params({ occurrenceId: fx.occA })
    )
    expect(foreign.status).toBe(404)
  })

  test('GET events opens a stream for the device', async () => {
    const ac = new AbortController()
    const res = await eventsRoute(
      new Request(`${ORIGIN}/api/companion/events`, {
        headers: { authorization: `Bearer ${tokens.a1}` },
        signal: ac.signal
      }),
      {}
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(': open\n\n')
    await reader.cancel()
    ac.abort()
    expect((await eventsRoute(new Request(`${ORIGIN}/api/companion/events`), {})).status).toBe(401)
  })

  test('POST pair trades a code for a device token', async () => {
    const { createPairingCode } = await import('../lib/companion/tokens')
    const { code } = await createPairingCode(createScope(db, fx.a1.memberId))
    const body = JSON.stringify({ code, deviceName: 'ROUTE-PC' })
    const res = await pairRoute(
      new Request(`${ORIGIN}/api/companion/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body
      })
    )
    expect(res.status).toBe(200)
    const paired = PairResponseSchema.parse(await res.json())
    expect(paired.ntfy).toEqual({ url: 'https://ntfy.example', topic: 'tm-routes-test', token: 'tk_routes_test' })
    const again = await pairRoute(
      new Request(`${ORIGIN}/api/companion/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body
      })
    )
    expect([again.status, await again.json()]).toEqual([400, { error: 'invalid_code' }])
  })
})

describe('member routes', () => {
  test('POST /api/devices/pairing-code answers a code for the signed-in member', async () => {
    sessionMember = fx.a1.memberId
    const res = await devicesRoutes.pairingCode(new Request(`${ORIGIN}/api/devices/pairing-code`, { method: 'POST' }))
    expect(res.status).toBe(200)
    expect((await res.json()).code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    sessionMember = fx.b1.memberId // no ntfy topic
    const refused = await devicesRoutes.pairingCode(
      new Request(`${ORIGIN}/api/devices/pairing-code`, { method: 'POST' })
    )
    expect([refused.status, await refused.json()]).toEqual([409, { error: 'ntfy_not_set_up' }])
  })

  test('POST /api/devices/<id>/revoke reads the device id from ctx.params', async () => {
    sessionMember = fx.a1.memberId
    const request = (id: string) => new Request(`${ORIGIN}/api/devices/${id}/revoke`, { method: 'POST' })
    // Another member's device is not found for this member.
    const foreign = await devicesRoutes.revoke(request(fx.b1.deviceId), params({ id: fx.b1.deviceId }))
    expect([foreign.status, await foreign.json()]).toEqual([404, { error: 'not_found' }])
    const ok = await devicesRoutes.revoke(request(fx.a2.deviceId), params({ id: fx.a2.deviceId }))
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true }])
    const [row] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, fx.a2.deviceId))
    expect(row!.revokedAt).not.toBeNull()
  })
})
