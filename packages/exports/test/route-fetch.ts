export interface FakeCall {
  method: string
  url: string
  /** Header names are lower-case. */
  headers: Record<string, string>
  body: string
  redirect: string
}

type Respond = (req: Request, n: number) => Response | Promise<Response>
export type Route = [method: string, url: string | RegExp, respond: Respond]

function matches(url: string | RegExp, full: string): boolean {
  if (url instanceof RegExp) return url.test(full)
  const u = new URL(full)
  return u.origin + u.pathname === url || u.pathname === url
}

/**
 * A `fetch` that answers from `routes` (the first that matches) and records every call. A string matches a request whose
 * origin + pathname, or pathname alone, equals it; a RegExp is tested on the full URL. `n` counts earlier calls to the
 * same route. An unmatched request throws `unexpected <method> <url>`.
 */
export function routeFetch(routes: Route[]) {
  const calls: FakeCall[] = []
  const seen = new Map<Route, number>()
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({
      method: req.method,
      url: req.url,
      headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
      body: await req.clone().text(),
      redirect: req.redirect
    })
    const route = routes.find(([m, u]) => m === req.method && matches(u, req.url))
    if (!route) throw new Error(`unexpected ${req.method} ${req.url}`)
    const n = seen.get(route) ?? 0
    seen.set(route, n + 1)
    return route[2](req, n)
  }) as typeof fetch
  const find = (method: string, url: string | RegExp) => calls.filter((c) => c.method === method && matches(url, c.url))
  return {
    fetch: fetchFake,
    calls,
    call(method: string, url: string | RegExp): FakeCall {
      const found = find(method, url)[0]
      if (!found) throw new Error(`no ${method} ${String(url)} call`)
      return found
    },
    count: (method: string, url: string | RegExp) => find(method, url).length
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers })
