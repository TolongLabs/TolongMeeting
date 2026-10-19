const MAX_UNWRAP_DEPTH = 3
// /j/<id>, /wc/join/<id> and /wc/<id>/join all name the same meeting.
const JOIN_PATHS = [/^\/j\/(\d+)\/?$/, /^\/wc\/join\/(\d+)\/?$/, /^\/wc\/(\d+)\/join\/?$/]
const CONTROL_CHARACTERS = /\p{Cc}/u

function unwrapOnce(url: string): string {
  if (!URL.canParse(url)) return url
  const u = new URL(url)
  if (u.hostname.endsWith('.safelinks.protection.outlook.com')) return u.searchParams.get('url') ?? url
  if (u.hostname === 'www.google.com' || u.hostname === 'google.com') {
    if (u.pathname !== '/url') return url
    return u.searchParams.get('q') ?? u.searchParams.get('url') ?? url
  }
  return url
}

/** Peels Safe Links and Google redirect wrappers, up to three layers. */
export function unwrapLink(url: string): string {
  let current = url
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const next = unwrapOnce(current)
    if (next === current) break
    current = next
  }
  return current
}

function isZoomHost(hostname: string): boolean {
  return hostname === 'zoom.us' || hostname.endsWith('.zoom.us')
}

/**
 * Turns any Zoom meeting link into the web-client URL (`/wc/join/<id>`, which never opens the desktop app), or null.
 * Every accepted form is rewritten to `/wc/join/<id>`, the only path verified in the session record; the `/j/` launcher
 * page is never returned. Only https on the default port, with no userinfo, on `zoom.us` or an exact `*.zoom.us` host,
 * is accepted. Personal `/my/` links, other paths, look-alike hosts and URLs with control characters (which the URL
 * parser would silently strip) are refused. This is the one Zoom link rule: the timetable accepts a link only if the
 * worker accepts it.
 */
export function normaliseZoomLink(url: string): string | null {
  const trimmed = url.trim()
  if (CONTROL_CHARACTERS.test(trimmed)) return null
  const unwrapped = unwrapLink(trimmed)
  if (CONTROL_CHARACTERS.test(unwrapped) || !URL.canParse(unwrapped)) return null
  const u = new URL(unwrapped)
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null
  if (!isZoomHost(u.hostname)) return null
  // The fragment (for example #success) is dropped; the query (pwd) is kept as it came.
  for (const path of JOIN_PATHS) {
    const m = path.exec(u.pathname)
    if (m) return `${u.origin}/wc/join/${m[1]}${u.search}`
  }
  return null
}
