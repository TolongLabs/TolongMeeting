import { sql } from 'drizzle-orm'
import type { Db } from './index'

/**
 * Takes the per-occurrence pipeline lock without waiting, for the length of the transaction `tx` (a Drizzle
 * transaction, not the pool). The pipeline consumer holds it for a whole run; the retention pass takes it before it
 * removes a meeting that is stuck in the pipeline. True when this call got it.
 */
export async function tryPipelineLock(tx: Db, occurrenceId: string): Promise<boolean> {
  const result = await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'pipeline:' + occurrenceId}, 0)) as locked`
  )
  return result.rows[0]?.locked === true
}
