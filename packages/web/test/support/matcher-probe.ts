// Run by `proxy-matcher.test.ts` in a child process: prints, for each URL in `PROBE_URLS` (a JSON array), whether the
// proxy runs on it, using Next's own matcher check. Next expects its server environment to have put
// `AsyncLocalStorage` on the global object, which `next start` does and a bare script does not.
import { AsyncLocalStorage } from 'node:async_hooks'

Object.assign(globalThis, { AsyncLocalStorage })
const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server')
const { config } = await import('../../proxy')

const urls: string[] = JSON.parse(process.env.PROBE_URLS!)
console.log(JSON.stringify(urls.map((url) => unstable_doesMiddlewareMatch({ config, url }))))
