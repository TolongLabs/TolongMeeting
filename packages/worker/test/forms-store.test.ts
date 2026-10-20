import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleRecord } from '@tm/core/testing'
import { formEventData, loadFormRecords, saveFormRecord } from '../src/forms/store'

const rec = sampleRecord({
  formId: '0123456789abcdef',
  finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform?usp=pp_url&entry.1=Test%20Student',
  url: 'https://forms.gle/abc?entry.1=Test%20Student',
  sender: 'Classmate',
  senderRole: 'participant',
  source: 'meeting_chat',
  state: 'submitted',
  submittedAt: '2026-10-20T12:42:10.000Z'
})

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tm-forms-store-'))
}

test('saveFormRecord round-trips through loadFormRecords', async () => {
  const dir = await tempDir()
  await saveFormRecord(dir, rec)
  expect(await loadFormRecords(dir)).toEqual({ records: [rec], invalid: [] })
  expect(existsSync(join(dir, 'forms', rec.formId, 'record.json.tmp'))).toBe(false)
  await rm(dir, { recursive: true, force: true })
})

test('a restarted worker process loads the records the previous one wrote', async () => {
  const dir = await tempDir()
  await saveFormRecord(dir, rec)
  const storePath = join(import.meta.dir, '..', 'src', 'forms', 'store.ts')
  const script = `const { loadFormRecords } = await import(${JSON.stringify(storePath)});
    process.stdout.write(JSON.stringify(await loadFormRecords(${JSON.stringify(dir)})))`
  const proc = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  expect(err).toBe('')
  expect(code).toBe(0)
  expect(JSON.parse(out)).toEqual({ records: [rec], invalid: [] })
  await rm(dir, { recursive: true, force: true })
})

test('a failed write leaves the previous record in place', async () => {
  const dir = await tempDir()
  await saveFormRecord(dir, rec)
  // A directory where the temp file goes makes the write fail before the rename can replace record.json.
  await mkdir(join(dir, 'forms', rec.formId, 'record.json.tmp'))
  const next = { ...rec, state: 'failed' as const, reason: 'submit_failed' as const }
  await expect(saveFormRecord(dir, next)).rejects.toThrow()
  expect(await loadFormRecords(dir)).toEqual({ records: [rec], invalid: [] })
  await rm(dir, { recursive: true, force: true })
})

test('an unreadable record still counts as handled', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'forms', 'abcdef0123456789'), { recursive: true })
  await writeFile(join(dir, 'forms', 'abcdef0123456789', 'record.json'), 'not json')
  expect(await loadFormRecords(dir)).toEqual({
    records: [],
    invalid: ['abcdef0123456789']
  })
  await rm(dir, { recursive: true, force: true })
})

test('a record that fails the schema counts as handled', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'forms', rec.formId), { recursive: true })
  await writeFile(join(dir, 'forms', rec.formId, 'record.json'), JSON.stringify({ formId: rec.formId, state: 'nope' }))
  expect(await loadFormRecords(dir)).toEqual({ records: [], invalid: [rec.formId] })
  await rm(dir, { recursive: true, force: true })
})

test('a data directory with no forms yet loads as empty', async () => {
  const dir = await tempDir()
  expect(await loadFormRecords(dir)).toEqual({ records: [], invalid: [] })
  await rm(dir, { recursive: true, force: true })
})

test('saveFormRecord refuses a record that fails the schema', async () => {
  const dir = await tempDir()
  await expect(saveFormRecord(dir, { ...rec, state: 'nope' as never })).rejects.toThrow()
  expect(await readdir(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('formEventData names fields but never carries their values', async () => {
  const data = formEventData({
    ...rec,
    fieldsFilled: [
      {
        page: 1,
        question: 'Full name',
        detailKey: 'full_name',
        value: 'Test Student',
        via: 'label'
      },
      {
        page: 2,
        question: 'Declaration',
        detailKey: null,
        value: 'I confirm I am attending this class',
        via: 'confirmation'
      }
    ]
  })
  expect(data.fieldsFilled).toEqual(['full_name', 'attendance_confirmation'])
  expect(JSON.stringify(data)).not.toContain('Test Student')
  expect(JSON.stringify(data)).not.toContain('I confirm')
})

test('formEventData carries the record fields the forms table needs, with the query stripped from both URLs', () => {
  const data = formEventData(rec)
  expect(data).toEqual({
    formId: '0123456789abcdef',
    state: 'submitted',
    provider: 'google',
    source: 'meeting_chat',
    sender: 'Classmate',
    senderRole: 'participant',
    trustReason: null,
    reason: null,
    seenAt: rec.seenAt,
    submittedAt: '2026-10-20T12:42:10.000Z',
    url: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
    finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSf-x/viewform',
    fieldsFilled: []
  })
  expect(JSON.stringify(data)).not.toContain('Test')
  expect(JSON.stringify(data)).not.toContain('entry.1')
})

test('the store writes the record file as plain JSON of the record', async () => {
  const dir = await tempDir()
  await saveFormRecord(dir, rec)
  const text = await readFile(join(dir, 'forms', rec.formId, 'record.json'), 'utf8')
  expect(JSON.parse(text)).toEqual(rec)
  await rm(dir, { recursive: true, force: true })
})

const oldPing = { url: 'https://docs.google.com/forms/d/e/x/viewform', source: 'qr', state: 'needs_member' }

async function writeRaw(dir: string, formId: string, body: string | object): Promise<void> {
  await mkdir(join(dir, 'forms', formId), { recursive: true })
  await writeFile(join(dir, 'forms', formId, 'record.json'), typeof body === 'string' ? body : JSON.stringify(body))
}

test('loadFormRecords: a form dir with no record.json is absent, so a restart handles the form', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'forms', '1111111111111111'), { recursive: true })
  expect(await loadFormRecords(dir)).toEqual({ records: [], invalid: [] })
  await rm(dir, { recursive: true, force: true })
})

test('loadFormRecords: a 1A record is absent until its ping went out, then it counts as handled', async () => {
  const dir = await tempDir()
  const at = '2026-10-20T12:00:00.000Z'
  await writeRaw(dir, '4444444444444444', { ...oldPing, formId: '4444444444444444', pingedAt: at })
  await writeRaw(dir, '5555555555555555', { ...oldPing, formId: '5555555555555555', pingedAt: null, state: 'failed' })
  expect(await loadFormRecords(dir)).toEqual({ records: [], invalid: ['4444444444444444'] })
  await rm(dir, { recursive: true, force: true })
})

test('loadFormRecords: a record that is not JSON or matches neither shape counts as handled', async () => {
  const dir = await tempDir()
  await writeRaw(dir, '6666666666666666', 'not json')
  await writeRaw(dir, '7777777777777777', { unrelated: true })
  await writeRaw(dir, '8888888888888888', { ...oldPing, formId: '8888888888888888', pingedAt: 'not a date but set' })
  expect((await loadFormRecords(dir)).invalid).toEqual(['6666666666666666', '7777777777777777', '8888888888888888'])
  await rm(dir, { recursive: true, force: true })
})

test('loadFormRecords: a read error other than a missing file is thrown, not turned into a verdict', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'forms', '9999999999999999', 'record.json'), { recursive: true }) // EISDIR on read
  await expect(loadFormRecords(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  await rm(dir, { recursive: true, force: true })
})
