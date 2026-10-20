// Date and time values as the planner and the drivers share them: a date is `YYYY-MM-DD`, a time is `HH:MM` (24 hours).
// A widget that wants another format is written to and read back through DateFormat, so a locale that swaps day and
// month cannot turn one date into another without the read-back showing it.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK = /^(\d{2}):(\d{2})$/
// A format a widget names in its own placeholder, such as "Please input date (M/d/yyyy)" or "dd/MM/yyyy".
const FORMAT = /(y{4}|M{1,2}|d{1,2})([/.-])(y{4}|M{1,2}|d{1,2})\2(y{4}|M{1,2}|d{1,2})/

type Field = 'y' | 'M' | 'd'

export interface DateFormat {
  fields: [Field, Field, Field] // left to right
  padded: { M: boolean; d: boolean } // "MM" and "dd" write two digits, "M" and "d" as many as needed
  separator: string
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// `YYYY-MM-DD` of a real calendar day, else null.
export function isoDate(text: string): string | null {
  const m = ISO_DATE.exec(text)
  return m !== null && validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? text : null
}

// `HH:MM` of a real time of day, else null.
export function clockTime(text: string): string | null {
  const m = CLOCK.exec(text)
  return m !== null && Number(m[1]) < 24 && Number(m[2]) < 60 ? text : null
}

// The format a text date widget names in its placeholder. Null unless it names year, month and day exactly once each.
export function parseDateFormat(placeholder: string): DateFormat | null {
  const m = FORMAT.exec(placeholder)
  if (m === null) return null
  const tokens = [m[1]!, m[3]!, m[4]!]
  const fields = tokens.map((t) => t[0] as Field)
  if (new Set(fields).size !== 3) return null
  return {
    fields: fields as DateFormat['fields'],
    padded: { M: tokens.includes('MM'), d: tokens.includes('dd') },
    separator: m[2]!
  }
}

// Writes an ISO date the way the widget expects it.
export function formatDate(iso: string, format: DateFormat): string {
  const m = ISO_DATE.exec(iso)
  if (m === null || isoDate(iso) === null) throw new Error(`not a calendar date: ${iso}`)
  const part = { y: m[1]!, M: m[2]!, d: m[3]! }
  const shown = (field: Field) => (field === 'y' || format.padded[field] ? part[field] : String(Number(part[field])))
  return format.fields.map(shown).join(format.separator)
}

// Reads what the widget shows back to an ISO date; null when it is not a real date in that format.
export function parseDate(text: string, format: DateFormat): string | null {
  const pieces = text.trim().split(format.separator)
  if (pieces.length !== 3 || !pieces.every((p) => /^\d+$/.test(p))) return null
  const found: Record<Field, string> = { y: '', M: '', d: '' }
  format.fields.forEach((field, i) => (found[field] = pieces[i]!))
  if (found.y.length !== 4 || found.M.length > 2 || found.d.length > 2) return null
  const iso = `${found.y}-${found.M.padStart(2, '0')}-${found.d.padStart(2, '0')}`
  return isoDate(iso)
}

// Hour and minute inputs back to `HH:MM`; null when either is not a number of a real time.
export function joinTime(hour: string, minute: string): string | null {
  const h = hour.trim()
  const m = minute.trim()
  if (!/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m)) return null
  return clockTime(`${h.padStart(2, '0')}:${m.padStart(2, '0')}`)
}
