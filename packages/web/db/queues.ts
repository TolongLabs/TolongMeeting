import type { PgBoss } from 'pg-boss'
import type { Db } from './index'

export const QUEUES = {
  expand: 'expand',
  launch: 'launch',
  launchDead: 'launch-dead',
  pipeline: 'pipeline',
  signinStart: 'signin-start',
  deleteOccurrence: 'delete-occurrence',
  retention: 'retention',
  backup: 'backup',
  orgCheck: 'org-check'
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/** pg-boss's per-call `db` option: anything that can run a parameterised statement (`ConnectionOptions.db`). */
export interface QueueDb {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface SendOpts {
  startAfter?: Date
  /**
   * Informational only: on a standard queue pg-boss does not deduplicate on it. Correctness comes from
   * `unique (entry_id, scheduled_start)` and from the launcher treating a missing row or a changed `scheduled_start` as
   * a stale job.
   */
  singletonKey?: string
  /** Send through this connection, so the job commits or rolls back with the caller's transaction. */
  db?: QueueDb
}

/** The part of pg-boss that web and scheduler code uses to queue jobs, so tests can swap in `FakeQueue`. */
export interface Queue {
  send(name: QueueName, data: Record<string, unknown>, opts?: SendOpts): Promise<string | null>
}

/** A `Queue` over a started pg-boss instance. The queue named in `send` must already exist (`boss.createQueue`). */
export function bossQueue(boss: PgBoss): Queue {
  return {
    send: (name, data, opts) => boss.send(name, data, opts ?? {})
  }
}

/**
 * A `QueueDb` over a Drizzle transaction, for `SendOpts.db`: pg-boss runs its insert on the transaction's own
 * connection, so the job exists only if the transaction commits. Pass the `tx` of `db.transaction`, not the pool `Db`.
 */
export function queueDbOf(tx: Db): QueueDb {
  // `tx.execute` takes only Drizzle SQL, so run the statement on the checked-out client the transaction is bound to.
  const client = (tx as unknown as { session?: { client?: { query?: unknown } } }).session?.client
  if (!client || typeof client.query !== 'function') throw new Error('queueDbOf needs a node-postgres transaction')
  const pg = client as { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }
  return { executeSql: (text, values) => pg.query(text, values) }
}
