import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalFormUrl,
  FormRecordSchema,
  isFormPageUrl,
  isPlainHttpsUrl,
  localParts,
  type FormRecord
} from '@tm/core'

const NOT_SEEN = 'not seen'
const SEEN = 'a form was seen; check the meeting page'
const UNFINISHED = 'a form was left unfinished; check the meeting page'
const UNREADABLE = 'a form was seen but could not be read; check the meeting page'
const MAYBE_SUBMITTED = 'maybe submitted; check it'
const PROVIDER_NAME: Record<FormRecord['provider'], string> = { google: 'Google Forms', microsoft: 'Microsoft Forms' }
const NEEDS_YOU = new Set<FormRecord['state']>(['needs_member', 'awaiting_signin', 'untrusted', 'failed', 'submitting'])
const IN_FLIGHT = new Set<FormRecord['state']>([
  'detected',
  'resolving',
  'checking_trust',
  'opening',
  'inspecting',
  'filling'
])
const LIMIT = { needsYou: 5, submitted: 5, answered: 3 }

// A readable record with the canonical page of its link, the only link the summary prints.
interface Readable {
  record: FormRecord
  url: string
}

// The canonical page of a stored link, or null when the stored link is not a plain https form page.
function formPageLink(finalUrl: string): string | null {
  if (!isPlainHttpsUrl(finalUrl)) return null
  const url = canonicalFormUrl(finalUrl)
  return isFormPageUrl(url) ? url : null
}

// A record that is missing, torn, not a FormRecord or not a form page reads as null. Any read error does too.
async function readRecord(formDir: string): Promise<Readable | null> {
  let json: unknown
  try {
    json = JSON.parse(await readFile(join(formDir, 'record.json'), 'utf8'))
  } catch {
    return null
  }
  const parsed = FormRecordSchema.safeParse(json)
  if (!parsed.success) return null
  const record = parsed.data
  // A submitted form without its time cannot be shown as submitted at a time.
  if (record.state === 'submitted' && record.submittedAt === null) return null
  const url = formPageLink(record.finalUrl)
  return url === null ? null : { record, url }
}

// The needs-you part. The link is the canonical page, never a pre-filled or direct-submit link.
function needsYou({ record, url }: Readable): string {
  if (record.state === 'failed') {
    const maybe = record.reason === 'submit_unconfirmed' || record.reason === 'interrupted_submitting'
    return `needs you: ${url} (${maybe ? MAYBE_SUBMITTED : 'not submitted'})`
  }
  if (record.state === 'submitting') return `needs you: ${url} (${MAYBE_SUBMITTED})`
  if (record.state === 'awaiting_signin') return `needs you: ${url} (sign in again)`
  if (record.state === 'untrusted') return `needs you: ${url} (sender not trusted)`
  return `needs you: ${url}`
}

/**
 * The text after "Attendance: ", from the form records in `<dataDir>/forms/<formId>/record.json`. Parts are joined
 * with "; ": needs-you (oldest first, at most 5), one unfinished marker, one unreadable marker, submitted (by time, at
 * most 5), already answered (at most 3). A part beyond a cap becomes "(+N more)". One entry per canonical page: a form
 * already submitted or answered wins over a copy that still needs the member. A record that cannot be read, including
 * a symlinked entry, adds the unreadable marker and its URL is never printed. "not seen" appears only when no form
 * directory exists. Quiz and not-attendance forms add no part, so a directory holding only those reads as "a form was seen".
 */
export async function attendanceLine(dataDir: string, timeZone: string): Promise<string> {
  const forms = join(dataDir, 'forms')
  const names = await readdir(forms).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })

  let formCount = 0
  let unreadable = false
  const readable: Readable[] = []
  for (const name of names) {
    const dir = join(forms, name)
    // lstat: a symlink is not followed. A failed lstat is unreadable too.
    const stat = await lstat(dir).catch(() => null)
    if (stat !== null && !stat.isDirectory() && !stat.isSymbolicLink()) continue
    formCount++
    const record = stat?.isDirectory() ? await readRecord(dir) : null
    if (record === null) {
      console.error(`tm-pipeline: forms/${name} is unreadable and was skipped`)
      unreadable = true
    } else readable.push(record)
  }
  if (formCount === 0) return NOT_SEEN

  const unique = dedupe(readable)
  const submitted = unique.flatMap((x) =>
    x.record.state === 'submitted' && x.record.submittedAt !== null ? [{ x, at: x.record.submittedAt }] : []
  )
  submitted.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const answered = unique.filter((x) => x.record.state === 'already_answered').sort(bySeen)
  const needs = unique.filter((x) => NEEDS_YOU.has(x.record.state)).sort(bySeen)
  const unfinished = unique.some((x) => IN_FLIGHT.has(x.record.state))

  const parts = [
    ...capped(needs.map(needsYou), LIMIT.needsYou),
    ...(unfinished ? [UNFINISHED] : []),
    ...(unreadable ? [UNREADABLE] : []),
    ...capped(
      submitted.map(({ x, at }) => `submitted at ${clock(at, timeZone)} (${PROVIDER_NAME[x.record.provider]}) ✓`),
      LIMIT.submitted
    ),
    ...capped(
      answered.map((x) => `already answered (${PROVIDER_NAME[x.record.provider]}) ✓`),
      LIMIT.answered
    )
  ]
  if (parts.length === 0) return SEEN
  return parts.join('; ')
}

// One entry per canonical page. A form already submitted or answered beats a copy that still needs the member.
function dedupe(readable: Readable[]): Readable[] {
  const done = ({ record }: Readable): number =>
    record.state === 'submitted' || record.state === 'already_answered' ? 0 : 1
  const ordered = [...readable].sort((a, b) => done(a) - done(b) || bySeen(a, b))
  const seen = new Set<string>()
  return ordered.filter(({ url }) => {
    if (seen.has(url)) return false
    seen.add(url)
    return true
  })
}

// The first `limit` parts, then "(+N more)" for the rest.
function capped(parts: string[], limit: number): string[] {
  return parts.length <= limit ? parts : [...parts.slice(0, limit), `(+${parts.length - limit} more)`]
}

function bySeen(a: Readable, b: Readable): number {
  return Date.parse(a.record.seenAt) - Date.parse(b.record.seenAt)
}

// "HH:MM" in the entry's time zone.
function clock(at: string, timeZone: string): string {
  const { hhmm } = localParts(at, timeZone)
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
}
