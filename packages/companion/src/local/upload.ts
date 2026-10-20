import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join, sep } from 'node:path'
import { UPLOAD_CHUNK_MAX_BYTES } from '@tm/core'
import type { CompanionApi } from '../api'
import { isMissing } from '../atomic'

// What a local run sends to the website once the meeting is over. Files are read from the run's own data folder only
// (`<data>/occurrences/<occurrenceId>`), which a worker container wrote: nothing in it is trusted, so a file is sent
// only when it is a regular file reached without a link, and it is opened without following one. Errors are fixed
// sentences: no file content, path, token or meeting link is ever put in a message.

/** A chunk is at most this big (16 MiB); the website refuses more. */
export { UPLOAD_CHUNK_MAX_BYTES }

/** The only paths the website takes for a local run (08 Task 3's `isUploadPath`). */
const UPLOAD_PATTERNS: readonly RegExp[] = [
  /^recording\/meeting\.mkv$/,
  /^recording\/attempt_\d+_seg_\d{3}\.mkv$/,
  /^frames\/\d{4}_\d{6}\.png$/,
  /^(?:chat|events)\.jsonl$/,
  /^forms\/[A-Za-z0-9_-]+\/(?:record\.json|filled\.png|confirmation\.png)$/,
  /^transcript\/live\.jsonl$/,
  /^transcript\/native\/audio\.(?:txt|srt|json)$/
]

export function isUploadPath(relPath: string): boolean {
  return UPLOAD_PATTERNS.some((re) => re.test(relPath))
}

const NATIVE_TRANSCRIPT = /^transcript\/native\//
const MAX_SET_FILES = 20_000
const MAX_CONFLICTS = 3
/** The whole bytes of an empty file: one 0-byte chunk, sent as `bytes *` then `/0`. */
const EMPTY = new Uint8Array(0)

/** Something is wrong with a local file or with what the website said about it. The message names no path or value. */
export class UploadError extends Error {
  constructor(
    readonly reason: 'not_regular' | 'changed' | 'server_ahead' | 'server_out_of_step' | 'bad_path' | 'too_many',
    message: string
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

async function lstatOrNull(path: string) {
  try {
    // `bigint`: a Windows file id does not fit in a double, so two files could look alike as plain numbers.
    return await lstat(path, { bigint: true })
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
}

/**
 * Every file under `occDir` that the website takes, as relative POSIX paths, small things first and the recording last.
 * A link, a folder where a file belongs and a name outside the allowed patterns are left out. The native transcript
 * (`transcript/native/*`) is sent after transcription, and the attempt segments are left out once `meeting.mkv` exists.
 */
export async function uploadSet(occDir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(rel === '' ? occDir : join(occDir, rel), { withFileTypes: true })
    } catch (e) {
      if (isMissing(e)) return
      throw e
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1)
      else if (entry.isFile() && isUploadPath(path)) found.push(path)
      if (found.length > MAX_SET_FILES) throw new UploadError('too_many', 'There are too many files to upload')
    }
  }
  await walk('', 0)
  const joined = found.includes('recording/meeting.mkv')
  return found
    .filter((p) => !NATIVE_TRANSCRIPT.test(p) && !(joined && /^recording\/attempt_/.test(p)))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

function rank(path: string): number {
  if (path === 'events.jsonl') return 0
  if (path === 'chat.jsonl') return 1
  if (path.startsWith('transcript/')) return 2
  if (path.startsWith('forms/')) return 3
  if (path.startsWith('frames/')) return 4
  return 5
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** Whether two looks at a file (both with `bigint: true`) are the same regular file: same device and same inode. */
export function sameFile(
  before: Pick<BigIntStats, 'dev' | 'ino'>,
  after: Pick<BigIntStats, 'dev' | 'ino'> & { isFile(): boolean }
): boolean {
  return after.isFile() && after.ino === before.ino && after.dev === before.dev
}

/**
 * Opens `relPath` under `occDir` for reading. Each folder on the way and the file itself must be a real folder or a
 * regular file (not a link), the file is opened with `O_NOFOLLOW` where the system has it, and the open descriptor must
 * be the very file that was checked (same device and inode), inside the real `occDir`. Nothing else is read.
 */
export async function openRegularFile(occDir: string, relPath: string): Promise<{ handle: FileHandle; size: number }> {
  if (!isUploadPath(relPath)) throw new UploadError('bad_path', 'That file is not one the website takes')
  const notRegular = () => new UploadError('not_regular', 'A file to upload is missing or is not a regular file')
  const root = await lstatOrNull(occDir)
  if (root === null || !root.isDirectory()) throw notRegular()
  const parts = relPath.split('/')
  let walked = occDir
  for (const part of parts.slice(0, -1)) {
    walked = join(walked, part)
    const st = await lstatOrNull(walked)
    if (st === null || !st.isDirectory()) throw notRegular()
  }
  const file = join(occDir, ...parts)
  const before = await lstatOrNull(file)
  if (before === null || !before.isFile()) throw notRegular()
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_RDONLY | NOFOLLOW)
  } catch (e) {
    // ELOOP: the final part is a link (planted between the check and the open).
    if (e instanceof Error && 'code' in e && (e.code === 'ELOOP' || e.code === 'ENOENT')) throw notRegular()
    throw e
  }
  try {
    const after = await handle.stat({ bigint: true })
    const home = await realpath(occDir)
    const real = await realpath(file)
    if (!sameFile(before, after) || !real.startsWith(home + sep)) throw notRegular()
    return { handle, size: Number(after.size) }
  } catch (e) {
    await handle.close()
    throw e
  }
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled)
    if (bytesRead === 0) throw new UploadError('changed', 'A file changed while it was being uploaded')
    filled += bytesRead
  }
  return buf
}

export type UploadApi = Pick<CompanionApi, 'uploadOffset' | 'uploadChunk'>

/**
 * Sends one file in chunks of `UPLOAD_CHUNK_MAX_BYTES`, starting at the offset the website reports. A chunk is sent
 * only at that offset: when the website answers 409 with a different offset this continues from it (a few times),
 * and an offset past the end of the local file stops with an `UploadError`. An aborted `signal` stops it between chunks
 * with an `AbortError`. A call after a crash or a lost
 * connection therefore resumes; it does not start again. An empty file is still its one request, `Content-Range:`
 * `bytes *` then `/0` with no body at offset 0, so `complete` finds the file: HEAD reports 0 whether or not the
 * website holds it.
 */
export async function uploadFile(
  api: UploadApi,
  jobId: string,
  occDir: string,
  relPath: string,
  chunkBytes: number = UPLOAD_CHUNK_MAX_BYTES,
  signal?: AbortSignal
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > UPLOAD_CHUNK_MAX_BYTES) {
    throw new RangeError('bad chunk size')
  }
  const { handle, size } = await openRegularFile(occDir, relPath)
  try {
    let offset = await api.uploadOffset(jobId, relPath)
    if (offset > size) throw new UploadError('server_ahead', 'The website holds more of a file than this PC has')
    let conflicts = 0
    while (offset < size) {
      signal?.throwIfAborted()
      if ((await handle.stat()).size !== size)
        throw new UploadError('changed', 'A file changed while it was being uploaded')
      const bytes = await readExactly(handle, offset, Math.min(chunkBytes, size - offset))
      const sent = await api.uploadChunk(jobId, relPath, offset, size, bytes)
      if (sent.accepted) {
        offset += bytes.byteLength
        conflicts = 0
        continue
      }
      if (++conflicts > MAX_CONFLICTS) throw new UploadError('server_out_of_step', 'The website would not take a chunk')
      if (sent.offset > size) throw new UploadError('server_ahead', 'The website holds more of a file than this PC has')
      offset = sent.offset
    }
    if (size === 0) {
      signal?.throwIfAborted()
      const sent = await api.uploadChunk(jobId, relPath, 0, 0, EMPTY)
      if (!sent.accepted) {
        if (sent.offset > size) {
          throw new UploadError('server_ahead', 'The website holds more of a file than this PC has')
        }
        throw new UploadError('server_out_of_step', 'The website would not take a chunk')
      }
    }
  } finally {
    await handle.close()
  }
}
