import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEVICE_ONLINE_WINDOW_MS, JOB_LEASE_MS, type NativeJobPayload } from '@tm/core'
import { eq, sql } from 'drizzle-orm'
import { artefacts, companionJobs, deviceTokens, events, occurrences, type Db } from '../db'
import { claimJob, createCompanionJob } from '../db/companion'
import { localRunPayload, seedCompanionFixture } from '../db/companion.fixtures'
import { createTestDb, dropAllTestDbs } from '../db/testing'
import {
  handleClaimRequest,
  handleJobsRequest,
  handleProgressRequest,
  MAX_PROGRESS_BODY_BYTES
} from '../lib/companion/jobs'
import { createDeviceScope, withDevice } from '../lib/companion/scope'
import { handleSummariesRequest, handleSummaryRequest } from '../lib/companion/summaries'
import { newDeviceToken } from '../lib/companion/tokens'

let db: Db
let fx: Awaited<ReturnType<typeof seedCompanionFixture>>
let work: string
let previousRoot: string | undefined
const tokens = {} as Record<'a1' | 'a2' | 'b1', string>

const ORIGIN = 'https://tm.example'
const ID = '6f1c0a9e-1111-4222-8333-944455556666'

const deps = () => ({ db })
const LIST = withDevice(handleJobsRequest, deps)
const CLAIM = withDevice(async (_r, scope, ctx: { id: string }) => handleClaimRequest(scope, ctx.id), deps)
const PROGRESS = withDevice(async (r, scope, ctx: { id: string }) => handleProgressRequest(r, scope, ctx.id), deps)
const SUMMARIES = withDevice(handleSummariesRequest, deps)
const SUMMARY = withDevice(
  async (_r, scope, ctx: { occurrenceId: string }) => handleSummaryRequest(scope, ctx.occurrenceId),
  deps
)

const authed = (path: string, token: string, method = 'GET', body?: string) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body })

const nativePayload = (occurrenceId: string): NativeJobPayload => ({
  occurrenceId,
  entryName: 'Data Mining',
  start: '2026-10-21T14:00:00+08:00',
  timeZone: 'Asia/Kuala_Lumpur',
  durationSec: 5400,
  flacBytes: 1000
})
const pendingJob = (memberId: string, occurrenceId: string) =>
  createCompanionJob(db, { memberId, occurrenceId, kind: 'native_transcription', payload: nativePayload(occurrenceId) })
const stateOf = async (occurrenceId: string) =>
  (await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId)))[0]!.state

beforeAll(async () => {
  db = await createTestDb()
  fx = await seedCompanionFixture(db)
  // A native job is live only while its meeting is in the transcript wait.
  await db.update(occurrences).set({ state: 'transcribing' })
  for (const key of ['a1', 'a2', 'b1'] as const) {
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx[key].deviceId))
    tokens[key] = token
  }
  work = await mkdtemp(join(tmpdir(), 'tm-companion-jobs-'))
  previousRoot = process.env.TM_DATA_ROOT
  process.env.TM_DATA_ROOT = join(work, 'data')
}, 60_000)

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.TM_DATA_ROOT
  else process.env.TM_DATA_ROOT = previousRoot
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 60_000)

describe('GET jobs', () => {
  test('releases lapsed leases before listing', async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    const long = new Date(Date.now() - 2 * JOB_LEASE_MS)
    expect(await claimJob(db, fx.a1, id, long)).toMatchObject({ id, state: 'claimed' })
    const res = await LIST(authed('/api/companion/jobs', tokens.a2), {})
    expect(res.status).toBe(200)
    expect((await res.json()).jobs).toContainEqual(expect.objectContaining({ id, state: 'pending' }))
  })

  test("does not release another member's lapsed leases", async () => {
    const mine = await pendingJob(fx.a1.memberId, fx.occA)
    const theirs = await pendingJob(fx.b1.memberId, fx.occB)
    const long = new Date(Date.now() - 2 * JOB_LEASE_MS)
    await claimJob(db, fx.a1, mine, long)
    await claimJob(db, fx.b1, theirs, long)
    const res = await LIST(authed('/api/companion/jobs', tokens.b1), {})
    expect(res.status).toBe(200)
    const stateOfJob = async (id: string) => (await db.select().from(companionJobs).where(eq(companionJobs.id, id)))[0]!
    expect((await stateOfJob(theirs)).state).toBe('pending')
    expect((await stateOfJob(mine)).state).toBe('claimed')
  })

  test('answers 401 with the fixed body without a device token', async () => {
    const res = await LIST(new Request(`${ORIGIN}/api/companion/jobs`), {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'device_revoked_or_unknown' })
  })
})

describe('claim', () => {
  test('answers 200, then a fixed 409 for another device, and 404 for another member or a bad id', async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    const path = `/api/companion/jobs/${id}/claim`
    const ok = await CLAIM(authed(path, tokens.a1, 'POST'), { id })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ id, state: 'claimed', kind: 'native_transcription' })

    const taken = await CLAIM(authed(path, tokens.a2, 'POST'), { id })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'already_claimed' })

    for (const [token, jobId] of [
      [tokens.b1, id],
      [tokens.a1, 'not-a-uuid'],
      [tokens.a1, ID]
    ] as const) {
      const res = await CLAIM(authed(`/api/companion/jobs/${jobId}/claim`, token, 'POST'), { id: jobId })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  test('a claim of a job whose occurrence waits for a PC applies pc_claimed and records the move', async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    await db.update(occurrences).set({ state: 'waiting_for_pc' }).where(eq(occurrences.id, fx.occA))
    const res = await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokens.a1, 'POST'), { id })
    expect(res.status).toBe(200)
    expect(await stateOf(fx.occA)).toBe('transcribing')
    const moves = await db.select().from(events).where(eq(events.occurrenceId, fx.occA))
    expect(moves.map((e) => e.data)).toContainEqual(
      expect.objectContaining({ from: 'waiting_for_pc', to: 'transcribing', trigger: 'pc_claimed' })
    )
  })

  test('a claim while the occurrence is already transcribing leaves its state alone', async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    await db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, fx.occA))
    expect((await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokens.a1, 'POST'), { id })).status).toBe(200)
    expect(await stateOf(fx.occA)).toBe('transcribing')
  })

  test('a failed pc_claimed leaves the job unclaimed and the occurrence waiting', async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    await db.update(occurrences).set({ state: 'waiting_for_pc' }).where(eq(occurrences.id, fx.occA))
    // The state change writes an `events` row; refuse it, so the move fails after the job was claimed.
    await db.execute(sql`create function tm_refuse_event() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$`)
    await db.execute(
      sql`create trigger tm_refuse_event before insert on events for each row execute function tm_refuse_event()`
    )
    try {
      await expect(CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokens.a1, 'POST'), { id })).rejects.toThrow()
    } finally {
      await db.execute(sql`drop trigger tm_refuse_event on events`)
      await db.execute(sql`drop function tm_refuse_event()`)
    }
    const [row] = await db.select().from(companionJobs).where(eq(companionJobs.id, id))
    expect(row).toMatchObject({ state: 'pending', deviceId: null, leaseUntil: null })
    expect(await stateOf(fx.occA)).toBe('waiting_for_pc')
    // Without the failure the same claim succeeds.
    expect((await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokens.a1, 'POST'), { id })).status).toBe(200)
    expect(await stateOf(fx.occA)).toBe('transcribing')
  })

  test('a local_run is claimable by its target device only, and while that device is online', async () => {
    const id = await createCompanionJob(db, {
      memberId: fx.a1.memberId,
      occurrenceId: fx.occA,
      kind: 'local_run',
      payload: localRunPayload(fx.occA),
      targetDeviceId: fx.a1.deviceId
    })
    const path = `/api/companion/jobs/${id}/claim`
    // Another device of the member, and another member's device, do not see it.
    for (const token of [tokens.a2, tokens.b1]) {
      const res = await CLAIM(authed(path, token, 'POST'), { id })
      expect([res.status, await res.json()]).toEqual([404, { error: 'not_found' }])
    }
    // The route's authentication marks the calling device as seen, so the target is online when it asks.
    const ok = await CLAIM(authed(path, tokens.a1, 'POST'), { id })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ id, kind: 'local_run', state: 'claimed' })
  })

  test('a local_run whose target was last seen outside the online window is a conflict', async () => {
    // The earlier test's run is over: an occurrence has at most one live local_run.
    await db.update(companionJobs).set({ state: 'done' }).where(eq(companionJobs.occurrenceId, fx.occA))
    const id = await createCompanionJob(db, {
      memberId: fx.a1.memberId,
      occurrenceId: fx.occA,
      kind: 'local_run',
      payload: localRunPayload(fx.occA),
      targetDeviceId: fx.a2.deviceId
    })
    // Through the scope with a later clock: the same guard the route reaches, after its sign-in marks the device seen.
    const scope = createDeviceScope(db, fx.a2)
    const seenAt = new Date()
    await db.update(deviceTokens).set({ lastUsedAt: seenAt }).where(eq(deviceTokens.id, fx.a2.deviceId))
    expect(await scope.claimJob(id, new Date(seenAt.getTime() + DEVICE_ONLINE_WINDOW_MS + 1000))).toBe('conflict')
    expect(await scope.claimJob(id, new Date(seenAt.getTime() + 1000))).toMatchObject({ kind: 'local_run' })
  })

  test('two devices claiming at once: exactly one wins', async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    const path = `/api/companion/jobs/${id}/claim`
    const results = await Promise.all([
      CLAIM(authed(path, tokens.a1, 'POST'), { id }),
      CLAIM(authed(path, tokens.a2, 'POST'), { id })
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  })
})

test('the database refuses a claimed job without a lease', async () => {
  const id = await pendingJob(fx.a1.memberId, fx.occA)
  const claimWithoutLease = async () => {
    await db.update(companionJobs).set({ state: 'claimed' }).where(eq(companionJobs.id, id))
  }
  await expect(claimWithoutLease()).rejects.toThrow()
})

describe('progress', () => {
  const claimed = async () => {
    const id = await pendingJob(fx.a1.memberId, fx.occA)
    await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokens.a1, 'POST'), { id })
    return id
  }
  const send = (id: string, token: string, body?: string) =>
    PROGRESS(authed(`/api/companion/jobs/${id}/progress`, token, 'POST', body), { id })

  test('answers 404 from a device that does not hold the job', async () => {
    const id = await claimed()
    const res = await send(id, tokens.a2)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect((await send(id, tokens.b1)).status).toBe(404)
  })

  test('answers 204 and renews the lease, for an empty body and for a valid report', async () => {
    const id = await claimed()
    for (const body of [undefined, '{}', '{"percent":40}']) {
      await db
        .update(companionJobs)
        .set({ leaseUntil: new Date(Date.now() + 1000) })
        .where(eq(companionJobs.id, id))
      const res = await send(id, tokens.a1, body)
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      const [row] = await db.select().from(companionJobs).where(eq(companionJobs.id, id))
      expect(row!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + JOB_LEASE_MS - 60_000)
    }
  })

  test('refuses a body that is not valid, or too large, with fixed errors and no renewal', async () => {
    const id = await claimed()
    const soon = new Date(Date.now() + 1000)
    await db.update(companionJobs).set({ leaseUntil: soon }).where(eq(companionJobs.id, id))
    const cases: [string, number, string][] = [
      ['{"percent":101}', 400, 'invalid_progress'],
      ['{"percent":"half"}', 400, 'invalid_progress'],
      ['{"note":"hello"}', 400, 'invalid_progress'],
      ['[1]', 400, 'invalid_progress'],
      ['not json', 400, 'invalid_progress'],
      [JSON.stringify({ percent: 1, pad: 'x'.repeat(MAX_PROGRESS_BODY_BYTES) }), 413, 'body_too_large']
    ]
    for (const [body, status, error] of cases) {
      const res = await send(id, tokens.a1, body)
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error })
    }
    const [row] = await db.select().from(companionJobs).where(eq(companionJobs.id, id))
    expect(row!.leaseUntil!.getTime()).toBe(soon.getTime())
  })
})

describe('summaries', () => {
  const T = new Date('2026-10-21T08:00:00Z')

  async function summary(occurrenceId: string, memberId: string, name: string, text: string) {
    const path = join(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId, 'out', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    await db.update(occurrences).set({ state: 'completed' }).where(eq(occurrences.id, occurrenceId))
    await db
      .insert(artefacts)
      .values({ occurrenceId, memberId, kind: 'summary', path: `out/${name}`, bytes: text.length, createdAt: T })
  }

  beforeAll(async () => {
    await summary(fx.occA, fx.a1.memberId, '2026-10-21 1400 Data Mining.md', '# Summary\n\nHello')
    await summary(fx.occB, fx.b1.memberId, '2026-10-21 1500 Other.md', 'Secret')
  })

  test('the list answers the member summaries after a time, nothing of another member, and 400 for a bad time', async () => {
    const res = await SUMMARIES(authed('/api/companion/summaries?after=2026-10-21T07:00:00.000Z', tokens.a1), {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      summaries: [{ occurrenceId: fx.occA, fileName: '2026-10-21 1400 Data Mining.md', readyAt: T.toISOString() }]
    })
    const none = await SUMMARIES(authed('/api/companion/summaries?after=2026-10-21T08:00:00.000Z', tokens.a1), {})
    expect(await none.json()).toEqual({ summaries: [] })
    for (const query of ['', '?after=yesterday', '?after=']) {
      const bad = await SUMMARIES(authed(`/api/companion/summaries${query}`, tokens.a1), {})
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'invalid_after' })
    }
  })

  test('one summary is Markdown text; another member summary and a bad id are 404', async () => {
    const ok = await SUMMARY(authed(`/api/companion/summaries/${fx.occA}`, tokens.a1), { occurrenceId: fx.occA })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await ok.text()).toBe('# Summary\n\nHello')
    for (const occurrenceId of [fx.occB, 'nope', ID]) {
      const res = await SUMMARY(authed(`/api/companion/summaries/${occurrenceId}`, tokens.a1), { occurrenceId })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })
})
