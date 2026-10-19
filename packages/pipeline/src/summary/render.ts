import { localParts, type JobConfig } from '@tm/core'
import { scrub } from '../scrub'
import type { Inventory, InventoryItem } from './inventory'

type Source = InventoryItem['source']

const SECTION_CAP = 5
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const RANK: Record<Source, number> = { slide: 0, lecturer_chat: 1, speech: 2 }
const SAYS: Record<Source, string> = { slide: 'slide says', lecturer_chat: 'chat says', speech: 'heard as' }
const NOTHING_TO_DO = 'nothing to do from this session'

// "Sun 1 Nov 2026" or "Sun 1 Nov 2026, 23:59" from "YYYY-MM-DD[Thh:mm]". The string has no zone, so it is read as
// UTC and the process zone cannot move the weekday.
function dateText(due: string): string {
  const [datePart, time] = due.split('T') as [string, string | undefined]
  const [year, month, day] = datePart.split('-').map(Number) as [number, number, number]
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  const date = `${weekday} ${day} ${MONTHS[month - 1]} ${year}`
  return time === undefined ? date : `${date}, ${time}`
}

/**
 * The due value from the highest-ranked source with a date (slide, lecturer chat, speech), and a note for every other
 * differing date, such as `heard as Sat 31 Oct 2026`.
 */
export function chooseDue(item: InventoryItem): { due: string | null; note: string | null } {
  const versions = [{ source: item.source, due: item.due }, ...item.conflicts]
  const dated = versions.filter((v): v is { source: Source; due: string } => v.due !== null)
  const best = dated.reduce<(typeof dated)[number] | null>(
    (top, v) => (top === null || RANK[v.source] < RANK[top.source] ? v : top),
    null
  )
  if (best === null) return { due: null, note: null }
  const notes = dated.filter((v) => v.due !== best.due).map((v) => `${SAYS[v.source]} ${dateText(v.due)}`)
  return { due: best.due, note: notes.length === 0 ? null : [...new Set(notes)].join('; ') }
}

// Join links and passcodes never reach the summary, whatever the model copied into an item.
function clean(text: string): string {
  return scrub(text).replace(/\s+/g, ' ').trim()
}

function itemLine(item: InventoryItem): string {
  const { due, note } = chooseDue(item)
  const parts = [due === null ? null : `due ${dateText(due)}`, note].filter((p) => p !== null)
  return parts.length === 0 ? clean(item.text) : `${clean(item.text)} (${parts.join('; ')})`
}

function byDue(a: InventoryItem, b: InventoryItem): number {
  const x = chooseDue(a).due
  const y = chooseDue(b).due
  if (x === y) return 0
  if (x === null) return 1
  if (y === null) return -1
  return x < y ? -1 : 1
}

function numbered(lines: string[]): string {
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n')
}

function titleLine(cfg: JobConfig, inv: Inventory): string {
  const { name, start, end, timeZone } = cfg.entry
  const from = localParts(start, timeZone)
  const to = localParts(end, timeZone)
  const clock = (hhmm: string): string => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
  const label = inv.sessionLabel === null || inv.sessionLabel.trim() === '' ? '' : `, ${clean(inv.sessionLabel)}`
  return `${name}${label} (${from.weekday} ${from.dayMonthYear}, ${clock(from.hhmm)} to ${clock(to.hhmm)})`
}

/**
 * The lecture summary. `attendance` is the text after "Attendance: "; null leaves the line out (work entries).
 * Sections: To do, What was covered, Announcements and More deadlines hold at most 5 items each, except that
 * More deadlines is uncapped; empty sections are left out.
 */
export function renderLectureSummary(
  inv: Inventory,
  ctx: { cfg: JobConfig; attendance: string | null; outDir: string; unreadSlides?: number[] }
): string {
  const actionable = inv.items.filter((i) => i.kind === 'deadline' || i.kind === 'task').sort(byDue)
  const notices = [...inv.items.filter((i) => i.kind === 'announcement'), ...inv.items.filter((i) => i.kind === 'link')]
  const nextUp = actionable.find((i) => chooseDue(i).due !== null)
  const doNext =
    nextUp !== undefined ? itemLine(nextUp) : inv.nextAction !== null ? clean(inv.nextAction) : NOTHING_TO_DO

  const todo = actionable.slice(0, SECTION_CAP)
  const announcements = notices.slice(0, SECTION_CAP)
  const more = [
    ...actionable.slice(SECTION_CAP),
    ...notices.slice(SECTION_CAP).filter((i) => chooseDue(i).due !== null)
  ]
  const covered = inv.covered.slice(0, SECTION_CAP).map(clean)

  const blocks = [titleLine(ctx.cfg, inv), `Do next: ${doNext}`]
  if (ctx.attendance !== null) blocks.push(`Attendance: ${ctx.attendance}`)
  if (todo.length > 0) blocks.push(`To do\n${numbered(todo.map(itemLine))}`)
  if (covered.length > 0) blocks.push(`What was covered\n${numbered(covered)}`)
  if (announcements.length > 0) blocks.push(`Announcements\n${numbered(announcements.map(itemLine))}`)
  if (more.length > 0) blocks.push(`More deadlines\n${numbered(more.map(itemLine))}`)
  const unread = ctx.unreadSlides ?? []
  if (unread.length > 0) {
    const numbers = unread.map((n) => String(n).padStart(2, '0')).join(', ')
    blocks.push(`Slide text could not be read for slide ${numbers}. Items on those slides may be missing.`)
  }
  blocks.push(`Details: transcript.md, slides.md and chat.md in ${ctx.outDir}`)
  return `${blocks.join('\n\n')}\n`
}
