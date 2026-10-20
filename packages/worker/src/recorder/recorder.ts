import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Screen } from '../types'

const run = promisify(execFile)

/** The PulseAudio source the recording reads: the monitor of the worker image's `tm_sink`. */
export const PULSE_SOURCE = 'tm_sink.monitor'

/**
 * Where the recording gets its audio. `pulse` is production and reads `tm_sink.monitor`.
 * `silence` is a test-only ffmpeg `anullsrc` source for hosts without PulseAudio; it records no real sound.
 */
export type AudioInput = 'pulse' | 'silence'

export interface Recorder {
  /** Wall-clock time of the first recorded frame of this attempt: the transcript's time origin. */
  startedAt: Date
  /** Stops ffmpeg (SIGINT, so the last segment is closed properly) and sets `stoppedAt`. Rejects if the recorder gave up. */
  stop(): Promise<void>
  /**
   * Called after ffmpeg died (or hung) and recording resumed in the next segment. `from` is when the last good segment
   * stopped receiving data, `to` the first frame of the new segment. A listener that throws is logged and ignored.
   */
  onGap(cb: (g: { from: Date; to: Date }) => void): void
  /**
   * Called once if recording cannot be resumed within the restart budget. Nothing is recorded after this.
   * A listener that throws is logged and ignored.
   */
  onFatal(cb: (error: Error) => void): void
}

export interface RecorderOptions {
  /** Segment length in seconds. Production uses the default of 300; tests use a few seconds. */
  segmentSeconds?: number
  /** Test-only. Leave unset in production: the recorder then requires the PulseAudio sink and fails if it is absent. */
  testAudio?: 'silence'
  /** How long restarts may keep failing, from the moment ffmpeg died, before the recorder gives up. Default 5 minutes. */
  restartBudgetMs?: number
  /** How long the newest segment may stay the same size while ffmpeg is alive before it is killed and restarted. Default 15 s. */
  stallMs?: number
}

const SEGMENT_PATTERN = (attempt: number) => new RegExp(`^attempt_${attempt}_seg_(\\d+)\\.mkv$`)
const FIRST_SEGMENT_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 10_000
/** Restarts wait 1, 2, 4, 8, 16 s ... up to MAX_BACKOFF_MS between tries. */
const RESTART_DELAY_MS = 1000
const MAX_BACKOFF_MS = 30_000
const DEFAULT_RESTART_BUDGET_MS = 5 * 60_000
/** A restarted ffmpeg counts as healthy once it has lived this long and its segment is growing. */
const HEALTHY_AFTER_MS = 3000
const GROWTH_WAIT_MS = 3000
const DEFAULT_STALL_MS = 15_000
const POLL_MS = 500

// The ffmpeg command line from the design (spike 6's tested command, preset `veryfast`).
export function recorderArgs(
  screen: Screen,
  outDir: string,
  attempt: number,
  startNumber: number,
  segmentSeconds = 300,
  audio: AudioInput = 'pulse'
): string[] {
  const { stage } = screen
  const audioInput =
    audio === 'pulse'
      ? ['-thread_queue_size', '1024', '-f', 'pulse', '-use_wallclock_as_timestamps', '1', '-i', PULSE_SOURCE]
      : ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-thread_queue_size',
    '1024',
    '-f',
    'x11grab',
    '-framerate',
    '15',
    '-video_size',
    `${stage.width}x${stage.height}`,
    '-draw_mouse',
    '0',
    '-use_wallclock_as_timestamps',
    '1',
    '-i',
    `${screen.display}.0+${stage.x},${stage.y}`,
    ...audioInput,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-af',
    'aresample=async=1',
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    '-segment_format',
    'matroska',
    // The Matroska muxer writes whole clusters (5 s by default) and buffers them; without these a SIGKILL loses
    // everything since the last flush, which on a static silent screen was ~25 s. Now it loses ~1 s.
    '-segment_format_options',
    'flush_packets=1:cluster_time_limit=1000',
    '-reset_timestamps',
    '1',
    '-segment_start_number',
    String(startNumber),
    join(outDir, `attempt_${attempt}_seg_%03d.mkv`)
  ]
}

const AttemptsSchema = z.array(
  z.looseObject({
    attempt: z.number(),
    startedAt: z.string(),
    stoppedAt: z.string().nullable(),
    // Added by this recorder: every time ffmpeg died and recording resumed. Readers may ignore it.
    gaps: z.array(z.object({ from: z.string(), to: z.string() })).optional()
  })
)
type AttemptRecord = z.infer<typeof AttemptsSchema>[number]

async function readAttempts(file: string): Promise<AttemptRecord[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return AttemptsSchema.parse(JSON.parse(text))
}

// Atomic rewrite: a crash never leaves a half-written attempts.json.
async function writeAttempts(file: string, records: AttemptRecord[]): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`)
  await rename(tmp, file)
}

async function nextSegmentNumber(outDir: string, attempt: number): Promise<number> {
  return ((await segmentNumbers(outDir, attempt)).at(-1) ?? -1) + 1
}

async function requirePulseSource(): Promise<void> {
  let sources: string
  try {
    sources = (await run('pactl', ['list', 'short', 'sources'])).stdout
  } catch (error) {
    throw new Error(
      `cannot read PulseAudio sources (is pactl installed and the server running?): ${(error as Error).message}`
    )
  }
  if (!sources.split('\n').some((line) => line.split('\t')[1] === PULSE_SOURCE))
    throw new Error(`PulseAudio source ${PULSE_SOURCE} not found; the recording needs the worker image's tm_sink`)
}

interface Running {
  child: ChildProcess
  exited: Promise<void>
  /** What ffmpeg printed last, or why it could not start. */
  stderr: () => string
}

function startFfmpeg(args: string[]): Running {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString()).slice(-2000)
  })
  const exited = new Promise<void>((resolve) => {
    // 'exit' does not fire when the process cannot be spawned; 'error' does.
    child.once('error', (error) => {
      err = `cannot start ffmpeg: ${error.message}`
      resolve()
    })
    child.once('exit', () => resolve())
  })
  return { child, exited, stderr: () => err.trim() }
}

const isAlive = (r: Running) => r.child.pid !== undefined && r.child.exitCode === null && r.child.signalCode === null

function delay(ms: number, interrupt: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([timeout, interrupt]).finally(() => clearTimeout(timer))
}

// Resolves true when `file` exists, false when ffmpeg exits (or the timeout passes) first.
async function waitForFile(file: string, r: Running, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      await access(file).then(
        () => true,
        () => false
      )
    )
      return true
    if (!isAlive(r)) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// SIGINT lets ffmpeg close the open segment; SIGKILL only if it ignores that.
async function interrupt(r: Running): Promise<void> {
  if (!isAlive(r)) return
  r.child.kill('SIGINT')
  let timer: NodeJS.Timeout
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS)
  })
  const result = await Promise.race([r.exited.then(() => 'exited' as const), timedOut]).finally(() =>
    clearTimeout(timer)
  )
  if (result === 'timeout') {
    r.child.kill('SIGKILL')
    await r.exited
  }
}

// ffmpeg that hangs ignores SIGINT (a stopped one never handles it), so a hung process is killed outright.
async function kill(r: Running): Promise<void> {
  if (isAlive(r)) r.child.kill('SIGKILL')
  await r.exited
}

// Calls every listener on its own: one that throws (or rejects) is logged and must not stop the recording.
function notify<T>(listeners: ((value: T) => void)[], value: T, what: string): void {
  const report = (error: unknown) =>
    console.error(`[recorder] ${what} listener failed: ${error instanceof Error ? error.message : String(error)}`)
  for (const listener of listeners) {
    try {
      const result: unknown = listener(value)
      if (result instanceof Promise) result.catch(report)
    } catch (error) {
      report(error)
    }
  }
}

async function segmentNumbers(outDir: string, attempt: number): Promise<number[]> {
  const pattern = SEGMENT_PATTERN(attempt)
  return (await readdir(outDir))
    .map((name) => pattern.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b)
}

// The newest segment's number and size: it changes whenever ffmpeg writes (or rolls to a new segment).
async function growth(outDir: string, attempt: number, fileOf: (n: number) => string): Promise<string> {
  const newest = (await segmentNumbers(outDir, attempt)).at(-1)
  if (newest === undefined) return 'none'
  return `${newest}:${(await stat(fileOf(newest))).size}`
}

// First and end timestamp (seconds into the segment) of the frames in a segment, from ffprobe; null when it holds none.
async function probeSpan(file: string): Promise<{ start: number; end: number } | null> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file],
      {
        maxBuffer: 64_000_000
      }
    ))
  } catch {
    return null // not a readable Matroska file: this segment holds no usable frames
  }
  let start = Infinity
  let end = -Infinity
  for (const line of stdout.split('\n')) {
    const [pts, duration] = line.split(',').map(Number)
    if (pts === undefined || Number.isNaN(pts)) continue
    start = Math.min(start, pts)
    end = Math.max(end, pts + (duration && !Number.isNaN(duration) ? duration : 0))
  }
  return start === Infinity ? null : { start, end }
}

/**
 * When the newest segment that holds frames last received data. Segment timestamps restart at 0, so the wall clock
 * comes from the file's modification time; with `flush_packets=1` that is when ffmpeg last wrote a packet.
 * Null when no segment of the attempt holds a frame.
 */
async function lastDataTime(outDir: string, attempt: number, fileOf: (n: number) => string): Promise<Date | null> {
  for (const number of (await segmentNumbers(outDir, attempt)).reverse()) {
    const file = fileOf(number)
    if ((await probeSpan(file)) !== null) return new Date((await stat(file)).mtimeMs)
  }
  return null
}

/**
 * Records the stage and the sink into `<outDir>/attempt_<attempt>_seg_<NNN>.mkv` and keeps recording. When ffmpeg
 * dies, or its segment stops growing for 15 s, it is restarted in the next segment number after 1, 2, 4, 8 ... s
 * (until a restart stays alive 3 s and writes) and the gap is reported. If restarts keep failing for 5 minutes,
 * `onFatal` fires once and `stop()` rejects.
 * Production needs the PulseAudio sink `tm_sink`; without it this throws. Tests on hosts without PulseAudio pass
 * `{ testAudio: 'silence' }`.
 */
export async function startRecorder(
  screen: Screen,
  outDir: string,
  attempt: number,
  opts: RecorderOptions = {}
): Promise<Recorder> {
  const segmentSeconds = opts.segmentSeconds ?? 300
  const restartBudgetMs = opts.restartBudgetMs ?? DEFAULT_RESTART_BUDGET_MS
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS
  const audio: AudioInput = opts.testAudio === 'silence' ? 'silence' : 'pulse'
  if (audio === 'pulse') await requirePulseSource()
  await mkdir(outDir, { recursive: true })
  const attemptsFile = join(outDir, 'attempts.json')
  if ((await readAttempts(attemptsFile)).some((a) => a.attempt === attempt))
    throw new Error(`attempt ${attempt} is already recorded in ${attemptsFile}`)

  const segmentFile = (n: number) => join(outDir, `attempt_${attempt}_seg_${String(n).padStart(3, '0')}.mkv`)
  const launch = async () => {
    const number = await nextSegmentNumber(outDir, attempt)
    return { running: startFfmpeg(recorderArgs(screen, outDir, attempt, number, segmentSeconds, audio)), number }
  }

  // The first start must succeed; there is no recording to protect yet.
  const first = await launch()
  let current = first.running
  if (!(await waitForFile(segmentFile(first.number), current, FIRST_SEGMENT_TIMEOUT_MS))) {
    const stderr = current.stderr()
    await interrupt(current)
    throw new Error(`ffmpeg wrote no segment within ${FIRST_SEGMENT_TIMEOUT_MS / 1000} s${stderr ? `: ${stderr}` : ''}`)
  }
  const startedAt = new Date()

  // attempts.json updates run one after the other.
  let queue: Promise<void> = Promise.resolve()
  const update = (change: (record: AttemptRecord) => void): Promise<void> => {
    queue = queue.then(async () => {
      const records = await readAttempts(attemptsFile)
      const record = records.find((a) => a.attempt === attempt)
      if (!record) throw new Error(`attempt ${attempt} vanished from ${attemptsFile}`)
      change(record)
      await writeAttempts(attemptsFile, records)
    })
    return queue
  }
  await writeAttempts(attemptsFile, [
    ...(await readAttempts(attemptsFile)),
    { attempt, startedAt: startedAt.toISOString(), stoppedAt: null }
  ])

  const gapCallbacks: ((g: { from: Date; to: Date }) => void)[] = []
  const fatalCallbacks: ((error: Error) => void)[] = []
  let stopping = false
  let fatal: Error | null = null
  let wake!: () => void
  const stopped = new Promise<void>((resolve) => {
    wake = resolve
  })

  // Waits `ms`, or less when stop() runs or `r` exits.
  const pause = (ms: number, r: Running) => delay(ms, Promise.race([stopped, r.exited]))
  const stalled = (since: number) => Date.now() - since >= stallMs

  // Returns when `r` has exited or stop() ran. Kills `r` if its segment stops growing while it is alive (hung x11grab).
  const watch = async (r: Running): Promise<void> => {
    let last = await growth(outDir, attempt, segmentFile)
    let changedAt = Date.now()
    while (isAlive(r) && !stopping) {
      await pause(POLL_MS, r)
      const now = await growth(outDir, attempt, segmentFile)
      if (now !== last) {
        last = now
        changedAt = Date.now()
      } else if (isAlive(r) && !stopping && stalled(changedAt)) {
        console.error(`[recorder] ffmpeg wrote nothing for ${stallMs / 1000} s; restarting it`)
        await kill(r)
      }
    }
  }

  // A restart is healthy when ffmpeg lives HEALTHY_AFTER_MS and its newest segment grows. Returns the wall time of
  // the new segment's first frame, or null when this try failed.
  const confirmHealthy = async (r: Running, file: string): Promise<Date | null> => {
    await pause(HEALTHY_AFTER_MS, r)
    if (stopping || !isAlive(r)) return null
    const before = await growth(outDir, attempt, segmentFile)
    const deadline = Date.now() + GROWTH_WAIT_MS
    while ((await growth(outDir, attempt, segmentFile)) === before) {
      if (stopping || !isAlive(r) || Date.now() > deadline) return null
      await pause(250, r)
    }
    const span = await probeSpan(file)
    if (!span) return null
    // The segment's first frame is as far before its last write as the frames it holds are long.
    return new Date((await stat(file)).mtimeMs - (span.end - span.start) * 1000)
  }

  const supervise = async (): Promise<void> => {
    for (;;) {
      await watch(current)
      if (stopping) return
      await current.exited
      const diedAt = Date.now()
      const from = (await lastDataTime(outDir, attempt, segmentFile)) ?? startedAt
      let lastError = current.stderr()
      for (let failures = 0; ; failures += 1) {
        const wait = Math.min(RESTART_DELAY_MS * 2 ** failures, MAX_BACKOFF_MS)
        if (Date.now() + wait > diedAt + restartBudgetMs)
          throw new Error(
            `ffmpeg could not be restarted within ${restartBudgetMs / 1000} s (${failures} tries); recording stopped at ${from.toISOString()}${lastError ? `: ${lastError}` : ''}`
          )
        await delay(wait, stopped)
        if (stopping) return
        const next = await launch()
        current = next.running
        if (stopping) {
          await interrupt(current) // stop() ran while the launch was under way and did not see this process
          return
        }
        const firstFrame = await confirmHealthy(current, segmentFile(next.number))
        if (stopping) {
          await interrupt(current)
          return
        }
        if (firstFrame) {
          const gap = { from, to: firstFrame < from ? from : firstFrame }
          await update((record) => {
            record.gaps = [...(record.gaps ?? []), { from: gap.from.toISOString(), to: gap.to.toISOString() }]
          })
          notify(gapCallbacks, gap, 'onGap')
          break
        }
        lastError = current.stderr() || lastError
        await kill(current)
      }
    }
  }
  const supervising = supervise().catch(async (error: unknown) => {
    fatal = error instanceof Error ? error : new Error(String(error))
    await interrupt(current)
    await update((record) => {
      record.stoppedAt = new Date().toISOString()
    }).catch((e: unknown) => console.error(`[recorder] cannot close attempts.json: ${String(e)}`))
    notify(fatalCallbacks, fatal, 'onFatal')
  })

  let stopPromise: Promise<void> | null = null
  return {
    startedAt,
    onGap(cb) {
      gapCallbacks.push(cb)
    },
    onFatal(cb) {
      fatalCallbacks.push(cb)
    },
    stop() {
      stopPromise ??= (async () => {
        stopping = true
        wake()
        await interrupt(current)
        await supervising
        if (fatal) throw fatal
        await update((record) => {
          record.stoppedAt = new Date().toISOString()
        })
      })()
      return stopPromise
    }
  }
}
