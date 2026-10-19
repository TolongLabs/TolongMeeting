import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { aiKeys, artefacts, identities, occurrences, profiles, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { homeData } from '../lib/home'
import { createScope } from '../lib/scope'

const NOW = new Date('2026-10-20T00:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Dropping every test database is slow on the shared Postgres under load; the default hook timeout is 5 seconds.
const DROP_TIMEOUT_MS = 120_000

const SUMMARY = ['# Lecture 4', 'Covered sorting.', 'Do next: Submit lab 3 (due Fri 23 Oct, 23:59)', 'Read chapter 5.']

// One data root for the file: TM_DATA_ROOT is process-wide, and occurrence ids keep the members' files apart.
let savedRoot: string | undefined
let dataRoot: string

beforeAll(async () => {
  savedRoot = process.env.TM_DATA_ROOT
  dataRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-home-'))
  process.env.TM_DATA_ROOT = dataRoot
})

afterAll(async () => {
  if (savedRoot === undefined) delete process.env.TM_DATA_ROOT
  else process.env.TM_DATA_ROOT = savedRoot
  await dropAllTestDbs()
}, DROP_TIMEOUT_MS)

/** One member with an identity 'University', a signed-out Zoom account and four meetings, one with a summary file. */
async function homeFixture(db: Db) {
  const { memberId, identityId } = await seedMember(db, { full: false })
  await db.update(identities).set({ name: 'University' }).where(eq(identities.id, identityId))
  await db
    .update(profiles)
    .set({ accountStatus: { zoom: { verifiedAt: NOW.toISOString(), signedIn: false } } })
    .where(eq(profiles.identityId, identityId))

  const add = async (values: Partial<typeof occurrences.$inferInsert>) => {
    const start = values.scheduledStart ?? NOW
    const [row] = await db
      .insert(occurrences)
      .values({
        memberId,
        identityId,
        entryName: 'Lecture',
        entryType: 'lecture',
        transcription: 'live',
        scheduledEnd: new Date(start.getTime() + 2 * HOUR),
        deleteAfter: new Date(start.getTime() + 30 * DAY),
        scheduledStart: start,
        state: 'scheduled',
        ...values
      })
      .returning()
    return row!.id
  }

  const upcoming = await add({ entryName: 'Lecture A', scheduledStart: new Date('2026-10-21T06:00:00Z') })
  const running = await add({ state: 'in_meeting', scheduledStart: new Date('2026-10-20T00:30:00Z') })
  const done = await add({
    state: 'completed',
    entryName: 'Lecture B',
    scheduledStart: new Date('2026-10-19T06:00:00Z')
  })
  const expiring = await add({
    state: 'completed',
    entryName: 'Lecture C',
    scheduledStart: new Date('2026-10-18T06:00:00Z'),
    deleteAfter: new Date('2026-10-22T00:00:00Z')
  })

  await db
    .insert(artefacts)
    .values({ occurrenceId: done, memberId, kind: 'summary', path: 'out/summary.md', bytes: 80 })
  await mkdir(join(dataRoot, 'occurrences', done, 'out'), { recursive: true })
  await writeFile(join(dataRoot, 'occurrences', done, 'out', 'summary.md'), SUMMARY.join('\n'))

  return { scope: createScope(db, memberId), memberId, ids: { upcoming, running, done, expiring } }
}

test('home groups upcoming, running, recent and expiring meetings', async () => {
  const db = await createTestDb()
  const { scope, ids } = await homeFixture(db)
  const h = await homeData(scope, NOW)
  expect(h.upcoming.map((o) => o.when)).toEqual(['Wed 21 Oct, 14:00'])
  expect(h.inProgress.map((o) => o.state)).toEqual(['in_meeting'])
  expect(h.recent.map((o) => o.id)).toEqual([ids.done])
  expect(h.recent[0]!.doNext).toBe('Do next: Submit lab 3 (due Fri 23 Oct, 23:59)')
  expect(h.deletingSoon.map((o) => o.id)).toEqual([ids.expiring])
  expect(h.warnings).toEqual(
    expect.arrayContaining([
      { kind: 'ntfy_not_set_up' },
      { kind: 'account_signed_out', identity: 'University', account: 'zoom' }
    ])
  )
  expect(h.warnings).toHaveLength(2)
})

test('home shows only the signed-in member its own meetings', async () => {
  const db = await createTestDb()
  const { scope } = await homeFixture(db)
  await homeFixture(db)
  const h = await homeData(scope, NOW)
  expect(h.upcoming).toHaveLength(1)
  expect(h.recent).toHaveLength(1)
})

test('home warns about a missing, untested or failing AI key', async () => {
  const db = await createTestDb()
  const { scope, memberId } = await homeFixture(db)
  await db.delete(aiKeys).where(eq(aiKeys.memberId, memberId))
  expect((await homeData(scope, NOW)).warnings).toContainEqual({ kind: 'no_ai_key' })

  // A key saved but never tested is "not tested yet", never "failing".
  await db.insert(aiKeys).values({ memberId, dashscopeKeyEnc: 'sealed', testOk: false })
  const untested = (await homeData(scope, NOW)).warnings
  expect(untested).toContainEqual({ kind: 'ai_key_untested' })
  expect(untested).not.toContainEqual({ kind: 'ai_key_failing' })

  await db.update(aiKeys).set({ testedAt: NOW, testError: 'x' }).where(eq(aiKeys.memberId, memberId))
  const failing = (await homeData(scope, NOW)).warnings
  expect(failing).toContainEqual({ kind: 'ai_key_failing' })
  expect(failing).not.toContainEqual({ kind: 'ai_key_untested' })
})

test('home shows "summary not available" for a summary that is a symlink to another member\'s file', async () => {
  const db = await createTestDb()
  const { scope, ids } = await homeFixture(db)
  const other = await homeFixture(db)
  const otherSummary = join(dataRoot, 'occurrences', other.ids.done, 'out', 'summary.md')
  await writeFile(otherSummary, 'Do next: OTHER MEMBER SECRET')
  await symlink(otherSummary, join(dataRoot, 'occurrences', ids.done, 'out', 'link.md'))
  await db.update(artefacts).set({ path: 'out/link.md' }).where(eq(artefacts.occurrenceId, ids.done))

  const h = await homeData(scope, NOW)
  expect(h.recent.map((o) => [o.id, o.doNext])).toEqual([[ids.done, 'summary not available']])
})

test('home still renders when a summary file is missing', async () => {
  const db = await createTestDb()
  const { scope, memberId, ids } = await homeFixture(db)
  const [identity] = await db.select({ id: identities.id }).from(identities).where(eq(identities.memberId, memberId))
  const [gone] = await db
    .insert(occurrences)
    .values({
      memberId,
      identityId: identity!.id,
      entryName: 'Lecture D',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: new Date('2026-10-17T06:00:00Z'),
      scheduledEnd: new Date('2026-10-17T08:00:00Z'),
      deleteAfter: new Date('2026-11-16T06:00:00Z'),
      state: 'completed'
    })
    .returning({ id: occurrences.id })
  await db
    .insert(artefacts)
    .values({ occurrenceId: gone!.id, memberId, kind: 'summary', path: 'out/gone.md', bytes: 1 })

  const h = await homeData(scope, NOW)
  expect(h.recent.map((o) => [o.id, o.doNext])).toEqual([
    [ids.done, 'Do next: Submit lab 3 (due Fri 23 Oct, 23:59)'],
    [gone!.id, 'summary not available']
  ])
  expect(h.upcoming.map((o) => o.id)).toEqual([ids.upcoming])
  expect(h.inProgress.map((o) => o.id)).toEqual([ids.running])
})

test('home lists only scheduled meetings within 14 days', async () => {
  const db = await createTestDb()
  const { scope, memberId, ids } = await homeFixture(db)
  const [identity] = await db.select({ id: identities.id }).from(identities).where(eq(identities.memberId, memberId))
  await db.insert(occurrences).values({
    memberId,
    identityId: identity!.id,
    entryName: 'Too far',
    entryType: 'lecture',
    transcription: 'live',
    scheduledStart: new Date(NOW.getTime() + 15 * DAY),
    scheduledEnd: new Date(NOW.getTime() + 15 * DAY + HOUR),
    deleteAfter: new Date(NOW.getTime() + 45 * DAY),
    state: 'scheduled'
  })
  const h = await homeData(scope, NOW)
  expect(h.upcoming.map((o) => o.id)).toEqual([ids.upcoming])
})
