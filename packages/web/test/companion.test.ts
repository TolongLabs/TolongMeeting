import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { JOB_LEASE_MS, type CompanionJob, type LocalRunPayload } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionJobs, deviceTokens, occurrences, type Db } from '../db'
import {
  claimJob,
  cancelNativeJobs,
  completeJob,
  createCompanionJob,
  emitCompanionEvent,
  failJobAttempt,
  getClaimedJob,
  getJob,
  listCompanionEvents,
  listJobsForDevice,
  markPcPingSent,
  releaseExpiredLeases,
  renewLease
} from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { DbError } from '../db/errors'
import { createTestDb, dropAllTestDbs } from '../db/testing'

afterAll(dropAllTestDbs, 60_000)

const native = (occurrenceId: string) => ({
  occurrenceId,
  entryName: 'Data Mining',
  start: '2026-10-21T14:00:00+08:00',
  timeZone: 'Asia/Kuala_Lumpur',
  durationSec: 5400,
  flacBytes: 1000
})
const localRun = (occurrenceId: string): LocalRunPayload => ({
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
const t0 = new Date('2026-10-21T08:00:00Z')
const plus = (ms: number) => new Date(t0.getTime() + ms)

let db: Db
let f: Awaited<ReturnType<typeof seedCompanionFixture>>

beforeEach(async () => {
  db = await createTestDb()
  f = await seedCompanionFixture(db)
  // The fixture devices were paired a day before `t0`, so the events the tests emit at `t0` are theirs to see.
  await db.update(deviceTokens).set({ createdAt: plus(-86_400_000) })
  // A native job is live only while its meeting waits for the transcript.
  await db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, f.occA))
}, 60_000)

const nativeJob = (targetDeviceId?: string) =>
  createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: native(f.occA),
    targetDeviceId
  })
const localJob = (targetDeviceId: string) =>
  createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'local_run',
    payload: localRun(f.occA),
    targetDeviceId
  })
const seen = (deviceId: string, at: Date) =>
  db.update(deviceTokens).set({ lastUsedAt: at }).where(eq(deviceTokens.id, deviceId))

describe('claiming', () => {
  test('the first device to claim wins; the second gets a conflict', async () => {
    const id = await nativeJob()
    expect((await claimJob(db, f.a1, id, t0)) as CompanionJob).toMatchObject({ state: 'claimed' })
    expect(await claimJob(db, f.a2, id, t0)).toBe('conflict')
    expect(await claimJob(db, f.a1, id, t0)).toBe('conflict')
  })

  test('two claims at once: exactly one wins', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await nativeJob()
      const results = await Promise.all([claimJob(db, f.a1, id, t0), claimJob(db, f.a2, id, t0)])
      expect(results.filter((r) => typeof r === 'object' && r !== null)).toHaveLength(1)
      expect(results.filter((r) => r === 'conflict')).toHaveLength(1)
      const held = await getJob(db, id)
      expect(held?.state).toBe('claimed')
      const [row] = await db.select().from(companionJobs).where(eq(companionJobs.id, id))
      expect([f.a1.deviceId, f.a2.deviceId]).toContain(row!.deviceId!)
    }
  })

  test('many devices racing for one job still give one winner', async () => {
    const id = await nativeJob()
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claimJob(db, i % 2 ? f.a1 : f.a2, id, t0)))
    expect(results.filter((r) => typeof r === 'object' && r !== null)).toHaveLength(1)
  })

  test("a device never sees or claims another member's job", async () => {
    const id = await nativeJob()
    expect((await listJobsForDevice(db, f.b1)).map((j) => j.id)).not.toContain(id)
    expect(await claimJob(db, f.b1, id, t0)).toBeNull()
    expect(await getClaimedJob(db, f.b1, id, t0)).toBeNull()
    expect(await renewLease(db, f.b1, id, t0)).toBe(false)
    expect((await getJob(db, id))?.state).toBe('pending')
  })

  test("a job aimed at one device is hidden from the member's other devices", async () => {
    const id = await nativeJob(f.a2.deviceId)
    expect((await listJobsForDevice(db, f.a1)).map((j) => j.id)).not.toContain(id)
    expect((await listJobsForDevice(db, f.a2)).map((j) => j.id)).toContain(id)
    expect(await claimJob(db, f.a1, id, t0)).toBeNull()
    expect(await claimJob(db, f.a2, id, t0)).toMatchObject({ state: 'claimed' })
  })

  test('a revoked device cannot claim', async () => {
    const id = await nativeJob()
    await db.update(deviceTokens).set({ revokedAt: t0 }).where(eq(deviceTokens.id, f.a1.deviceId))
    expect(await claimJob(db, f.a1, id, t0)).toBeNull()
  })

  test('a device lists the jobs it holds as well as the pending ones', async () => {
    const mine = await nativeJob()
    const other = await nativeJob()
    await claimJob(db, f.a1, mine, t0)
    expect((await listJobsForDevice(db, f.a1)).map((j) => j.id).sort()).toEqual([mine, other].sort())
    expect((await listJobsForDevice(db, f.a2)).map((j) => j.id)).toEqual([other])
  })
})

describe('a native job and its meeting', () => {
  const setState = (state: 'transcribing' | 'waiting_for_pc' | 'failed' | 'deleted' | 'post_processing') =>
    db.update(occurrences).set({ state }).where(eq(occurrences.id, f.occA))

  test('a job of a meeting waiting for the PC is listed and claimable', async () => {
    const id = await nativeJob()
    await setState('waiting_for_pc')
    expect((await listJobsForDevice(db, f.a1)).map((j) => j.id)).toEqual([id])
    expect(await claimJob(db, f.a1, id, t0)).toMatchObject({ state: 'claimed' })
  })

  test('the job of a deleted meeting leaves the list and cannot be claimed', async () => {
    const id = await nativeJob()
    await setState('deleted')
    expect(await listJobsForDevice(db, f.a1)).toEqual([])
    expect(await claimJob(db, f.a1, id, t0)).toBeNull()
    expect((await getJob(db, id))?.state).toBe('pending')
  })

  test('a job whose meeting failed or moved on is neither listed nor claimable, and a held one drops off the list', async () => {
    const held = await nativeJob()
    const open = await nativeJob()
    await claimJob(db, f.a1, held, t0)
    for (const state of ['failed', 'post_processing'] as const) {
      await setState(state)
      expect(await listJobsForDevice(db, f.a1)).toEqual([])
      expect(await listJobsForDevice(db, f.a2)).toEqual([])
      expect(await claimJob(db, f.a2, open, t0)).toBeNull()
    }
  })

  test('a local_run is not tied to the state of its occurrence', async () => {
    const id = await localJob(f.a1.deviceId)
    await seen(f.a1.deviceId, t0)
    await setState('failed')
    expect((await listJobsForDevice(db, f.a1)).map((j) => j.id)).toEqual([id])
    expect(await claimJob(db, f.a1, id, t0)).toMatchObject({ state: 'claimed' })
  })

  test('cancelNativeJobs cancels the open native jobs of an occurrence and nothing else', async () => {
    const pending = await nativeJob()
    const held = await nativeJob()
    const done = await nativeJob()
    const local = await localJob(f.a1.deviceId)
    await claimJob(db, f.a1, held, t0)
    await claimJob(db, f.a2, done, t0)
    await completeJob(db, f.a2, done, plus(1000))
    expect((await cancelNativeJobs(db, { occurrenceId: f.occA }, plus(2000))).sort()).toEqual([pending, held].sort())
    expect(await getJob(db, held)).toMatchObject({ state: 'cancelled' })
    expect(await getClaimedJob(db, f.a1, held, plus(2000))).toBeNull()
    expect((await getJob(db, done))?.state).toBe('done')
    expect((await getJob(db, local))?.state).toBe('pending')
    expect(await cancelNativeJobs(db, { occurrenceId: f.occA })).toEqual([])
  })
})

describe('local_run', () => {
  test('only its target device claims it, and only while that device is online', async () => {
    const id = await localJob(f.a1.deviceId)
    expect(await claimJob(db, f.a2, id, t0)).toBeNull()
    expect(await claimJob(db, f.a1, id, t0)).toBe('conflict') // never seen: offline
    await seen(f.a1.deviceId, plus(-100_000))
    expect(await claimJob(db, f.a1, id, t0)).toBe('conflict') // last seen 100 s ago: past the 90 s window
    await seen(f.a1.deviceId, plus(-30_000))
    expect(await claimJob(db, f.a1, id, t0)).toMatchObject({ kind: 'local_run', state: 'claimed' })
  })

  test('an expired lease is not released (R13) and the PC can still renew and fetch it', async () => {
    const id = await localJob(f.a1.deviceId)
    await seen(f.a1.deviceId, t0)
    await claimJob(db, f.a1, id, t0)
    expect(await releaseExpiredLeases(db, plus(JOB_LEASE_MS * 10))).not.toContain(id)
    expect((await getJob(db, id))?.state).toBe('claimed')
    expect(await getClaimedJob(db, f.a1, id, plus(JOB_LEASE_MS * 10))).toMatchObject({ id })
    expect(await renewLease(db, f.a1, id, plus(JOB_LEASE_MS * 10))).toBe(true)
  })

  test('a job needs a target device', async () => {
    await expect(
      createCompanionJob(db, {
        memberId: f.a1.memberId,
        occurrenceId: f.occA,
        kind: 'local_run',
        payload: localRun(f.occA)
      })
    ).rejects.toThrow('target device')
  })
})

describe('creating jobs', () => {
  test('an occurrence or a device of another member is refused with a safe database error', async () => {
    const error = await createCompanionJob(db, {
      memberId: f.a1.memberId,
      occurrenceId: f.occB,
      kind: 'native_transcription',
      payload: native(f.occB)
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).code).toBe('23503')
    await expect(nativeJob(f.b1.deviceId)).rejects.toBeInstanceOf(DbError)
  })

  test('the payload must be valid for its kind and name the same occurrence', async () => {
    await expect(
      createCompanionJob(db, {
        memberId: f.a1.memberId,
        occurrenceId: f.occA,
        kind: 'native_transcription',
        payload: { ...native(f.occA), flacBytes: 0 }
      })
    ).rejects.toThrow()
    await expect(
      createCompanionJob(db, {
        memberId: f.a1.memberId,
        occurrenceId: f.occA,
        kind: 'native_transcription',
        payload: native(f.occB)
      })
    ).rejects.toThrow('different occurrence')
  })

  test('a stored job reads back with a parsed payload', async () => {
    const id = await nativeJob()
    expect(await getJob(db, id)).toMatchObject({
      id,
      memberId: f.a1.memberId,
      kind: 'native_transcription',
      state: 'pending',
      attempts: 0,
      payload: native(f.occA)
    })
    expect(await getJob(db, '00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('leases', () => {
  test("releasing for a member leaves another member's lapsed leases alone", async () => {
    const mine = await nativeJob()
    const [theirs] = await db
      .insert(companionJobs)
      .values({
        memberId: f.b1.memberId,
        occurrenceId: f.occB,
        kind: 'native_transcription',
        payload: native(f.occB),
        state: 'claimed',
        deviceId: f.b1.deviceId,
        leaseUntil: t0
      })
      .returning({ id: companionJobs.id })
    await claimJob(db, f.a1, mine, plus(-JOB_LEASE_MS - 1000))
    expect(await releaseExpiredLeases(db, plus(1000), f.a1.memberId)).toEqual([mine])
    expect((await getJob(db, theirs!.id))?.state).toBe('claimed')
    expect(await releaseExpiredLeases(db, plus(1000))).toEqual([theirs!.id])
  })

  test('a lease lapses 5 minutes after the last progress', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    await renewLease(db, f.a1, id, plus(240_000))
    expect(await releaseExpiredLeases(db, plus(539_000))).not.toContain(id)
    expect(await releaseExpiredLeases(db, plus(541_000))).toContain(id)
    const [row] = await db.select().from(companionJobs).where(eq(companionJobs.id, id))
    expect(row).toMatchObject({ state: 'pending', deviceId: null, leaseUntil: null })
  })

  test('a lapsed lease cannot be renewed or used, even before it is released', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    expect(await getClaimedJob(db, f.a1, id, plus(JOB_LEASE_MS - 1))).toMatchObject({ id })
    expect(await getClaimedJob(db, f.a1, id, plus(JOB_LEASE_MS + 1))).toBeNull()
    expect(await renewLease(db, f.a1, id, plus(JOB_LEASE_MS + 1))).toBe(false)
  })

  test('only the holder renews or fetches a claimed job', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    expect(await renewLease(db, f.a2, id, plus(1000))).toBe(false)
    expect(await getClaimedJob(db, f.a2, id, plus(1000))).toBeNull()
    expect(await renewLease(db, f.a1, id, plus(1000))).toBe(true)
  })

  test('a released job can be claimed by another device', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    await releaseExpiredLeases(db, plus(JOB_LEASE_MS + 1000))
    expect(await claimJob(db, f.a2, id, plus(JOB_LEASE_MS + 2000))).toMatchObject({ state: 'claimed' })
  })
})

describe('finishing', () => {
  test('a failed attempt is retried once, then the job fails', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    expect(await failJobAttempt(db, f.a1, id, 'exit 1', plus(1000))).toBe('retry')
    expect((await getJob(db, id))?.state).toBe('pending')
    await claimJob(db, f.a1, id, plus(2000))
    expect(await failJobAttempt(db, f.a1, id, 'exit 1', plus(3000))).toBe('failed')
    expect(await getJob(db, id)).toMatchObject({ state: 'failed', attempts: 2 })
    await expect(failJobAttempt(db, f.a1, id, 'again', plus(4000))).rejects.toThrow('does not hold')
  })

  test('a failed attempt on a held job releases the holder', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    expect(await failJobAttempt(db, f.a1, id, 'exit 1', plus(1000))).toBe('retry')
    expect(await getClaimedJob(db, f.a1, id, plus(1000))).toBeNull()
    expect(await claimJob(db, f.a2, id, plus(1000))).toMatchObject({ state: 'claimed', attempts: 1 })
  })

  test('only the holder with a live lease fails an attempt', async () => {
    const id = await nativeJob()
    await expect(failJobAttempt(db, f.a1, id, 'x', t0)).rejects.toThrow('does not hold') // pending: not held
    await claimJob(db, f.a1, id, t0)
    for (const device of [f.a2, f.b1]) {
      await expect(failJobAttempt(db, device, id, 'x', plus(1000))).rejects.toThrow('does not hold')
    }
    await expect(failJobAttempt(db, f.a1, id, 'x', plus(JOB_LEASE_MS + 1))).rejects.toThrow('does not hold')
    expect(await getJob(db, id)).toMatchObject({ state: 'claimed', attempts: 0 })
  })

  test('completing counts once', async () => {
    const id = await nativeJob()
    expect(await completeJob(db, f.a1, id, t0)).toBe(false) // pending: not held
    await claimJob(db, f.a1, id, t0)
    expect(await completeJob(db, f.a1, id, plus(1000))).toBe(true)
    expect(await completeJob(db, f.a1, id, plus(1000))).toBe(false)
    expect((await getJob(db, id))?.state).toBe('done')
  })

  test('only the holder with a live lease completes a job', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    for (const device of [f.a2, f.b1]) expect(await completeJob(db, device, id, plus(1000))).toBe(false)
    expect(await completeJob(db, f.a1, id, plus(JOB_LEASE_MS + 1))).toBe(false) // lapsed, not yet released
    expect((await getJob(db, id))?.state).toBe('claimed')
  })

  test('a lapsed and reclaimed job cannot be completed or failed by the old holder', async () => {
    const id = await nativeJob()
    await claimJob(db, f.a1, id, t0)
    const later = plus(JOB_LEASE_MS + 1000)
    await releaseExpiredLeases(db, later)
    expect(await claimJob(db, f.a2, id, later)).toMatchObject({ state: 'claimed' })
    expect(await completeJob(db, f.a1, id, plus(JOB_LEASE_MS + 2000))).toBe(false)
    await expect(failJobAttempt(db, f.a1, id, 'late', plus(JOB_LEASE_MS + 2000))).rejects.toThrow('does not hold')
    expect(await getJob(db, id)).toMatchObject({ state: 'claimed', attempts: 0 })
    expect(await completeJob(db, f.a2, id, plus(JOB_LEASE_MS + 3000))).toBe(true)
  })

  test('the PC ping is marked sent only once', async () => {
    const id = await nativeJob()
    expect(await markPcPingSent(db, id, t0)).toBe(true)
    expect(await markPcPingSent(db, id, t0)).toBe(false)
  })
})

describe('events', () => {
  test("events are listed after an id and the member's events older than 24 hours are pruned", async () => {
    const old = await emitCompanionEvent(db, f.a1.memberId, { type: 'job_available', jobId: 'x' }, undefined, t0)
    const fresh = await emitCompanionEvent(
      db,
      f.a1.memberId,
      { type: 'job_available', jobId: 'y' },
      undefined,
      plus(86_401_000)
    )
    expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.id)).toEqual([fresh])
    expect(await listCompanionEvents(db, f.b1, 0)).toEqual([])
    expect(old).toBeLessThan(fresh)
  })

  test('a device sees only events created while it was paired, whatever cursor it sends', async () => {
    const before = await emitCompanionEvent(db, f.a1.memberId, { type: 'open_signin', identityId: 'i1' }, undefined, t0)
    const [late] = await db
      .insert(deviceTokens)
      .values({ memberId: f.a1.memberId, name: 'NEW-PC', tokenHash: 'late-device', createdAt: plus(60_000) })
      .returning({ id: deviceTokens.id })
    const device = { deviceId: late!.id, memberId: f.a1.memberId }
    const during = await emitCompanionEvent(
      db,
      f.a1.memberId,
      { type: 'local_identities_changed' },
      undefined,
      plus(61_000)
    )
    expect((await listCompanionEvents(db, device, 0)).map((e) => e.id)).toEqual([during])
    expect((await listCompanionEvents(db, device, before - 1)).map((e) => e.id)).toEqual([during])
    // The device that was already paired still sees both.
    expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.id)).toEqual([before, during])
  })

  test('a revoked device sees nothing created after its revoke', async () => {
    const during = await emitCompanionEvent(db, f.a1.memberId, { type: 'local_identities_changed' }, undefined, t0)
    await db
      .update(deviceTokens)
      .set({ revokedAt: plus(1000) })
      .where(eq(deviceTokens.id, f.a1.deviceId))
    await emitCompanionEvent(db, f.a1.memberId, { type: 'local_identities_changed' }, undefined, plus(2000))
    expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.id)).toEqual([during])
  })

  test("pruning one member's events leaves another member's alone", async () => {
    const other = await emitCompanionEvent(db, f.b1.memberId, { type: 'local_identities_changed' }, undefined, t0)
    await emitCompanionEvent(db, f.a1.memberId, { type: 'local_identities_changed' }, undefined, plus(86_401_000))
    expect((await listCompanionEvents(db, f.b1, 0)).map((e) => e.id)).toEqual([other])
  })

  test('a device sees events for all devices and for itself, after the given id', async () => {
    const all = await emitCompanionEvent(db, f.a1.memberId, { type: 'local_identities_changed' }, undefined, t0)
    const mine = await emitCompanionEvent(db, f.a1.memberId, { type: 'job_available', jobId: 'j' }, f.a1.deviceId, t0)
    const theirs = await emitCompanionEvent(db, f.a1.memberId, { type: 'job_available', jobId: 'j' }, f.a2.deviceId, t0)
    expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.id)).toEqual([all, mine])
    expect((await listCompanionEvents(db, f.a2, 0)).map((e) => e.id)).toEqual([all, theirs])
    expect((await listCompanionEvents(db, f.a1, all)).map((e) => e.id)).toEqual([mine])
    expect(await listCompanionEvents(db, f.a1, theirs)).toEqual([])
  })

  test("an event for another member's device is refused, and so is an unknown command", async () => {
    await expect(
      emitCompanionEvent(db, f.a1.memberId, { type: 'local_identities_changed' }, f.b1.deviceId, t0)
    ).rejects.toBeInstanceOf(DbError)
    await expect(
      emitCompanionEvent(db, f.a1.memberId, { type: 'run', cmd: 'calc' } as never, undefined, t0)
    ).rejects.toThrow()
  })
})
