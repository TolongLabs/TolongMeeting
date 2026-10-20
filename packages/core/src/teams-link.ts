import { unwrapLink } from './zoom-link'

const CONTROL_CHARACTERS = /\p{Cc}/u
const TEAMS_HOSTS: ReadonlySet<string> = new Set(['teams.microsoft.com', 'teams.live.com'])
// The shell paths a browser or the desktop launcher puts in front of the real `/l/...` path or `#/l/...` hash.
const SHELL_PATHS: ReadonlySet<string> = new Set(['/', '/_', '/_/', '/v2', '/v2/'])
const LAUNCHER_PATH = '/dl/launcher/launcher.html'
const MEETUP_JOIN = /^\/l\/meetup-join\/([^/]+)\/(\d+)\/?$/
const MEET_NOW = /^\/meet\/(\d+)\/?$/
const CHAT = /^\/l\/chat\/([^/]+)\/conversations\/?$/
// Meeting and group chat threads look like `19:meeting_<id>@thread.v2`; 1:1 chats end in `@unq.gbl.spaces`.
const THREAD = /^19:[^/\s]+@[A-Za-z0-9.]+$/

interface Located {
  host: string
  pathname: string
  params: URLSearchParams
}

/** Percent-decodes a path segment, or null when the escapes are malformed or the result holds a control character. */
function decodeSegment(segment: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
  return CONTROL_CHARACTERS.test(decoded) ? null : decoded
}

/** Reads `path?query` that came out of a hash or a launcher parameter; it must stay on the same origin. */
function locateRelative(relative: string, origin: string): Located | null {
  // A leading `//` or `/\` would make the URL parser switch host.
  if (!/^\/(?![/\\])/.test(relative)) return null
  // The URL parser would silently strip tabs and line breaks, so a decoded one is refused first.
  if (CONTROL_CHARACTERS.test(relative)) return null
  const u = new URL(relative, origin)
  return u.origin === origin ? { host: u.hostname, pathname: u.pathname, params: u.searchParams } : null
}

/**
 * Finds the real Teams path and query behind any wrapper: Safe Links and Google redirects (via `unwrapLink`), the
 * `/dl/launcher/launcher.html?url=/_#/l/...` page, and the `/_#/l/...` and `/v2/?meetingjoin=true#/l/...` shells.
 * Only https on the default port with no userinfo, on exactly `teams.microsoft.com` or `teams.live.com`, passes.
 */
function locate(input: string): Located | null {
  const trimmed = input.trim()
  if (CONTROL_CHARACTERS.test(trimmed)) return null
  const unwrapped = unwrapLink(trimmed)
  // The URL parser would silently strip these, so they are refused before it sees them.
  if (CONTROL_CHARACTERS.test(unwrapped) || !URL.canParse(unwrapped)) return null
  const u = new URL(unwrapped)
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null
  if (!TEAMS_HOSTS.has(u.hostname)) return null

  if (u.pathname === LAUNCHER_PATH) {
    const target = u.searchParams.get('url')
    if (target === null) return null
    return locateRelative(target.replace(/^\/_#/, ''), u.origin)
  }
  if (SHELL_PATHS.has(u.pathname) && u.hash.startsWith('#/')) return locateRelative(u.hash.slice(1), u.origin)
  return { host: u.hostname, pathname: u.pathname, params: u.searchParams }
}

/** A thread id that survives a round trip through `encodeURIComponent`, or null. */
function canonicalThread(segment: string): string | null {
  const thread = decodeSegment(segment)
  return thread !== null && THREAD.test(thread) ? encodeURIComponent(thread) : null
}

/** `?name=<value>` re-encoded the canonical way, or '' when the parameter is absent, empty or holds a control char. */
function canonicalParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)
  if (value === null || value === '') return ''
  return CONTROL_CHARACTERS.test(value) ? null : `?${name}=${encodeURIComponent(value)}`
}

/**
 * Turns any Teams meeting link into one canonical form, or null. Accepted: `/l/meetup-join/<thread>/<n>` (keeping only
 * `context`) and `/meet/<digits>` (keeping only `p`), reached directly or through Safe Links, the launcher page or the
 * `/_#/` and `/v2/?meetingjoin=true#/` shells. Everything else, including chat and channel links, look-alike hosts,
 * userinfo, ports and control characters, is refused. This is the one Teams link rule: the timetable accepts a link
 * only if the worker accepts it.
 */
export function normaliseTeamsLink(url: string): string | null {
  const found = locate(url)
  if (found === null) return null
  const origin = `https://${found.host}`
  const join = MEETUP_JOIN.exec(found.pathname)
  if (join) {
    const thread = canonicalThread(join[1])
    const context = canonicalParam(found.params, 'context')
    if (thread === null || context === null) return null
    return `${origin}/l/meetup-join/${thread}/${join[2]}${context}`
  }
  const meet = MEET_NOW.exec(found.pathname)
  if (meet) {
    const passcode = canonicalParam(found.params, 'p')
    return passcode === null ? null : `${origin}/meet/${meet[1]}${passcode}`
  }
  return null
}

/**
 * Turns a Teams chat or group chat link into `https://<host>/l/chat/<thread>/conversations`, or null for anything
 * else (a meeting, a channel, a chat name). Same host, wrapper and strictness rules as `normaliseTeamsLink`.
 */
export function normaliseTeamsChatUrl(url: string): string | null {
  const found = locate(url)
  if (found === null) return null
  const chat = CHAT.exec(found.pathname)
  if (!chat) return null
  const thread = canonicalThread(chat[1])
  return thread === null ? null : `https://${found.host}/l/chat/${thread}/conversations`
}
