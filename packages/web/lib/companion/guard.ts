import { DEVICE_TOKEN_PREFIX } from '@tm/core'

// The part of the device-token boundary that needs no database, so `proxy.ts` can run it on every request without
// importing the data layer. `scope.ts` re-exports it next to `withDevice`.

const COMPANION_PREFIX = '/api/companion/'
const MAX_DECODE_ROUNDS = 5
// `Authorization: Bearer tmd_...`, anywhere in the header (a proxy joins repeated headers with a comma), any case.
const DEVICE_BEARER = new RegExp(String.raw`\bbearer\s+${DEVICE_TOKEN_PREFIX}`, 'i')

/**
 * The path with every percent-escape decoded (also escapes of escapes), or `null` when it can't be a plain path: bad
 * escapes, escapes that never settle, control characters or a backslash.
 */
function decodedPath(pathname: string): string | null {
  let path = pathname
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string
    try {
      next = decodeURIComponent(path)
    } catch (e) {
      if (e instanceof URIError) return null
      throw e
    }
    if (next === path) return /[\u0000-\u001f\u007f\\]/.test(path) ? null : path
    path = next
  }
  return null
}

/**
 * True for `/api/companion/<something>` only, written exactly so. Everything odd answers `false`, which makes callers
 * refuse a device token: a different case (`/API/companion/`), an empty, `.` or `..` segment, a segment ending in a
 * dot or a space, an escaped slash or dot that hides a `..`, a backslash, or a longer first segment (`companionx`).
 */
export function isCompanionPath(pathname: string): boolean {
  const path = decodedPath(pathname)
  if (path === null || !path.startsWith(COMPANION_PREFIX)) return false
  const segments = path.slice(COMPANION_PREFIX.length).split('/')
  if (segments.at(-1) === '') segments.pop()
  return segments.length > 0 && segments.every((s) => s !== '' && s !== '.' && s !== '..' && !/[. ]$/.test(s))
}

/** True when the header carries a device token and the path is not a companion path. The token is not looked at. */
export function misplacedDeviceToken(pathname: string, authorization: string | null): boolean {
  return authorization !== null && DEVICE_BEARER.test(authorization) && !isCompanionPath(pathname)
}

/**
 * The refusal for a request that offers a device token outside `/api/companion/` (member pages, member API, the
 * `forward_auth` check for remote views), or `null` to let it through. It never reads the database and never says
 * whether the token is real.
 */
export function guardDeviceToken(request: Request): Response | null {
  if (!misplacedDeviceToken(new URL(request.url).pathname, request.headers.get('authorization'))) return null
  return Response.json({ error: 'device_token_not_allowed' }, { status: 403, headers: { 'cache-control': 'no-store' } })
}
