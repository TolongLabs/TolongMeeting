import { NextResponse, type NextRequest } from 'next/server'
import { guardDeviceToken } from './lib/companion/guard'

/**
 * Runs before every route, `/api/vnc/authorize` (Caddy's `forward_auth`) included. It answers 403 to a request that
 * offers a device token anywhere but `/api/companion/`. It does no sign-in check of either kind: a device route
 * authenticates in `withDevice` (bearer token only) and a member route in `requireMember` (session cookie only), so
 * neither credential is ever tried on the other's routes.
 */
export function proxy(request: NextRequest): Response {
  return guardDeviceToken(request) ?? NextResponse.next()
}
