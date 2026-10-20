import { and, asc, eq, inArray } from 'drizzle-orm'
import { exports as exportsTable, occurrences, type Db } from '@tm/web/db'
import { safeDbError } from '@tm/web/db/errors'
import { toExportRow } from '@tm/web/db/exports'
import type {
  Connection,
  ConnectionKind,
  ConnectionSummary,
  ExportErrorCode,
  ExportResult,
  ExportTargetId,
  ExportStatus,
  OccurrenceInfo
} from './types'
import { redact } from './vault'

export interface ExportRow {
  id: string
  occurrenceId: string
  memberId: string
  target: ExportTargetId
  status: ExportStatus
  title: string | null
  url: string | null
  /** Relative to the occurrence directory. */
  filePath: string | null
  note: string | null
  errorCode: ExportErrorCode | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}

/** What `create` answers when it does not queue an export. The message is safe to show to the member. */
export type CreateExportRefusal =
  { ok: false; code: 'already_running'; message: string } | { ok: false; code: 'not_found'; message: string }
export type CreateExportResult = { ok: true; row: ExportRow } | CreateExportRefusal

export const INTERRUPTED_MESSAGE = 'The export was interrupted. Try again.'

/** The member-facing export operations, bound to one member by a `MemberScope` (`memberExportStores`). */
export interface MemberExports {
  /** Queues an export. The partial unique index allows one queued or running export per occurrence and target. */
  create(occurrenceId: string, target: ExportTargetId): Promise<CreateExportResult>
  get(id: string): Promise<ExportRow | null>
  /** Newest first. */
  listForOccurrence(occurrenceId: string): Promise<ExportRow[]>
}

/** The member's connections, bound to one member by a `MemberScope`. Tokens are sealed in the database. */
export interface MemberConnections {
  /** The opened connection, tokens included: for server code that calls the provider. Never send it to the browser. */
  get(kind: ConnectionKind): Promise<{ connection: Connection; status: 'ok' | 'reconnect_needed' } | null>
  /** Holds no token. */
  summaries(): Promise<ConnectionSummary[]>
  /** Insert or replace; the status goes back to 'ok'. */
  save(c: Connection): Promise<void>
  markReconnect(kind: ConnectionKind): Promise<void>
  remove(kind: ConnectionKind): Promise<void>
}

/** Reads an occurrence the member owns; null otherwise. */
export interface MemberOccurrences {
  get(occurrenceId: string): Promise<OccurrenceInfo | null>
}

/**
 * The operations only `tm-exports` uses. They cross members, so they take the raw `Db` (like the pipeline consumer) and
 * never read a token.
 */
export interface RunnerStore {
  /** The oldest queued export becomes running. Two runners never claim the same row. */
  claimNext(): Promise<ExportRow | null>
  /** Throws when the export is not running (it was purged, or already finished). */
  succeed(id: string, title: string, r: ExportResult): Promise<void>
  /** `message` is cleaned with `redact` before it is stored. Throws when the export is neither queued nor running. */
  fail(id: string, code: ExportErrorCode, message: string): Promise<void>
  /** Running exports become failed with code 'interrupted' (the runner restarted). Returns them. */
  failInterrupted(): Promise<ExportRow[]>
  /** Deletes the rows of occurrences in state 'deleted'. Returns how many. */
  purgeDeleted(): Promise<number>
}

export function runnerStore(db: Db): RunnerStore {
  return {
    async claimNext() {
      try {
        return await db.transaction(async (tx) => {
          const [next] = await tx
            .select({ id: exportsTable.id })
            .from(exportsTable)
            .where(eq(exportsTable.status, 'queued'))
            .orderBy(asc(exportsTable.createdAt), asc(exportsTable.id))
            .limit(1)
            .for('update', { skipLocked: true })
          if (!next) return null
          const [row] = await tx
            .update(exportsTable)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(exportsTable.id, next.id))
            .returning()
          return toExportRow(row!)
        })
      } catch (e) {
        throw safeDbError(e)
      }
    },

    async succeed(id, title, r) {
      let rows
      try {
        rows = await db
          .update(exportsTable)
          .set({
            status: 'succeeded',
            title,
            url: r.url,
            filePath: r.filePath,
            note: r.note,
            errorCode: null,
            error: null,
            finishedAt: new Date()
          })
          .where(and(eq(exportsTable.id, id), eq(exportsTable.status, 'running')))
          .returning({ id: exportsTable.id })
      } catch (e) {
        throw safeDbError(e)
      }
      if (rows.length === 0) throw new Error(`Export ${id} is not running`)
    },

    async fail(id, code, message) {
      let rows
      try {
        rows = await db
          .update(exportsTable)
          .set({ status: 'failed', errorCode: code, error: redact(message, []), finishedAt: new Date() })
          .where(and(eq(exportsTable.id, id), inArray(exportsTable.status, ['queued', 'running'])))
          .returning({ id: exportsTable.id })
      } catch (e) {
        throw safeDbError(e)
      }
      if (rows.length === 0) throw new Error(`Export ${id} is not queued or running`)
    },

    async failInterrupted() {
      try {
        const rows = await db
          .update(exportsTable)
          .set({ status: 'failed', errorCode: 'interrupted', error: INTERRUPTED_MESSAGE, finishedAt: new Date() })
          .where(eq(exportsTable.status, 'running'))
          .returning()
        return rows.map(toExportRow)
      } catch (e) {
        throw safeDbError(e)
      }
    },

    async purgeDeleted() {
      try {
        const rows = await db
          .delete(exportsTable)
          .where(
            inArray(
              exportsTable.occurrenceId,
              db.select({ id: occurrences.id }).from(occurrences).where(eq(occurrences.state, 'deleted'))
            )
          )
          .returning({ id: exportsTable.id })
        return rows.length
      } catch (e) {
        throw safeDbError(e)
      }
    }
  }
}
