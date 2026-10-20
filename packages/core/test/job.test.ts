import { test, expect } from 'bun:test'
import { JobConfigSchema, parseJob } from '../src/job'

const validJob = {
  occurrenceId: 'occ_2026-10-21_lecture-1',
  attempt: 1,
  entry: {
    name: 'CSC 101 Lecture',
    type: 'lecture',
    start: '2026-10-21T09:00:00+08:00',
    end: '2026-10-21T11:00:00+08:00',
    timeZone: 'Asia/Kuala_Lumpur',
    link: { kind: 'fixed', url: 'https://zoom.us/j/1234567890' },
    trustedSenders: ['Dr. Lim'],
    transcription: 'live',
    formDetails: { course_code: 'CSC101', section: 'A' },
    attendanceKeywords: ['attendance', 'kehadiran']
  },
  identity: {
    id: 'identity-1',
    name: 'Alice Tan',
    zoomGuestName: 'Alice Tan (Bot)',
    formProviders: ['google'],
    organisation: null
  },
  member: {
    id: 'member-1',
    displayName: 'Alice',
    mentionNames: ['Alice', 'Tan'],
    details: [{ key: 'student_id', value: 'A12345', labels: ['Matric No.'] }]
  },
  ai: {
    baseUrl: 'https://dashscope.example.com/compatible-mode/v1',
    apiKey: 'sk-test-key',
    asrUrl: 'wss://dashscope.example.com/asr',
    models: { summary: 'm-summary', vision: 'm-vision', formMatch: 'm-match', asr: 'm-asr' }
  },
  ntfy: { url: 'https://ntfy.example.com', topic: 'tm-alice', token: 'tk_test' },
  dataDir: '/data/occurrences/occ_2026-10-21_lecture-1',
  profileDir: '/data/profiles/identity-1',
  control: null
}

test('valid job parses; bad values are reported by path only', () => {
  expect(parseJob(validJob).entry.timeZone).toBe('Asia/Kuala_Lumpur')
  const bad = {
    ...validJob,
    ai: { ...validJob.ai, apiKey: '' },
    entry: { ...validJob.entry, timeZone: 'Mars/Base' }
  }
  expect(() => parseJob(bad)).toThrow(/ai\.apiKey.*entry\.timeZone|entry\.timeZone.*ai\.apiKey/s)
  let message = ''
  try {
    parseJob({
      ...validJob,
      ai: { ...validJob.ai, baseUrl: 'sk-secret-value' }
    })
  } catch (e) {
    message = String(e)
  }
  expect(message).toContain('ai.baseUrl')
  expect(message).not.toContain('sk-secret-value')
})

test('end after start, safe occurrence id, absolute dirs, wss asr url', () => {
  expect(() =>
    parseJob({
      ...validJob,
      entry: { ...validJob.entry, end: validJob.entry.start }
    })
  ).toThrow('entry.end')
  expect(() => parseJob({ ...validJob, occurrenceId: '../x' })).toThrow('occurrenceId')
  expect(() => parseJob({ ...validJob, dataDir: 'rel/dir' })).toThrow('dataDir')
  expect(() => parseJob({ ...validJob, ai: { ...validJob.ai, asrUrl: 'https://x' } })).toThrow('ai.asrUrl')
})

test('identity.organisation defaults to null and accepts an OrgConfig', () => {
  const { organisation: _omitted, ...identity } = validJob.identity
  expect(JobConfigSchema.parse({ ...validJob, identity }).identity.organisation).toBeNull()
  const org = { name: 'Example University', emailDomain: 'example.edu.my' }
  expect(
    JobConfigSchema.parse({ ...validJob, identity: { ...validJob.identity, organisation: org } }).identity.organisation
  ).toEqual(org)
  expect(() =>
    parseJob({ ...validJob, identity: { ...validJob.identity, organisation: { name: '', emailDomain: 'x' } } })
  ).toThrow('identity.organisation.name')
})
