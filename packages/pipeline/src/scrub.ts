import { stripPasscode } from '@tm/core'

export const MEETING_LINK_REMOVED = '[meeting link removed]'
const CODE_REMOVED = '[removed]'
export const LINK_REMOVED = '[link removed]'

// The last character of a link: not trailing punctuation.
const END = `[^\\s.,;:!?)\\]'"<>]`
// Never start inside a word, a dotted name or an address (`you@school.zoom.us`).
const START = `(?<![\\w.@-])(?:https?:\\/\\/)?`
const SUBDOMAINS = `(?:[\\w-]+\\.)*`
// A link in running text: with a scheme, or starting `www.`.
const LINK_IN_TEXT = new RegExp(`(?:https?:\\/\\/|(?<![\\w.@-])www\\.)\\S*${END}`, 'gi')

// A trailing dot on a host is the same host: `us02web.zoom.us./j/1`.
const HOST_END = `(?:\\.(?=[/?#:]))?`
const PORT_PATH = `(?::\\d+)?(?:[/?#]\\S*${END})?`

// Every form of a meeting join link: Zoom (any link on zoom.us, *.zoom.us or zoomgov.com, and the zoommtg:// and
// zoomus:// schemes), Teams (any link on teams.microsoft.com, *.teams.microsoft.com or teams.live.com: join links
// come in many shapes) and Meet.
const MEETING_LINKS: RegExp[] = [
  new RegExp(`\\bzoom(?:mtg|us):\\/\\/\\S*${END}`, 'gi'),
  new RegExp(`${START}${SUBDOMAINS}(?:zoom\\.us|zoomgov\\.com)${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}${SUBDOMAINS}teams\\.microsoft\\.com${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}teams\\.live\\.com${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}meet\\.google\\.com\\/[\\w-]+(?:\\S*${END})?`, 'gi')
]
const ANY_URL = new RegExp(`https?:\\/\\/\\S*${END}`, 'gi')

const hasMeetingLink = (text: string): boolean => MEETING_LINKS.some((pattern) => text.search(pattern) !== -1)

// Decodes every %XX run (UTF-8); a malformed run becomes replacement characters instead of throwing.
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
    new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%'), (hex) => parseInt(hex, 16)))
  )
}

// A link whose query or fragment carries a percent-encoded join link (`?url=https%3A%2F%2Fzoom.us%2Fj%2F1`), even
// when it is encoded more than once.
function carriesMeetingLink(url: string): boolean {
  let text = url
  for (let round = 0; round < 3; round++) {
    const decoded = percentDecode(text)
    if (decoded === text) return false
    if (hasMeetingLink(decoded)) return true
    text = decoded
  }
  return false
}

// Spoken passcodes. The value is a token plus any further digit groups ("4 8 1 5 9 2"), or spelled-out digits
// ("one two three"). After a bare space the word must be followed by a digit-bearing token or spelled digits, so
// "password hashing" stays; after ':' '=' 'is' 'was' or a dash anything is a value. `[removed]` is never re-matched.
const PASS_WORD = `\\b(pass[ -]?code|password|pwd)\\b`
const DIGIT_WORD = `(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)`
const SPELLED = (min: number): string => `${DIGIT_WORD}(?:[\\s,.-]+${DIGIT_WORD}){${min},11}\\b`
const GROUPS = `(?:[ \\t]+\\d+){0,11}`
const PASSCODE_MARKED = new RegExp(
  `${PASS_WORD}(?:\\s*[:=]\\s*|\\s+[-\\u2013\\u2014]+\\s+|\\s*[\\u2013\\u2014]\\s*|\\s+(?:is|was)\\b\\s*[:=]?\\s*)` +
    `(?!\\[removed\\])(?:${SPELLED(0)}|\\S+${GROUPS})`,
  'gi'
)
const PASSCODE_BARE = new RegExp(`${PASS_WORD}\\s+(?:${SPELLED(1)}|(?=\\S*\\d)\\S+${GROUPS})`, 'gi')
const MEETING_ID_PHRASE = /\b(meeting\s*(?:id|number|code))\b\s*(?:is\s+)?[:#=]?\s*\d[\d \t-]*\d/gi

/**
 * Cuts everything that lets someone join the meeting: join links (also a join link percent-encoded inside another
 * link), passcodes (in a link or spoken or typed) and meeting IDs. Every other link keeps its place with any passcode
 * parameter removed. Safe to apply twice.
 */
export function scrub(text: string): string {
  // First, so a half-matched `...%252Fus02web.zoom.us...` cannot leave the rest of the encoded link behind.
  let out = text.replace(ANY_URL, (url) => (carriesMeetingLink(url) ? MEETING_LINK_REMOVED : url))
  for (const pattern of MEETING_LINKS) out = out.replace(pattern, MEETING_LINK_REMOVED)
  out = out.replace(ANY_URL, (url) => {
    const clean = stripPasscode(url)
    return clean === '' ? MEETING_LINK_REMOVED : clean
  })
  return out
    .replace(PASSCODE_MARKED, (_all, word: string) => `${word}: ${CODE_REMOVED}`)
    .replace(PASSCODE_BARE, (_all, word: string) => `${word}: ${CODE_REMOVED}`)
    .replace(MEETING_ID_PHRASE, (_all, label: string) => `${label}: ${CODE_REMOVED}`)
}

/** The links in a text: what `gateLinks` compares. A trailing dot, comma or bracket is not part of a link. */
export function linksIn(text: string): string[] {
  return text.match(LINK_IN_TEXT) ?? []
}

/**
 * Replaces every link in `text` that is not in `allowed` (exact match) with "[link removed]". Apply it to text that
 * is already scrubbed.
 */
export function gateLinks(text: string, allowed: ReadonlySet<string>): string {
  return text.replace(LINK_IN_TEXT, (url) => (allowed.has(url) ? url : LINK_REMOVED))
}

/** One line: every run of whitespace, line breaks included, becomes one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Stops a line of quoted text from reading as a Markdown heading, so it cannot forge a section. */
export function escapeHeadings(text: string): string {
  return text.replace(/^([ \t]*)#/gm, '$1\\#')
}
