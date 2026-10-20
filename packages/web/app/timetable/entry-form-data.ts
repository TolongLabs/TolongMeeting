import type { z } from 'zod'
import { identities, timetableEntries } from '../../db/schema'
import { maskedLink, type MaskedLink } from '../../lib/timetable'
import type { EntryFormValues } from './form-state'

type EntryRow = typeof timetableEntries.$inferSelect
type IdentityRow = typeof identities.$inferSelect

const text = (data: FormData, key: string): string => {
  const value = data.get(key)
  return typeof value === 'string' ? value : ''
}
const orUndefined = (value: string): string | undefined => (value.trim() === '' ? undefined : value)
const lines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

/**
 * The input `EntryInputSchema` expects, read from the entry form's fields. It does not validate: a field that is empty
 * or unknown is passed on as it is, so the schema reports it. `paused` is never sent, so a save keeps the entry's
 * paused setting.
 */
export function inputFromForm(data: FormData): unknown {
  const date = text(data, 'date')
  const repeatKind = text(data, 'repeatKind')
  const repeat =
    repeatKind === 'once'
      ? { kind: 'once', date }
      : repeatKind === 'weekly'
        ? { kind: 'weekly', days: data.getAll('days').map(Number), from: date }
        : undefined
  const linkKind = text(data, 'linkKind')
  const link =
    linkKind === 'keep'
      ? { kind: 'keep' }
      : linkKind === 'fixed'
        ? { kind: 'fixed', url: text(data, 'url') }
        : linkKind === 'chat'
          ? { kind: 'chat', app: text(data, 'chatApp'), chat: text(data, 'chat') }
          : linkKind === 'paste'
            ? { kind: 'paste' }
            : undefined
  return {
    id: orUndefined(text(data, 'id')),
    name: text(data, 'name'),
    type: text(data, 'type'),
    repeat,
    start: text(data, 'start'),
    end: text(data, 'end'),
    identityId: text(data, 'identityId'),
    link,
    trustedSenders: lines(text(data, 'trustedSenders')),
    transcription: orUndefined(text(data, 'transcription')),
    formDetails: {
      course_code: orUndefined(text(data, 'courseCode')),
      section: orUndefined(text(data, 'section')),
      lecturer: orUndefined(text(data, 'lecturer'))
    },
    attendanceKeywords: lines(text(data, 'keywords'))
  }
}

const FIELD_OF_DETAIL: Record<string, string> = {
  course_code: 'course-code',
  section: 'section',
  lecturer: 'lecturer'
}
const FIELD_OF_LINK: Record<string, string> = { url: 'link-url', chat: 'link-chat', app: 'link-app' }
const FIELD_OF_TOP: Record<string, string> = {
  name: 'name',
  type: 'type',
  start: 'start',
  end: 'end',
  identityId: 'identity',
  trustedSenders: 'trusted-senders',
  attendanceKeywords: 'keywords',
  transcription: 'transcription'
}
const PHRASE: Record<string, string> = {
  name: 'a name',
  start: 'a start time',
  end: 'an end time',
  'link-url': 'a meeting link',
  'link-chat': 'the chat',
  'course-code': 'a course code',
  section: 'a section',
  lecturer: 'a lecturer'
}

/** The id of the form field an issue belongs to, or `undefined` when it belongs to none. */
function fieldOf(path: PropertyKey[]): string | undefined {
  const [head, next] = path
  if (head === 'repeat') return next === undefined ? 'repeat-kind' : next === 'days' ? 'days' : 'date'
  if (head === 'link') return next === undefined ? 'link-kind' : FIELD_OF_LINK[String(next)]
  if (head === 'formDetails') return next === undefined ? undefined : FIELD_OF_DETAIL[String(next)]
  return typeof head === 'string' ? FIELD_OF_TOP[head] : undefined
}

/** The issue in plain words. Messages the schema wrote itself are kept; the library's defaults are replaced. */
function plain(issue: z.core.$ZodIssue, field: string): string {
  if (field === 'date') return 'Enter a real date, for example 2026-10-21.'
  if (field === 'identity') return 'Choose an identity.'
  if (field === 'repeat-kind') return 'Choose once or weekly.'
  if (field === 'link-kind') return 'Choose how to find the meeting link.'
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'array' ? 'Choose at least one day.' : `Enter ${PHRASE[field] ?? 'a value'}.`
    case 'too_big':
      return issue.origin === 'array'
        ? `Enter at most ${issue.maximum} lines.`
        : `Use at most ${issue.maximum} characters here.`
    case 'invalid_type':
    case 'invalid_value':
      return 'Choose one of the options.'
    default:
      return issue.message
  }
}

/** One message for each form field that has a problem (the first), by field id. Issues with no field are skipped. */
export function fieldErrors(issues: z.core.$ZodIssue[]): { fields: Record<string, string>; unplaced: string[] } {
  const fields: Record<string, string> = {}
  const unplaced: string[] = []
  for (const issue of issues) {
    const field = fieldOf(issue.path)
    if (field === undefined) unplaced.push(issue.message)
    else fields[field] ??= plain(issue, field)
  }
  return { fields, unplaced }
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** `Once on 2026-10-21` or `Every Monday and Wednesday from 2026-10-01`. */
export function describeRepeat(rule: EntryRow['repeat']): string {
  if (rule.kind === 'once') return `Once on ${rule.date}`
  const days = rule.days.map((d) => DAY_NAMES[d - 1]!)
  const joined = days.length < 2 ? days.join('') : `${days.slice(0, -1).join(', ')} and ${days.at(-1)}`
  return `Every ${joined} from ${rule.from}`
}

/** The link source in a few words, with no link, thread or passcode in it. */
export function describeLink(link: MaskedLink): string {
  if (link.kind === 'paste') return 'You paste the link'
  if (link.kind === 'chat') {
    const app = { whatsapp: 'WhatsApp', discord: 'Discord', teams: 'Teams' }[link.app]
    return `Watching a ${app} chat for the link`
  }
  return link.meetingId === null
    ? `Fixed link on ${link.host}`
    : `Fixed link on ${link.host}, meeting ${link.meetingId}`
}

/** Where an identity runs, in words. */
export function describeWhere(runLocation: IdentityRow['runLocation']): string {
  return {
    server: 'runs on the server',
    server_via_home: 'runs on the server, through your home connection',
    local: 'runs on your PC'
  }[runLocation]
}

/**
 * The form's starting values: a stored entry's, or the defaults for a new one. The stored link is never put in the
 * form: an edit starts at "keep the current link", and a typed link replaces it.
 */
export function entryFormValues(
  entry: EntryRow | null,
  fallback: { identityId: string; today: string }
): EntryFormValues {
  const blank: EntryFormValues = {
    id: '',
    name: '',
    type: 'lecture',
    repeatKind: 'weekly',
    date: fallback.today,
    days: [],
    start: '',
    end: '',
    identityId: fallback.identityId,
    linkKind: 'fixed',
    url: '',
    chatApp: 'whatsapp',
    chat: '',
    trustedSenders: '',
    courseCode: '',
    section: '',
    lecturer: '',
    keywords: '',
    transcription: 'live'
  }
  if (!entry) return blank
  const details = entry.formDetails
  return {
    ...blank,
    id: entry.id,
    name: entry.name,
    type: entry.type,
    repeatKind: entry.repeat.kind,
    date: entry.repeat.kind === 'once' ? entry.repeat.date : entry.repeat.from,
    days: entry.repeat.kind === 'weekly' ? entry.repeat.days.map(String) : [],
    start: entry.startTime.slice(0, 5),
    end: entry.endTime.slice(0, 5),
    identityId: entry.identityId,
    linkKind: 'keep',
    trustedSenders: entry.trustedSenders.join('\n'),
    courseCode: details.course_code ?? '',
    section: details.section ?? '',
    lecturer: details.lecturer ?? '',
    keywords: entry.attendanceKeywords.join('\n'),
    transcription: entry.transcription
  }
}

/** The stored link as the edit page may show it: host and meeting id only. */
export function currentLinkText(entry: EntryRow): string {
  return describeLink(maskedLink(entry))
}
