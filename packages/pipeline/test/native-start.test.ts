import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { PC_CLAIM_GRACE_MS } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionJobs, type Db } from '@tm/web/db'
import { claimJob, getJob, listCompanionEvents } from '@tm/web/db/companion'
import { seedCompanionFixture } from '@tm/web/db/companion.fixtures'
import { QUEUES } from '@tm/web/db/queues'
import { createTestDb, dropAllTestDbs, FakeQueue } from '@tm/web/db/testing'
import { startNativeTranscription, type NativeStartInput } from '../src/native/start'
import { toneMkv } from './native-fixtures'

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/native-start-`)
})
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

const NOW = new Date('2026-10-21T08:00:00Z')

let db: Db
let queue: FakeQueue
let f: Awaited<ReturnType<typeof seedCompanionFixture>>
let input: NativeStartInput

beforeEach(async () => {
  db = await createTestDb()
  queue = new FakeQueue()
  f = await seedCompanionFixture(db)
  const dataDir = await mkdtemp(`${tmp}/occ-`)
  await mkdir(`${dataDir}/recording`)
  toneMkv(`${dataDir}/recording/meeting.mkv`, 3)
  input = {
    occurrenceId: f.occA,
    memberId: f.a1.memberId,
    dataDir,
    entry: { name: 'Data Mining', start: '2026-10-21T14:00:00+08:00', timeZone: 'Asia/Kuala_Lumpur' }
  }
}, 60_000)

test('creates one job, announces it to the member and schedules the check at the end of the grace', async () => {
  const id = await startNativeTranscription({ db, queue }, input, undefined, NOW)
  const job = await getJob(db, id!)
  expect(job).toMatchObject({ kind: 'native_transcription', state: 'pending', occurrenceId: f.occA })
  const payload = job?.payload as { entryName: string; durationSec: number; flacBytes: number }
  expect(payload.entryName).toBe('Data Mining')
  // The length is rounded up to whole seconds (AAC adds a little padding to the 3 s tone).
  expect(payload.durationSec).toBeGreaterThanOrEqual(3)
  expect(payload.durationSec).toBeLessThanOrEqual(4)
  expect(payload.flacBytes).toBeGreaterThan(1000)
  expect(await listCompanionEvents(db, f.a2, 0)).toEqual([
    { id: expect.any(Number), command: { type: 'job_available', jobId: id! } }
  ])
  expect(queue.sent).toHaveLength(1)
  expect(queue.sent[0]).toMatchObject({ name: QUEUES.nativeJobCheck, data: { jobId: id } })
  expect(queue.sent[0]!.opts?.startAfter).toEqual(new Date(NOW.getTime() + PC_CLAIM_GRACE_MS))
})

test('does nothing when the native transcript is already uploaded', async () => {
  await mkdir(`${input.dataDir}/transcript/native`, { recursive: true })
  await writeFile(`${input.dataDir}/transcript/native/audio.json`, '{"segments":[]}')
  expect(await startNativeTranscription({ db, queue }, input)).toBeNull()
  expect(await db.select().from(companionJobs)).toEqual([])
  expect(queue.sent).toEqual([])
  expect(await readdir(input.dataDir)).not.toContain('audio.flac')
})

test('a second start returns the job it made and cuts, announces and schedules nothing more', async () => {
  const id = await startNativeTranscription({ db, queue }, input, undefined, NOW)
  expect(await startNativeTranscription({ db, queue }, input, undefined, NOW)).toBe(id)
  await claimJob(db, f.a1, id!, NOW)
  expect(await startNativeTranscription({ db, queue }, input, undefined, NOW)).toBe(id)
  expect(await db.select().from(companionJobs)).toHaveLength(1)
  expect(await listCompanionEvents(db, f.a1, 0)).toHaveLength(1)
  expect(queue.sent).toHaveLength(1)
})

test('a recording that cannot be cut creates no job, no event and no check', async () => {
  await rm(`${input.dataDir}/recording/meeting.mkv`)
  await expect(startNativeTranscription({ db, queue }, input)).rejects.toThrow('There is no recording')
  expect(await db.select().from(companionJobs)).toEqual([])
  expect(await listCompanionEvents(db, f.a1, 0)).toEqual([])
  expect(queue.sent).toEqual([])
})

test('a transcript directory that is a link counts as uploaded, so the read refuses it loudly', async () => {
  await mkdir(`${tmp}/elsewhere`, { recursive: true })
  await writeFile(`${tmp}/elsewhere/audio.json`, '{"segments":[]}')
  await mkdir(`${input.dataDir}/transcript`)
  await symlink(`${tmp}/elsewhere`, `${input.dataDir}/transcript/native`)
  expect(await startNativeTranscription({ db, queue }, input)).toBeNull()
})

test('the job row belongs to the occurrence', async () => {
  const id = await startNativeTranscription({ db, queue }, input, undefined, NOW)
  const [row] = await db.select().from(companionJobs).where(eq(companionJobs.id, id!))
  expect(row).toMatchObject({ memberId: f.a1.memberId, occurrenceId: f.occA })
})
