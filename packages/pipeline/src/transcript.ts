import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { formatOffset, localParts, type JobConfig } from '@tm/core'
import { correctNames } from './names'

export interface LiveLine {
  startMs: number
  endMs: number
  text: string
}

// ms is null when the attempt that crashed before its stop was recorded, so the gap's length is unknown.
export interface Gap {
  atMs: number
  ms: number | null
}

export type TranscriptBlock =
  | { kind: 'para'; atMs: number; text: string }
  | { kind: 'silence'; atMs: number; ms: number }
  | { kind: 'gap'; atMs: number; ms: number | null }

interface Attempt {
  attempt: number
  startedAt: string
  stoppedAt: string | null
}

const PAUSE_MS = 2_000
const SILENCE_MS = 120_000
const PARAGRAPH_CHARS = 600
const HALLUCINATIONS = new Set(['you', 'thank you', 'thank you for watching', 'thanks for watching'])
const NO_LIVE_TRANSCRIPT = '_No live transcript for this meeting._'
const NO_SPEECH = '_No speech recognised in the live transcript._'

export function isHallucination(text: string): boolean {
  const core = text
    .toLowerCase()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .replace(/\s+/g, ' ')
  return [...core].length <= 1 || HALLUCINATIONS.has(core)
}

// Silence in [from, to] that is not inside a recording gap. Null when an unknown-length gap ends inside the
// pause: its start is unknown, so the silence cannot be measured.
function silenceMs(from: number, to: number, gaps: Gap[]): number | null {
  let silent = to - from
  for (const gap of gaps) {
    if (gap.ms === null) {
      if (gap.atMs > from && gap.atMs <= to) return null
      continue
    }
    silent -= Math.max(0, Math.min(gap.atMs, to) - Math.max(gap.atMs - gap.ms, from))
  }
  return silent
}

export function paragraphs(lines: LiveLine[], gaps: Gap[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let para: { atMs: number; endMs: number; text: string } | null = null
  // ASR rows can overlap or arrive out of order, so pauses are measured between rows in start order.
  const ordered = [...lines].sort((a, b) => a.startMs - b.startMs)
  for (const line of ordered) {
    const text = line.text.trim()
    if (isHallucination(text)) continue
    if (para !== null) {
      const pause = line.startMs - para.endMs
      const silent = silenceMs(para.endMs, line.startMs, gaps)
      if (silent !== null && silent >= SILENCE_MS) {
        blocks.push({ kind: 'para', atMs: para.atMs, text: para.text })
        blocks.push({ kind: 'silence', atMs: para.endMs, ms: silent })
        para = null
      } else if (pause >= PAUSE_MS || para.text.length >= PARAGRAPH_CHARS) {
        blocks.push({ kind: 'para', atMs: para.atMs, text: para.text })
        para = null
      }
    }
    para =
      para === null
        ? { atMs: line.startMs, endMs: line.endMs, text }
        : { atMs: para.atMs, endMs: Math.max(para.endMs, line.endMs), text: `${para.text} ${text}` }
  }
  if (para !== null) blocks.push({ kind: 'para', atMs: para.atMs, text: para.text })
  for (const gap of gaps) blocks.push({ kind: 'gap', atMs: gap.atMs, ms: gap.ms })
  return blocks.sort((a, b) => a.atMs - b.atMs)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseLiveLine(value: unknown, where: string): LiveLine {
  if (
    !isRecord(value) ||
    typeof value.startMs !== 'number' ||
    typeof value.endMs !== 'number' ||
    typeof value.text !== 'string'
  ) {
    throw new Error(`${where}: not a live transcript line`)
  }
  return { startMs: value.startMs, endMs: value.endMs, text: value.text }
}

function parseAttempt(value: unknown, where: string): Attempt {
  if (
    !isRecord(value) ||
    typeof value.attempt !== 'number' ||
    typeof value.startedAt !== 'string' ||
    (value.stoppedAt !== null && typeof value.stoppedAt !== 'string')
  ) {
    throw new Error(`${where}: not an attempt record`)
  }
  return { attempt: value.attempt, startedAt: value.startedAt, stoppedAt: value.stoppedAt }
}

function timeOf(iso: string, where: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`${where}: invalid time ${iso}`)
  return ms
}

// Gaps sit between consecutive attempts. The time origin is the first attempt's start.
// An earlier attempt with no stoppedAt crashed; its gap ends at the next attempt's start but its length is unknown.
function gapsFrom(attempts: Attempt[]): Gap[] {
  const sorted = [...attempts].sort((a, b) => a.attempt - b.attempt)
  if (sorted.length === 0) return []
  const origin = timeOf(sorted[0].startedAt, 'recording/attempts.json')
  const gaps: Gap[] = []
  for (let k = 1; k < sorted.length; k++) {
    const previous = sorted[k - 1]
    const current = sorted[k]
    const start = timeOf(current.startedAt, 'recording/attempts.json')
    if (previous.stoppedAt === null) {
      gaps.push({ atMs: start - origin, ms: null })
      continue
    }
    const ms = start - timeOf(previous.stoppedAt, 'recording/attempts.json')
    if (ms > 0) gaps.push({ atMs: start - origin, ms })
  }
  return gaps
}

function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes === 0) return 'less than a minute'
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

function gapText(ms: number | null): string {
  return ms === null ? 'Recording gap (length unknown)' : `Recording gap of ${minutesText(ms)}`
}

function renderBlock(block: TranscriptBlock, vocab: string[]): string {
  switch (block.kind) {
    case 'para':
      return `**[${formatOffset(block.atMs)}]** ${correctNames(block.text, vocab)}`
    case 'silence':
      return `_[${formatOffset(block.atMs)}] No speech for ${minutesText(block.ms)}._`
    case 'gap':
      return `_[${formatOffset(block.atMs)}] ${gapText(block.ms)}._`
  }
}

function clock(hhmm: string): string {
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
}

function header(cfg: JobConfig): string {
  const { timeZone, start, end, name } = cfg.entry
  const from = localParts(start, timeZone)
  const to = localParts(end, timeZone)
  const when = `${from.weekday} ${from.dayMonthYear}, ${clock(from.hhmm)} to ${clock(to.hhmm)} (${timeZone})`
  return (
    `# ${name}: transcript\n\n` +
    `${when}. Live transcription; times are from the recording start, and names may be misheard.\n\n` +
    '## Transcript\n\n'
  )
}

async function liveBody(cfg: JobConfig, livePath: string, vocab: string[]): Promise<string> {
  const lines = (await Bun.file(livePath).text())
    .split('\n')
    .filter((raw) => raw.trim() !== '')
    .map((raw, index) => parseLiveLine(JSON.parse(raw), `${livePath} line ${index + 1}`))
  const attemptsPath = join(cfg.dataDir, 'recording', 'attempts.json')
  const attempts = (await Bun.file(attemptsPath).json()) as unknown
  if (!Array.isArray(attempts)) throw new Error(`${attemptsPath}: expected an array`)
  const blocks = paragraphs(
    lines,
    gapsFrom(attempts.map((value, index) => parseAttempt(value, `${attemptsPath}[${index}]`)))
  )
  if (blocks.length === 0) return NO_SPEECH
  return blocks.map((block) => renderBlock(block, vocab)).join('\n\n')
}

// Writes out/transcript.md and returns its path. A missing live.jsonl means there was no live transcript.
export async function buildTranscript(cfg: JobConfig, vocab: string[]): Promise<string> {
  const livePath = join(cfg.dataDir, 'transcript', 'live.jsonl')
  const body = (await Bun.file(livePath).exists()) ? await liveBody(cfg, livePath, vocab) : NO_LIVE_TRANSCRIPT
  const outPath = join(cfg.dataDir, 'out', 'transcript.md')
  await mkdir(dirname(outPath), { recursive: true })
  await Bun.write(outPath, `${header(cfg)}${body}\n`)
  return outPath
}
