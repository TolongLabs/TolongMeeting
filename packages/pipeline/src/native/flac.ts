import { lstat, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { durationOf, joinedRecording, MATROSKA_INPUT, tool } from '../remux'

/** The cut of a three hour lecture takes about a minute; a run that takes longer than this is stuck. */
export const FLAC_TIMEOUT_MS = 30 * 60_000
const FLAC_INPUT = ['-f', 'flac', '-protocol_whitelist', 'file']

/** The ffmpeg arguments that cut the audio of the Matroska file `input` into the 48 kHz mono FLAC `output`. */
export function flacArgs(input: string, output: string): string[] {
  // No `-y`: `output` sits in a fresh directory, so an existing file there is a bug and ffmpeg must refuse it.
  return [...MATROSKA_INPUT, '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'flac', output]
}

/**
 * Cuts the audio of the recording in `<occDir>` into `<occDir>/audio.flac` (48 kHz, mono) for the member's PC to
 * transcribe, and returns its path, size and length from `ffprobe`.
 *
 * The recording is the safely joined `recording/meeting.mkv` (`joinedRecording`: a worker that stopped before it joined
 * its segments has them joined here; the later remux still finds `meeting.mkv`). Nothing in the occurrence directory
 * is trusted: the input is read as Matroska through the `file` protocol only, the FLAC is written into a fresh
 * temporary directory and renamed into place (which replaces a planted link instead of writing through it), and the
 * recording directory is checked once more after the cut. The caller runs this only after the worker container is gone.
 * Throws when there is no recording or no audio stream, when ffmpeg fails or when `signal` aborts or the cut takes
 * longer than `FLAC_TIMEOUT_MS`.
 */
export async function extractFlac(
  occDir: string,
  signal?: AbortSignal
): Promise<{ path: string; durationSec: number; bytes: number }> {
  const joined = await joinedRecording(occDir, signal)
  if (joined === null) throw new Error(`There is no recording in ${occDir} to cut audio from`)
  const { root, recording } = joined
  const limit = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FLAC_TIMEOUT_MS)])
    : AbortSignal.timeout(FLAC_TIMEOUT_MS)
  const work = await mkdtemp(join(root, '.flac-'))
  try {
    const cut = join(work, 'audio.flac')
    await tool('ffmpeg', flacArgs(joined.path, cut), { signal: limit })
    const durationSec = await durationOf(cut, FLAC_INPUT, limit)
    if ((await realpath(recording)) !== `${root}${sep}recording`) throw new Error(`${recording} changed during the cut`)
    const { size: bytes } = await lstat(cut)
    const path = join(root, 'audio.flac')
    const planted = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (planted !== null && !planted.isFile()) await rm(path, { recursive: true, force: true })
    await rename(cut, path)
    return { path, durationSec, bytes }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
