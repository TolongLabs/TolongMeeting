import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalFormUrl, FormRecordSchema, localParts, type FormRecord } from '@tm/core'

const NOT_SEEN = 'not seen'
const SEEN = 'a form was seen; check the meeting page'
const UNREADABLE = 'a form was seen but could not be read; check the meeting page'
const PROVIDER_NAME: Record<FormRecord['provider'], string> = { google: 'Google Forms', microsoft: 'Microsoft Forms' }
const WAITING = new Set<FormRecord['state']>(['needs_member', 'awaiting_signin', 'untrusted', 'failed'])

// A record that is missing, torn or not a FormRecord reads as null. Only its form directory is named in the log.
async function readRecord(formDir: string): Promise<FormRecord | null> {
  let raw: string
  try {
    raw = await readFile(join(formDir, 'record.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = FormRecordSchema.safeParse(json)
  if (!parsed.success) return null
  const record = parsed.data
  // A submitted form without its time cannot be shown as submitted at a time.
  if (record.state === 'submitted' && record.submittedAt === null) return null
  try {
    canonicalFormUrl(record.finalUrl)
  } catch {
    return null
  }
  return record
}

// The needs-you part. The link is the canonical page, never a pre-filled or direct-submit link.
function needsYou(record: FormRecord): string {
  const url = canonicalFormUrl(record.finalUrl)
  if (record.state === 'failed') {
    const why =
      record.reason === 'submit_unconfirmed'
        ? 'maybe submitted; check it'
        : `failed: ${record.reason ?? 'no reason recorded'}`
    return `needs you: ${url} (${why})`
  }
  if (record.state === 'awaiting_signin') return `needs you: ${url} (sign in again)`
  if (record.state === 'untrusted') return `needs you: ${url} (sender not trusted)`
  return `needs you: ${url}`
}

/**
 * The text after "Attendance: ", from the form records in `<dataDir>/forms/<formId>/record.json`. Parts are joined
 * with "; ": submitted (by time), already answered, then the forms that need the member (oldest first). A record that
 * cannot be read adds "a form was seen but could not be read"; "not seen" appears only when no form directory exists.
 * Quiz and not-attendance forms add no part, so a directory holding only those reads as "a form was seen".
 */
export async function attendanceLine(dataDir: string, timeZone: string): Promise<string> {
  const forms = join(dataDir, 'forms')
  const entries = await readdir(forms, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const dirs = entries.filter((e) => e.isDirectory())
  if (dirs.length === 0) return NOT_SEEN

  const records: FormRecord[] = []
  let unreadable = false
  for (const dir of dirs) {
    const record = await readRecord(join(forms, dir.name))
    if (record === null) {
      console.error(`tm-pipeline: forms/${dir.name}/record.json is unreadable and was skipped`)
      unreadable = true
    } else records.push(record)
  }

  const submitted = records.flatMap((r) =>
    r.state === 'submitted' && r.submittedAt !== null ? [{ r, at: r.submittedAt }] : []
  )
  submitted.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const answered = records.filter((r) => r.state === 'already_answered').sort(bySeen)
  const waiting = records.filter((r) => WAITING.has(r.state)).sort(bySeen)

  const parts = [
    ...submitted.map(({ r, at }) => `submitted at ${clock(at, timeZone)} (${PROVIDER_NAME[r.provider]}) ✓`),
    ...answered.map((r) => `already answered (${PROVIDER_NAME[r.provider]}) ✓`),
    ...waiting.map(needsYou)
  ]
  if (unreadable) parts.push(UNREADABLE)
  if (parts.length === 0) return SEEN
  return parts.join('; ')
}

function bySeen(a: FormRecord, b: FormRecord): number {
  return Date.parse(a.seenAt) - Date.parse(b.seenAt)
}

// "HH:MM" in the entry's time zone.
function clock(at: string, timeZone: string): string {
  const { hhmm } = localParts(at, timeZone)
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
}
