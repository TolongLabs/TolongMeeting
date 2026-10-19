import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseJob, type JobConfig } from '@tm/core'

export interface Occurrence {
  cfg: JobConfig
  dataDir: string
  root: string
}

// A Wednesday 20:00 to 22:00 lecture in Kuala Lumpur, in a real temporary occurrence directory.
export async function makeOccurrence(): Promise<Occurrence> {
  const root = await mkdtemp(join(tmpdir(), 'tm-pipeline-'))
  const dataDir = join(root, 'occurrences', 'occ-1')
  await mkdir(dataDir, { recursive: true })
  const cfg = parseJob({
    occurrenceId: 'occ-1',
    attempt: 1,
    entry: {
      name: 'Data Mining',
      type: 'lecture',
      start: '2026-10-21T20:00:00+08:00',
      end: '2026-10-21T22:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'paste' },
      trustedSenders: [],
      transcription: 'live',
      formDetails: {},
      attendanceKeywords: []
    },
    identity: { id: 'identity-1', name: 'Member', zoomGuestName: 'Member', formProviders: [] },
    member: { id: 'member-1', displayName: 'Member', mentionNames: [], details: [] },
    ai: {
      baseUrl: 'https://ai.example.com/v1',
      apiKey: 'test-key',
      asrUrl: 'wss://asr.example.com/realtime',
      models: { summary: 'm1', vision: 'm2', formMatch: 'm3', asr: 'm4' }
    },
    ntfy: { url: 'https://ntfy.example.com', topic: 'topic', token: 'token' },
    dataDir,
    profileDir: join(root, 'profile'),
    control: null
  })
  return { cfg, dataDir, root }
}

export async function writeLines(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

// Writes recording/attempts.json as the recorder does. Times are milliseconds from the first start.
export async function writeAttempts(
  dataDir: string,
  attempts: { startMs: number; stopMs: number | null }[]
): Promise<void> {
  const origin = Date.parse('2026-10-21T12:00:00Z')
  const rows = attempts.map((a, index) => ({
    attempt: index + 1,
    startedAt: new Date(origin + a.startMs).toISOString(),
    stoppedAt: a.stopMs === null ? null : new Date(origin + a.stopMs).toISOString()
  }))
  await mkdir(join(dataDir, 'recording'), { recursive: true })
  await writeFile(join(dataDir, 'recording', 'attempts.json'), JSON.stringify(rows))
}

export async function removeOccurrence(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

export interface LiveRow {
  startMs: number
  endMs: number
  text: string
}

export function liveLine(startMs: number, endMs: number, text: string): LiveRow {
  return { startMs, endMs, text }
}
