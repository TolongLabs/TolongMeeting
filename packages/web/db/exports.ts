import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  MAX_ACTIVE_EXPORTS_PER_MEMBER,
  type Connection,
  type ConnectionKind,
  type ConnectionSummary,
  type CreateExportResult,
  type ExportRow,
  type MemberConnections,
  type MemberExports,
  type MemberOccurrences
} from '@tm/exports'
import { safeDbError } from './errors'
import { connections, exports as exportsTable, occurrences } from './schema'
import { sealColumn, openColumn } from './secrets'
import type { MemberScope } from '../lib/scope'

// Wiring between the exports package and the database. Member-facing operations take a `MemberScope`, so no query here
// can read or write another member's row. The runner's cross-member operations are in `packages/exports/src/store.ts`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNIQUE_VIOLATION = '23505'
const ACTIVE_INDEX = 'exports_one_active_idx'

export const ALREADY_RUNNING_MESSAGE = 'This export is already running.'
export const TOO_MANY_MESSAGE = 'You have too many exports running. Wait for one to finish.'
export const NOT_READY_MESSAGE = 'This meeting has no finished summary to export.'
/** The most exports `listForOccurrence` returns. */
export const MAX_LISTED_EXPORTS = 50

/** A stored `exports` row as the `ExportRow` the rest of the app uses (without `startedAt`). */
export function toExportRow(r: typeof exportsTable.$inferSelect): ExportRow {
  return {
    id: r.id,
    occurrenceId: r.occurrenceId,
    memberId: r.memberId,
    target: r.target,
    status: r.status,
    title: r.title,
    url: r.url,
    filePath: r.filePath,
    note: r.note,
    errorCode: r.errorCode,
    error: r.error,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt
  }
}

/** True when `e` is Postgres refusing a second queued or running export of one occurrence and target. */
function isAlreadyActive(e: unknown): boolean {
  const pg = ((e as { cause?: unknown } | null)?.cause ?? e) as { code?: unknown; constraint?: unknown } | null
  return pg?.code === UNIQUE_VIOLATION && pg.constraint === ACTIVE_INDEX
}

export function memberExports(scope: MemberScope): MemberExports {
  return {
    async create(occurrenceId, target): Promise<CreateExportResult> {
      if (!UUID.test(occurrenceId)) return { ok: false, code: 'not_found', message: 'Meeting not found.' }
      const [occurrence] = await scope.select(occurrences, eq(occurrences.id, occurrenceId))
      // A deleted meeting is gone for the member. Only a finished one has a summary to export.
      if (!occurrence || occurrence.state === 'deleted')
        return { ok: false, code: 'not_found', message: 'Meeting not found.' }
      if (occurrence.state !== 'completed') return { ok: false, code: 'not_ready', message: NOT_READY_MESSAGE }
      try {
        // One create at a time per member, so two requests can't both pass the count.
        return await scope.transaction(async (tx): Promise<CreateExportResult> => {
          await tx.lock('exports')
          const active = await tx.select(exportsTable, inArray(exportsTable.status, ['queued', 'running']))
          if (active.length >= MAX_ACTIVE_EXPORTS_PER_MEMBER)
            return { ok: false, code: 'too_many', message: TOO_MANY_MESSAGE }
          return { ok: true, row: toExportRow(await tx.insert(exportsTable, { occurrenceId, target })) }
        })
      } catch (e) {
        if (isAlreadyActive(e)) return { ok: false, code: 'already_running', message: ALREADY_RUNNING_MESSAGE }
        throw safeDbError(e)
      }
    },

    async get(id) {
      if (!UUID.test(id)) return null
      const [row] = await scope.select(exportsTable, eq(exportsTable.id, id))
      return row ? toExportRow(row) : null
    },

    async listForOccurrence(occurrenceId) {
      if (!UUID.test(occurrenceId)) return []
      const rows = await scope.select(exportsTable, eq(exportsTable.occurrenceId, occurrenceId))
      // `MemberScope.select` takes no order or limit, so the newest are picked here; the list is short (one active export per target).
      return rows
        .map(toExportRow)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, MAX_LISTED_EXPORTS)
    }
  }
}

/** An occurrence the member owns, with its directory under `dataRoot`. */
export function memberOccurrences(scope: MemberScope, dataRoot: string): MemberOccurrences {
  return {
    async get(occurrenceId) {
      if (!UUID.test(occurrenceId)) return null
      const [row] = await scope.select(occurrences, eq(occurrences.id, occurrenceId))
      if (!row) return null
      return { id: row.id, memberId: row.memberId, state: row.state, dataDir: join(dataRoot, 'occurrences', row.id) }
    }
  }
}

// What is secret (sealed) and what is not (kept in the `settings` column), per kind.
const GitHubSettings = z.object({
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  folder: z.string()
})
const GoogleSettings = z.object({
  account: z.string(),
  folderId: z.string(),
  folderName: z.string(),
  folderIsDefault: z.boolean()
})
const NotionSettings = z.object({
  workspace: z.string(),
  parent: z
    .object({
      type: z.enum(['page_id', 'data_source_id']),
      id: z.string(),
      name: z.string(),
      titleProperty: z.string()
    })
    .nullable()
})
const GitHubSecret = z.object({ kind: z.literal('github'), token: z.string() })
const GoogleSecret = z.object({ kind: z.literal('google'), refreshToken: z.string() })
const NotionSecret = z.object({
  kind: z.literal('notion'),
  accessToken: z.string(),
  refreshToken: z.string().nullable()
})

const SETTINGS = { github: GitHubSettings, google: GoogleSettings, notion: NotionSettings } as const
const SECRETS = { github: GitHubSecret, google: GoogleSecret, notion: NotionSecret } as const

/** Splits a connection into the part that is sealed (tokens, plus `kind`) and the part that is not. */
function split(c: Connection): { secret: Record<string, unknown>; settings: Record<string, unknown> } {
  const secret = SECRETS[c.kind].parse(c)
  const settings = SETTINGS[c.kind].parse(c)
  return { secret, settings }
}

function openConnection(
  master: Buffer,
  memberId: string,
  kind: ConnectionKind,
  row: typeof connections.$inferSelect
): Connection {
  const secret = SECRETS[kind].parse(JSON.parse(openColumn(master, memberId, 'connections.token', row.tokenEnc)))
  const settings = SETTINGS[kind].parse(row.settings)
  return { ...settings, ...secret } as Connection
}

/** The summary of one stored connection, or null when its settings no longer match their schema. */
function summarise(kind: ConnectionKind, status: 'ok' | 'reconnect_needed', raw: unknown): ConnectionSummary | null {
  if (kind === 'github') {
    const parsed = GitHubSettings.safeParse(raw)
    if (!parsed.success) return null
    const s = parsed.data
    return {
      kind,
      status,
      ready: true,
      label: `${s.owner}/${s.repo}`,
      detail: `branch ${s.branch}, folder ${s.folder || '/'}`
    }
  }
  if (kind === 'google') {
    const parsed = GoogleSettings.safeParse(raw)
    if (!parsed.success) return null
    return { kind, status, ready: true, label: parsed.data.account, detail: parsed.data.folderName }
  }
  const parsed = NotionSettings.safeParse(raw)
  if (!parsed.success) return null
  const s = parsed.data
  return { kind, status, ready: s.parent !== null, label: s.workspace, detail: s.parent?.name ?? 'No page chosen yet' }
}

/**
 * The member's connections. `master` seals each connection's tokens with `sealColumn` (bound to the member and to
 * `connections.token`); the sealed JSON carries `kind`, which is checked when it is opened, because the AAD has no kind.
 * A token is never in a summary, a log line or an error message. `summaries` skips a row whose settings fail their schema.
 */
export function memberConnections(scope: MemberScope, master: Buffer): MemberConnections {
  const forKind = (kind: ConnectionKind) => eq(connections.kind, kind)
  return {
    async get(kind) {
      const [row] = await scope.select(connections, forKind(kind))
      if (!row) return null
      return { connection: openConnection(master, scope.memberId, kind, row), status: row.status }
    },

    async summaries() {
      const rows = await scope.select(connections)
      const out: ConnectionSummary[] = []
      for (const row of rows.sort((a, b) => a.kind.localeCompare(b.kind))) {
        const summary = summarise(row.kind, row.status, row.settings)
        // The page lists what it can. A row that no longer parses is skipped and logged by id only (no settings, no token).
        if (summary === null) console.error(`connection ${row.id} has settings that do not match their schema`)
        else out.push(summary)
      }
      return out
    },

    async save(c) {
      const { secret, settings } = split(c)
      const tokenEnc = sealColumn(master, scope.memberId, 'connections.token', JSON.stringify(secret))
      try {
        await scope.transaction(async (tx) => {
          // One save at a time per member, so two first saves of a kind can't both insert.
          await tx.lock('connections')
          const set = { tokenEnc, settings, status: 'ok' as const }
          const changed = await tx.update(connections, set, forKind(c.kind))
          if (changed === 0) await tx.insert(connections, { kind: c.kind, ...set })
        })
      } catch (e) {
        throw safeDbError(e)
      }
    },

    async markReconnect(kind) {
      await scope.update(connections, { status: 'reconnect_needed' }, forKind(kind))
    },

    async remove(kind) {
      await scope.remove(connections, forKind(kind))
    }
  }
}

export interface MemberExportStores {
  exports: MemberExports
  connections: MemberConnections
  occurrences: MemberOccurrences
}

/** Every member-facing export store for one member. `master` is the 32-byte master key; `dataRoot` is `TM_DATA_ROOT`. */
export function memberExportStores(scope: MemberScope, master: Buffer, dataRoot: string): MemberExportStores {
  return {
    exports: memberExports(scope),
    connections: memberConnections(scope, master),
    occurrences: memberOccurrences(scope, dataRoot)
  }
}
