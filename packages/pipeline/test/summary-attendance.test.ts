import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FormRecord } from '@tm/core'
import { sampleRecord } from '@tm/core/testing'
import { attendanceLine } from '../src/summary/attendance'
import { makeOccurrence, removeOccurrence, type Occurrence } from './helpers'

const tz = 'Asia/Kuala_Lumpur'
const GOOGLE = 'https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform'
const MICROSOFT = 'https://forms.office.com/r/AbC123'
const UNFINISHED = 'a form was left unfinished; check the meeting page'
const UNREADABLE = 'a form was seen but could not be read; check the meeting page'
const SEEN = 'a form was seen; check the meeting page'

let occ: Occurrence
let dataDir: string

beforeEach(async () => {
  occ = await makeOccurrence()
  dataDir = occ.dataDir
})
afterEach(async () => {
  await removeOccurrence(occ.root)
})

async function writeRecordAt(dir: string, patch: Partial<FormRecord>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'record.json'), JSON.stringify(sampleRecord(patch)))
}

function writeRecord(name: string, patch: Partial<FormRecord>): Promise<void> {
  return writeRecordAt(join(dataDir, 'forms', name), patch)
}

async function writeRaw(name: string, raw: string): Promise<void> {
  const dir = join(dataDir, 'forms', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'record.json'), raw)
}

const google = { provider: 'google' as const, finalUrl: `${GOOGLE}?entry.1=Secret` }
const microsoft = { provider: 'microsoft' as const, finalUrl: `${MICROSOFT}?origin=lprLink` }
const googleAt = (id: string) => `https://docs.google.com/forms/d/e/${id}/viewform`
const microsoftAt = (id: string) => `https://forms.office.com/r/${id}`

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

test('a form that needs the member comes before the submitted ones, and its link is the canonical page', async () => {
  await writeRecord('g', { ...google, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' })
  await writeRecord('n', {
    ...google,
    state: 'needs_member',
    finalUrl: `${googleAt('N')}?entry.1=Secret`,
    seenAt: '2026-10-20T12:10:00.000Z'
  })
  const line = await attendanceLine(dataDir, tz)
  expect(line).toBe(`needs you: ${googleAt('N')}; submitted at 20:42 (Google Forms) ✓`)
  expect(line).not.toContain('Secret')
})

test('already answered', async () => {
  await writeRecord('m', { ...microsoft, state: 'already_answered' })
  expect(await attendanceLine(dataDir, tz)).toBe('already answered (Microsoft Forms) ✓')
})

test.each([
  [{ state: 'awaiting_signin' as const }, `needs you: ${GOOGLE} (sign in again)`],
  [{ state: 'untrusted' as const }, `needs you: ${GOOGLE} (sender not trusted)`],
  [{ state: 'failed' as const, reason: 'fill_failed' as const }, `needs you: ${GOOGLE} (not submitted)`],
  [{ state: 'failed' as const, reason: 'submit_failed' as const }, `needs you: ${GOOGLE} (not submitted)`],
  [{ state: 'failed' as const, reason: null }, `needs you: ${GOOGLE} (not submitted)`],
  [
    { state: 'failed' as const, reason: 'submit_unconfirmed' as const },
    `needs you: ${GOOGLE} (maybe submitted; check it)`
  ],
  [
    { state: 'failed' as const, reason: 'interrupted_submitting' as const },
    `needs you: ${GOOGLE} (maybe submitted; check it)`
  ],
  [{ state: 'submitting' as const }, `needs you: ${GOOGLE} (maybe submitted; check it)`]
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

test.each(['detected', 'resolving', 'checking_trust', 'opening', 'inspecting', 'filling'] as const)(
  'a form left in %s reads as unfinished, with its URL never printed',
  async (state) => {
    await writeRecord('f', { ...google, state })
    expect(await attendanceLine(dataDir, tz)).toBe(UNFINISHED)
  }
)

test('the unfinished marker is one part, however many forms are unfinished', async () => {
  await writeRecord('f', { ...google, state: 'filling' })
  await writeRecord('g', { ...microsoft, state: 'opening' })
  expect(await attendanceLine(dataDir, tz)).toBe(UNFINISHED)
})

test('the order is needs you, unfinished, unreadable, submitted, already answered', async () => {
  await writeRecord('n', {
    ...google,
    state: 'needs_member',
    finalUrl: googleAt('N'),
    seenAt: '2026-10-20T12:10:00.000Z'
  })
  await writeRecord('f', { ...google, state: 'filling', finalUrl: googleAt('F') })
  await writeRaw('t', '{')
  await writeRecord('s', {
    ...google,
    state: 'submitted',
    finalUrl: googleAt('S'),
    submittedAt: '2026-10-20T12:42:10.000Z'
  })
  await writeRecord('a', { ...microsoft, state: 'already_answered', finalUrl: microsoftAt('ANS') })
  expect(await attendanceLine(dataDir, tz)).toBe(
    [
      `needs you: ${googleAt('N')}`,
      UNFINISHED,
      UNREADABLE,
      'submitted at 20:42 (Google Forms) ✓',
      'already answered (Microsoft Forms) ✓'
    ].join('; ')
  )
})

test('each group is capped, and the rest is counted', async () => {
  for (let i = 0; i < 7; i++) {
    await writeRecord(`n${i}`, {
      ...google,
      state: 'needs_member',
      finalUrl: googleAt(`N${i}`),
      seenAt: `2026-10-20T12:${10 + i}:00.000Z`
    })
    await writeRecord(`s${i}`, {
      ...microsoft,
      state: 'submitted',
      finalUrl: microsoftAt(`S${i}`),
      submittedAt: `2026-10-20T13:${10 + i}:00.000Z`
    })
  }
  for (let i = 0; i < 5; i++) {
    await writeRecord(`a${i}`, { ...microsoft, state: 'already_answered', finalUrl: microsoftAt(`A${i}`) })
  }
  const needs = [0, 1, 2, 3, 4].map((i) => `needs you: ${googleAt(`N${i}`)}`)
  const submitted = [0, 1, 2, 3, 4].map((i) => `submitted at 21:${10 + i} (Microsoft Forms) ✓`)
  expect(await attendanceLine(dataDir, tz)).toBe(
    [
      ...needs,
      '(+2 more)',
      ...submitted,
      '(+2 more)',
      'already answered (Microsoft Forms) ✓',
      'already answered (Microsoft Forms) ✓',
      'already answered (Microsoft Forms) ✓',
      '(+2 more)'
    ].join('; ')
  )
})

test('one entry per canonical page: a submitted copy wins over a copy that needs the member', async () => {
  await writeRecord('a', { ...google, state: 'needs_member' })
  await writeRecord('b', {
    ...google,
    state: 'submitted',
    finalUrl: `${GOOGLE}?usp=sf_link`,
    submittedAt: '2026-10-20T12:42:10.000Z'
  })
  expect(await attendanceLine(dataDir, tz)).toBe('submitted at 20:42 (Google Forms) ✓')
})

test('two copies of a form that needs the member are listed once', async () => {
  await writeRecord('a', { ...google, state: 'needs_member' })
  await writeRecord('b', { ...google, state: 'needs_member', finalUrl: `${GOOGLE}?usp=sf_link` })
  expect(await attendanceLine(dataDir, tz)).toBe(`needs you: ${GOOGLE}`)
})

test('quiz and not-attendance forms add no part, and their directory reads as seen, not as not seen', async () => {
  await writeRecord('q', { ...google, state: 'quiz' })
  await writeRecord('x', { ...google, state: 'not_attendance' })
  expect(await attendanceLine(dataDir, tz)).toBe(SEEN)
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
  await writeRaw('t', raw)
  expect(await attendanceLine(dataDir, tz)).toBe(UNREADABLE)
})

test.each([
  ['an http link', 'http://docs.google.com/forms/d/e/1FAIpQLSabc/viewform'],
  ['a link with a port', 'https://docs.google.com:8443/forms/d/e/1FAIpQLSabc/viewform'],
  ['a javascript: link', 'javascript:alert(1)'],
  ['a link with userinfo', 'https://user:pw@docs.google.com/forms/d/e/1FAIpQLSabc/viewform'],
  ['a link on another host', 'https://example.com/forms/d/e/1FAIpQLSabc/viewform'],
  ['a Google Drive page', 'https://docs.google.com/drive/x'],
  ['a 400-character form URL', `https://forms.office.com/r/${'a'.repeat(400)}`]
])('a record with %s is unreadable, and its URL is never printed', async (_label, finalUrl) => {
  await writeRecord('n', { state: 'needs_member', finalUrl })
  expect(await attendanceLine(dataDir, tz)).toBe(UNREADABLE)
})

test('a directory with no record.json is reported as unreadable', async () => {
  await mkdir(join(dataDir, 'forms', 'empty'), { recursive: true })
  expect(await attendanceLine(dataDir, tz)).toBe(UNREADABLE)
})

test('a record.json that cannot be read as a file is reported as unreadable', async () => {
  await mkdir(join(dataDir, 'forms', 'd', 'record.json'), { recursive: true })
  expect(await attendanceLine(dataDir, tz)).toBe(UNREADABLE)
})

test('a symlinked form entry is not followed, and reads as unreadable', async () => {
  await writeRecordAt(join(dataDir, 'elsewhere', 'g'), {
    ...google,
    state: 'submitted',
    submittedAt: '2026-10-20T12:42:10.000Z'
  })
  await mkdir(join(dataDir, 'forms'), { recursive: true })
  await symlink(join(dataDir, 'elsewhere', 'g'), join(dataDir, 'forms', 'link'), 'dir')
  expect(await attendanceLine(dataDir, tz)).toBe(UNREADABLE)
})

test('an unreadable record beside a readable one is reported before the submitted forms', async () => {
  await writeRecord('g', { ...google, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' })
  await writeRaw('torn', '{')
  expect(await attendanceLine(dataDir, tz)).toBe(`${UNREADABLE}; submitted at 20:42 (Google Forms) ✓`)
})
