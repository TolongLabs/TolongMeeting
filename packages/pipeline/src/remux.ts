import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SEGMENT = /^attempt_(\d+)_seg_(\d+)\.mkv$/
/** The copy must be as long as the original to within this many seconds, or the original is kept. */
const DURATION_TOLERANCE_S = 1

/** The ffmpeg arguments that copy `<dir>/recording/meeting.mkv` into a fast-start `meeting.mp4` for the browser. */
export function remuxArgs(dir: string): string[] {
  return [
    '-y',
    '-i',
    `${dir}/recording/meeting.mkv`,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    `${dir}/recording/meeting.mp4`
  ]
}

async function tool(cmd: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  const base = cmd === 'ffmpeg' ? ['-hide_banner', '-loglevel', 'error', '-nostdin'] : []
  try {
    return (await run(cmd, [...base, ...args], { maxBuffer: 10_000_000 })).stdout
  } catch (error) {
    const { stderr } = error as { stderr?: string }
    throw new Error(`${cmd} failed: ${stderr?.trim() || (error as Error).message}`)
  }
}

async function exists(path: string): Promise<boolean> {
  return (
    (await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })) !== null
  )
}

// An entry of the concat demuxer's list file: single quotes are escaped as '\''.
const concatLine = (file: string) => `file '${file.replaceAll("'", "'\\''")}'`

/**
 * Joins `attempt_<N>_seg_<NNN>.mkv` (by attempt, then number) into `meeting.mkv`, for a worker that stopped before it
 * could (its teardown ran out of time). Empty segments are skipped; no stream is re-encoded. False when there are no
 * segments to join.
 */
async function joinSegments(recordingDir: string): Promise<boolean> {
  const segments = (await readdir(recordingDir))
    .map((name) => ({ name, match: SEGMENT.exec(name) }))
    .filter((s) => s.match !== null)
    .map((s) => ({ name: s.name, attempt: Number(s.match![1]), number: Number(s.match![2]) }))
    .sort((a, b) => a.attempt - b.attempt || a.number - b.number)
  const present: string[] = []
  for (const s of segments) if ((await stat(join(recordingDir, s.name))).size > 0) present.push(s.name)
  if (present.length === 0) return false
  // Inside the recording directory, not the system temp directory: the joined copy is as large as the recording.
  const work = await mkdtemp(join(recordingDir, '.join-'))
  try {
    const list = join(work, 'list.txt')
    await writeFile(list, `${present.map((name) => concatLine(join(recordingDir, name))).join('\n')}\n`)
    const joined = join(work, 'meeting.mkv')
    await tool('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', joined])
    await rename(joined, join(recordingDir, 'meeting.mkv'))
    return true
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function durationOf(file: string): Promise<number> {
  const out = (
    await tool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  ).trim()
  const seconds = Number(out)
  if (out === '' || !Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${file}`)
  return seconds
}

/**
 * Makes `<dir>/recording/meeting.mp4` from the recording and deletes `meeting.mkv` once the copy is as long as the
 * original (within one second). A worker that stopped before it joined the segments has them joined first. Safe to
 * run again: it does nothing when `meeting.mkv` is gone and has no segments to join or the MP4 is already there. A copy that fails or is too short is deleted,
 * the `.mkv` stays and the error is thrown.
 */
export async function remuxRecording(dir: string): Promise<void> {
  const recording = join(dir, 'recording')
  const mkv = join(recording, 'meeting.mkv')
  const mp4 = join(recording, 'meeting.mp4')
  if (!(await exists(recording))) return
  if (!(await exists(mkv))) {
    // An MP4 with no MKV is a finished earlier run: the segments are not joined a second time.
    if ((await exists(mp4)) || !(await joinSegments(recording))) return
  }
  try {
    await tool('ffmpeg', remuxArgs(dir))
    const [original, copy] = [await durationOf(mkv), await durationOf(mp4)]
    if (Math.abs(original - copy) > DURATION_TOLERANCE_S) {
      throw new Error(`the MP4 is ${copy.toFixed(1)} s long but the recording is ${original.toFixed(1)} s`)
    }
  } catch (error) {
    await rm(mp4, { force: true })
    throw error
  }
  await rm(mkv)
}
