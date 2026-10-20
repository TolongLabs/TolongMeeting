import { stripPasscode } from '@tm/core'
import { LinkifyIt } from 'linkify-it'
import tlds from 'tlds'

export const MEETING_LINK_REMOVED = '[meeting link removed]'
const CODE_REMOVED = '[removed]'
export const LINK_REMOVED = '[link removed]'

// The last character of a link: not trailing punctuation.
const END = `[^\\s.,;:!?)\\]'"<>]`
// Never start inside a word, a dotted name or an address (`you@school.zoom.us`).
const START = `(?<![\\w.@-])(?:https?:\\/\\/)?`
const SUBDOMAINS = `(?:[\\w-]+\\.)*`

// `scrub` uses this to find the passcode parameter of a link with no scheme: dot-separated labels (letters of any
// script, digits, hyphens) ending in a TLD of 2 to 24 letters or an `xn--` punycode TLD. It is not the link gate;
// that is `linkSpans`, which asks linkify-it.
const LABEL = `[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?`
const TLD = `(?:xn--[a-z0-9-]{2,59}|\\p{L}{2,24})`
const BARE_URL =
  `(?<![\\p{L}\\p{N}_.@-])(?<host>(?:${LABEL}\\.)+(?<tld>${TLD}))(?![\\p{L}\\p{N}_@-])` +
  `(?<rest>(?::\\d{1,5})?(?:[/?#]\\S*${END})?)`
const BARE_ONLY = new RegExp(BARE_URL, 'giu')

// A trailing dot on a host is the same host: `us02web.zoom.us./j/1`.
const HOST_END = `(?:\\.(?=[/?#:]))?`
const PORT_PATH = `(?::\\d+)?(?:[/?#]\\S*${END})?`

// Every form of a meeting join link: Zoom (any link on zoom.us, *.zoom.us or zoomgov.com, and the zoommtg:// and
// zoomus:// schemes), Teams (any link on teams.microsoft.com, *.teams.microsoft.com or teams.live.com: join links
// come in many shapes, and the msteams: and ms-teams: schemes) and Meet (any link on meet.google.com, the g.co/meet
// short link and the tel.meet dial-in link, which carries a PIN).
const MEETING_LINKS: RegExp[] = [
  new RegExp(`\\bzoom(?:mtg|us):\\/\\/\\S*${END}`, 'gi'),
  new RegExp(`\\b(?:msteams|ms-teams):\\S*${END}`, 'gi'),
  new RegExp(`${START}${SUBDOMAINS}(?:zoom\\.us|zoomgov\\.com)${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}${SUBDOMAINS}teams\\.microsoft\\.com${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}teams\\.live\\.com${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}meet\\.google\\.com${HOST_END}${PORT_PATH}`, 'gi'),
  new RegExp(`${START}g\\.co${HOST_END}\\/meet(?:\\/\\S*${END}|(?![\\w-]))`, 'gi'),
  new RegExp(`${START}tel\\.meet${HOST_END}${PORT_PATH}`, 'gi')
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
// A Meet code (`abc-defg-hij`, also spoken as "abc defg hij") after a word that names it. Like a Zoom meeting ID, a
// code on its own is not found: `one-time-pad` has the same shape.
const MEET_CODE_PHRASE =
  /\b((?:(?:google\s+)?meet|meeting|join(?:ing)?|video\s*call)\s*(?:id|number|code))\b\s*(?:is\s+)?[:#=]?\s*[a-z]{3}[ \t-][a-z]{4}[ \t-][a-z]{3}\b/gi

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
// Whole tokens are tested, not a `\S*%xx\S*` pattern, which is quadratic on a long token with no escape.
function removeEncodedJoinLinks(text: string): string {
  return text.replace(/\S+/g, (token) => {
    if (!/%[0-9a-f]{2}/i.test(token)) return token
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
    .replace(MEET_CODE_PHRASE, (_all, label: string) => `${label}: ${CODE_REMOVED}`)
}

// Every IANA TLD (and `xn--` punycode, which linkify-it always accepts), bare hosts, IP addresses and emails.
const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: true, urlAuth: true }).tlds(tlds)

// Schemes whose links do something without `//`.
const DANGEROUS_SCHEMES =
  'javascript|data|vbscript|file|mailto|tel|sms|intent|geo|magnet|skype|callto|view-source|market|content|whatsapp|tg|ftp|' +
  'msteams|ms-teams|facetime|facetime-audio|sip|xmpp|bitcoin|smsto|mms|upi|maps|news'
// Any scheme followed by `//`; a dangerous scheme followed by anything; http(s) and its lookalikes (`hxxps`, `h**ps`,
// `https:evil.example`) followed by anything. `[:]` is a defanged colon.
const SCHEME_URL = new RegExp(
  `(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*\\[?:\\]?(?=\\/\\/)|h[tx*]{2}ps?\\[?:\\]?(?=\\S)|` +
    `(?<![\\p{L}\\p{N}])(?:${DANGEROUS_SCHEMES})\\[?:\\]?(?=\\S))\\S*${END}`,
  'giu'
)
// What can follow a host: a port, a path, a query, a fragment.
const HOST_TAIL = new RegExp(`(?::\\d{1,5})?(?:[/?#]\\S*${END})?`, 'uy')
const WWW_URL = new RegExp(`(?<![\\w.@-])www\\.\\S*${END}`, 'gi')

const PUNCTUATION = /[^\p{L}\p{N}\s]/u
const LETTER = /\p{L}/u
const DIGIT = /\p{N}/u

type Span = readonly [start: number, end: number]

// linkify-it only starts a link after a space or similar and ends it at a TLD followed by little else, so `.evil.com/x`,
// `wait...evil.com`, `v1.2.3.4`, `evil.com:8080`, `evil.com-x` and `evil.com.pdf` give nothing, where a phone's
// linkifier finds the host. So each word is also read as every piece that starts after a punctuation character or a
// letter-to-digit change (or at the start) and ends before a punctuation character (or at the end).
// Only a dot, colon, slash or `@` can make a link, so a word without one is skipped. A word over MAX_WORD characters
// is not scanned: with a dot, colon or slash it is one removed candidate, otherwise it is kept.
const MAX_WORD = 256
const LINK_MARK = /[.:/@\u3002\uFF61\uFF0E]/
// linkify-it finds no host whose label is over 63 characters, so for an alphanumeric run of 64 or more before a dot-TLD
// the last 63 characters are read too; a link found there begins where the whole run begins.
const LONG_LABEL = /[\p{L}\p{N}]{64,}(?=\.(?:xn--|\p{L}{2,}))/gu
const MAX_LABEL = 63

function linkifySpans(text: string): Span[] {
  const spans: Span[] = []
  const found = (piece: string, offset: number, origin?: number): void => {
    for (const m of linkify.match(piece) ?? []) {
      const start = origin !== undefined && m.index === 0 ? origin : offset + m.index
      spans.push([start, offset + m.lastIndex])
    }
  }
  found(text, 0)
  for (const word of text.matchAll(/\S+/gu)) {
    const [chars, base] = [word[0], word.index]
    if (!LINK_MARK.test(chars)) continue
    if (chars.length > MAX_WORD) {
      if (/[.:/]/.test(chars)) spans.push([base, base + chars.length])
      continue
    }
    const starts = [0]
    const ends = [chars.length]
    const origin = new Map<number, number>()
    for (const label of chars.matchAll(LONG_LABEL)) {
      const labelEnd = label.index + label[0].length
      starts.push(labelEnd - MAX_LABEL)
      origin.set(labelEnd - MAX_LABEL, label.index)
    }
    for (let i = 1; i < chars.length; i++) {
      if (PUNCTUATION.test(chars[i - 1]!) || (LETTER.test(chars[i - 1]!) && DIGIT.test(chars[i]!))) starts.push(i)
      if (PUNCTUATION.test(chars[i]!)) ends.push(i)
    }
    for (const start of starts)
      for (const end of ends) {
        if (end <= start) continue
        const from = origin.get(start)
        found(chars.slice(start, end), base + start, from === undefined ? undefined : base + from)
      }
  }
  return spans
}

/**
 * The links in a normalised text, as `[start, end)` spans. A span is a link candidate for the gate:
 * 1. whatever linkify-it finds (fuzzy links on any IANA TLD, IP addresses, emails, `//host`, `user:pass@host`),
 *    also behind punctuation, in the spellings `linkifySpans` covers;
 * 2. a scheme: any `name:` followed by `//`, a dangerous scheme (`SCHEME_URL`), the `hxxp` and `h**p` lookalikes;
 * 3. a name starting `www.`.
 * Overlapping candidates are one span, so a link cannot be split into pieces that each look harmless.
 */
function linkSpans(text: string): Span[] {
  const spans = linkifySpans(text).map(([start, end]): Span => {
    HOST_TAIL.lastIndex = end
    return [start, end + (HOST_TAIL.exec(text)?.[0].length ?? 0)]
  })
  for (const pattern of [SCHEME_URL, WWW_URL])
    for (const m of text.matchAll(pattern)) spans.push([m.index, m.index + m[0].length])
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1])
  const merged: [number, number][] = []
  for (const [start, end] of spans) {
    const last = merged.at(-1)
    if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** The links in a text: what `gateLinks` compares (see `linkSpans`). A trailing dot, comma or bracket is not part of a link. */
export function linksIn(text: string): string[] {
  return linkSpans(text).map(([start, end]) => text.slice(start, end))
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
  let out = ''
  let at = 0
  for (const [start, end] of linkSpans(text)) {
    out += text.slice(at, start) + (allowed.has(text.slice(start, end)) ? text.slice(start, end) : LINK_REMOVED)
    at = end
  }
  return out + text.slice(at)
}

/** One line: every run of whitespace, line breaks included, becomes one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Stops a line of quoted text from reading as a Markdown heading, so it cannot forge a section. */
export function escapeHeadings(text: string): string {
  return text.replace(/^([ \t]*)#/gm, '$1\\#')
}
