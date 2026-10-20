export interface LocalParts {
  date: string // 2026-10-21
  hhmm: string // 2000
  hhmmss: string // 200000
  weekday: string // Wed
  dayMonthYear: string // 21 Oct 2026
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Formats a duration in milliseconds as HH:MM:SS, rounding down to whole seconds.
export function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':')
}

// Wall-clock parts of an instant in the given IANA zone. Never uses the process zone.
export function localParts(at: Date | string, timeZone: string): LocalParts {
  const instant = typeof at === 'string' ? new Date(at) : at
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant)

  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type)
    if (!part) throw new Error(`Intl did not return a ${type} part`)
    return part.value
  }

  const year = value('year')
  const month = value('month')
  const day = value('day')
  const hour = value('hour')
  const minute = value('minute')
  const second = value('second')

  return {
    date: `${year}-${month}-${day}`,
    hhmm: `${hour}${minute}`,
    hhmmss: `${hour}${minute}${second}`,
    weekday: value('weekday'),
    dayMonthYear: `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`
  }
}
