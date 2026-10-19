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

test('the store writes the same record file the pinger reads', async () => {
  const dir = await tempDir()
  await saveFormRecord(dir, rec)
  const text = await readFile(join(dir, 'forms', rec.formId, 'record.json'), 'utf8')
  expect(JSON.parse(text)).toEqual(rec)
  await rm(dir, { recursive: true, force: true })
})
