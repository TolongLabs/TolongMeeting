import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { OccurrenceIdSchema, type CompanionJob, type Heartbeat } from '@tm/core'
import { CompanionApiError, type CompanionApi } from '../api'
import { isMissing, writeFileAtomic } from '../atomic'
import { collectOutputs, buildWhisperArgv, runWhisper, whisperTimeoutMs, type SpawnLike } from '../jobs/whisper'
import type { Settings } from '../settings'
import { DockerError, imageRefOk, UnsafeDockerInput, type DockerLike } from './docker'
import { uploadFile, uploadSet, type UploadApi } from './upload'

// After a local meeting: send what the run wrote to the website, cut the audio and transcribe it on this PC when the
// meeting is in native mode, tell the website the run is whole (or failed), and only then delete the local copy. A
// failure that may pass (the network, a 5xx) is tried again every `retryMs`; anything else stops with the data kept,
// so a later call resumes at the offsets the website reports. No message here carries a path, a link or a token.

export type LocalJob = CompanionJob & { kind: 'local_run' }
export type LocalOutcome = 'ended' | 'crashed'

export type AfterApi = UploadApi & Pick<CompanionApi, 'complete' | 'fail' | 'heartbeat'>

export interface AfterDeps {
  api: AfterApi
  docker: DockerLike
  /** Only a worker image under this repository cuts the audio (the app's `TM_WORKER_IMAGE_PREFIX`). */
  imagePrefix: string
  settings: () => Settings
  spawn: SpawnLike
  report(state: 'uploading' | 'transcribing'): Promise<void>
  /** Wait between tries of a failed request. Default 60000. */
  retryMs?: number
  /** Stops the work (the app is quitting or unpaired): the next step throws an `AbortError`. The data stays for the next start. */
  signal?: AbortSignal
  /** Chunk size for uploads. Default `UPLOAD_CHUNK_MAX_BYTES`. */
  chunkBytes?: number
  /** How long the FLAC cut may take, in ms. Default `flacTimeoutMs(meeting length)`. */
  flacTimeoutMs?: number
}

/** The website still lacks files after `complete`. The local data stays. */
export class IncompleteUploadError extends Error {
  constructor(readonly missing: string[]) {
    super(`The website is still missing ${missing.length} file(s)`)
    this.name = 'IncompleteUploadError'
  }
}

const WHISPER_TRIES = 2
const RETRY_MS = 60_000
const FLAC_PIDS_LIMIT = '64'
const FLAC_MEMORY = '1g'
const TRANSCRIPT_FILES = ['audio.txt', 'audio.srt', 'audio.json'] as const

/**
 * The ffmpeg arguments that cut a recording's audio into 48 kHz mono FLAC. These are the flags the website uses for
 * the same cut (`flacArgs` in `packages/pipeline/src/native/flac.ts`, with the base flags of its `tool`): read the input
 * as Matroska through the `file` protocol only, take the first audio stream, drop the video, no `-y`.
 */
export function ffmpegFlacArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'matroska',
    '-protocol_whitelist',
    'file',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'flac',
    output
  ]
}

export const flacContainerName = (occurrenceId: string): string => `tm-flac-${occurrenceId}`

/**
 * The `docker run` arguments that cut the FLAC with the worker image, offline: no network, no capabilities, only this
 * occurrence's own folder mounted (as `/tm/data`), `ffmpeg` in place of the image's entrypoint. Detached: the caller
 * waits for it with `docker.wait`, for as long as the recording needs. They pass `checkRunArgs` as they are. An image
 * outside `imagePrefix` is refused here, before any list exists.
 */
export function flacArgs(o: { image: string; imagePrefix: string; dataDir: string; occurrenceId: string }): string[] {
  if (!imageRefOk(o.image, o.imagePrefix)) throw new UnsafeDockerInput('an image reference')
  return [
    'run',
    '-d',
    '--name',
    flacContainerName(o.occurrenceId),
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    FLAC_PIDS_LIMIT,
    '--memory',
    FLAC_MEMORY,
    '--pull',
    'never',
    '-v',
    `${occurrenceDir(o.dataDir, o.occurrenceId)}:/tm/data`,
    '--entrypoint',
    'ffmpeg',
    o.image,
    ...ffmpegFlacArgs('/tm/data/recording/meeting.mkv', '/tm/data/audio.flac')
  ]
}

/** How long the FLAC cut may take: the audio encodes far faster than it plays, so the meeting's length plus 10 minutes, at most 6 hours. */
export function flacTimeoutMs(durationSec: number): number {
  return Math.min(6 * 3_600_000, 600_000 + durationSec * 1000)
}

/** `<dataDir>/occurrences/<occurrenceId>`. */
export function occurrenceDir(dataDir: string, occurrenceId: string): string {
  return join(dataDir, 'occurrences', OccurrenceIdSchema.parse(occurrenceId))
}

/**
 * Whether a run that was cut off by a restart still has local data, and how it ended: `ended` when the worker joined
 * its recording into `meeting.mkv`, else `crashed`. `null` when there is nothing left to send.
 */
export async function resumeOutcome(job: LocalJob, dataDir: string): Promise<LocalOutcome | null> {
  const occDir = occurrenceDir(dataDir, job.payload.occurrenceId)
  if (!(await isRealDir(occDir))) return null
  return (await isRegular(join(occDir, 'recording', 'meeting.mkv'))) ? 'ended' : 'crashed'
}

async function lastAttempt(occDir: string, fallback: number): Promise<number> {
  let names: string[] = []
  try {
    names = await readdir(join(occDir, 'recording'))
  } catch (e) {
    if (!isMissing(e)) throw e
  }
  const seen = names.map((n) => /^attempt_(\d{1,6})_seg_\d{3}\.mkv$/.exec(n)?.[1]).filter((n) => n !== undefined)
  return Math.max(fallback, ...seen.map(Number))
}

/**
 * `report` for `finishLocalRun`: a heartbeat sent by the PC itself, so it works after the relay has closed or the app
 * restarted. It names the last attempt that left a segment, and carries no events.
 */
export function localReporter(
  api: Pick<CompanionApi, 'heartbeat'>,
  job: LocalJob,
  dataDir: string
): (state: 'uploading' | 'transcribing') => Promise<void> {
  return async (state) => {
    const occurrenceId = job.payload.occurrenceId
    const attempt = await lastAttempt(occurrenceDir(dataDir, occurrenceId), job.payload.job.attempt)
    const hb: Heartbeat = { occurrenceId, attempt, state, recording: false, participants: null, events: [] }
    await api.heartbeat(job.id, hb)
  }
}

// --- Retrying ---

/** A failure that may pass: the network, a timeout, or a server error. */
function isTransient(e: unknown): boolean {
  if (e instanceof CompanionApiError) return e.status >= 500 || e.status === 408 || e.status === 429
  return (
    e instanceof TypeError || (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'NetworkError'))
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Removes `path` like `rm -rf`. On Windows a file a process had open (the FLAC cut, a stopped container's bind mount)
 * can stay locked for a moment after that process ends, so EBUSY and EPERM are retried for up to two seconds.
 */
async function removePath(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rm(path, { recursive: true, force: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 10) throw e
      await sleep(200)
    }
  }
}

/** Runs `step` until it works. A failure that may pass waits `retryMs` and goes again; any other failure is thrown. */
async function persist<T>(d: AfterDeps, step: () => Promise<T>): Promise<T> {
  for (;;) {
    d.signal?.throwIfAborted()
    try {
      return await step()
    } catch (e) {
      if (!isTransient(e) || d.signal?.aborted) throw e
      await sleep(d.retryMs ?? RETRY_MS, d.signal)
      if (d.signal?.aborted) throw e
    }
  }
}

// --- Local files ---

async function isRealDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (e) {
    if (isMissing(e)) return false
    throw e
  }
}

/** Makes `<occDir>/<parts…>` real folders, replacing a link or file a worker left in the way. */
async function ensureDirs(occDir: string, parts: string[]): Promise<string> {
  let at = occDir
  for (const part of parts) {
    at = join(at, part)
    if (!(await isRealDir(at))) {
      await rm(at, { recursive: true, force: true })
      await mkdir(at, { mode: 0o700 })
    }
  }
  return at
}

async function isRegular(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (e) {
    if (isMissing(e)) return false
    throw e
  }
}

/** Deletes the run's folder when it is `<dataDir>/occurrences/<id>` for real. A link in its place is only unlinked. */
async function deleteRun(dataDir: string, occDir: string): Promise<void> {
  const st = await lstat(occDir).catch((e: unknown) => (isMissing(e) ? null : Promise.reject(e)))
  if (st === null) return
  if (st.isSymbolicLink()) return void (await rm(occDir, { force: true }))
  const home = await realpath(dataDir)
  if (!(await realpath(occDir)).startsWith(home + sep)) throw new Error('The run folder is outside the data folder')
  await removePath(occDir)
}

async function transcriptOnDisk(occDir: string): Promise<boolean> {
  const dir = join(occDir, 'transcript', 'native')
  if (!(await isRealDir(join(occDir, 'transcript'))) || !(await isRealDir(dir))) return false
  for (const name of TRANSCRIPT_FILES) if (!(await isRegular(join(dir, name)))) return false
  return true
}

function durationSec(job: LocalJob): number {
  const { start, end } = job.payload.job.entry
  return Math.max(60, (Date.parse(end) - Date.parse(start)) / 1000)
}

/**
 * Cuts the FLAC in a detached container and waits for it up to `flacTimeoutMs`. True when ffmpeg exited 0. A container
 * that outlives the limit or the stop signal is removed (`rm --force` kills it) whatever happens.
 */
async function cutFlac(d: AfterDeps, job: LocalJob, dataDir: string): Promise<boolean> {
  const name = flacContainerName(job.payload.occurrenceId)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await d.docker.rm(name)
    await d.docker.run(
      flacArgs({
        image: job.payload.image,
        imagePrefix: d.imagePrefix,
        dataDir,
        occurrenceId: job.payload.occurrenceId
      })
    )
    const exited = d.docker.wait(name)
    exited.catch(() => {}) // a wait that fails after the race is over is not news
    const limit = new Promise<'timeout'>(
      (resolve) => (timer = setTimeout(() => resolve('timeout'), d.flacTimeoutMs ?? flacTimeoutMs(durationSec(job))))
    )
    const stopped = new Promise<'stopped'>((resolve) => {
      onAbort = () => resolve('stopped')
      if (d.signal?.aborted) onAbort()
      else d.signal?.addEventListener('abort', onAbort, { once: true })
    })
    const result = await Promise.race([exited, limit, stopped])
    if (result === 'stopped') throw new DOMException('The audio cut was stopped', 'AbortError')
    return result === 0
  } catch (e) {
    if (e instanceof DockerError) return false
    throw e
  } finally {
    clearTimeout(timer)
    if (onAbort) d.signal?.removeEventListener('abort', onAbort)
    await d.docker.rm(name)
  }
}

/**
 * One try at the native transcript: cut the FLAC in a container, run the member's transcriber, and keep the three
 * outputs in `transcript/native`. Returns false when this try failed in a way another try may fix. The FLAC and the
 * transcriber's scratch folder are removed whatever happens.
 */
async function transcribeOnce(d: AfterDeps, job: LocalJob, dataDir: string, occDir: string): Promise<boolean> {
  const whisper = d.settings().whisper
  if (whisper.cwd === null) return false
  const flac = join(occDir, 'audio.flac')
  let scratch: string | null = null
  try {
    await removePath(flac)
    for (const stale of (await readdir(occDir)).filter((n) => n.startsWith('.whisper-'))) {
      await removePath(join(occDir, stale))
    }
    if (!(await cutFlac(d, job, dataDir)) || !(await isRegular(flac))) return false

    scratch = await mkdtemp(join(occDir, '.whisper-'))
    const argv = buildWhisperArgv(whisper.command, { audio: flac, model: whisper.model, outDir: scratch })
    const ran = await runWhisper({
      argv,
      cwd: whisper.cwd,
      timeoutMs: whisperTimeoutMs(durationSec(job)),
      spawn: d.spawn,
      signal: d.signal
    })
    if (!ran.ok) {
      if (ran.stopped) throw new DOMException('The transcriber was stopped', 'AbortError')
      return false
    }
    const out = await collectOutputs(scratch)
    if (!out.ok) return false
    const dir = await ensureDirs(occDir, ['transcript', 'native'])
    // The outputs are written whole or not at all, so a restart never finds half a transcript.
    await writeFileAtomic(join(dir, 'audio.json'), out.files.json, 0o600)
    await writeFileAtomic(join(dir, 'audio.srt'), out.files.srt, 0o600)
    await writeFileAtomic(join(dir, 'audio.txt'), out.files.txt, 0o600)
    return true
  } finally {
    await removePath(flac)
    if (scratch !== null) await removePath(scratch)
  }
}

async function sendFiles(d: AfterDeps, job: LocalJob, occDir: string, files: string[]): Promise<void> {
  for (const rel of files) await persist(d, () => uploadFile(d.api, job.id, occDir, rel, d.chunkBytes, d.signal))
}

/**
 * Sends a finished local meeting to the website, then removes it from this PC.
 *
 * `ended`: report `uploading`, send the run's files; in native mode with a recording, report `transcribing`, cut the
 * FLAC, run the transcriber (two tries) and send `transcript/native/audio.{txt,srt,json}`; then `complete`. After two
 * failed tries the job is failed as `native_transcription_failed`, since the website has the recording already.
 * `crashed`: send what exists, fail the job as `worker_crashed`, never transcribe.
 *
 * The local folder is deleted only after `complete` or `fail` was accepted. When this throws (a job the website no
 * longer gives this PC, a refused file, a stop signal) the data stays, and calling this again resumes: each file
 * continues at the offset the website reports and a finished local transcript is not made again.
 */
export async function finishLocalRun(
  d: AfterDeps,
  job: LocalJob,
  dataDir: string,
  outcome: LocalOutcome
): Promise<void> {
  const occDir = occurrenceDir(dataDir, job.payload.occurrenceId)
  await persist(d, () => d.report('uploading'))
  await sendFiles(d, job, occDir, await uploadSet(occDir))

  if (outcome === 'crashed') {
    await persist(d, () => d.api.fail(job.id, 'worker_crashed'))
    return deleteRun(dataDir, occDir)
  }

  const native = job.payload.job.entry.transcription === 'native'
  if (native && (await isRegular(join(occDir, 'recording', 'meeting.mkv')))) {
    if (!(await transcriptOnDisk(occDir))) {
      await persist(d, () => d.report('transcribing'))
      let done = false
      for (let attempt = 1; attempt <= WHISPER_TRIES && !done; attempt++) {
        done = await transcribeOnce(d, job, dataDir, occDir)
      }
      if (!done) {
        await persist(d, () => d.api.fail(job.id, 'native_transcription_failed'))
        return deleteRun(dataDir, occDir)
      }
    }
    await sendFiles(
      d,
      job,
      occDir,
      TRANSCRIPT_FILES.map((n) => `transcript/native/${n}`)
    )
  }

  const answer = await persist(d, () => d.api.complete(job.id))
  if (!answer.ok) throw new IncompleteUploadError(answer.missing)
  await deleteRun(dataDir, occDir)
}
