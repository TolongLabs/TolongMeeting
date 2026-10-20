import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  IllegalTransition,
  NATIVE_UPLOAD_MAX_FILE_BYTES,
  PreflightReportSchema,
  UPLOAD_CHUNK_MAX_BYTES,
  WhisperJsonSchema,
  meetingUrl,
  shortTime,
  type CompanionJob,
  type DeviceAuth,
  type OccurrenceTrigger,
  type PreflightReport
} from '@tm/core'
import { pings } from '@tm/notify'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { completeJob, getClaimedJob, type Db } from '../../db/companion'
import { deviceName } from '../../db/local-runs'
import { appNotifier, type Notifier } from '../../db/notifier'
import { QUEUES, queueDbOf, type Queue } from '../../db/queues'
import { companionJobs, occurrences } from '../../db/schema'
import { applyTrigger } from '../../db/transitions'
import { MAX_BODY_BYTES, handleDeviceHeartbeat } from '../control'
import { getQueue } from '../queue'
import { companionDeps } from './deps'
import { StreamDeadline, deadlineReader, type Deadlines } from './deadline'
import type { DeviceScope } from './scope'
import { readCapped } from './tokens'

// The server side of a meeting that runs on the member's PC (plan 08 T3): heartbeats through the PC, the PC's Docker
// pre-flight report, the chunked upload of what the run wrote, and the completion that hands the occurrence to the
// pipeline. Every route here is for the device that holds the live `local_run` job, and answers anyone else with a
// fixed 404. Everything the PC sends is untrusted: a path comes from an allow-list, a range from a strict grammar, and
// no answer or log line carries a token, a file's content, a path or a meeting link.

const NO_STORE = { 'cache-control': 'no-store' }
const fixed = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE })

export { UPLOAD_CHUNK_MAX_BYTES }

/** What the local-run routes run on. */
export interface LocalRunDeps {
  db: Db
  queue: Queue
  notifier: Notifier
  publicUrl: string
  /** `$TM_DATA_ROOT`: the uploads land in `<dataRoot>/occurrences/<occurrenceId>/`. */
  dataRoot: string
  /** Test seam: shorter limits than `IDLE_MS` and `TOTAL_MS` for a chunk body. */
  deadlines?: Deadlines
}

/** The database, the queue, the notifier and the server's paths, read per request. Routes never open the database. */
export async function localRunDeps(env: Record<string, string | undefined> = process.env): Promise<LocalRunDeps> {
  const need = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
  }
  return {
    ...companionDeps(),
    queue: await getQueue(),
    notifier: appNotifier(),
    publicUrl: need('TM_PUBLIC_URL'),
    dataRoot: need('TM_DATA_ROOT')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type LocalJob = CompanionJob & { kind: 'local_run' }

/** The `local_run` job this device holds, else `null`. */
async function heldRun(db: Db, device: DeviceAuth, jobId: string, now: Date = new Date()): Promise<LocalJob | null> {
  if (!UUID.test(jobId)) return null
  const job = await getClaimedJob(db, device, jobId, now)
  return job !== null && job.kind === 'local_run' ? job : null
}

// --- Upload paths and caps ---

/** The only paths a local run may upload, relative to its occurrence folder. */
const UPLOAD_PATTERNS: readonly RegExp[] = [
  /^recording\/meeting\.mkv$/,
  /^recording\/attempt_\d+_seg_\d{3}\.mkv$/,
  /^frames\/\d{4}_\d{6}\.png$/,
  /^(?:chat|events)\.jsonl$/,
  /^forms\/[A-Za-z0-9_-]+\/(?:record\.json|filled\.png|confirmation\.png)$/,
  /^transcript\/live\.jsonl$/,
  /^transcript\/native\/audio\.(?:txt|srt|json)$/
]

/** True for exactly the allowed files: nothing with `..`, a backslash, a leading slash or a NUL passes. */
export function isUploadPath(relPath: string): boolean {
  return UPLOAD_PATTERNS.some((pattern) => pattern.test(relPath))
}

const MB = 1024 ** 2
const GB = 1024 ** 3
/** All the files of one occurrence together. */
export const OCCURRENCE_UPLOAD_MAX_BYTES = 12 * GB

/** The most one file of this path may hold. */
export function fileCap(relPath: string): number {
  if (relPath.startsWith('recording/')) return 8 * GB
  if (relPath.startsWith('transcript/native/')) return NATIVE_UPLOAD_MAX_FILE_BYTES
  if (relPath.startsWith('frames/') || relPath.endsWith('.png')) return 20 * MB
  if (relPath.startsWith('forms/')) return 10 * MB
  return 256 * MB // chat.jsonl, events.jsonl, transcript/live.jsonl
}

/** `bytes <start>-<end>/<total>`, nothing else: plain digits, `start <= end < total`, a chunk of at most 16 MiB. */
function parseRange(header: string): { start: number; end: number; total: number } | null {
  const m = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(header)
  if (m === null) return null
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!(start <= end && end < total && end - start + 1 <= UPLOAD_CHUNK_MAX_BYTES)) return null
  return { start, end, total }
}

// --- The occurrence folder ---

const occurrencesRoot = (deps: Pick<LocalRunDeps, 'dataRoot'>) => resolve(deps.dataRoot, 'occurrences')

class Refusal extends Error {}

const lstatOrNull = (path: string) =>
  lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  })

/**
 * `<occurrences>/<id>/<parts…>`, one component at a time. Every existing component must be a real directory (never a
 * link: the tree was once written by a worker). With `create`, a missing one is made. Returns `null` when a component
 * is missing (and not created); throws `Refusal` for a link, a file in the way or a path that resolves elsewhere.
 */
async function folder(
  deps: Pick<LocalRunDeps, 'dataRoot'>,
  occurrenceId: string,
  parts: string[],
  create: boolean
): Promise<string | null> {
  const root = occurrencesRoot(deps)
  const names = [occurrenceId, ...parts]
  let current = root
  for (const [i, name] of ['', ...names].entries()) {
    if (i > 0) current = join(current, name)
    const info = await lstatOrNull(current)
    if (info === null) {
      if (!create) return null
      await mkdir(current, { mode: 0o755, recursive: i === 0 })
    } else if (!info.isDirectory()) throw new Refusal()
  }
  const real = await realpath(current)
  if (real !== join(await realpath(root), ...names)) throw new Refusal()
  return current
}

/** The size of the regular file `<dir>/<name>`, `null` when absent; a link or other thing in its place is a `Refusal`. */
async function sizeOf(dir: string, name: string): Promise<number | null> {
  const info = await lstatOrNull(join(dir, name))
  if (info === null) return null
  if (!info.isFile()) throw new Refusal()
  return info.size
}

const split = (relPath: string) => {
  const parts = relPath.split('/')
  return { dirs: parts.slice(0, -1), name: parts.at(-1)! }
}

/** Every regular file under the occurrence folder together, except `<skip>` and its `.part`. */
async function occurrenceBytes(occDir: string, skip: string): Promise<number> {
  let total = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const entry of await readdir(rel === '' ? occDir : join(occDir, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (path === skip || path === `${skip}.part`) continue
      if (entry.isDirectory() && depth < 4) await walk(path, depth + 1)
      else if (entry.isFile()) total += (await lstat(join(occDir, path))).size
    }
  }
  await walk('', 0)
  return total
}

// --- Heartbeat ---

/**
 * `POST /api/companion/jobs/<id>/heartbeat`: the capped JSON body goes to `handleDeviceHeartbeat`. The reply is the
 * worker's `HeartbeatReply`, or a fixed 400, 404 or 410.
 */
export async function handleHeartbeatRequest(
  request: Request,
  scope: DeviceScope,
  deps: LocalRunDeps,
  jobId: string,
  now: Date = new Date()
): Promise<Response> {
  if (!UUID.test(jobId)) return fixed('not_found', 404)
  const raw = await readCapped(request, MAX_BODY_BYTES)
  if (raw === null) return fixed('invalid request', 400)
  let body: unknown = null
  if (raw !== '') {
    try {
      body = JSON.parse(raw)
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
    }
  }
  const result = await handleDeviceHeartbeat({ ...deps, now }, scope.device, jobId, body)
  return Response.json(result.body, { status: result.status, headers: NO_STORE })
}

// --- Pre-flight ---

const PREFLIGHT_MAX_BODY_BYTES = 1024
/** The PC has until this long before the meeting to fix what it reported. */
const FIX_BEFORE_MS = 10 * 60_000

/**
 * What the PC says about its own readiness. `ok` clears the stored problem. `docker_unavailable` and
 * `image_unavailable` are stored on the job and the member is pinged when the problem is new, not on every repeat.
 * `docker_memory_low` cannot be fixed by waiting: the job and the occurrence fail and the member is pinged. `false`
 * when this device does not hold the job.
 */
export async function recordPreflight(
  deps: LocalRunDeps,
  device: DeviceAuth,
  jobId: string,
  report: PreflightReport,
  now: Date = new Date()
): Promise<boolean> {
  const job = await heldRun(deps.db, device, jobId, now)
  if (job === null) return false
  const entry = job.payload.job.entry
  const ping = async (reason: PreflightReport['reason']) => {
    const when = shortTime(entry.start, entry.timeZone)
    const url = meetingUrl(deps.publicUrl, job.occurrenceId)
    const pcName = (await deviceName(deps.db, device.deviceId)) ?? 'your PC'
    if (reason === 'docker_unavailable') {
      const deadline = shortTime(new Date(Date.parse(entry.start) - FIX_BEFORE_MS).toISOString(), entry.timeZone)
      return pings.dockerNotRunning({ entry: entry.name, when, pcName, deadline, meetingUrl: url })
    }
    if (reason === 'docker_memory_low') {
      return pings.dockerMemoryLow({
        entry: entry.name,
        when,
        pcName,
        dockerBytes: report.dockerMemBytes ?? 0,
        meetingUrl: url
      })
    }
    return pings.botSoftwareUnavailable({ entry: entry.name, when, pcName, meetingUrl: url })
  }
  const mine = and(
    eq(companionJobs.id, jobId),
    eq(companionJobs.deviceId, device.deviceId),
    eq(companionJobs.state, 'claimed')
  )

  if (report.reason === 'ok') {
    await deps.db.update(companionJobs).set({ error: null, updatedAt: now }).where(mine)
    return true
  }
  if (report.reason !== 'docker_memory_low') {
    // Only a change of problem is news: the update matches only when the stored one differs.
    const changed = await deps.db
      .update(companionJobs)
      .set({ error: report.reason, updatedAt: now })
      .where(and(mine, or(isNull(companionJobs.error), ne(companionJobs.error, report.reason))))
      .returning({ id: companionJobs.id })
    if (changed.length === 1) await deps.notifier.notify(device.memberId, await ping(report.reason))
    return true
  }
  const failed = await deps.db.transaction(async (tx) => {
    await tx.select({ id: occurrences.id }).from(occurrences).where(eq(occurrences.id, job.occurrenceId)).for('update')
    const rows = await tx
      .update(companionJobs)
      .set({ state: 'failed', error: 'docker_memory_low', updatedAt: now })
      .where(mine)
      .returning({ id: companionJobs.id })
    if (rows.length !== 1) return false
    try {
      await applyTrigger(tx, job.occurrenceId, 'fail', { reason: 'docker_memory_low' })
    } catch (e) {
      if (!(e instanceof IllegalTransition)) throw e
    }
    return true
  })
  if (failed) await deps.notifier.notify(device.memberId, await ping('docker_memory_low'))
  return true
}

/** `POST /api/companion/jobs/<id>/preflight`: 204, or 400 for a body that is not a report, or 404. */
export async function handlePreflightRequest(
  request: Request,
  scope: DeviceScope,
  deps: LocalRunDeps,
  jobId: string
): Promise<Response> {
  if ((await heldRun(deps.db, scope.device, jobId)) === null) return fixed('not_found', 404)
  const raw = await readCapped(request, PREFLIGHT_MAX_BODY_BYTES)
  if (raw === null) return fixed('invalid_report', 400)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return fixed('invalid_report', 400)
  }
  const report = PreflightReportSchema.safeParse(body)
  if (!report.success) return fixed('invalid_report', 400)
  if (!(await recordPreflight(deps, scope.device, jobId, report.data))) return fixed('not_found', 404)
  return new Response(null, { status: 204, headers: NO_STORE })
}

// --- Uploads ---

/** Files being written right now, by `<job>/<path>`: a second request for one of them is refused, not queued. */
const writing = new Set<string>()

/**
 * How many bytes of `relPath` the website holds for this run: the finished file's size, else the `.part` file's, else 0.
 * `null` (a 404) when this device does not hold the job, the path is not allowed, or something in the folder is a link.
 */
export async function uploadOffset(
  deps: Pick<LocalRunDeps, 'db' | 'dataRoot'>,
  device: DeviceAuth,
  jobId: string,
  relPath: string
): Promise<number | null> {
  const job = await heldRun(deps.db, device, jobId)
  if (job === null || !isUploadPath(relPath)) return null
  const { dirs, name } = split(relPath)
  try {
    const dir = await folder(deps, job.occurrenceId, dirs, false)
    if (dir === null) return 0
    return (await sizeOf(dir, name)) ?? (await sizeOf(dir, `${name}.part`)) ?? 0
  } catch (e) {
    if (e instanceof Refusal) return null
    throw e
  }
}

export type UploadResult = { status: 204 | 400 | 404 | 408 | 409 | 413; offset: number }

/**
 * One chunk of a file: `contentRange` is `bytes <start>-<end>/<total>`. The chunk is taken only when `start` is the
 * server's offset (a gap or an overlap is a 409 with that offset), the file stays within its cap and the occurrence
 * within its total cap, the body has exactly `end - start + 1` bytes, and the device still holds the job. The bytes go
 * to `<path>.part`; the file is renamed to its name when `end + 1 === total`. A failed chunk leaves `.part` as it was.
 */
export async function appendUpload(
  deps: LocalRunDeps,
  device: DeviceAuth,
  jobId: string,
  relPath: string,
  contentRange: string,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadResult> {
  const job = await heldRun(deps.db, device, jobId)
  if (job === null) return { status: 404, offset: 0 }
  if (!isUploadPath(relPath)) return { status: 400, offset: 0 }
  const range = parseRange(contentRange)
  if (range === null || body === null) return { status: 400, offset: 0 }
  if (range.total > fileCap(relPath)) return { status: 413, offset: 0 }

  const key = `${jobId}/${relPath}`
  if (writing.has(key)) return { status: 409, offset: (await uploadOffset(deps, device, jobId, relPath)) ?? 0 }
  writing.add(key)
  try {
    return await writeChunk(deps, device, job, relPath, range, body)
  } catch (e) {
    if (e instanceof Refusal) return { status: 409, offset: 0 }
    throw e
  } finally {
    writing.delete(key)
  }
}

async function writeChunk(
  deps: LocalRunDeps,
  device: DeviceAuth,
  job: LocalJob,
  relPath: string,
  range: { start: number; end: number; total: number },
  body: ReadableStream<Uint8Array>
): Promise<UploadResult> {
  const { dirs, name } = split(relPath)
  const dir = (await folder(deps, job.occurrenceId, dirs, true))!
  // A finished file is never extended or replaced.
  const done = await sizeOf(dir, name)
  if (done !== null) return { status: 409, offset: done }

  const part = join(dir, `${name}.part`)
  const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644).catch((e) => {
    // ELOOP: the `.part` name is a link (planted by a worker that once wrote this tree).
    throw (e as NodeJS.ErrnoException).code === 'ELOOP' ? new Refusal() : e
  })
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Refusal()
    if (info.size !== range.start) return { status: 409, offset: info.size }
    const occDir = join(occurrencesRoot(deps), job.occurrenceId)
    if ((await occurrenceBytes(occDir, relPath)) + range.end + 1 > OCCURRENCE_UPLOAD_MAX_BYTES) {
      return { status: 413, offset: info.size }
    }

    const expected = range.end - range.start + 1
    const reader = deadlineReader(body, deps.deadlines)
    let written = 0
    let failure: UploadResult['status'] | null = null
    try {
      while (failure === null) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        if (written + value.byteLength > expected) failure = 400
        else {
          await handle.write(value, 0, value.byteLength, range.start + written)
          written += value.byteLength
        }
      }
    } catch (e) {
      if (!(e instanceof StreamDeadline)) throw e
      failure = 408
    } finally {
      if (failure !== null) await reader.cancel()
    }
    if (failure === null && written !== expected) failure = 400
    // The lease is checked again after the body: it may have ended while the chunk arrived.
    if (failure === null && (await heldRun(deps.db, device, job.id)) === null) failure = 404
    if (failure !== null) {
      await handle.truncate(range.start)
      return { status: failure, offset: range.start }
    }
  } finally {
    await handle.close()
  }
  if (range.end + 1 === range.total) await rename(part, join(dir, name))
  return { status: 204, offset: range.end + 1 }
}

/** `HEAD` and `PUT` of `/api/companion/jobs/<id>/files/<path>`. */
export async function handleFilesRequest(
  request: Request,
  scope: DeviceScope,
  deps: LocalRunDeps,
  jobId: string,
  segments: string[]
): Promise<Response> {
  const relPath = segments.join('/')
  if (request.method === 'HEAD') {
    const offset = await uploadOffset(deps, scope.device, jobId, relPath)
    if (offset === null) return new Response(null, { status: 404, headers: NO_STORE })
    return new Response(null, { status: 200, headers: { ...NO_STORE, 'upload-offset': String(offset) } })
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (!(declared <= UPLOAD_CHUNK_MAX_BYTES)) {
    // Checked before the job so a refused body costs nothing, but a stranger still learns nothing from the answer.
    return (await heldRun(deps.db, scope.device, jobId)) === null
      ? fixed('not_found', 404)
      : fixed('chunk_too_large', 413)
  }
  const result = await appendUpload(
    deps,
    scope.device,
    jobId,
    relPath,
    request.headers.get('content-range') ?? '',
    request.body
  )
  if (result.status === 204) return new Response(null, { status: 204, headers: NO_STORE })
  const headers = result.status === 409 ? { ...NO_STORE, 'upload-offset': String(result.offset) } : NO_STORE
  const error = { 400: 'invalid_upload', 404: 'not_found', 408: 'body_too_slow', 409: 'out_of_step', 413: 'too_large' }[
    result.status
  ]
  return Response.json({ error }, { status: result.status, headers })
}

// --- Completion ---

const NATIVE_FILES = ['transcript/native/audio.txt', 'transcript/native/audio.srt', 'transcript/native/audio.json']

/** Whether `relPath` is a finished regular file of this run. */
async function finished(deps: Pick<LocalRunDeps, 'dataRoot'>, occurrenceId: string, relPath: string): Promise<boolean> {
  const { dirs, name } = split(relPath)
  try {
    const dir = await folder(deps, occurrenceId, dirs, false)
    return dir !== null && (await sizeOf(dir, name)) !== null
  } catch (e) {
    if (e instanceof Refusal) return false
    throw e
  }
}

/** The files the run still has to upload before it can complete. */
async function missingFiles(deps: LocalRunDeps, job: LocalJob): Promise<string[]> {
  const missing: string[] = []
  if (!(await finished(deps, job.occurrenceId, 'events.jsonl'))) missing.push('events.jsonl')
  const native = job.payload.job.entry.transcription === 'native'
  if (native && (await finished(deps, job.occurrenceId, 'recording/meeting.mkv'))) {
    for (const file of NATIVE_FILES) if (!(await finished(deps, job.occurrenceId, file))) missing.push(file)
    if (missing.length === 0) {
      // The pipeline reads the segments: the file must be Whisper output, not just a file of the right name.
      const dir = (await folder(deps, job.occurrenceId, ['transcript', 'native'], false))!
      const text = await readFile(join(dir, 'audio.json'), 'utf8')
      try {
        if (!WhisperJsonSchema.safeParse(JSON.parse(text)).success) missing.push(NATIVE_FILES[2]!)
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e
        missing.push(NATIVE_FILES[2]!)
      }
    }
  }
  return missing
}

/** The in-meeting states a run may still be in when its files arrive, and the trigger that leaves each. */
const TOWARDS_UPLOADING: Partial<Record<string, OccurrenceTrigger>> = { in_meeting: 'meeting_over', leaving: 'left' }

class WrongState extends Error {}

/**
 * The PC says the upload is whole. The required files (`events.jsonl`, and in native mode with a recording the three
 * transcript files, `audio.json` valid) must be finished; otherwise `{ ok: false, missing }`. Then, in one transaction,
 * the guarded `UPDATE` that completes the job (a repeat finds it `done` and gets `null`), the move to `uploading` if
 * the run's last states were lost, `uploaded`, and the pipeline job. `null` when this device does not hold the job;
 * `'conflict'` when the occurrence is in a state the upload cannot move on from.
 */
export async function completeLocalRun(
  deps: LocalRunDeps,
  device: DeviceAuth,
  jobId: string,
  now: Date = new Date()
): Promise<{ ok: true } | { ok: false; missing: string[] } | 'conflict' | null> {
  const job = await heldRun(deps.db, device, jobId, now)
  if (job === null) return null
  const missing = await missingFiles(deps, job)
  if (missing.length > 0) return { ok: false, missing }
  try {
    const moved = await deps.db.transaction(async (tx) => {
      await tx
        .select({ id: occurrences.id })
        .from(occurrences)
        .where(eq(occurrences.id, job.occurrenceId))
        .for('update')
      if (!(await completeJob(tx, device, jobId, now))) return false
      const [occ] = await tx
        .select({ state: occurrences.state })
        .from(occurrences)
        .where(eq(occurrences.id, job.occurrenceId))
      let state = occ!.state
      while (state !== 'uploading') {
        const trigger = TOWARDS_UPLOADING[state]
        if (trigger === undefined) throw new WrongState()
        state = (await applyTrigger(tx, job.occurrenceId, trigger)).to
      }
      await applyTrigger(tx, job.occurrenceId, 'uploaded')
      await deps.queue.send(QUEUES.pipeline, { occurrenceId: job.occurrenceId }, { db: queueDbOf(tx) })
      return true
    })
    return moved ? { ok: true } : null
  } catch (e) {
    if (e instanceof WrongState || e instanceof IllegalTransition) return 'conflict'
    throw e
  }
}

/** `POST /api/companion/jobs/<id>/complete`: 204, 400 with `{ missing }`, 404, or 409. */
export async function handleCompleteRequest(scope: DeviceScope, deps: LocalRunDeps, jobId: string): Promise<Response> {
  const result = await completeLocalRun(deps, scope.device, jobId)
  if (result === null) return fixed('not_found', 404)
  if (result === 'conflict') return fixed('conflict', 409)
  if (!result.ok) return Response.json({ missing: result.missing }, { status: 400, headers: NO_STORE })
  return new Response(null, { status: 204, headers: NO_STORE })
}
