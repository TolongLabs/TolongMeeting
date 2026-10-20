import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SEGMENT = /^attempt_(\d+)_seg_(\d+)\.mkv$/
/** The copy must be as long as the original to within this many seconds, or the original is kept. */
const DURATION_TOLERANCE_S = 1
/** Every Matroska file starts with this EBML header magic. */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

/**
 * Only the `file` protocol and a fixed container format are allowed on every input: the worker that wrote the
 * recording directory is not trusted, and a text file named `.mkv` must not be read as an HLS or concat playlist
 * (which could name any file or URL).
 */
const MATROSKA_INPUT = ['-f', 'matroska', '-protocol_whitelist', 'file']
const MP4_INPUT = ['-f', 'mp4', '-protocol_whitelist', 'file']

/** The ffmpeg arguments that copy the Matroska file `input` into the fast-start MP4 `output` for the browser. */
export function remuxArgs(input: string, output: string): string[] {
  return ['-y', ...MATROSKA_INPUT, '-i', input, '-c', 'copy', '-movflags', '+faststart', output]
}

async function tool(cmd: 'ffmpeg' | 'ffprobe', args: string[], opts: { cwd?: string; signal?: AbortSignal }) {
  const base = cmd === 'ffmpeg' ? ['-hide_banner', '-loglevel', 'error', '-nostdin'] : []
  try {
    const { stdout } = await run(cmd, [...base, ...args], { maxBuffer: 10_000_000, ...opts })
    return stdout
  } catch (error) {
    opts.signal?.throwIfAborted()
    const { stderr } = error as { stderr?: string }
    throw new Error(`${cmd} failed: ${stderr?.trim() || (error as Error).message}`)
  }
}

async function infoOf(path: string) {
  return lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  })
}

/** The size of a regular file at `path` that is not a link; null when there is none. A link, FIFO or directory is logged. */
async function regularFile(path: string): Promise<{ size: number } | null> {
  const info = await infoOf(path)
  if (info === null) return null
  if (!info.isFile()) {
    console.error(`remux: ${path} is not a regular file; it is skipped`)
    return null
  }
  return { size: info.size }
}

async function startsWithEbml(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(EBML_MAGIC.length)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return bytesRead === head.length && head.equals(EBML_MAGIC)
  } finally {
    await handle.close()
  }
}

async function durationOf(file: string, format: string[], signal?: AbortSignal): Promise<number> {
  const out = (
    await tool('ffprobe', [...format, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      signal
    })
  ).trim()
  const seconds = Number(out)
  if (out === '' || !Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${file}`)
  return seconds
}

// An entry of the concat demuxer's list file; the names are the validated `SEGMENT` names, which need no quoting.
const concatLine = (name: string) => `file '${name}'`

/**
 * Joins `attempt_<N>_seg_<NNN>.mkv` (by attempt, then number) into `<recording>/meeting.mkv`, for a worker that stopped
 * before it could (its teardown ran out of time). A segment that is empty, is not a regular file (a link is never
 * followed) or does not start with the Matroska header is skipped; no stream is re-encoded. The concat runs inside the
 * recording directory on bare names, so the list needs no `-safe 0`. False when there are no segments to join.
 */
async function joinSegments(dir: string, recording: string, signal?: AbortSignal): Promise<boolean> {
  const segments = (await readdir(recording))
    .map((name) => ({ name, match: SEGMENT.exec(name) }))
    .filter((s) => s.match !== null)
    .map((s) => ({ name: s.name, attempt: Number(s.match![1]), number: Number(s.match![2]) }))
    .sort((a, b) => a.attempt - b.attempt || a.number - b.number)
  const present: string[] = []
  for (const s of segments) {
    const file = await regularFile(join(recording, s.name))
    if (file === null || file.size === 0) continue
    if (!(await startsWithEbml(join(recording, s.name)))) {
      console.error(`remux: ${join(recording, s.name)} is not a Matroska file; it is skipped`)
      continue
    }
    present.push(s.name)
  }
  if (present.length === 0) return false
  // The concat demuxer resolves the names against the directory of the list, so the list sits in the recording
  // directory under a random name and is created exclusively (`wx` never opens an existing file or link). The joined copy
  // is as large as the recording, so it goes to the occurrence directory, not the system temp directory.
  const list = `.join-${randomUUID()}.txt`
  const work = await mkdtemp(join(dir, '.join-'))
  try {
    await writeFile(join(recording, list), `${present.map(concatLine).join('\n')}\n`, { flag: 'wx' })
    const joined = join(work, 'meeting.mkv')
    await tool(
      'ffmpeg',
      ['-y', '-f', 'concat', '-protocol_whitelist', 'file', '-i', list, '-map', '0', '-c', 'copy', joined],
      { cwd: recording, signal }
    )
    await rename(joined, join(recording, 'meeting.mkv'))
    return true
  } finally {
    await rm(join(recording, list), { force: true })
    await rm(work, { recursive: true, force: true })
  }
}

/** The occurrence directory's real path and its `recording` directory, when that is a real directory inside it. */
async function recordingDirOf(dir: string): Promise<{ root: string; recording: string } | null> {
  const root = await realpath(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  })
  if (root === null) return null
  const recording = join(root, 'recording')
  const info = await infoOf(recording)
  if (info === null) return null
  if (!info.isDirectory() || (await realpath(recording)) !== `${root}${sep}recording`) {
    console.error(`remux: ${recording} is not a plain directory inside ${root}; it is skipped`)
    return null
  }
  return { root, recording }
}

/** A work directory left behind by a remux that died is deleted after this long. */
const STALE_WORK_MS = 10 * 60_000

/** Deletes `.remux-*` and `.join-*` directories (real directories only, never links) older than ten minutes. */
async function removeStaleWork(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    if (!name.startsWith('.remux-') && !name.startsWith('.join-')) continue
    const info = await infoOf(join(root, name))
    if (info === null || !info.isDirectory() || Date.now() - info.mtimeMs < STALE_WORK_MS) continue
    await rm(join(root, name), { recursive: true, force: true })
  }
}

/**
 * Makes `<dir>/recording/meeting.mp4` from the recording and deletes `meeting.mkv` once the copy is as long as the
 * original (within one second). A worker that stopped before it joined the segments has them joined first. Returns
 * true when a `meeting.mp4` that passed the duration check is in place at the end, false when there is no recording.
 * Safe to run again: it does nothing to a finished earlier run except check its length.
 *
 * Nothing in the directory is trusted, because the worker that wrote it is not: the recording directory, `meeting.mkv`,
 * `meeting.mp4` and every segment must be plain files (a link or special file is skipped, never followed); the inputs
 * are read as Matroska with only the `file` protocol; the copy is written to a fresh temporary directory in the
 * occurrence directory and renamed into place (which replaces a planted link instead of writing through it). A stale
 * or partial `meeting.mp4` is deleted before remuxing. A copy that fails or is too short is discarded, the `.mkv`
 * stays and the error is thrown. Leftover `.remux-*` and `.join-*` work directories older than ten minutes are
 * deleted first. A worker that swaps a file after these checks is not guarded against; that is safe only because both
 * callers run this after the occurrence's `container_name` has been cleared, which the monitor does only once Docker
 * reports the worker container gone (the pipeline consumer throws, to be retried, while it is set).
 */
export async function remuxRecording(dir: string, signal?: AbortSignal): Promise<boolean> {
  const where = await recordingDirOf(dir)
  if (where === null) return false
  const { root, recording } = where
  await removeStaleWork(root)
  const mkv = join(recording, 'meeting.mkv')
  const mp4 = join(recording, 'meeting.mp4')

  if ((await regularFile(mkv)) === null) {
    // An MP4 with no MKV is a finished earlier run: it is checked, and the segments are not joined a second time.
    const earlier = await regularFile(mp4)
    if (earlier !== null) return (await durationOf(mp4, MP4_INPUT, signal).catch(() => 0)) > 0
    await rm(mp4, { force: true })
    if (!(await joinSegments(root, recording, signal))) return false
  }

  await rm(mp4, { force: true })
  const work = await mkdtemp(join(root, '.remux-'))
  try {
    const copy = join(work, 'meeting.mp4')
    await tool('ffmpeg', remuxArgs(mkv, copy), { signal })
    const [original, made] = [await durationOf(mkv, MATROSKA_INPUT, signal), await durationOf(copy, MP4_INPUT, signal)]
    if (Math.abs(original - made) > DURATION_TOLERANCE_S) {
      throw new Error(`the MP4 is ${made.toFixed(1)} s long but the recording is ${original.toFixed(1)} s`)
    }
    if ((await realpath(recording)) !== `${root}${sep}recording`)
      throw new Error(`${recording} changed during the remux`)
    await rename(copy, mp4)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  await rm(mkv, { force: true })
  return true
}
