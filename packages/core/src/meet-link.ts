import { unwrapLink } from './zoom-link'

const CONTROL_CHARACTERS = /\p{Cc}/u
// Three letters, four letters, three letters; the hyphens are optional on input and always written on output.
const CODE = /^([a-z]{3})-?([a-z]{4})-?([a-z]{3})$/i
const LOOKUP_NAME = /^[A-Za-z0-9_-]{1,64}$/
// The host and the path exactly as the sender wrote them, before the URL parser tidies them.
const RAW_PARTS = /^https:\/\/([^/?#]*)([^?#]*)/i
// A link written without a scheme is accepted only when it starts with one of the two Meet hosts.
const SCHEMELESS = /^(?:meet\.google\.com|g\.co)\//i

/**
 * Turns any Google Meet link into `https://meet.google.com/<abc-defg-hij>` (or `/lookup/<name>`), or null.
 * Accepted: `meet.google.com/<code>`, `meet.google.com/lookup/<name>` and `g.co/meet/<code>`, reached directly or through
 * Safe Links and Google redirects (peeled with `unwrapLink`). Only https on the default port, with no userinfo, on
 * exactly `meet.google.com` (or `g.co` for the short form), is accepted; a scheme-less link is accepted only when it
 * starts with one of those two hosts. The host is checked as the sender wrote it, so an escaped, fullwidth or
 * trailing-dot spelling is refused, and so are backslashes, dot segments, any percent escape in the path, and any control character
 * (which the URL parser would silently strip). The query and fragment are dropped, and the output is rebuilt from parts.
 * This is the one Meet link rule: the timetable accepts a link only if the worker accepts it.
 */
export function normaliseMeetLink(url: string): string | null {
  const trimmed = url.trim()
  if (CONTROL_CHARACTERS.test(trimmed)) return null
  let unwrapped = unwrapLink(trimmed)
  // Checked again: the wrapper's parameter was percent-decoded, and may now hold a control character.
  if (CONTROL_CHARACTERS.test(unwrapped) || unwrapped.includes('\\')) return null
  if (SCHEMELESS.test(unwrapped)) unwrapped = `https://${unwrapped}`
  if (!URL.canParse(unwrapped)) return null
  const u = new URL(unwrapped)
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null
  // A host the parser rewrote (escapes, fullwidth letters, a trailing dot) or a path it resolved (`/./`, `/../`,
  // `%2e%2e`, a space) is ambiguous. The path is then matched as written and never decoded.
  const raw = RAW_PARTS.exec(unwrapped)
  if (raw === null || raw[1]!.toLowerCase() !== u.host || raw[2] !== u.pathname) return null
  const segments = u.pathname.replace(/\/$/, '').split('/')
  if (segments[0] !== '') return null

  if (u.hostname === 'meet.google.com') {
    if (segments.length === 2) return canonicalCode(segments[1]!)
    if (segments.length === 3 && segments[1] === 'lookup' && LOOKUP_NAME.test(segments[2]!)) {
      return `https://meet.google.com/lookup/${segments[2]}`
    }
    return null
  }
  if (u.hostname === 'g.co' && segments.length === 3 && segments[1] === 'meet') return canonicalCode(segments[2]!)
  return null
}

function canonicalCode(segment: string): string | null {
  const m = CODE.exec(segment)
  return m === null ? null : `https://meet.google.com/${m[1]}-${m[2]}-${m[3]}`.toLowerCase()
}
