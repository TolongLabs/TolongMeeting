import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getDb, type Db } from './index'

export const migrationsFolder = new URL('./migrations', import.meta.url).pathname

/**
 * Applies every pending migration. Applied ones are recorded in `drizzle.__drizzle_migrations`, so a rerun does nothing.
 * Two processes booting together (a restart that overlaps its predecessor, `db:migrate` by hand) would both read the same
 * list of pending migrations and apply them twice, so the work runs under an advisory lock, `hashtextextended('tm:migrate',
 * 0)`, held by a connection of its own (the transaction below, which does nothing else). The second process waits for
 * the first, then finds nothing pending. The lock goes when the transaction ends or its connection drops.
 */
export async function runMigrations(db: Db): Promise<void> {
  await db.transaction(async (lock) => {
    await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended('tm:migrate', 0))`)
    // The migrator only runs SQL; its NodePgDatabase type just doesn't carry our schema generic. It uses the pool, not `lock`.
    await migrate(db as unknown as NodePgDatabase, { migrationsFolder })
  })
}

if (import.meta.main) {
  await runMigrations(getDb())
  console.log('Migrations applied')
  process.exit(0)
}
