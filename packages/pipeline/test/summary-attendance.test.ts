import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FormRecord } from '@tm/core'
import { sampleRecord } from '@tm/core/testing'
import { attendanceLine } from '../src/summary/attendance'
import { makeOccurrence, removeOccurrence, type Occurrence } from './helpers'

const tz = 'Asia/Kuala_Lumpur'
const GOOGLE = 'https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform'
const MICROSOFT = 'https://forms.office.com/r/AbC123'

let occ: Occurrence
let dataDir: string

beforeEach(async () => {
  occ = await makeOccurrence()
  dataDir = occ.dataDir
})
afterEach(async () => {
  await removeOccurrence(occ.root)
})

async function writeRecord(name: string, patch: Partial<FormRecord>): Promise<void> {
  const dir = join(dataDir, 'forms', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'record.json'), JSON.stringify(sampleRecord(patch)))
}

const google = { provider: 'google' as const, finalUrl: `${GOOGLE}?entry.1=Secret` }
const microsoft = { provider: 'microsoft' as const, finalUrl: `${MICROSOFT}?origin=lprLink` }

test('submitted forms, in time order, at the entry time zone', async () => {
  await writeRecord('m', { ...microsoft, state: 'submitted', submittedAt: '2026-10-20T13:05:00.000Z' })
  await writeRecord('g', { ...google, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' })
  expect(await attendanceLine(dataDir, tz)).toBe(
    'submitted at 20:42 (Google Forms) ✓; submitted at 21:05 (Microsoft Forms) ✓'
  )
  expect(await attendanceLine(dataDir, 'America/New_York')).toBe(
    'submitted at 08:42 (Google Forms) ✓; submitted at 09:05 (Microsoft Forms) ✓'
  )
})

test('a form that needs the member follows the submitted ones, and its link is the canonical page', async () => {
  await writeRecord('g', { ...google, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' })
  await writeRecord('n', { ...google, state: 'needs_member', seenAt: '2026-10-20T12:10:00.000Z' })
  const line = await attendanceLine(dataDir, tz)
  expect(line).toBe(`submitted at 20:42 (Google Forms) ✓; needs you: ${GOOGLE}`)
  expect(line).not.toContain('Secret')
})

test('already answered', async () => {
  await writeRecord('m', { ...microsoft, state: 'already_answered' })
  expect(await attendanceLine(dataDir, tz)).toBe('already answered (Microsoft Forms) ✓')
})

test.each([
  [{ state: 'awaiting_signin' as const }, `needs you: ${GOOGLE} (sign in again)`],
  [{ state: 'untrusted' as const }, `needs you: ${GOOGLE} (sender not trusted)`],
  [{ state: 'failed' as const, reason: 'fill_failed' as const }, `needs you: ${GOOGLE} (failed: fill_failed)`],
  [{ state: 'failed' as const, reason: null }, `needs you: ${GOOGLE} (failed: no reason recorded)`],
  [
    { state: 'failed' as const, reason: 'submit_unconfirmed' as const },
    `needs you: ${GOOGLE} (maybe submitted; check it)`
  ]
])('the waiting state %j reads as the brief says', async (patch, expected) => {
  await writeRecord('n', { ...google, ...patch })
  expect(await attendanceLine(dataDir, tz)).toBe(expected)
})

test('a Microsoft short link is cut to its canonical page', async () => {
  await writeRecord('m', { ...microsoft, state: 'needs_member' })
  expect(await attendanceLine(dataDir, tz)).toBe(`needs you: ${MICROSOFT}`)
})

test('every form that needs the member is listed, oldest first', async () => {
  await writeRecord('b', {
    ...google,
    state: 'needs_member',
    finalUrl: 'https://docs.google.com/forms/d/e/B/viewform',
    seenAt: '2026-10-20T12:20:00.000Z'
  })
  await writeRecord('c', {
    ...google,
    state: 'needs_member',
    finalUrl: 'https://docs.google.com/forms/d/e/C/viewform',
    seenAt: '2026-10-20T12:10:00.000Z'
  })
  await writeRecord('d', {
    ...google,
    state: 'needs_member',
    finalUrl: 'https://docs.google.com/forms/d/e/D/viewform',
    seenAt: '2026-10-20T12:30:00.000Z'
  })
  expect(await attendanceLine(dataDir, tz)).toBe(
    'needs you: https://docs.google.com/forms/d/e/C/viewform; needs you: https://docs.google.com/forms/d/e/B/viewform; needs you: https://docs.google.com/forms/d/e/D/viewform'
  )
})

test('quiz and not-attendance forms add no part, and their directory reads as seen, not as not seen', async () => {
  await writeRecord('q', { ...google, state: 'quiz' })
  await writeRecord('x', { ...google, state: 'not_attendance' })
  expect(await attendanceLine(dataDir, tz)).toBe('a form was seen; check the meeting page')
})

test('no form directory, or an empty one, is not seen', async () => {
  expect(await attendanceLine(dataDir, tz)).toBe('not seen')
  await mkdir(join(dataDir, 'forms'), { recursive: true })
  expect(await attendanceLine(dataDir, tz)).toBe('not seen')
})

test.each([
  ['torn JSON', '{"state": "needs_mem'],
  ['an empty file', ''],
  ['not a FormRecord', JSON.stringify({ state: 'needs_member', url: 'not a url' })],
  ['submitted without a time', JSON.stringify(sampleRecord({ state: 'submitted', submittedAt: null }))],
  ['a final URL that is not a URL', JSON.stringify(sampleRecord({ state: 'needs_member', finalUrl: 'not a url' }))]
])('a record that is %s is reported as unreadable, never as not seen', async (_label, raw) => {
  const dir = join(dataDir, 'forms', 't')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'record.json'), raw)
  expect(await attendanceLine(dataDir, tz)).toBe('a form was seen but could not be read; check the meeting page')
})

test('a directory with no record.json is reported as unreadable', async () => {
  await mkdir(join(dataDir, 'forms', 'empty'), { recursive: true })
  expect(await attendanceLine(dataDir, tz)).toBe('a form was seen but could not be read; check the meeting page')
})

test('an unreadable record beside a readable one is told last', async () => {
  await writeRecord('g', { ...google, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' })
  await mkdir(join(dataDir, 'forms', 'torn'), { recursive: true })
  await writeFile(join(dataDir, 'forms', 'torn', 'record.json'), '{')
  expect(await attendanceLine(dataDir, tz)).toBe(
    'submitted at 20:42 (Google Forms) ✓; a form was seen but could not be read; check the meeting page'
  )
})
