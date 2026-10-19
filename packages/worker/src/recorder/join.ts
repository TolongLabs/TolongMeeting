import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SEGMENT = /^attempt_(\d+)_seg_(\d+)\.mkv$/

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { maxBuffer: 10_000_000 })
  } catch (error) {
    const { stderr } = error as { stderr?: string }
    throw new Error(`ffmpeg ${args.join(' ')} failed: ${stderr?.trim() || (error as Error).message}`)
  }
}

// An entry of the concat demuxer's list file: single quotes are escaped as '\''.
const concatLine = (file: string) => `file '${file.replaceAll("'", "'\\''")}'`

/**
 * Joins `attempt_<N>_seg_<NNN>.mkv` (by attempt, then number) into `<recordingDir>/meeting.mkv` and returns its path.
 * Each segment is remuxed first, which repairs one cut short by a crash. An empty file (ffmpeg died as it opened the
 * segment) holds nothing and is skipped. Gaps are not filled; `attempts.json` records them.
 */
export async function joinRecording(recordingDir: string): Promise<string> {
  const segments = (await readdir(recordingDir))
    .map((name) => ({ name, match: SEGMENT.exec(name) }))
    .filter((s) => s.match !== null)
    .map((s) => ({ name: s.name, attempt: Number(s.match![1]), number: Number(s.match![2]) }))
    .sort((a, b) => a.attempt - b.attempt || a.number - b.number)
  const present = []
  for (const s of segments) if ((await stat(join(recordingDir, s.name))).size > 0) present.push(s)
  if (present.length === 0) throw new Error(`no recorded segments in ${recordingDir}`)

  // Inside the recording directory, not the system temp directory: the remuxed copies are as large as the recording.
  const work = await mkdtemp(join(recordingDir, '.join-'))
  try {
    const remuxed: string[] = []
    for (const s of present) {
      const out = join(work, s.name)
      await ffmpeg(['-err_detect', 'ignore_err', '-i', join(recordingDir, s.name), '-map', '0', '-c', 'copy', out])
      remuxed.push(out)
    }
    const list = join(work, 'list.txt')
    await writeFile(list, `${remuxed.map(concatLine).join('\n')}\n`)
    const joined = join(work, 'meeting.mkv')
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', joined])
    const target = join(recordingDir, 'meeting.mkv')
    await rename(joined, target)
    return target
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
