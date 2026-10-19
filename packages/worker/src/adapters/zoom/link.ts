import { unwrapLink } from '../../forms/links'

const JOIN_PATHS = [/^\/j\/(\d+)\/?$/, /^\/wc\/join\/(\d+)\/?$/]
const WC_JOIN_AFTER_ID = /^\/wc\/(\d+)\/join\/?$/

function isZoomHost(hostname: string): boolean {
  return hostname === 'zoom.us' || hostname.endsWith('.zoom.us')
}

// Turns any Zoom meeting link into the web-client URL (/wc/join/<id>, which never opens the desktop app), or null.
// The /j/ launcher page is never returned. Personal /my/ links, other paths and look-alike hosts are refused.
export function normaliseZoomLink(url: string): string | null {
  const unwrapped = unwrapLink(url.trim())
  if (!URL.canParse(unwrapped)) return null
  const u = new URL(unwrapped)
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null
  if (!isZoomHost(u.hostname)) return null
  // The fragment (for example #success) is dropped; the query (pwd) is kept as it came.
  const afterId = WC_JOIN_AFTER_ID.exec(u.pathname)
  if (afterId) return `${u.origin}/wc/${afterId[1]}/join${u.search}`
  for (const path of JOIN_PATHS) {
    const m = path.exec(u.pathname)
    if (m) return `${u.origin}/wc/join/${m[1]}${u.search}`
  }
  return null
}
