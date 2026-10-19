import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalFormUrl, FormRecordSchema, type FormRecord } from '@tm/core'

const ATTENDANCE_CONFIRMATION = 'attendance_confirmation'

function formDir(dataDir: string, formId: string): string {
  return join(dataDir, 'forms', formId)
}

// Writes the whole record to record.json.tmp, flushes it to disk, then renames it over record.json, so a reader
// sees either the old record or the new one.
export async function saveFormRecord(dataDir: string, rec: FormRecord): Promise<void> {
  const valid = FormRecordSchema.parse(rec)
  const dir = formDir(dataDir, valid.formId)
  const final = join(dir, 'record.json')
  const temp = `${final}.tmp`
  await mkdir(dir, { recursive: true })
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(valid, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, final)
}

// A form directory whose record cannot be read or fails the schema is reported as invalid. It still counts as
// handled, so the worker never submits that form again.
export async function loadFormRecords(dataDir: string): Promise<{ records: FormRecord[]; invalid: string[] }> {
  const forms = join(dataDir, 'forms')
  const entries = await readdir(forms, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const records: FormRecord[] = []
  const invalid: string[] = []
  const formIds = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const formId of formIds) {
    const raw = await readFile(join(forms, formId, 'record.json'), 'utf8').catch(() => null)
    const parsed = raw === null ? null : FormRecordSchema.safeParse(parseJson(raw))
    if (parsed?.success) {
      records.push(parsed.data)
    } else {
      invalid.push(formId)
    }
  }
  return { records, invalid }
}

// The event payload for the `form` event and the forms table. Field values never appear here, only the names of
// the fields filled; the URLs carry no query, so they can't leak prefilled answers.
export function formEventData(rec: FormRecord): Record<string, unknown> {
  const canonical = canonicalFormUrl(rec.finalUrl)
  return {
    formId: rec.formId,
    state: rec.state,
    provider: rec.provider,
    source: rec.source,
    sender: rec.sender,
    senderRole: rec.senderRole,
    trustReason: rec.trustReason,
    reason: rec.reason,
    seenAt: rec.seenAt,
    submittedAt: rec.submittedAt,
    url: canonical,
    finalUrl: canonical,
    fieldsFilled: rec.fieldsFilled.map((f) => f.detailKey ?? ATTENDANCE_CONFIRMATION)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
