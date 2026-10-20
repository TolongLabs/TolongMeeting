import { randomUUID } from 'node:crypto'
import type { RunnerConnections } from '../src/runner'
import type { ExportRow, RunnerStore } from '../src/store-types'
import type { Connection, ConnectionKind, ExportTargetId, OccurrenceInfo, OccurrenceLookup } from '../src/types'

export interface MemoryStores {
  /** What `tm-exports` uses. Like the real store but in memory; `fail` keeps the message exactly as it was given. */
  store: RunnerStore
  /** What a member's request does, for tests: queue an export and read it back. */
  exports: {
    create(memberId: string, occurrenceId: string, target: ExportTargetId): Promise<ExportRow>
    get(memberId: string, id: string): Promise<ExportRow | null>
  }
  connections: RunnerConnections
  occurrences: OccurrenceLookup
  /** The kinds `markReconnect` was called for, in order. */
  markedReconnect: ConnectionKind[]
  /** The connections `save` was called with, in order. */
  saved: Connection[]
}

/** In-memory stand-ins for the runner's database access. Ids and times are unique and increasing. */
export function memoryStores(seed?: {
  occurrences?: OccurrenceInfo[]
  connections?: { memberId: string; connection: Connection; status?: 'ok' | 'reconnect_needed' }[]
}): MemoryStores {
  const rows: ExportRow[] = []
  const occurrences = new Map((seed?.occurrences ?? []).map((o) => [`${o.memberId}/${o.id}`, o]))
  const connections = new Map(
    (seed?.connections ?? []).map((c) => [
      `${c.memberId}/${c.connection.kind}`,
      { connection: c.connection, status: c.status ?? ('ok' as const) }
    ])
  )
  const markedReconnect: ConnectionKind[] = []
  const saved: Connection[] = []
  let clock = Date.parse('2026-10-20T12:00:00Z')
  const now = () => new Date((clock += 1000))
  const byId = (id: string) => rows.find((r) => r.id === id)

  const store: RunnerStore = {
    async claimNext() {
      const next = rows.find((r) => r.status === 'queued')
      if (!next) return null
      next.status = 'running'
      return { ...next }
    },
    async succeed(id, title, r) {
      const row = byId(id)
      if (row?.status !== 'running') throw new Error(`Export ${id} is not running`)
      Object.assign(row, { status: 'succeeded', title, ...r, errorCode: null, error: null, finishedAt: now() })
    },
    async fail(id, code, message) {
      const row = byId(id)
      if (row === undefined || (row.status !== 'queued' && row.status !== 'running'))
        throw new Error(`Export ${id} is not queued or running`)
      Object.assign(row, { status: 'failed', errorCode: code, error: message, finishedAt: now() })
    },
    async failInterrupted() {
      const stale = rows.filter((r) => r.status === 'running')
      for (const row of stale) {
        Object.assign(row, {
          status: 'failed',
          errorCode: 'interrupted',
          error: 'The export was interrupted. Try again.',
          finishedAt: now()
        })
      }
      return stale.map((r) => ({ ...r }))
    },
    async purgeDeleted() {
      const gone = rows.filter((r) => occurrences.get(`${r.memberId}/${r.occurrenceId}`)?.state === 'deleted')
      for (const row of gone) rows.splice(rows.indexOf(row), 1)
      return gone.length
    }
  }

  return {
    store,
    exports: {
      async create(memberId, occurrenceId, target) {
        const row: ExportRow = {
          id: randomUUID(),
          occurrenceId,
          memberId,
          target,
          status: 'queued',
          title: null,
          url: null,
          filePath: null,
          note: null,
          errorCode: null,
          error: null,
          createdAt: now(),
          finishedAt: null
        }
        rows.push(row)
        return { ...row }
      },
      async get(memberId, id) {
        const row = byId(id)
        return row && row.memberId === memberId ? { ...row } : null
      }
    },
    connections: {
      async get(memberId, kind) {
        return connections.get(`${memberId}/${kind}`) ?? null
      },
      async save(memberId, c) {
        saved.push(c)
        connections.set(`${memberId}/${c.kind}`, { connection: c, status: 'ok' })
      },
      async markReconnect(memberId, kind) {
        markedReconnect.push(kind)
        const found = connections.get(`${memberId}/${kind}`)
        if (found) found.status = 'reconnect_needed'
      }
    },
    occurrences: {
      async get(memberId, occurrenceId) {
        return occurrences.get(`${memberId}/${occurrenceId}`) ?? null
      }
    },
    markedReconnect,
    saved
  }
}
