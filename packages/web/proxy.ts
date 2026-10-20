import { NextResponse, type NextRequest } from 'next/server'
import { guardDeviceToken } from './lib/companion/guard'
import { connectionsCsp, isConnectionsPage, newNonce } from './lib/connections-csp'

/**
 * Runs before every route except the device upload routes below, `/api/vnc/authorize` (Caddy's `forward_auth`)
 * included. It answers 403 to a request that offers a device token anywhere but `/api/companion/`. It does no sign-in
 * check of either kind: a device route authenticates in `withDevice` (bearer token only) and a member route in
 * `requireMember` (session cookie only), so neither credential is ever tried on the other's routes.
 *
 * Why the exclusion: when a proxy runs, Next buffers a copy of the request body in memory, up to
 * `experimental.proxyClientMaxBodySize` (10 MB), and past that limit it cuts the body short, logs a warning and lets
 * the request go on. A route that reads a larger body would silently get a truncated one. The upload routes take
 * bodies of up to 50 MB per part (160 MB in all), and a chunk may be 16 MiB, so the proxy must not run on them. Raising the limit instead would
 * buffer up to 160 MB per request in memory. Every excluded route is under `/api/companion/` and authenticates with
 * `withDevice` itself, so the device-token guard (which only refuses tokens outside `/api/companion/`) loses nothing.
 *
 * The excluded routes are `/api/companion/jobs/<id>/transcript` and the local-run chunk uploads
 * `/api/companion/jobs/<id>/files/<path>` (plan 08 Task 3, chunks of up to 16 MiB). To exclude another one, add one
 * alternative to the lookahead in `config.matcher`. Keep the job id pattern (the UUID shape, not just 36 hex digits and dashes), so only a real job id is
 * excluded. Next reads `config` statically, so the matcher must stay one literal string.
 */
export function proxy(request: NextRequest): Response {
  const refused = guardDeviceToken(request)
  if (refused) return refused
  if (!isConnectionsPage(request.nextUrl.pathname)) return NextResponse.next()
  // The Connections page loads the Google Picker, so it alone gets a Content-Security-Policy with a nonce. Next reads the
  // nonce from the request's policy and puts it on its own scripts.
  const policy = connectionsCsp(newNonce())
  const headers = new Headers(request.headers)
  headers.set('Content-Security-Policy', policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', policy)
  return response
}

export const config = {
  matcher: [
    '/((?!api/companion/jobs/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/(?:transcript$|files/.+)).*)'
  ]
}
