import { PingError } from '@tm/notify'

// What is safe to print about a failure. A ping error says only that ntfy failed and its status: the fetch message
// behind it can carry the ntfy URL.
export function describeError(e: unknown): string {
  if (e instanceof PingError) {
    return e.status === null ? 'PingError (ntfy did not answer)' : `PingError (ntfy answered ${e.status})`
  }
  return e instanceof Error ? e.message : String(e)
}
