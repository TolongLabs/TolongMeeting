import { stripPasscode } from '@tm/core'

export const MEETING_LINK_REMOVED = '[meeting link removed]'
const CODE_REMOVED = '[removed]'
export const LINK_REMOVED = '[link removed]'

// The last character of a link: not trailing punctuation.
const END = `[^\\s.,;:!?)\\]'"<>]`
// Never start inside a word, a dotted name or an address (`you@school.zoom.us`).
const START = `(?<![\\w.@-])(?:https?:\\/\\/)?`
const SUBDOMAINS = `(?:[\\w-]+\\.)*`

// What the gate treats as a link in running text (see `gateLinks`):
// 1. a URL with a scheme: http(s) and lookalikes (`hxxps`, `h**ps`, `https:evil.example`), and ftp, file, data,
//    javascript, vbscript, mailto, tel, sms and intent;
// 2. a name starting `www.`;
// 3. a bare `host.tld[:port][/path][?query][#fragment]`: dot-separated labels (letters of any script, digits,
//    hyphens) ending in a TLD of 2 to 24 letters or an `xn--` punycode TLD. A TLD of digits never matches, so
//    `1.2.3` is not a host. A bare host with no port, path or query whose TLD is a well-known file extension that is
//    not a delegated TLD (`notes.pdf`, `index.html`, `app.js`) is a file name, not a link. An address with `@`
//    right after it (`john.doe@school.edu`) is an email address, not a host.
const SCHEMES = `(?:h[tx*]{2}ps?|ftp|file|data|javascript|vbscript|mailto|tel|sms|intent)`
const SCHEME_URL = `(?<![\\p{L}\\p{N}_-])${SCHEMES}\\[?:\\]?(?=\\S)\\S*${END}`
const WWW_URL = `(?<![\\w.@-])www\\.\\S*${END}`
const LABEL = `[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?`
const TLD = `(?:xn--[a-z0-9-]{2,59}|\\p{L}{2,24})`
const BARE_URL =
  `(?<![\\p{L}\\p{N}_.@-])(?<host>(?:${LABEL}\\.)+(?<tld>${TLD}))(?![\\p{L}\\p{N}_@-])` +
  `(?<rest>(?::\\d{1,5})?(?:[/?#]\\S*${END})?)`
const LINK_IN_TEXT = new RegExp(`${SCHEME_URL}|${WWW_URL}|${BARE_URL}`, 'giu')
const BARE_ONLY = new RegExp(BARE_URL, 'giu')
// Extensions of file names that are not delegated TLDs. (`.py`, `.md`, `.sh`, `.zip` and `.mov` are TLDs, so a bare
// `main.py` is a link unless a slide or the lecturer's chat carries it.)
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  `pdf doc docx ppt pptx xls xlsx csv txt rtf odt ods odp png jpg jpeg gif webp svg bmp mp3 mp4 wav json xml yaml yml
html htm css js jsx ts tsx java cpp ipynb tex log bak tmp sql toml lock env`.split(/\s+/)
)

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

// The name of a query pair, percent-decoded as a whole, so `pwd%3Dabc` reads as `pwd=abc`.
function pairName(pair: string): string {
  return percentDecode(pair).split('=')[0]!.toLowerCase()
}

// Cuts `pwd` and `passcode` pairs from the query of a link, also when the `=` is percent-encoded (`?pwd%3Dabc`).
function stripEncodedPasscode(link: string): string {
  const queryAt = link.indexOf('?')
  if (queryAt === -1) return link
  const hashAt = link.indexOf('#', queryAt)
  const query = link.slice(queryAt + 1, hashAt === -1 ? undefined : hashAt)
  const kept = query.split('&').filter((pair) => !['pwd', 'passcode'].includes(pairName(pair)))
  const base = link.slice(0, queryAt)
  return (kept.length > 0 ? `${base}?${kept.join('&')}` : base) + (hashAt === -1 ? '' : link.slice(hashAt))
}

// A token (a run without spaces) with a percent escape that carries a join link in its encoded part.
function removeEncodedJoinLinks(text: string): string {
  return text.replace(/\S*%[0-9a-f]{2}\S*/gi, (token) => {
    const [, core = token, tail = ''] = /^(.*?)([.,;:!?)\]'"<>]*)$/s.exec(token) ?? []
    return carriesMeetingLink(core) ? `${MEETING_LINK_REMOVED}${tail}` : token
  })
}

/**
 * Cuts everything that lets someone join the meeting: join links (also a join link percent-encoded inside another
 * link, with or without a scheme), passcodes (in a link, also percent-encoded, or spoken or typed) and meeting IDs.
 * Every other link keeps its place with any passcode parameter removed. Safe to apply twice.
 */
export function scrub(text: string): string {
  // First, so a half-matched `...%252Fus02web.zoom.us...` cannot leave the rest of the encoded link behind.
  let out = text.replace(ANY_URL, (url) => (carriesMeetingLink(url) ? MEETING_LINK_REMOVED : url))
  out = removeEncodedJoinLinks(out)
  for (const pattern of MEETING_LINKS) out = out.replace(pattern, MEETING_LINK_REMOVED)
  out = out.replace(ANY_URL, (url) => {
    const clean = stripPasscode(url)
    return clean === '' ? MEETING_LINK_REMOVED : stripEncodedPasscode(clean)
  })
  out = out.replace(BARE_ONLY, (bare) => stripEncodedPasscode(bare))
  return out
    .replace(PASSCODE_MARKED, (_all, word: string) => `${word}: ${CODE_REMOVED}`)
    .replace(PASSCODE_BARE, (_all, word: string) => `${word}: ${CODE_REMOVED}`)
    .replace(MEETING_ID_PHRASE, (_all, label: string) => `${label}: ${CODE_REMOVED}`)
}

type Groups = { tld?: string; rest?: string } | undefined

// A bare name like `notes.pdf`: a file extension that is no TLD, with no port, path or query.
function isFileName(groups: Groups): boolean {
  return groups?.tld !== undefined && groups.rest === '' && FILE_EXTENSIONS.has(groups.tld.toLowerCase())
}

/** The links in a text: what `gateLinks` compares (see `LINK_IN_TEXT`). A trailing dot, comma or bracket is not part of a link. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK_IN_TEXT)].filter((m) => !isFileName(m.groups)).map((m) => m[0])
}

/**
 * Normalises a model-written string so a link cannot hide in its spelling: NFKC (fullwidth letters become plain, so
 * `ｈｔｔｐｓ://` is `https://`), then invisible characters (zero-width, soft hyphen, BOM, bidi marks) are removed, a
 * defanged dot `[.]` becomes a dot and an ideographic full stop between host characters becomes a dot.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/\[\.\]|\(\.\)/g, '.')
    .replace(/(?<=[\p{L}\p{N}-])[\u3002\uFF61](?=[\p{L}\p{N}-])/gu, '.')
}

/**
 * Replaces every link in `text` that is not in `allowed` (exact match) with "[link removed]". Apply it to text that
 * is already normalised and scrubbed.
 */
export function gateLinks(text: string, allowed: ReadonlySet<string>): string {
  return text.replace(LINK_IN_TEXT, (url, ...rest) => {
    const groups = rest.at(-1) as Groups
    return allowed.has(url) || isFileName(groups) ? url : LINK_REMOVED
  })
}

/** One line: every run of whitespace, line breaks included, becomes one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Stops a line of quoted text from reading as a Markdown heading, so it cannot forge a section. */
export function escapeHeadings(text: string): string {
  return text.replace(/^([ \t]*)#/gm, '$1\\#')
}
