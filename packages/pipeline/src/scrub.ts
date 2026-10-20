import { LinkifyIt } from 'linkify-it'
import tlds from 'tlds'

// The regex scrub (join links, passcodes, meeting IDs) lives in core so pings share it; this module keeps the
// linkify-it link gate on top of it.
export { MEETING_LINK_REMOVED, scrubMeetingDetails as scrub } from '@tm/core'
export const LINK_REMOVED = '[link removed]'

// The last character of a link: not trailing punctuation.
const END = `[^\\s.,;:!?)\\]'"<>]`

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
