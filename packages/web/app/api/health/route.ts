import { sql } from 'drizzle-orm'
import { controlDeps } from '../../../lib/control'

// Never cached or prerendered: the answer is the database's state now.
export const dynamic = 'force-dynamic'

/**
 * Compose and Caddy's health check: `200 ok` after `select 1`, else a bare `503`. The database comes from
 * `controlDeps` because only `lib/` opens it (`no-direct-db.test.ts`); that call also starts the send-only queue. Nothing
 * from the failure (a connection string, a host) is returned or logged.
 */
export async function GET(): Promise<Response> {
  try {
    const { db } = await controlDeps()
    await db.execute(sql`select 1`)
  } catch (e) {
    console.error(`health: failed (${e instanceof Error ? e.name : 'unknown'})`)
    return new Response('unavailable', { status: 503, headers: { 'cache-control': 'no-store' } })
  }
  return new Response('ok', { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } })
}
