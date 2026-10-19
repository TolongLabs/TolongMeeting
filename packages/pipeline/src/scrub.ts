import { stripPasscode } from '@tm/core'

export const MEETING_LINK_REMOVED = '[meeting link removed]'
const CODE_REMOVED = '[removed]'

// The last character of a link: not trailing punctuation.
const END = `[^\\s.,;:!?)\\]'"<>]`
// Never start inside a word, a dotted name or an address (`you@school.zoom.us`).
const START = `(?<![\\w.@-])(?:https?:\\/\\/)?`
const SUBDOMAINS = `(?:[\\w-]+\\.)*`

// Every form of a meeting join link: Zoom (any link on zoom.us, *.zoom.us or zoomgov.com, and the zoommtg:// and
// zoomus:// schemes), Teams (/l/meetup-join and /meet/<id>?p=) and Meet.
const MEETING_LINKS: RegExp[] = [
  new RegExp(`${START}${SUBDOMAINS}(?:zoom\\.us|zoomgov\\.com)(?::\\d+)?(?:[/?#]\\S*${END})?`, 'gi'),
  new RegExp(`\\bzoom(?:mtg|us):\\/\\/\\S*${END}`, 'gi'),
  new RegExp(`${START}${SUBDOMAINS}teams\\.microsoft\\.com\\/(?:l\\/meetup-join|meet)\\/\\S*${END}`, 'gi'),
  new RegExp(`${START}teams\\.live\\.com\\/meet\\/\\S*${END}`, 'gi'),
  new RegExp(`${START}meet\\.google\\.com\\/[\\w-]+(?:\\S*${END})?`, 'gi')
]
const ANY_URL = new RegExp(`https?:\\/\\/\\S*${END}`, 'gi')
// "passcode 123456", "password: abc", "pwd=xyz", "the passcode is 4 8 1 5 9 2": the word, an optional "is" or
// separator, the token and any spoken digit groups after it.
const PASSCODE_PHRASE = /\b(pass\s?code|password|pwd)\b(?:\s*[:=]\s*|\s+(?:is|was)\s+|\s+)\S+(?:[ \t]+\d+){0,7}/gi
const MEETING_ID_PHRASE = /\b(meeting\s*(?:id|number|code))\b\s*(?:is\s+)?[:#=]?\s*\d[\d \t-]*\d/gi

/**
 * Cuts everything that lets someone join the meeting: join links, passcodes (in a link or spoken or typed) and meeting
 * IDs. Every other link keeps its place with any passcode parameter removed. Safe to apply twice.
 */
export function scrub(text: string): string {
  let out = text
  for (const pattern of MEETING_LINKS) out = out.replace(pattern, MEETING_LINK_REMOVED)
  out = out.replace(ANY_URL, (url) => {
    const clean = stripPasscode(url)
    return clean === '' ? MEETING_LINK_REMOVED : clean
  })
  return out
    .replace(PASSCODE_PHRASE, (_all, word: string) => `${word}: ${CODE_REMOVED}`)
    .replace(MEETING_ID_PHRASE, (_all, label: string) => `${label}: ${CODE_REMOVED}`)
}

/** One line: every run of whitespace, line breaks included, becomes one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Stops a line of quoted text from reading as a Markdown heading, so it cannot forge a section. */
export function escapeHeadings(text: string): string {
  return text.replace(/^([ \t]*)#/gm, '$1\\#')
}
