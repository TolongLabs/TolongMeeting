import { isPlainHttpsUrl, unwrapLink, type ChatMessage } from '@tm/core'
import { adapterFor } from '../adapters'

export type WatchPhase = 'before' | 'during'

// [min, max] in milliseconds, both inclusive.
export const POLL_MS = {
  before: [25_000, 45_000],
  during: [12_000, 25_000]
} as const

const CONTROL_CHARACTERS = /\p{Cc}/u

export function nextPollDelayMs(phase: WatchPhase, random: () => number): number {
  const [min, max] = POLL_MS[phase]
  return min + Math.floor(random() * (max - min + 1))
}

// A link the member pasted beats one a watcher found.
export function chooseMeetingLink(watched: string | null, pasted: string | null): string | null {
  return pasted ?? watched
}

/**
 * Splits the links of one chat message. Safe Links and Google redirect wrappers are peeled first (core `unwrapLink`),
 * so the host that is checked is the real one. Only plain https links (no port, no userinfo, no control characters)
 * are kept, without duplicates and in message order. `meeting` holds the links a platform adapter accepts (so the
 * adapter's own link rule decides), `other` the rest; whether an `other` link is a form is decided later, by the form
 * intake.
 */
export function splitLinks(m: ChatMessage): { meeting: string[]; other: string[] } {
  const meeting: string[] = []
  const other: string[] = []
  const seen = new Set<string>()
  for (const raw of m.links) {
    const link = unwrapLink(raw.trim())
    if (seen.has(link) || CONTROL_CHARACTERS.test(link) || !isPlainHttpsUrl(link)) continue
    seen.add(link)
    if (adapterFor(link) !== null) meeting.push(link)
    else other.push(link)
  }
  return { meeting, other }
}

// Changes when the message is edited to carry a different set of links. The links are not logged by callers.
export function messageSignature(m: ChatMessage): string {
  return `${m.key}|${[...m.links].sort().join(' ')}`
}
