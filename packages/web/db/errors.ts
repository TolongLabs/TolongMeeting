/** A failed database write. Its message is fixed, and it keeps only the Postgres SQLSTATE `code`. */
export class DbError extends Error {
  readonly code: string | undefined

  constructor(code: string | undefined) {
    super(code ? `Database write failed (SQLSTATE ${code}).` : 'Database write failed.')
    this.name = 'DbError'
    this.code = code
  }
}

/** A Postgres SQLSTATE: five digits or upper-case letters. Node codes such as `ECONNREFUSED` don't match. */
const SQLSTATE = /^[0-9A-Z]{5}$/

function sqlstateOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined
}

/**
 * Turns a failed query into an error that is safe to log or show. A Drizzle query error carries the SQL text and its
 * parameters, which are the member's saved values, in its message, its stack and its `cause`; the result keeps none of
 * them. Any other error is returned unchanged. Use it as `throw safeDbError(e)` wherever a write saves member values.
 */
export function safeDbError(e: unknown): unknown {
  if (!(e instanceof Error) || !('query' in e && 'params' in e)) return e
  return new DbError(sqlstateOf(e.cause) ?? sqlstateOf(e))
}
