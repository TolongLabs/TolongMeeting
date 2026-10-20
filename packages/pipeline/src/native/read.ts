import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { NATIVE_UPLOAD_MAX_FILE_BYTES, WhisperJsonSchema } from '@tm/core'
import { isHallucination, type LiveLine } from '../transcript'

const NATIVE_JSON = join('transcript', 'native', 'audio.json')

// The native transcript is uploaded from a member's PC, so it is untrusted like every other input. It is read only if
// it is a regular file (not a link) whose real path is inside the occurrence directory and which is within the size cap.
async function readContained(occDir: string): Promise<string> {
  const root = await realpath(occDir)
  const path = join(root, NATIVE_JSON)
  const refuse = (why: string): never => {
    throw new Error(`${path}: ${why}`)
  }
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return refuse('the native transcript is missing')
    throw err
  })
  if (!info.isFile()) refuse('not a regular file')
  if ((await realpath(path)) !== `${root}${sep}${NATIVE_JSON}`) refuse('outside the occurrence directory')
  if (info.size > NATIVE_UPLOAD_MAX_FILE_BYTES) refuse(`larger than ${NATIVE_UPLOAD_MAX_FILE_BYTES} bytes`)
  // O_NOFOLLOW and the identity check close the gap between the checks above and the read.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) refuse('changed while it was read')
    const buffer = Buffer.alloc(Math.min(opened.size, NATIVE_UPLOAD_MAX_FILE_BYTES) + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > NATIVE_UPLOAD_MAX_FILE_BYTES) refuse(`larger than ${NATIVE_UPLOAD_MAX_FILE_BYTES} bytes`)
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/**
 * The rows of `transcript/native/audio.json` (whisper-transcriber's `json` output), in the shape of
 * `transcript/live.jsonl`: recording-relative milliseconds. Segments with no words or only a hallucination are
 * dropped, and whitespace and control characters in the text become single spaces. Throws when the file is missing,
 * unsafe, too big or not a valid segment list.
 */
export async function readNativeTranscript(occDir: string): Promise<LiveLine[]> {
  const parsed = WhisperJsonSchema.parse(JSON.parse(await readContained(occDir)))
  const rows: LiveLine[] = []
  for (const segment of parsed.segments) {
    const text = segment.text.replace(/[\s\p{Cc}]+/gu, ' ').trim()
    if (isHallucination(text)) continue
    const startMs = Math.round(segment.start * 1000)
    rows.push({ startMs, endMs: Math.max(startMs, Math.round(segment.end * 1000)), text })
  }
  return rows
}
