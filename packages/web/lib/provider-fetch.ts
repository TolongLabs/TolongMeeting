/** The longest one call to a provider (Google, Notion, GitHub) may take in a web request. */
export const PROVIDER_TIMEOUT_MS = 15_000

/**
 * `fetch` for the site's calls to a provider: it gives up after `PROVIDER_TIMEOUT_MS`, so a provider that accepts the
 * connection and then says nothing can't hold a request open. A signal the caller passes works too; either aborts.
 */
export const providerFetch = ((input, init) => {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
}) as typeof fetch
