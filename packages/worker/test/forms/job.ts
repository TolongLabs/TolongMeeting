import { parseJob, type AiConfig, type JobConfig, type OrgConfig } from '@tm/core'

export function testJob(
  dataDir: string,
  patch: {
    organisation?: OrgConfig | null
    ai?: Partial<AiConfig>
    attendanceKeywords?: string[]
  } = {}
): JobConfig {
  const organisation =
    patch.organisation === undefined
      ? { name: 'Example University', emailDomain: 'example.edu.my' }
      : patch.organisation
  return parseJob({
    occurrenceId: 'occ-test',
    attempt: 1,
    entry: {
      name: 'Example lecture',
      type: 'lecture',
      start: '2026-10-20T20:00:00+08:00',
      end: '2026-10-20T22:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'paste' },
      trustedSenders: ['Dr Example'],
      transcription: 'live',
      formDetails: { course_code: 'ABC1234', section: '02', lecturer: 'Dr Example' },
      attendanceKeywords: patch.attendanceKeywords ?? []
    },
    identity: {
      id: 'identity-test',
      name: 'Test identity',
      zoomGuestName: 'Test Student',
      formProviders: ['google', 'microsoft'],
      organisation
    },
    member: {
      id: 'member-test',
      displayName: 'Test Student',
      mentionNames: [],
      details: [
        { key: 'full_name', value: 'Test Student', labels: [] },
        { key: 'student_id', value: 'A00000000', labels: [] },
        { key: 'university_email', value: 'student@example.edu.my', labels: [] },
        { key: 'programme', value: 'MSc Example', labels: [] }
      ]
    },
    ai: {
      baseUrl: 'https://ai.example.test/v1',
      apiKey: 'test-key',
      asrUrl: 'wss://asr.example.test/realtime',
      models: { summary: 'test-summary', vision: 'test-vision', formMatch: 'qwen-flash', asr: 'test-asr' },
      ...patch.ai
    },
    ntfy: { url: 'https://ntfy.example.test', topic: 'test-topic', token: 'test-token' },
    dataDir,
    profileDir: `${dataDir}/profile`,
    control: null
  })
}
