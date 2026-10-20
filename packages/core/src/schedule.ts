import { DateTime } from 'luxon'
import type { RepeatRule } from './timetable'

export interface Slot {
  start: Date
  end: Date
}

export interface ClashSlot extends Slot {
  id: string
  /** The entry's creation time in milliseconds: the older entry wins a tie. */
  rank: number
}

const DAY_MS = 24 * 3_600_000

function parseTime(hhmm: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(hhmm)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Not a time of day: ${hhmm}`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/**
 * The instant of wall-clock `hhmm` on `day`, and how many milliseconds the wall clock was moved to reach it. `set` on a
 * valid local day resolves a time inside a spring-forward gap to the time shifted forward by the gap length, and a time
 * that happens twice in an autumn overlap to the first one.
 */
function localTime(day: DateTime, hhmm: string): { at: DateTime; shiftMs: number } {
  const { hour, minute } = parseTime(hhmm)
  const at = day.set({ hour, minute, second: 0, millisecond: 0 })
  if (!at.isValid) throw new Error(`Not a time of day: ${hhmm}`)
  const wall = (d: { year: number; month: number; day: number; hour: number; minute: number }) =>
    Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute)
  return { at, shiftMs: wall(at) - wall({ year: day.year, month: day.month, day: day.day, hour, minute }) }
}

/**
 * The sessions of a timetable entry that start after `now` and before `now + horizonDays`. Dates and times are the
 * wall clock of `timeZone`; an end written at or before the start is on the next day.
 */
export function expandEntry(
  e: { repeat: RepeatRule; startTime: string; endTime: string },
  timeZone: string,
  now: Date,
  horizonDays = 14
): Slot[] {
  const first = DateTime.fromJSDate(now, { zone: timeZone })
  if (!first.isValid) throw new Error(`Not a time zone: ${timeZone}`)
  const limit = now.getTime() + horizonDays * DAY_MS
  const slots: Slot[] = []
  // Decided on the written times, not on resolved instants: a gap or an overlap must not turn a 1 hour slot into 24.
  const toMinutes = (t: string) => parseTime(t).hour * 60 + parseTime(t).minute
  const endsNextDay = toMinutes(e.endTime) <= toMinutes(e.startTime)
  // One day either side of the window covers every local date whose session could start inside it.
  const days = Math.ceil(horizonDays) + 2
  for (let i = -1; i < days; i++) {
    const day = first.startOf('day').plus({ days: i })
    const date = day.toISODate()!
    const hit =
      e.repeat.kind === 'once'
        ? e.repeat.date === date
        : e.repeat.days.includes(day.weekday as 1) && date >= e.repeat.from
    if (!hit) continue
    const start = localTime(day, e.startTime)
    const end = localTime(endsNextDay ? day.plus({ days: 1 }) : day, e.endTime)
    const startMs = start.at.toMillis()
    let endMs = end.at.toMillis()
    // A start that a spring-forward gap pushed to or past an end that was not moved would give an empty or negative
    // slot: move the end by the same amount so the slot keeps its intended length.
    if (endMs <= startMs) endMs += start.shiftMs
    if (startMs > now.getTime() && startMs < limit) slots.push({ start: new Date(startMs), end: new Date(endMs) })
  }
  return slots
}

/**
 * Every pair of overlapping slots (`a.start < b.end && b.start < a.end`). The earlier start wins, then the lower rank,
 * then the lower id. A slot that loses to one slot can still be the winner of another pair.
 */
export function findClashes(slots: ClashSlot[]): { winner: string; loser: string }[] {
  const sorted = [...slots].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const clashes: { winner: string; loser: string }[] = []
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!
      const b = sorted[j]!
      // Sorted by start, so once `b` starts at or after `a` ends no later slot can overlap `a`.
      if (b.start >= a.end) break
      clashes.push({ winner: a.id, loser: b.id })
    }
  }
  return clashes
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Wed 21 Oct` in the member's time zone. Fixed English names: ICU locale data spells September `Sept` in places. */
export function formatDay(d: Date, timeZone: string): string {
  const t = DateTime.fromJSDate(d, { zone: timeZone })
  return `${WEEKDAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]}`
}

/** `Wed 21 Oct, 14:00` in the member's time zone. */
export function formatWhen(d: Date, timeZone: string): string {
  return `${formatDay(d, timeZone)}, ${DateTime.fromJSDate(d, { zone: timeZone }).toFormat('HH:mm')}`
}

/** `14:00` in the member's time zone. */
export function formatTime(d: Date, timeZone: string): string {
  return DateTime.fromJSDate(d, { zone: timeZone }).toFormat('HH:mm')
}

/** The member-facing page of one meeting: `<origin of PUBLIC_URL>/meetings/<occurrence id>`. */
export function meetingUrl(publicUrl: string, occurrenceId: string): string {
  return `${new URL(publicUrl).origin}/meetings/${encodeURIComponent(occurrenceId)}`
}
