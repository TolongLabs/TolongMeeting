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

function localTime(day: DateTime, hhmm: string): DateTime {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(hhmm)
  if (!match) throw new Error(`Not a time of day: ${hhmm}`)
  if (Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Not a time of day: ${hhmm}`)
  // `set` on a valid local day resolves a time inside a spring-forward gap to the first valid time after it, and a
  // time that happens twice in an autumn overlap to the first one.
  const at = day.set({ hour: Number(match[1]), minute: Number(match[2]), second: 0, millisecond: 0 })
  if (!at.isValid) throw new Error(`Not a time of day: ${hhmm}`)
  return at
}

/**
 * The sessions of a timetable entry that start after `now` and before `now + horizonDays`. Dates and times are the
 * wall clock of `timeZone`; an end at or before the start is on the next day.
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
    let end = localTime(day, e.endTime)
    if (end <= start) end = localTime(day.plus({ days: 1 }), e.endTime)
    const startMs = start.toMillis()
    if (startMs > now.getTime() && startMs < limit) slots.push({ start: start.toJSDate(), end: end.toJSDate() })
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

/** `Wed 21 Oct, 14:00` in the member's time zone. */
export function formatWhen(d: Date, timeZone: string): string {
  return DateTime.fromJSDate(d, { zone: timeZone }).setLocale('en-GB').toFormat('ccc d LLL, HH:mm')
}

/** `Wed 21 Oct` in the member's time zone. */
export function formatDay(d: Date, timeZone: string): string {
  return DateTime.fromJSDate(d, { zone: timeZone }).setLocale('en-GB').toFormat('ccc d LLL')
}
