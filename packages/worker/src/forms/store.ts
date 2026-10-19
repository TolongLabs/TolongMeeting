import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalFormUrl, FormRecordSchema, type FormRecord } from '@tm/core'
import { z } from 'zod'

const ATTENDANCE_CONFIRMATION = 'attendance_confirmation'

// The fields of a 1A FormPingRecord that decide whether its ping went out. The rest is ours to trust.
const PingRecordSchema = z.object({
  formId: z.string().min(1),
  url: z.string().min(1),
  pingedAt: z.string().nullable()
})

function formDir(dataDir: string, formId: string): string {
  return join(dataDir, 'forms', formId)
}

// The sorted names of the directories under forms/. A missing forms/ is empty; any other read error is thrown.
async function formDirIds(dataDir: string): Promise<string[]> {
  const entries = await readdir(join(dataDir, 'forms'), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

// Replaces the file at `path` with `text`. The text goes to a temp file with a random suffix, is flushed, and is
// renamed over `path`; then the directory is flushed so the rename survives a crash. A reader sees the old file or the
// new one, and a failed write leaves the old file in place.
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (err) {
    // Best effort: the write error is the one to report, not a failed cleanup of its temp file.
    await rm(temp, { force: true }).catch(() => {})
    throw err
  }
  const dir = await open(dirname(path), 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
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
  const records: FormRecord[] = []
  const invalid: string[] = []
  for (const formId of await formDirIds(dataDir)) {
    const raw = await readFile(join(formDir(dataDir, formId), 'record.json'), 'utf8').catch(() => null)
    const parsed = raw === null ? null : FormRecordSchema.safeParse(parseJson(raw))
    if (parsed?.success) {
      records.push(parsed.data)
    } else {
      invalid.push(formId)
    }
  }
  return { records, invalid }
}

// The form ids an earlier run handled, for FormPinger.ready. A form counts as handled when a sent ping is recorded:
// - a 1B FormRecord, unless it is a failure with an empty pings log (it failed before any ping went out);
// - a 1A FormPingRecord whose pingedAt is set.
// A record that does not parse, or matches neither shape, also counts as handled: it cannot show whether a ping went
// out, and a repeated ping is the worse error. A form dir with no record.json was never recorded, so it is not
// handled and a restart pings it. Any other read error (EACCES, EIO) rejects: a form must not be skipped unseen.
export async function loadHandledFormIds(dataDir: string): Promise<string[]> {
  const handled: string[] = []
  for (const formId of await formDirIds(dataDir)) {
    const raw = await readRecordText(dataDir, formId)
    if (raw !== null && isHandled(parseJson(raw))) handled.push(formId)
  }
  return handled
}

// The text of a form's record.json, or null when there is no such file.
async function readRecordText(dataDir: string, formId: string): Promise<string | null> {
  try {
    return await readFile(join(formDir(dataDir, formId), 'record.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function isHandled(json: unknown): boolean {
  const form = FormRecordSchema.safeParse(json)
  if (form.success) return form.data.state !== 'failed' || form.data.pings.length > 0
  const ping = PingRecordSchema.safeParse(json)
  if (ping.success) return ping.data.pingedAt !== null
  return true
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
