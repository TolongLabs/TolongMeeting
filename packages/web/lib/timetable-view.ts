import { eq } from 'drizzle-orm'
import { identities, occurrences, timetableEntries } from '../db/schema'
import { hasWorkingKey } from './ai-keys'
import { listIdentities } from './identities'
import type { MemberScope } from './scope'

export type EntryRow = typeof timetableEntries.$inferSelect
export type IdentityRow = typeof identities.$inferSelect

/** What the timetable page shows for one entry. */
export interface EntryListItem {
  entry: EntryRow
  identityName: string
  /** The start of the entry's next scheduled session, or `null` (paused, or none in the scheduling window). */
  next: Date | null
}

export interface TimetableView {
  timeZone: string
  entries: EntryListItem[]
  identities: IdentityRow[]
  hasKey: boolean
}

/** The member's entries by name, each with its identity and next session, plus what the page needs to guide an empty start. */
export async function timetableView(scope: MemberScope, now: Date): Promise<TimetableView> {
  const [me, rows, ids, sessions, hasKey] = await Promise.all([
    scope.me(),
    scope.select(timetableEntries),
    listIdentities(scope),
    scope.select(occurrences, eq(occurrences.state, 'scheduled')),
    hasWorkingKey(scope)
  ])
  const nextByEntry = new Map<string, Date>()
  for (const s of sessions) {
    if (s.entryId === null || s.scheduledStart <= now) continue
    const seen = nextByEntry.get(s.entryId)
    if (!seen || s.scheduledStart < seen) nextByEntry.set(s.entryId, s.scheduledStart)
  }
  const identityName = new Map(ids.map((i) => [i.id, i.name]))
  const entries = rows
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((entry) => ({
      entry,
      identityName: identityName.get(entry.identityId) ?? 'Unknown identity',
      next: entry.paused ? null : (nextByEntry.get(entry.id) ?? null)
    }))
  return { timeZone: me.timeZone, entries, identities: ids, hasKey }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One of the member's entries, or `null` when the id is not a uuid or names no entry of theirs. */
export async function entryById(scope: MemberScope, id: string): Promise<EntryRow | null> {
  if (!UUID.test(id)) return null
  const [row] = await scope.select(timetableEntries, eq(timetableEntries.id, id))
  return row ?? null
}

/** Today's date in `timeZone` as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
