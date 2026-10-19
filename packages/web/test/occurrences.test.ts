import { afterAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { aiKeys, identities, members, occurrences, timetableEntries } from '../db'
import { identityClashes, syncOccurrences } from '../db/occurrences'
import { dropAllTestDbs, FakeQueue, seedMember, withEntry, type EntryShape } from '../db/testing'
import { createScope } from '../lib/scope'

afterAll(dropAllTestDbs)

const now = new Date('2026-10-20T00:00:00Z')
const WEDNESDAY_14: EntryShape = {
  repeat: { kind: 'weekly', days: [3], from: '2026-10-01' },
  startTime: '14:00',
  endTime: '16:00'
}

async function rows(db: Awaited<ReturnType<typeof withEntry>>['db'], memberId: string) {
  return db.select().from(occurrences).where(eq(occurrences.memberId, memberId)).orderBy(occurrences.scheduledStart)
}

describe('syncOccurrences', () => {
  test('sync creates occurrences once and queues launches at T-60', async () => {
    const { db, memberId, q } = await withEntry(WEDNESDAY_14)
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 2, removed: 0 })
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
    expect(q.sent).toHaveLength(2)
    expect(q.sent[0]).toEqual({
      name: 'launch',
      data: { occurrenceId: expect.any(String), scheduledStart: '2026-10-21T06:00:00.000Z' },
      opts: {
        startAfter: new Date('2026-10-21T05:00:00.000Z'),
        singletonKey: expect.stringMatching(/^launch:.+:2026-10-21T06:00:00\.000Z$/),
        db: expect.anything()
      }
    })
    const [o] = await rows(db, memberId)
    expect(o!.deleteAfter.toISOString()).toBe('2026-11-20T08:00:00.000Z')
    expect(o!.entryName).toBe('Seed lecture')
    expect(o!.state).toBe('scheduled')
  })

  test('a launch for a meeting less than an hour away starts now', async () => {
    const { db, q } = await withEntry({
      repeat: { kind: 'once', date: '2026-10-20' },
      startTime: '08:30',
      endTime: '09:30'
    })
    // 08:30 in Kuala Lumpur is 00:30Z, so the T-60 mark (23:30Z the day before) has passed.
    const at = new Date('2026-10-20T00:00:00Z')
    await syncOccurrences(db, q, at)
    expect(q.sent[0]!.opts!.startAfter).toEqual(at)
  })

  test('pausing an entry removes its future scheduled occurrences', async () => {
    const { db, entryId, q } = await withEntry(WEDNESDAY_14)
    await syncOccurrences(db, q, now)
    await db.update(timetableEntries).set({ paused: true }).where(eq(timetableEntries.id, entryId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 2 })
    // Unpausing brings the same slots back: the removed rows no longer hold the unique (entry, start) pair.
    await db.update(timetableEntries).set({ paused: false }).where(eq(timetableEntries.id, entryId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 2, removed: 0 })
  })

  test('moving an entry to 15:00 replaces its scheduled occurrences', async () => {
    const { db, entryId, memberId, q } = await withEntry(WEDNESDAY_14)
    await syncOccurrences(db, q, now)
    await db
      .update(timetableEntries)
      .set({ startTime: '15:00', endTime: '17:00' })
      .where(eq(timetableEntries.id, entryId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 2, removed: 2 })
    expect((await rows(db, memberId))[0]!.scheduledStart.toISOString()).toBe('2026-10-21T07:00:00.000Z')
  })

  test('renaming an entry or changing its end refreshes future scheduled occurrences', async () => {
    const { db, entryId, memberId, q } = await withEntry(WEDNESDAY_14)
    await syncOccurrences(db, q, now)
    await db
      .update(timetableEntries)
      .set({ name: 'Renamed', type: 'work', transcription: 'native', endTime: '17:00' })
      .where(eq(timetableEntries.id, entryId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
    const [o] = await rows(db, memberId)
    expect(o).toMatchObject({ entryName: 'Renamed', entryType: 'work', transcription: 'native' })
    expect(o!.scheduledEnd.toISOString()).toBe('2026-10-21T09:00:00.000Z')
    expect(o!.deleteAfter.toISOString()).toBe('2026-11-20T09:00:00.000Z')
  })

  test('occurrences that are running, finished or already started are never touched', async () => {
    const { db, entryId, memberId, q } = await withEntry(WEDNESDAY_14)
    await syncOccurrences(db, q, now)
    const [first, second] = await rows(db, memberId)
    await db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, first!.id))
    await db.update(occurrences).set({ state: 'completed' }).where(eq(occurrences.id, second!.id))
    await db.update(timetableEntries).set({ paused: true, name: 'Renamed' }).where(eq(timetableEntries.id, entryId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
    expect(await rows(db, memberId)).toMatchObject([
      { state: 'in_meeting', entryName: 'Seed lecture' },
      { state: 'completed', entryName: 'Seed lecture' }
    ])
    // A finished slot is not recreated when the entry is unpaused.
    await db.update(timetableEntries).set({ paused: false }).where(eq(timetableEntries.id, entryId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
    expect(await rows(db, memberId)).toHaveLength(2)
  })

  test('a scheduled occurrence that has already started is left for the launcher', async () => {
    const { db, memberId, q } = await withEntry(WEDNESDAY_14)
    await syncOccurrences(db, q, now)
    const later = new Date('2026-10-21T06:30:00Z')
    // The 21 Oct slot is not removed or recreated; the horizon moved on far enough to add 4 Nov.
    expect(await syncOccurrences(db, q, later)).toEqual({ created: 1, removed: 0 })
    expect((await rows(db, memberId)).map((o) => o.scheduledStart.toISOString())).toEqual([
      '2026-10-21T06:00:00.000Z',
      '2026-10-28T06:00:00.000Z',
      '2026-11-04T06:00:00.000Z'
    ])
  })

  test('two syncs at once create each occurrence once', async () => {
    const { db, memberId, q } = await withEntry(WEDNESDAY_14)
    const results = await Promise.all([syncOccurrences(db, q, now), syncOccurrences(db, q, now)])
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(2)
    expect(await rows(db, memberId)).toHaveLength(2)
    expect(q.sent).toHaveLength(2)
  })

  test('a member without a working AI key gets no occurrences', async () => {
    const { db, memberId, q } = await withEntry(WEDNESDAY_14)
    await db.update(aiKeys).set({ testOk: false }).where(eq(aiKeys.memberId, memberId))
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
    expect(await rows(db, memberId)).toEqual([])
  })

  test('occurrences are expanded in the time zone of the member', async () => {
    const { db, memberId, q } = await withEntry({
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '14:00',
      endTime: '16:00'
    })
    await db.update(members).set({ timeZone: 'Europe/London' }).where(eq(members.id, memberId))
    await syncOccurrences(db, q, now)
    expect((await rows(db, memberId))[0]!.scheduledStart.toISOString()).toBe('2026-10-21T13:00:00.000Z')
  })

  test('syncing one member leaves the others alone', async () => {
    const { db, memberId, identityId, q } = await withEntry(WEDNESDAY_14)
    const other = await seedMember(db, { full: false })
    await db.insert(timetableEntries).values({
      memberId: other.memberId,
      identityId: other.identityId,
      name: 'Other',
      type: 'lecture',
      repeat: { kind: 'once', date: '2026-10-22' },
      startTime: '10:00',
      endTime: '11:00',
      link: { kind: 'paste' },
      transcription: 'live'
    })
    expect(await syncOccurrences(db, q, now, memberId)).toEqual({ created: 2, removed: 0 })
    expect(await rows(db, other.memberId)).toEqual([])
    expect(await syncOccurrences(db, q, now)).toEqual({ created: 1, removed: 0 })
    expect(identityId).not.toBe(other.identityId)
  })
})

describe('identityClashes', () => {
  async function twoEntries() {
    const ctx = await withEntry(WEDNESDAY_14)
    // A second entry on the same identity, overlapping from 15:00 to 17:00, created later.
    const [second] = await ctx.db
      .insert(timetableEntries)
      .values({
        memberId: ctx.memberId,
        identityId: ctx.identityId,
        name: 'Overlap',
        type: 'work',
        repeat: { kind: 'once', date: '2026-10-21' },
        startTime: '15:00',
        endTime: '17:00',
        link: { kind: 'paste' },
        transcription: 'live'
      })
      .returning()
    await syncOccurrences(ctx.db, ctx.q, now)
    return { ...ctx, secondId: second!.id }
  }

  test('the same identity in two overlapping occurrences clashes, and the earlier start wins', async () => {
    const { db, identityId } = await twoEntries()
    const clashes = await identityClashes(db, identityId, now, new Date('2026-11-05T00:00:00Z'))
    expect(clashes).toHaveLength(1)
    expect(clashes[0]!.winner.entryName).toBe('Seed lecture')
    expect(clashes[0]!.loser.entryName).toBe('Overlap')
  })

  test('only the window asked for is searched', async () => {
    const { db, identityId } = await twoEntries()
    expect(
      await identityClashes(db, identityId, new Date('2026-10-22T00:00:00Z'), new Date('2026-11-05T00:00:00Z'))
    ).toEqual([])
  })

  test('skipped, failed and deleted occurrences do not clash', async () => {
    const { db, identityId, memberId } = await twoEntries()
    for (const state of ['skipped_identity_clash', 'skipped_capacity', 'failed', 'deleted'] as const) {
      await db
        .update(occurrences)
        .set({ state })
        .where(and(eq(occurrences.memberId, memberId), eq(occurrences.entryName, 'Overlap')))
      expect(await identityClashes(db, identityId, now, new Date('2026-11-05T00:00:00Z'))).toEqual([])
    }
  })

  test('another identity of the same member does not clash', async () => {
    const { db, identityId, memberId, secondId } = await twoEntries()
    const [second] = await db
      .insert(identities)
      .values({ memberId, name: 'Second', zoomGuestName: 'Second' })
      .returning()
    await db.update(timetableEntries).set({ identityId: second!.id }).where(eq(timetableEntries.id, secondId))
    await syncOccurrences(db, new FakeQueue(), now)
    expect(await identityClashes(db, identityId, now, new Date('2026-11-05T00:00:00Z'))).toEqual([])
  })

  test('a member scope searches only its own occurrences', async () => {
    const { db, identityId, memberId, q } = await twoEntries()
    const other = createScope(db, (await seedMember(db, { full: false })).memberId)
    expect(await other.identityClashes(identityId, now, new Date('2026-11-05T00:00:00Z'))).toEqual([])
    const mine = createScope(db, memberId)
    expect(await mine.identityClashes(identityId, now, new Date('2026-11-05T00:00:00Z'))).toHaveLength(1)
    expect(await mine.syncOccurrences(q, now)).toEqual({ created: 0, removed: 0 })
  })
})
