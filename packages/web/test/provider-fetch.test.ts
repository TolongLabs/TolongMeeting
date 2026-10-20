import { afterEach, expect, test } from 'bun:test'
import { PROVIDER_TIMEOUT_MS, providerFetch } from '../lib/provider-fetch'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Replaces the global `fetch` with one that records the signal it was given. */
function spy() {
  const seen: { signal: AbortSignal | null | undefined }[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ signal: init?.signal })
    return new Response('ok')
  }) as unknown as typeof fetch
  return seen
}

test('every provider call carries a 15 second timeout signal', async () => {
  expect(PROVIDER_TIMEOUT_MS).toBe(15_000)
  const seen = spy()
  await providerFetch('https://api.example/x')
  expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
  expect(seen[0]!.signal!.aborted).toBe(false)
})

test("a caller's own signal still aborts the call", async () => {
  const seen = spy()
  const own = new AbortController()
  await providerFetch('https://api.example/x', { signal: own.signal })
  expect(seen[0]!.signal!.aborted).toBe(false)
  own.abort()
  expect(seen[0]!.signal!.aborted).toBe(true)
})

test('a provider that never answers is cut off by the timeout, not left open', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => undefined) })
  try {
    const started = Date.now()
    const outcome = await providerFetch(`http://127.0.0.1:${server.port}/`, {
      signal: AbortSignal.timeout(100)
    }).catch((e: unknown) => e)
    expect((outcome as Error).name).toBe('TimeoutError')
    expect(Date.now() - started).toBeLessThan(5000)
  } finally {
    await server.stop(true)
  }
})
