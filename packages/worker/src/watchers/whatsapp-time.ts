export type DateOrder = 'dmy' | 'mdy'

export interface PrePlain {
  /** ISO 8601, UTC. */
  sentAt: string
  sender: string
  /** The time and date as WhatsApp shows them, e.g. `14:05, 21/10/2026`. */
  shown: string
}

// `[<time>, <date>] <sender>: `. The time is 24-hour or 12-hour with am/pm (a no-break space may precede it).
const PRE_PLAIN = /^\[((\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?, (\d{1,2})\/(\d{1,2})\/(\d{4}))\] (.+): $/i

/**
 * Reads a message's `data-pre-plain-text`. `offsetMinutes` is the page's offset east of UTC (`-getTimezoneOffset()`).
 * Returns null for anything else (a system notice) and for an impossible date or time.
 */
export function parseWhatsAppPrePlain(attr: string, order: DateOrder, offsetMinutes: number): PrePlain | null {
  const m = PRE_PLAIN.exec(attr)
  if (m === null) return null
  const [, shown, hh, mm, meridiem, first, second, yyyy, sender] = m
  let hour = Number(hh)
  const minute = Number(mm)
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0)
  }
  const [day, month] = order === 'dmy' ? [Number(first), Number(second)] : [Number(second), Number(first)]
  const local = Date.UTC(Number(yyyy), month - 1, day, hour, minute)
  const check = new Date(local)
  // Date.UTC rolls an impossible date over (31 February, hour 24): only a date that survives the round trip is real.
  if (
    check.getUTCFullYear() !== Number(yyyy) ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  )
    return null
  return { sentAt: new Date(local - offsetMinutes * 60_000).toISOString(), sender: sender!, shown: shown! }
}
