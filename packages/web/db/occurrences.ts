import { and, eq, gt, inArray, lt, notInArray, sql } from 'drizzle-orm'
import { expandEntry, findClashes, type OccurrenceState } from '@tm/core'
import type { Db } from './index'
import { aiKeys, members, occurrences, timetableEntries } from './schema'
import { QUEUES, queueDbOf, type Queue } from './queues'

type OccurrenceRow = typeof occurrences.$inferSelect

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const LAUNCH_LEAD = 60 * MINUTE
const RETENTION = 30 * DAY

/** Occurrences that are not worth running: they never clash and are never counted. */
const OUT_OF_PLAY: OccurrenceState[] = [
  'skipped_capacity',
  'skipped_identity_clash',
  'skipped_pc_offline',
  'failed',
  'deleted'
]

interface Wanted {
  entryId: string
  identityId: string
  entryName: string
  entryType: OccurrenceRow['entryType']
  transcription: OccurrenceRow['transcription']
  scheduledStart: Date
  scheduledEnd: Date
  deleteAfter: Date
}

const keyOf = (entryId: string | null, start: Date) => `${entryId}|${start.getTime()}`

/**
 * Brings the future `scheduled` occurrences of every member with a working AI key (or of `memberId` alone) in line
 * with their unpaused timetable entries, looking 14 days ahead. Only `scheduled` occurrences that start after `now` are
 * ever changed or removed; running, finished and already started ones are left alone. It is safe to run twice at once:
 * a lock per member serialises syncs and `unique (entry_id, scheduled_start)` stops a slot being written twice.
 */
export async function syncOccurrences(
  db: Db,
  queue: Queue,
  now: Date,
  memberId?: string
): Promise<{ created: number; removed: number }> {
  const owners = await db
    .select({ id: members.id, timeZone: members.timeZone })
    .from(members)
    .innerJoin(aiKeys, eq(aiKeys.memberId, members.id))
    .where(and(eq(aiKeys.testOk, true), memberId ? eq(members.id, memberId) : undefined))
    .orderBy(members.id)

  const total = { created: 0, removed: 0 }
  for (const owner of owners) {
    const done = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'sync-occurrences:' + owner.id}, 0))`)
      return syncMember(tx, queue, now, owner.id, owner.timeZone)
    })
    total.created += done.created
    total.removed += done.removed
  }
  return total
}

async function syncMember(db: Db, queue: Queue, now: Date, memberId: string, timeZone: string) {
  const entries = await db
    .select()
    .from(timetableEntries)
    .where(and(eq(timetableEntries.memberId, memberId), eq(timetableEntries.paused, false)))

  const wanted = new Map<string, Wanted>()
  for (const entry of entries) {
    for (const slot of expandEntry(entry, timeZone, now)) {
      wanted.set(keyOf(entry.id, slot.start), {
        entryId: entry.id,
        identityId: entry.identityId,
        entryName: entry.name,
        entryType: entry.type,
        transcription: entry.transcription,
        scheduledStart: slot.start,
        scheduledEnd: slot.end,
        deleteAfter: new Date(slot.end.getTime() + RETENTION)
      })
    }
  }

  // Only occurrences that have not started and are still `scheduled` may be changed or removed.
  const future = await db
    .select()
    .from(occurrences)
    .where(
      and(eq(occurrences.memberId, memberId), eq(occurrences.state, 'scheduled'), gt(occurrences.scheduledStart, now))
    )

  const stale: string[] = []
  for (const row of future) {
    const want = wanted.get(keyOf(row.entryId, row.scheduledStart))
    if (!want) {
      stale.push(row.id)
      continue
    }
    const changed =
      row.entryName !== want.entryName ||
      row.entryType !== want.entryType ||
      row.transcription !== want.transcription ||
      row.identityId !== want.identityId ||
      row.scheduledEnd.getTime() !== want.scheduledEnd.getTime() ||
      row.deleteAfter.getTime() !== want.deleteAfter.getTime()
    if (!changed) continue
    await db
      .update(occurrences)
      .set({
        entryName: want.entryName,
        entryType: want.entryType,
        transcription: want.transcription,
        identityId: want.identityId,
        scheduledEnd: want.scheduledEnd,
        deleteAfter: want.deleteAfter
      })
      .where(and(eq(occurrences.id, row.id), eq(occurrences.state, 'scheduled')))
  }

  // The hard delete loses nothing: only `scheduled` rows go, and no machine edge returns to `scheduled`, so such a row
  // never had events, forms or artefacts.
  // Deleted rows must go before inserts: a moved slot may reuse the (entry, start) pair of a removed one.
  const removed =
    stale.length === 0
      ? []
      : await db
          .delete(occurrences)
          .where(
            and(eq(occurrences.memberId, memberId), eq(occurrences.state, 'scheduled'), inArray(occurrences.id, stale))
          )
          .returning({ id: occurrences.id })

  const inserted =
    wanted.size === 0
      ? []
      : await db
          .insert(occurrences)
          .values([...wanted.values()].map((w) => ({ ...w, memberId })))
          .onConflictDoNothing({ target: [occurrences.entryId, occurrences.scheduledStart] })
          .returning({ id: occurrences.id, scheduledStart: occurrences.scheduledStart })

  inserted.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())
  // The job goes through this transaction's connection: it exists only if the occurrence rows commit.
  const txDb = queueDbOf(db)
  for (const row of inserted) {
    const scheduledStart = row.scheduledStart.toISOString()
    await queue.send(
      QUEUES.launch,
      { occurrenceId: row.id, scheduledStart },
      {
        startAfter: new Date(Math.max(row.scheduledStart.getTime() - LAUNCH_LEAD, now.getTime())),
        singletonKey: `launch:${row.id}:${scheduledStart}`,
        db: txDb
      }
    )
  }
  return { created: inserted.length, removed: removed.length }
}

/**
 * The pairs of overlapping occurrences of one identity that touch `[from, to)`, winner first. Skipped, failed and
 * deleted occurrences are ignored. The earlier start wins, then the older entry. Pass `memberId` to search one member's
 * occurrences only.
 */
export async function identityClashes(
  db: Db,
  identityId: string,
  from: Date,
  to: Date,
  memberId?: string
): Promise<{ winner: OccurrenceRow; loser: OccurrenceRow }[]> {
  const rows = await db
    .select({ occurrence: occurrences, entryCreatedAt: timetableEntries.createdAt })
    .from(occurrences)
    .leftJoin(
      timetableEntries,
      and(eq(timetableEntries.id, occurrences.entryId), eq(timetableEntries.memberId, occurrences.memberId))
    )
    .where(
      and(
        eq(occurrences.identityId, identityId),
        memberId ? eq(occurrences.memberId, memberId) : undefined,
        notInArray(occurrences.state, OUT_OF_PLAY),
        lt(occurrences.scheduledStart, to),
        gt(occurrences.scheduledEnd, from)
      )
    )
  const byId = new Map(rows.map((r) => [r.occurrence.id, r.occurrence]))
  const slots = rows.map((r) => ({
    id: r.occurrence.id,
    start: r.occurrence.scheduledStart,
    end: r.occurrence.scheduledEnd,
    // An occurrence whose entry was deleted ranks by its own creation.
    rank: (r.entryCreatedAt ?? r.occurrence.createdAt).getTime()
  }))
  return findClashes(slots).map((c) => ({ winner: byId.get(c.winner)!, loser: byId.get(c.loser)! }))
}
