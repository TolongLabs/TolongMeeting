import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import * as schema from './schema'

export * from './schema'
export { schema }

/** A Drizzle database over node-postgres. Transactions (`db.transaction(async (tx) => ...)`) are `Db` too. */
export type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>

// Next.js reloads modules in development; keep one pool per process.
const globalForDb = globalThis as typeof globalThis & { __tmDb?: { url: string; db: Db; pool: Pool } }

/** The process-wide database on `DATABASE_URL` (one node-postgres pool). Throws when the variable is unset. */
export function getDb(): Db {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  if (globalForDb.__tmDb?.url !== url) {
    const pool = new Pool({ connectionString: url })
    globalForDb.__tmDb = { url, pool, db: drizzle(pool, { schema }) }
  }
  return globalForDb.__tmDb.db
}

/** Closes the pool behind `getDb()` (graceful shutdown, scripts, tests). The next `getDb()` opens a new one. */
export async function closeDb(): Promise<void> {
  const current = globalForDb.__tmDb
  globalForDb.__tmDb = undefined
  await current?.pool.end()
}
