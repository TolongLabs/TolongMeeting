import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  IllegalTransition,
  NATIVE_UPLOAD_FIELDS,
  NATIVE_UPLOAD_MAX_BODY_BYTES,
  NATIVE_UPLOAD_MAX_FILE_BYTES,
  WhisperJsonSchema
} from '@tm/core'
import { completeJob, getClaimedJob } from '../../db/companion'
import { QUEUES, queueDbOf, type Queue } from '../../db/queues'
import { applyTrigger } from '../../db/transitions'
import { notFound, openOccurrenceFile, serveFile } from '../files'
import { getQueue } from '../queue'
import { companionDeps } from './deps'
import type { DeviceDeps, DeviceScope } from './scope'

// The two routes a PC uses to transcribe on its own GPU: it downloads the cut audio of a recording and uploads the
// Whisper output. Everything the PC sends is untrusted, and so is the occurrence directory (a worker once wrote it).
// Every answer is a fixed body: no audio, transcript text, path or token appears in a response or a log line.

type Db = DeviceDeps['db']

/** What the upload route runs on: the database and the queue. */
export interface NativeDeps {
  db: Db
  queue: Queue
}

/** The database and the queue the upload route passes on. Routes never open the database themselves. */
export async function nativeDeps(): Promise<NativeDeps> {
  return { ...companionDeps(), queue: await getQueue() }
}

const NO_STORE = { 'cache-control': 'no-store' }
const fixed = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE })

export const AUDIO_FILE = 'audio.flac'
/** Each Whisper output file may be this big (the cap is applied while the body is read). */
export const MAX_TRANSCRIPT_FILE_BYTES = NATIVE_UPLOAD_MAX_FILE_BYTES

/** The directory a recording's files live in. `occurrenceId` comes from a job row, never from the request. */
const occurrenceDir = (occurrenceId: string) => resolve(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)

/**
 * `GET /api/companion/jobs/<id>/audio`: the cut audio, with `Range` for a resumed download. 404 unless this device holds
 * the live lease of a `native_transcription` job (a lapsed lease, another device and another member's device all get the
 * same answer), 410 when `audio.flac` is gone, is not a regular file or is not inside the occurrence directory.
 */
export async function handleAudioRequest(request: Request, scope: DeviceScope, jobId: string): Promise<Response> {
  const job = await scope.getClaimedJob(jobId)
  if (job === null || job.kind !== 'native_transcription') return notFound()
  const file = await openOccurrenceFile(occurrenceDir(job.occurrenceId), AUDIO_FILE)
  if (file === null) return fixed('audio_gone', 410)
  return serveFile(file, request.headers.get('range'), request.signal)
}

// --- Reading the upload ---

type UploadFailure = 'too_large' | 'malformed'

class UploadError extends Error {
  constructor(readonly failure: UploadFailure) {
    super(failure)
  }
}

/** Part headers are a line or two: anything longer is not from the companion. */
const MAX_PART_HEADER_BYTES = 2048
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/

/** The boundary of a `multipart/form-data` content type, or null. */
function boundaryOf(contentType: string | null): string | null {
  if (contentType === null) return null
  const [type, ...params] = contentType.split(';')
  if (type!.trim().toLowerCase() !== 'multipart/form-data') return null
  for (const param of params) {
    const match = /^\s*boundary\s*=\s*(?:"([^"]*)"|([^\s"]*))\s*$/i.exec(param)
    if (match) {
      const boundary = match[1] ?? match[2] ?? ''
      return BOUNDARY.test(boundary) && !boundary.endsWith(' ') ? boundary : null
    }
  }
  return null
}

/** The field name of a part from its headers; the only header that may appear besides `Content-Type`. */
function fieldOf(headers: string): (typeof NATIVE_UPLOAD_FIELDS)[number] {
  let name: string | null = null
  for (const line of headers.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 1) throw new UploadError('malformed')
    const key = line.slice(0, colon).trim().toLowerCase()
    if (key === 'content-type') continue
    if (key !== 'content-disposition' || name !== null) throw new UploadError('malformed')
    const value = line.slice(colon + 1)
    if (!/^\s*form-data\s*;/i.test(value)) throw new UploadError('malformed')
    const match = /;\s*name="([^"]*)"/i.exec(value)
    if (!match) throw new UploadError('malformed')
    name = match[1]!
  }
  const field = NATIVE_UPLOAD_FIELDS.find((f) => f === name)
  if (!field) throw new UploadError('malformed')
  return field
}

/**
 * Reads the multipart body as it arrives and stops at the first byte over a cap: `NATIVE_UPLOAD_MAX_BODY_BYTES` for the
 * whole body and `NATIVE_UPLOAD_MAX_FILE_BYTES` for each part. Nothing is held that the caps do not allow, and nothing
 * is written to disk here. Exactly the fields `txt`, `srt` and `json`, each once, in any order, no other part.
 */
async function readUpload(body: ReadableStream<Uint8Array>, boundary: string): Promise<Record<string, Buffer>> {
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const parts = new Map<string, Buffer>()
  const reader = body.getReader()
  // `consume` changes it, which the compiler can't see from the loop below.
  let state = 'delimiter' as 'delimiter' | 'headers' | 'body' | 'done'
  // The first delimiter has no CRLF in front of it in the stream, so one is supplied.
  let buffer = Buffer.from('\r\n')
  let total = 0
  let field: string | null = null
  let chunks: Buffer[] = []
  let size = 0

  const keep = (piece: Buffer) => {
    size += piece.length
    if (size > NATIVE_UPLOAD_MAX_FILE_BYTES) throw new UploadError('too_large')
    chunks.push(piece)
  }

  // Consumes what `buffer` holds; returns when more bytes are needed or the closing delimiter was seen.
  const consume = () => {
    for (;;) {
      if (state === 'delimiter') {
        if (buffer.length < delimiter.length + 2) return
        if (!buffer.subarray(0, delimiter.length).equals(delimiter)) throw new UploadError('malformed')
        const tail = buffer.subarray(delimiter.length, delimiter.length + 2).toString('latin1')
        if (tail === '--') {
          state = 'done'
          return
        }
        if (tail !== '\r\n') throw new UploadError('malformed')
        buffer = buffer.subarray(delimiter.length + 2)
        state = 'headers'
      } else if (state === 'headers') {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) {
          if (buffer.length > MAX_PART_HEADER_BYTES) throw new UploadError('malformed')
          return
        }
        if (end > MAX_PART_HEADER_BYTES) throw new UploadError('malformed')
        field = fieldOf(buffer.subarray(0, end).toString('latin1'))
        if (parts.has(field)) throw new UploadError('malformed')
        buffer = buffer.subarray(end + 4)
        chunks = []
        size = 0
        state = 'body'
      } else if (state === 'body') {
        const at = buffer.indexOf(delimiter)
        if (at >= 0) {
          keep(buffer.subarray(0, at))
          parts.set(field!, Buffer.concat(chunks))
          buffer = buffer.subarray(at)
          chunks = []
          state = 'delimiter'
          continue
        }
        // The delimiter may straddle two chunks: hold back as many bytes as it is long, less one.
        const safe = buffer.length - (delimiter.length - 1)
        if (safe > 0) {
          keep(buffer.subarray(0, safe))
          buffer = buffer.subarray(safe)
        }
        return
      } else return
    }
  }

  try {
    while (state !== 'done') {
      const { done, value } = await reader.read()
      if (done) throw new UploadError('malformed')
      total += value.byteLength
      if (total > NATIVE_UPLOAD_MAX_BODY_BYTES) throw new UploadError('too_large')
      buffer = Buffer.concat([buffer, value])
      consume()
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined)
    throw e
  }
  // Whatever follows the closing delimiter is not read.
  await reader.cancel().catch(() => undefined)
  return Object.fromEntries(parts)
}

type Transcript = Record<(typeof NATIVE_UPLOAD_FIELDS)[number], Buffer>

/** The upload as three files, each valid UTF-8, the `json` valid against the Whisper schema; else null. */
function validTranscript(parts: Record<string, Buffer>): Transcript | null {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (const field of NATIVE_UPLOAD_FIELDS) decoder.decode(parts[field]!)
    const json: unknown = JSON.parse(decoder.decode(parts.json!))
    if (!WhisperJsonSchema.safeParse(json).success) return null
  } catch (e) {
    if (e instanceof TypeError || e instanceof SyntaxError) return null
    throw e
  }
  return parts as Transcript
}

// --- Writing the upload ---

/** The upload cannot be taken now. `conflict` is a state that does not allow it, `gone` is a job that is not the device's. */
class Refusal extends Error {
  constructor(readonly kind: 'conflict' | 'gone') {
    super(kind)
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false
      throw e
    }
  )

/**
 * `<occurrence>/transcript/native`, made one component at a time. Each existing component must be a real directory (not
 * a link, not a file): a worker once wrote this tree, and a link here would send the write somewhere else.
 */
async function nativeDir(occDir: string): Promise<string> {
  const root = await lstat(occDir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  })
  if (!root?.isDirectory()) throw new Refusal('conflict')
  let current = occDir
  for (const part of ['transcript', 'native']) {
    current = join(current, part)
    const info = await lstat(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (info === null) await mkdir(current, { mode: 0o755 })
    else if (!info.isDirectory()) throw new Refusal('conflict')
  }
  if ((await realpath(current)) !== join(await realpath(occDir), 'transcript', 'native')) throw new Refusal('conflict')
  return current
}

/** A new file under a name this server makes up. `O_EXCL` refuses an existing name, a link included. */
async function writeTemp(dir: string, data: Buffer): Promise<string> {
  const path = join(dir, `.upload-${randomUUID()}.tmp`)
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644
  )
  try {
    await handle.writeFile(data)
  } catch (e) {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(() => undefined)
    throw e
  } finally {
    await handle.close().catch(() => undefined)
  }
  return path
}

/**
 * `POST /api/companion/jobs/<id>/transcript`: multipart fields `txt`, `srt`, `json`. 204 when it is taken; 404 unless
 * this device holds the live lease of the `native_transcription` job; 409 when the occurrence no longer waits for a
 * transcript, or one is already there; 413 over a cap; 400 for a body that is not the three files or a `json` that is
 * not Whisper output. Nothing is written before the body is valid.
 *
 * One transaction does the rest: the guarded `UPDATE` that completes the job (a second upload finds it `done` and
 * gets 404, and two at once cannot both win), `transcript_ready`, the three files (temporary names, then renamed;
 * `audio.json` last) and the pipeline job. Any failure rolls the transaction back and removes what was written, so the
 * job stays claimed and the PC may send again. `audio.flac` is deleted after the commit.
 */
export async function handleTranscriptRequest(
  request: Request,
  scope: DeviceScope,
  deps: NativeDeps,
  jobId: string
): Promise<Response> {
  const job = await scope.getClaimedJob(jobId)
  if (job === null || job.kind !== 'native_transcription') return fixed('not_found', 404)

  const boundary = boundaryOf(request.headers.get('content-type'))
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (!(declared <= NATIVE_UPLOAD_MAX_BODY_BYTES)) return fixed('body_too_large', 413)
  if (boundary === null || request.body === null) return fixed('invalid_upload', 400)
  let transcript: Transcript | null
  try {
    const parts = await readUpload(request.body, boundary)
    if (!NATIVE_UPLOAD_FIELDS.every((f) => parts[f] !== undefined)) return fixed('invalid_upload', 400)
    transcript = validTranscript(parts)
  } catch (e) {
    if (!(e instanceof UploadError)) throw e
    return e.failure === 'too_large' ? fixed('body_too_large', 413) : fixed('invalid_upload', 400)
  }
  if (transcript === null) return fixed('invalid_transcript', 400)

  const occDir = occurrenceDir(job.occurrenceId)
  const made: string[] = []
  try {
    await deps.db.transaction(async (tx) => {
      // Re-checked in the transaction: the lease may have lapsed while the body arrived.
      if ((await getClaimedJob(tx, scope.device, jobId)) === null || !(await completeJob(tx, jobId)))
        throw new Refusal('gone')
      try {
        await applyTrigger(tx, job.occurrenceId, 'transcript_ready')
      } catch (e) {
        if (e instanceof IllegalTransition) throw new Refusal('conflict')
        throw e
      }
      const dir = await nativeDir(occDir)
      if (await exists(join(dir, 'audio.json'))) throw new Refusal('conflict')

      const temps = new Map<string, string>()
      for (const ext of ['txt', 'srt', 'json'] as const) {
        const temp = await writeTemp(dir, transcript[ext])
        made.push(temp)
        temps.set(ext, temp)
      }
      await deps.queue.send(QUEUES.pipeline, { occurrenceId: job.occurrenceId }, { db: queueDbOf(tx) })
      // `audio.json` is what the pipeline looks for, so it is renamed last.
      for (const ext of ['txt', 'srt', 'json']) {
        const target = join(dir, `audio.${ext}`)
        await rename(temps.get(ext)!, target)
        made.push(target)
      }
    })
  } catch (e) {
    await Promise.all(made.map((path) => unlink(path).catch(() => undefined)))
    if (e instanceof Refusal) return e.kind === 'gone' ? fixed('not_found', 404) : fixed('conflict', 409)
    throw e
  }
  // The transcript is stored: the audio is not needed any more. A failure here only leaves a file behind.
  await unlink(join(occDir, AUDIO_FILE)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') console.error(`native transcript: audio.flac not removed (${e.code ?? 'error'})`)
  })
  return new Response(null, { status: 204, headers: NO_STORE })
}
