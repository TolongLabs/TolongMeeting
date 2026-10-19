import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getDb, type Db } from './index'

export const migrationsFolder = new URL('./migrations', import.meta.url).pathname

/** Applies every pending migration. Applied ones are recorded in `drizzle.__drizzle_migrations`, so a rerun does nothing. */
export async function runMigrations(db: Db): Promise<void> {
  // The migrator only runs SQL; its NodePgDatabase type just doesn't carry our schema generic.
  await migrate(db as unknown as NodePgDatabase, { migrationsFolder })
}

if (import.meta.main) {
  await runMigrations(getDb())
  console.log('Migrations applied')
  process.exit(0)
}
