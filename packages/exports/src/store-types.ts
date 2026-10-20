// Types only: this module has no runtime code, so the package index can export it without pulling in the database. The
// cross-member `runnerStore` is in `./store` and only the runner entry imports it.
import type {
  Connection,
  ConnectionKind,
  ConnectionSummary,
  ExportErrorCode,
  ExportResult,
  ExportStatus,
  ExportTargetId,
  OccurrenceInfo
} from './types'

export interface ExportRow {
  id: string
  occurrenceId: string
  memberId: string
  target: ExportTargetId
  status: ExportStatus
  title: string | null
  url: string | null
  /** Relative to the occurrence directory (for example `exports/<exportId>.zip`), never absolute. */
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
  /** `message` is cleaned with `redact` (also removing `secrets`, the tokens of the opened connection) before it is stored. Throws when the export is neither queued nor running. */
  fail(id: string, code: ExportErrorCode, message: string, secrets?: readonly string[]): Promise<void>
  /** Running exports become failed with code 'interrupted' (the runner restarted). Returns them. */
  failInterrupted(): Promise<ExportRow[]>
  /** Deletes the rows of occurrences in state 'deleted'. Returns how many. */
  purgeDeleted(): Promise<number>
}
