import { and, asc, eq, inArray } from 'drizzle-orm'
import { exports as exportsTable, occurrences, type Db } from '@tm/web/db'
import { safeDbError } from '@tm/web/db/errors'
import { toExportRow } from '@tm/web/db/exports'
import type { RunnerStore } from './store-types'
import { redact } from './vault'

export const INTERRUPTED_MESSAGE = 'The export was interrupted. Try again.'

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

    async fail(id, code, message, secrets = []) {
      let rows
      try {
        rows = await db
          .update(exportsTable)
          .set({ status: 'failed', errorCode: code, error: redact(message, secrets), finishedAt: new Date() })
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
