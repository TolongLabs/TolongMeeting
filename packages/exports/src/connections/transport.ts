import { ExportError } from '../types'

/**
 * True for what `fetch` rejects with when the provider gave no answer: a `TypeError` (DNS, refused or reset connection,
 * a refused redirect) or an abort or timeout. Anything else is a bug and is not hidden.
 */
export function isTransportError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))
}

/**
 * `http` that turns "no answer" into an `ExportError` with the fixed `message`, so a route answers it like any other
 * unavailable provider and an export fails with a sentence. The original error stays in `cause` and is never shown.
 */
export function guarded(http: typeof fetch, message: string): typeof fetch {
  return (async (input, init) => {
    try {
      return await http(input, init)
    } catch (e) {
      if (!isTransportError(e)) throw e
      const error = new ExportError('failed', message)
      error.cause = e
      throw error
    }
  }) as typeof fetch
}
