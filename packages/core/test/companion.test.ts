import { describe, expect, test } from 'bun:test'
import {
  COMPANION_JOB_KINDS,
  COMPANION_JOB_STATES,
  CompanionEventEnvelopeSchema,
  CompanionEventSchema,
  CompanionJobSchema,
  JOB_LEASE_MS,
  JobFailureReportSchema,
  LocalIdentitiesResponseSchema,
  LocalRunPayloadSchema,
  LocalSecretsSchema,
  NATIVE_MAX_ATTEMPTS,
  NativeJobPayloadSchema,
  PC_CLAIM_GRACE_MS,
  PairRequestSchema,
  PairResponseSchema,
  PreflightReportSchema,
  RUN_LOCATIONS,
  RunLocationChoiceSchema,
  SummaryListItemSchema,
  WhisperJsonSchema,
  parseJob,
  shortDate,
  shortTime
} from '../src'

const ntfy = { url: 'https://ntfy.example', topic: 't', token: 'x' }
const native = {
  occurrenceId: 'occ_1',
  entryName: 'CS6013: AI/ML?',
  start: '2026-10-21T14:00:00+08:00',
  timeZone: 'Asia/Kuala_Lumpur',
  durationSec: 3600,
  flacBytes: 120_000_000
}
const job = {
  occurrenceId: 'occ_1',
  attempt: 1,
  entry: {
    name: 'Data Mining',
    type: 'lecture',
    start: '2026-10-21T14:00:00+08:00',
    end: '2026-10-21T16:00:00+08:00',
    timeZone: 'Asia/Kuala_Lumpur',
    link: { kind: 'paste' },
    trustedSenders: [],
    transcription: 'live',
    formDetails: {},
    attendanceKeywords: []
  },
  identity: { id: 'i1', name: 'Alice', zoomGuestName: 'Alice', formProviders: ['google'], organisation: null },
  member: { id: 'm1', displayName: 'Alice', mentionNames: [] },
  ai: {
    baseUrl: 'https://ai.example/v1',
    asrUrl: 'wss://ai.example/asr',
    models: { summary: 'a', vision: 'b', formMatch: 'c', asr: 'd' }
  },
  ntfy: { url: 'https://ntfy.example', topic: 't' },
  dataDir: '/data/occ_1',
  profileDir: '/profiles/i1'
}
const local = { occurrenceId: 'occ_1', identityId: 'i1', identityName: 'Alice', image: 'ghcr.io/org/worker:1', job }

describe('timings and formatting', () => {
  test('shortDate formats in the member time zone', () => {
    expect(shortDate('2026-10-21T14:00:00+08:00', 'Asia/Kuala_Lumpur')).toBe('Wed 21 Oct')
    expect(shortDate('2026-10-21T23:30:00Z', 'Asia/Kuala_Lumpur')).toBe('Thu 22 Oct')
    expect(shortTime('2026-10-21T06:05:00Z', 'Asia/Kuala_Lumpur')).toBe('14:05')
  })
  test('pinned companion timings', () => {
    expect(JOB_LEASE_MS).toBe(300_000)
    expect(PC_CLAIM_GRACE_MS).toBe(120_000)
    expect(NATIVE_MAX_ATTEMPTS).toBe(2)
  })
  test('database-facing value lists', () => {
    expect([...RUN_LOCATIONS]).toEqual(['server', 'server_via_home', 'local'])
    expect([...COMPANION_JOB_KINDS]).toEqual(['native_transcription', 'local_run'])
    expect([...COMPANION_JOB_STATES]).toEqual(['pending', 'claimed', 'done', 'failed', 'cancelled'])
  })
})

describe('commands and events', () => {
  test('only known commands parse', () => {
    expect(CompanionEventSchema.parse({ id: 7, command: { type: 'job_available', jobId: 'j1' } }).id).toBe(7)
    expect(CompanionEventSchema.parse({ id: 9, command: { type: 'local_identities_changed' } }).id).toBe(9)
    expect(CompanionEventSchema.parse({ id: 10, command: { type: 'open_signin', identityId: 'i1' } }).id).toBe(10)
    expect(() => CompanionEventSchema.parse({ id: 8, command: { type: 'run', cmd: 'calc' } })).toThrow()
  })
  test('commands refuse extra keys, bad ids and bad event ids', () => {
    expect(() =>
      CompanionEventSchema.parse({ id: 1, command: { type: 'job_available', jobId: 'j1', cmd: 'calc' } })
    ).toThrow()
    expect(() => CompanionEventSchema.parse({ id: 1, command: { type: 'job_available', jobId: '../x' } })).toThrow()
    expect(() => CompanionEventSchema.parse({ id: 0, command: { type: 'local_identities_changed' } })).toThrow()
    expect(() => CompanionEventSchema.parse({ id: 1.5, command: { type: 'local_identities_changed' } })).toThrow()
  })
  test('the envelope keeps the id of a command from a newer server', () => {
    const e = CompanionEventEnvelopeSchema.parse({ id: 12, command: { type: 'brand_new', x: 1 } })
    expect(e.id).toBe(12)
    expect(CompanionEventSchema.safeParse(e).success).toBe(false)
  })
})

describe('pairing', () => {
  test('a pair response needs a tmd_ token', () => {
    const ok = { deviceId: 'd', token: 'tmd_abc', ntfy, pairedAt: '2026-10-21T00:00:00Z' }
    expect(PairResponseSchema.parse(ok).token).toBe('tmd_abc')
    expect(() => PairResponseSchema.parse({ ...ok, token: 'abc' })).toThrow()
    expect(() => PairResponseSchema.parse({ ...ok, extra: 1 })).toThrow()
  })
  test('a pair request bounds the code and the device name', () => {
    expect(PairRequestSchema.parse({ code: 'ABCD-1234', deviceName: '  DESKTOP-ABC ' }).deviceName).toBe('DESKTOP-ABC')
    for (const bad of [
      { code: 'AB', deviceName: 'pc' },
      { code: 'A'.repeat(33), deviceName: 'pc' },
      { code: 'ABCD-1234', deviceName: '' },
      { code: 'ABCD-1234', deviceName: 'x'.repeat(65) },
      { code: 'ABCD-1234', deviceName: 'pc\u0000' },
      { code: 'ABCD-1234', deviceName: 'pc\n2' },
      { code: 'ABCD-1234', deviceName: 'pc', admin: true }
    ]) {
      expect(() => PairRequestSchema.parse(bad)).toThrow()
    }
  })
})

describe('jobs', () => {
  test('a native job and a local job parse by kind', () => {
    const base = { id: 'j1', state: 'pending', occurrenceId: 'occ_1', attempts: 0 }
    expect(CompanionJobSchema.parse({ ...base, kind: 'native_transcription', payload: native }).kind).toBe(
      'native_transcription'
    )
    expect(CompanionJobSchema.parse({ ...base, kind: 'local_run', payload: local }).kind).toBe('local_run')
    expect(() => CompanionJobSchema.parse({ ...base, kind: 'local_run', payload: native })).toThrow()
    expect(() => CompanionJobSchema.parse({ ...base, kind: 'format_disk', payload: native })).toThrow()
    expect(() =>
      CompanionJobSchema.parse({ ...base, state: 'running', kind: 'native_transcription', payload: native })
    ).toThrow()
  })
  test('a native payload is bounded', () => {
    expect(NativeJobPayloadSchema.parse(native).flacBytes).toBe(120_000_000)
    for (const bad of [
      { ...native, timeZone: 'Mars/Base' },
      { ...native, start: 'tomorrow' },
      { ...native, durationSec: 0 },
      { ...native, durationSec: 86_401 },
      { ...native, flacBytes: -1 },
      { ...native, flacBytes: 1.5 },
      { ...native, entryName: 'x'.repeat(301) },
      { ...native, entryName: 'a\u0007b' },
      { ...native, occurrenceId: '../etc' },
      { ...native, extra: true }
    ]) {
      expect(() => NativeJobPayloadSchema.parse(bad)).toThrow()
    }
  })
  test('a local payload carries a template without secrets', () => {
    expect(LocalRunPayloadSchema.parse(local).job.ai).not.toHaveProperty('apiKey')
    expect(() =>
      LocalRunPayloadSchema.parse({ ...local, job: { ...job, ai: { ...job.ai, apiKey: 'sk-x' } } })
    ).toThrow()
    expect(() => LocalRunPayloadSchema.parse({ ...local, job: { ...job, control: null } })).toThrow()
    expect(() => LocalRunPayloadSchema.parse({ ...local, image: 'x y; rm -rf /' })).toThrow()
  })
  test('a template plus secrets, ntfy token and relay is a valid job config', () => {
    const t = LocalRunPayloadSchema.parse(local).job
    const cfg = parseJob({
      ...t,
      member: { ...t.member, details: [] },
      ai: { ...t.ai, apiKey: 'sk-x' },
      ntfy: { ...t.ntfy, token: 'tk' },
      control: null
    })
    expect(cfg.ai.apiKey).toBe('sk-x')
  })
  test('secrets, failure reports and preflight reports are bounded', () => {
    expect(LocalSecretsSchema.parse({ apiKey: 'sk-x', details: [{ key: 'id', value: '1', labels: [] }] }).apiKey).toBe(
      'sk-x'
    )
    expect(() => LocalSecretsSchema.parse({ apiKey: '', details: [] })).toThrow()
    expect(JobFailureReportSchema.parse({ error: 'whisper exited 1' }).error).toBe('whisper exited 1')
    expect(() => JobFailureReportSchema.parse({ error: 'x'.repeat(1001) })).toThrow()
    expect(() => JobFailureReportSchema.parse({ error: '' })).toThrow()
    expect(PreflightReportSchema.parse({ reason: 'docker_memory_low', dockerMemBytes: 2_000_000_000 }).reason).toBe(
      'docker_memory_low'
    )
    expect(() => PreflightReportSchema.parse({ reason: 'weird', dockerMemBytes: null })).toThrow()
    expect(() => PreflightReportSchema.parse({ reason: 'ok', dockerMemBytes: -1 })).toThrow()
  })
})

describe('whisper JSON', () => {
  test('keeps start, end and text and passes other keys through', () => {
    const j = WhisperJsonSchema.parse({
      text: 'Hi',
      language: 'en',
      segments: [{ id: 0, start: 0.5, end: 1.25, text: ' Hi', tokens: [1] }]
    })
    expect(j.segments[0]).toMatchObject({ start: 0.5, end: 1.25, text: ' Hi' })
    expect(j).toMatchObject({ language: 'en' })
    expect(() => WhisperJsonSchema.parse({ segments: [{ start: 'x' }] })).toThrow()
    expect(() => WhisperJsonSchema.parse({ segments: [{ start: -1, end: 1, text: 'a' }] })).toThrow()
    expect(() => WhisperJsonSchema.parse({ segments: [{ start: 0, end: Infinity, text: 'a' }] })).toThrow()
    expect(() => WhisperJsonSchema.parse({})).toThrow()
  })
})

describe('summaries, run locations', () => {
  test('a summary item needs a bounded file name and a timestamp', () => {
    const item = { occurrenceId: 'occ_1', fileName: '2026-10-21 1400 Data Mining.md', readyAt: '2026-10-21T08:00:00Z' }
    expect(SummaryListItemSchema.parse(item).fileName).toBe(item.fileName)
    expect(() => SummaryListItemSchema.parse({ ...item, fileName: '' })).toThrow()
    for (const fileName of [
      'evil.bat',
      'a.cmd',
      'a.vbs',
      'a.js',
      'a.hta',
      'a.lnk',
      'a.url',
      'a.scr',
      'noext',
      'a.md.exe'
    ]) {
      expect(() => SummaryListItemSchema.parse({ ...item, fileName })).toThrow()
    }
    expect(() => SummaryListItemSchema.parse({ ...item, readyAt: 'soon' })).toThrow()
  })
  test('a run-location choice names a PC only for local', () => {
    expect(RunLocationChoiceSchema.parse({ location: 'local', deviceId: 'd1' })).toEqual({
      location: 'local',
      deviceId: 'd1'
    })
    expect(RunLocationChoiceSchema.parse({ location: 'server_via_home' }).location).toBe('server_via_home')
    expect(() => RunLocationChoiceSchema.parse({ location: 'local' })).toThrow()
    expect(() => RunLocationChoiceSchema.parse({ location: 'server', deviceId: 'd1' })).toThrow()
    expect(() => RunLocationChoiceSchema.parse({ location: 'moon' })).toThrow()
  })
  test('the identities answer carries the worker image', () => {
    const ok = { identities: [{ id: 'i1', name: 'Alice' }], image: 'ghcr.io/org/worker:1' }
    expect(LocalIdentitiesResponseSchema.parse(ok).identities).toHaveLength(1)
    expect(() => LocalIdentitiesResponseSchema.parse({ ...ok, image: '' })).toThrow()
  })
})
