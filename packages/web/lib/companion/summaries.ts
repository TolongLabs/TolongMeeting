import type { SummaryListItem } from '@tm/core'
import { and, asc, eq, gt, gte, lt, type SQL } from 'drizzle-orm'
import { posix } from 'node:path'
import { artefacts, occurrences } from '../../db/schema'
import { openMemberFile } from '../files'
import { MAX_ARTEFACT_BYTES } from '../meeting'
import { createScope } from '../scope'

/** The database (or a transaction) the device-side reads run on. The caller opens it; this module does not. */
type Db = Parameters<typeof createScope>[0]

/** A page of the list holds at most this many summaries. */
export const SUMMARY_PAGE = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SummaryRow {
  occurrenceId: string
  path: string
  createdAt: Date
}

/**
 * The member's summary rows of finished occurrences (`completed` only: the summary row is registered before the
 * occurrence reaches `completed`, so an unfinished run is filtered here), oldest first, then by id.
 */
function summaryRows(db: Db, memberId: string, extra?: SQL) {
  return db
    .select({ occurrenceId: artefacts.occurrenceId, path: artefacts.path, createdAt: artefacts.createdAt })
    .from(artefacts)
    .innerJoin(
      occurrences,
      and(eq(occurrences.id, artefacts.occurrenceId), eq(occurrences.memberId, artefacts.memberId))
    )
    .where(
      and(eq(artefacts.memberId, memberId), eq(artefacts.kind, 'summary'), eq(occurrences.state, 'completed'), extra)
    )
    .orderBy(asc(artefacts.createdAt), asc(artefacts.id))
}

const toItem = (row: SummaryRow): SummaryListItem => ({
  occurrenceId: row.occurrenceId,
  fileName: posix.basename(row.path),
  readyAt: row.createdAt.toISOString()
})

/**
 * The member's summaries ready after `after`, oldest first, at most `SUMMARY_PAGE`. The companion passes the `readyAt` of
 * the last item it kept as the next `after`, so the comparison is strict.
 *
 * A page never ends inside a group of summaries that share one timestamp (to the millisecond, as `readyAt` is): a sibling
 * cut off at the edge would be skipped by the strict comparison. The group moves whole to the next page, or is returned
 * whole when it alone is larger than a page. Items carry the file name, the occurrence and the time only: no meeting
 * link and no passcode.
 */
export async function listSummaries(db: Db, memberId: string, after: Date): Promise<SummaryListItem[]> {
  const rows = await summaryRows(db, memberId, gt(artefacts.createdAt, after)).limit(SUMMARY_PAGE + 1)
  if (rows.length <= SUMMARY_PAGE) return rows.map(toItem)
  const edge = rows[SUMMARY_PAGE - 1]!.createdAt.getTime()
  if (rows[SUMMARY_PAGE]!.createdAt.getTime() > edge) return rows.slice(0, SUMMARY_PAGE).map(toItem)
  const earlier = rows.slice(0, SUMMARY_PAGE).filter((row) => row.createdAt.getTime() < edge)
  if (earlier.length > 0) return earlier.map(toItem)
  // The whole first page is one group that continues past it: return the group entire.
  const group = await summaryRows(
    db,
    memberId,
    and(gte(artefacts.createdAt, new Date(edge)), lt(artefacts.createdAt, new Date(edge + 1)))
  )
  return group.map(toItem)
}

/**
 * The text of one of the member's finished-occurrence summaries, or null when there is none. Null also when the file is
 * missing, is a symlink or other refused path (`openMemberFile`), or is over `MAX_ARTEFACT_BYTES`. The path is the one the
 * artefact row holds, never one from the request; `occurrenceId` must be a UUID.
 */
export async function readSummary(
  db: Db,
  memberId: string,
  occurrenceId: string
): Promise<{ fileName: string; text: string } | null> {
  if (!UUID.test(occurrenceId)) return null
  const row = (await summaryRows(db, memberId, eq(artefacts.occurrenceId, occurrenceId))).at(-1)
  if (!row) return null
  const file = await openMemberFile(createScope(db, memberId), occurrenceId, row.path)
  if (file === null) return null
  try {
    const { size } = await file.handle.stat()
    if (size > MAX_ARTEFACT_BYTES) return null
    return { fileName: posix.basename(row.path), text: await file.handle.readFile('utf8') }
  } finally {
    await file.handle.close()
  }
}
