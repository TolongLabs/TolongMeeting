import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { durationSeconds } from './helpers/media'
import { joinRecording } from '../src/recorder/join'

const run = promisify(execFile)
const hasFfmpeg = (() => {
  try {
    execFileSync('which', ['ffmpeg'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// A segment shaped like the recorder's: H.264 video and AAC audio, timestamps from zero.
async function lavfiSegment(dir: string, name: string, seconds: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x180:rate=15:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=48000:cl=stereo`,
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    join(dir, name)
  ])
}

// Cuts `seconds` worth of bytes (by the file's average rate) off the end: what a SIGKILL leaves behind.
async function truncateTail(file: string, seconds: number, total: number): Promise<void> {
  const size = (await stat(file)).size
  const handle = await open(file, 'r+')
  await handle.truncate(Math.floor(size * (1 - seconds / total)))
  await handle.close()
}

describe.skipIf(!hasFfmpeg)('joinRecording', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-join-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  test('segments of two attempts join, a truncated segment included', async () => {
    await lavfiSegment(dir, 'attempt_1_seg_000.mkv', 2)
    await lavfiSegment(dir, 'attempt_1_seg_001.mkv', 2)
    await lavfiSegment(dir, 'attempt_2_seg_000.mkv', 2)
    await truncateTail(join(dir, 'attempt_1_seg_001.mkv'), 0.2, 2)
    const out = await joinRecording(dir)
    expect(basename(out)).toBe('meeting.mkv')
    expect(await durationSeconds(out)).toBeGreaterThan(5)
  })

  test('segments join in attempt and number order, not name order', async () => {
    await lavfiSegment(dir, 'attempt_10_seg_000.mkv', 1)
    await lavfiSegment(dir, 'attempt_2_seg_000.mkv', 2)
    const out = await joinRecording(dir)
    expect(await durationSeconds(out)).toBeGreaterThan(2.8)
    // attempt 2 (2 s) comes first, so the second keyframe is at 2 s (name order would put it at 1 s)
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'packet=pts_time,flags',
      '-select_streams',
      'v',
      '-of',
      'csv=p=0',
      out
    ])
    const keyTimes = stdout
      .trim()
      .split('\n')
      .filter((l) => l.includes('K'))
      .map((l) => Number(l.split(',')[0]))
    expect(keyTimes).toHaveLength(2)
    expect(keyTimes[1]).toBeCloseTo(2, 0)
  })

  test('an empty segment (ffmpeg died as it opened it) is skipped, other files are ignored', async () => {
    await lavfiSegment(dir, 'attempt_1_seg_000.mkv', 2)
    await writeFile(join(dir, 'attempt_1_seg_001.mkv'), '')
    await writeFile(join(dir, 'notes.txt'), 'not a segment')
    const out = await joinRecording(dir)
    expect(await durationSeconds(out)).toBeGreaterThan(1.8)
  })

  test('a corrupt non-empty segment is skipped with a warning, the rest still joins', async () => {
    await lavfiSegment(dir, 'attempt_1_seg_000.mkv', 2)
    await writeFile(join(dir, 'attempt_1_seg_001.mkv'), 'garbage, not matroska')
    await lavfiSegment(dir, 'attempt_1_seg_002.mkv', 2)
    const warnings: string[] = []
    const out = await joinRecording(dir, { onWarning: (w) => warnings.push(w) })
    expect(await durationSeconds(out)).toBeGreaterThan(3.5)
    expect(await durationSeconds(out)).toBeLessThan(4.5)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('attempt_1_seg_001.mkv')
  })

  test('when no segment is usable it fails loudly and leaves no meeting.mkv', async () => {
    await writeFile(join(dir, 'attempt_1_seg_000.mkv'), 'garbage, not matroska')
    const warnings: string[] = []
    await expect(joinRecording(dir, { onWarning: (w) => warnings.push(w) })).rejects.toThrow('no usable segments')
    expect(warnings).toHaveLength(1)
    await expect(stat(join(dir, 'meeting.mkv'))).rejects.toThrow()
  })

  test('a directory without segments fails loudly', async () => {
    await expect(joinRecording(dir)).rejects.toThrow('no recorded segments')
  })
})
