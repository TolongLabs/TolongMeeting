import { afterAll, beforeEach, expect, test } from 'bun:test'
import { JOB_LEASE_MS } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionJobs, deviceTokens, events, occurrences, type Db } from '@tm/web/db'
import {
  NATIVE_JOB_CANCEL_REASON,
  claimJob,
  completeJob,
  createCompanionJob,
  failJobAttempt,
  getClaimedJob,
  listJobsForDevice
} from '@tm/web/db/companion'
import { seedCompanionFixture } from '@tm/web/db/companion.fixtures'
import { FakeNotifier } from '@tm/web/db/notifier'
import { QUEUES } from '@tm/web/db/queues'
import { applyTrigger } from '@tm/web/db/transitions'
import { createTestDb, dropAllTestDbs, FakeQueue } from '@tm/web/db/testing'
import { checkNativeJob, handleNativeJobCheck, handleNativeJobDead } from '../src/native-check'

afterAll(dropAllTestDbs, 60_000)

const t0 = new Date('2026-10-21T08:00:00Z')
const plus = (ms: number) => new Date(t0.getTime() + ms)

let db: Db
let queue: FakeQueue
let notifier: FakeNotifier
let f: Awaited<ReturnType<typeof seedCompanionFixture>>
let jobId: string
const deps = () => ({ db, queue, notifier, env: { publicUrl: 'https://tm.example' } })
const state = async () => (await db.select().from(occurrences).where(eq(occurrences.id, f.occA)))[0]!.state

beforeEach(async () => {
  db = await createTestDb()
  queue = new FakeQueue()
  notifier = new FakeNotifier()
  f = await seedCompanionFixture(db)
  await db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, f.occA))
  jobId = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: {
      occurrenceId: f.occA,
      entryName: 'Data Mining',
      start: '2026-10-21T14:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      durationSec: 5400,
      flacBytes: 1000
    }
  })
}, 60_000)

const nextCheck = () => queue.sent.filter((s) => s.name === QUEUES.nativeJobCheck)

test('an unclaimed job moves the occurrence to waiting_for_pc, pings once and checks again later', async () => {
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('waiting_for_pc')
  expect(await state()).toBe('waiting_for_pc')
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]).toMatchObject({
    memberId: f.a1.memberId,
    ping: {
      title: 'Waiting for your PC: Data Mining',
      actions: [{ label: 'Open meeting page', url: `https://tm.example/meetings/${f.occA}` }]
    }
  })
  expect(nextCheck().map((s) => [s.data, s.opts?.startAfter])).toEqual([[{ jobId }, plus(120_000 + JOB_LEASE_MS)]])
  // The next check finds the same thing: no second move and no second ping.
  expect(await checkNativeJob(deps(), jobId, plus(120_000 + JOB_LEASE_MS))).toBe('waiting_for_pc')
  expect(notifier.sent).toHaveLength(1)
  expect(nextCheck()).toHaveLength(2)
})

test('a ping that did not go out is tried again by the next check', async () => {
  notifier.notify = async () => false
  await checkNativeJob(deps(), jobId, plus(120_000))
  expect((await db.select().from(companionJobs))[0]!.pcPingSentAt).toBeNull()
  const sent = new FakeNotifier()
  await checkNativeJob({ ...deps(), notifier: sent }, jobId, plus(420_000))
  expect(sent.sent).toHaveLength(1)
  expect((await db.select().from(companionJobs))[0]!.pcPingSentAt).not.toBeNull()
})

test('a claimed job with a live lease leaves the occurrence alone and is checked again', async () => {
  await claimJob(db, f.a1, jobId, plus(100_000))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('claimed')
  expect(await state()).toBe('transcribing')
  expect(notifier.sent).toEqual([])
  expect(nextCheck()).toHaveLength(1)
})

test('a lapsed lease returns the job to waiting_for_pc without a second ping', async () => {
  await checkNativeJob(deps(), jobId, plus(120_000))
  await claimJob(db, f.a1, jobId, plus(200_000))
  await applyTrigger(db, f.occA, 'pc_claimed') // what the claim route does
  expect(await state()).toBe('transcribing')
  expect(await checkNativeJob(deps(), jobId, plus(200_000 + JOB_LEASE_MS + 1))).toBe('waiting_for_pc')
  expect(await state()).toBe('waiting_for_pc')
  expect(notifier.sent).toHaveLength(1)
  const moves = await db.select().from(events).where(eq(events.occurrenceId, f.occA))
  expect(moves.map((e) => (e.data as { trigger: string }).trigger)).toEqual([
    'wait_for_pc',
    'pc_claimed',
    'wait_for_pc'
  ])
})

test('a PC that claimed between the check read and its move takes the occurrence back to transcribing', async () => {
  await db.update(occurrences).set({ state: 'waiting_for_pc' }).where(eq(occurrences.id, f.occA))
  await claimJob(db, f.a1, jobId, plus(100_000))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('claimed')
  expect(await state()).toBe('transcribing')
})

test('a done job stops the checks', async () => {
  await claimJob(db, f.a1, jobId, plus(100_000))
  await completeJob(db, f.a1, jobId, plus(110_000))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('done')
  expect(nextCheck()).toEqual([])
  expect(await state()).toBe('transcribing')
})

test('a failed job stops the checks', async () => {
  await claimJob(db, f.a1, jobId, plus(100_000))
  await failJobAttempt(db, f.a1, jobId, 'boom', plus(101_000))
  await claimJob(db, f.a1, jobId, plus(102_000))
  await failJobAttempt(db, f.a1, jobId, 'boom', plus(103_000))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('failed')
  expect(nextCheck()).toEqual([])
})

test('a job whose occurrence has left the wait, or whose row is gone, is stale and ends the chain', async () => {
  await db.update(occurrences).set({ state: 'post_processing' }).where(eq(occurrences.id, f.occA))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('stale')
  expect(await checkNativeJob(deps(), '00000000-0000-4000-8000-000000000000', plus(120_000))).toBe('stale')
  expect(nextCheck()).toEqual([])
  expect(notifier.sent).toEqual([])
})

const jobOf = async () => (await db.select().from(companionJobs).where(eq(companionJobs.id, jobId)))[0]!

test('a stale check cancels the pending job of a meeting that has left the wait', async () => {
  await db.update(occurrences).set({ state: 'failed' }).where(eq(occurrences.id, f.occA))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('stale')
  expect(await jobOf()).toMatchObject({ state: 'cancelled', deviceId: null, leaseUntil: null })
  expect((await jobOf()).error).toBe(NATIVE_JOB_CANCEL_REASON)
  expect(await listJobsForDevice(db, f.a1)).toEqual([])
})

test('a stale check cancels a job a PC still holds after the meeting failed', async () => {
  await claimJob(db, f.a1, jobId, plus(100_000))
  await db.update(occurrences).set({ state: 'failed' }).where(eq(occurrences.id, f.occA))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('stale')
  expect(await jobOf()).toMatchObject({ state: 'cancelled', deviceId: null, leaseUntil: null })
  expect(await getClaimedJob(db, f.a1, jobId, plus(120_000))).toBeNull()
})

test('a stale check leaves a finished job as it is', async () => {
  await claimJob(db, f.a1, jobId, plus(100_000))
  await completeJob(db, f.a1, jobId, plus(110_000))
  await db.update(occurrences).set({ state: 'failed' }).where(eq(occurrences.id, f.occA))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('done')
  expect((await jobOf()).state).toBe('done')
})

const seenAt = (deviceId: string, at: Date) =>
  db.update(deviceTokens).set({ lastUsedAt: at }).where(eq(deviceTokens.id, deviceId))
/** One failed attempt: the job is pending again with `attempts = 1`. */
async function failedOnce() {
  await claimJob(db, f.a1, jobId, plus(100_000))
  await failJobAttempt(db, f.a1, jobId, 'boom', plus(101_000))
  expect(await jobOf()).toMatchObject({ state: 'pending', attempts: 1 })
}

test('a retried job whose PC is online keeps the occurrence and sends no ping', async () => {
  await failedOnce()
  await seenAt(f.a2.deviceId, plus(120_000 - 89_000))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('pending')
  expect(await state()).toBe('transcribing')
  expect(notifier.sent).toEqual([])
  expect(nextCheck()).toHaveLength(1)
})

test('a retried job moves to waiting_for_pc and pings once no PC was seen for 90 s', async () => {
  await failedOnce()
  await seenAt(f.a2.deviceId, plus(120_000 - 91_000))
  await seenAt(f.b1.deviceId, plus(120_000)) // another member's PC does not count
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('waiting_for_pc')
  expect(await state()).toBe('waiting_for_pc')
  expect(notifier.sent).toHaveLength(1)
})

test('a revoked PC does not count as online', async () => {
  await failedOnce()
  await seenAt(f.a1.deviceId, plus(120_000))
  await db
    .update(deviceTokens)
    .set({ revokedAt: plus(119_000) })
    .where(eq(deviceTokens.id, f.a1.deviceId))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('waiting_for_pc')
})

test('a job nobody has tried waits for a PC even when one is online', async () => {
  await seenAt(f.a1.deviceId, plus(119_000))
  expect(await checkNativeJob(deps(), jobId, plus(120_000))).toBe('waiting_for_pc')
  expect(await state()).toBe('waiting_for_pc')
  expect(notifier.sent).toHaveLength(1)
})

test('the handlers read the job id from the queue body and refuse anything else', async () => {
  expect(await handleNativeJobCheck(deps(), { jobId }, plus(120_000))).toBe('waiting_for_pc')
  expect(await handleNativeJobDead(deps(), { jobId }, plus(900_000))).toBe('waiting_for_pc')
  await expect(handleNativeJobCheck(deps(), { jobId, extra: 1 }, t0)).rejects.toThrow()
  await expect(handleNativeJobDead(deps(), {}, t0)).rejects.toThrow()
})
