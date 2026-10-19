import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
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
  /** Called after ffmpeg died and recording resumed in the next segment. `from` is the death, `to` the resume. */
  onGap(cb: (g: { from: Date; to: Date }) => void): void
  /** Called once if recording cannot be resumed (or a callback threw). Nothing is recorded after this. */
  onFatal(cb: (error: Error) => void): void
}

export interface RecorderOptions {
  /** Segment length in seconds. Production uses the default of 300; tests use a few seconds. */
  segmentSeconds?: number
  /** Test-only. Leave unset in production: the recorder then requires the PulseAudio sink and fails if it is absent. */
  testAudio?: 'silence'
}

const SEGMENT_PATTERN = (attempt: number) => new RegExp(`^attempt_${attempt}_seg_(\\d+)\\.mkv$`)
const RESTART_DELAY_MS = 1000
const FIRST_SEGMENT_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 10_000
const MAX_FAILED_RESTARTS = 5

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
  const pattern = SEGMENT_PATTERN(attempt)
  let highest = -1
  for (const name of await readdir(outDir)) {
    const match = pattern.exec(name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
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

/**
 * Records the stage and the sink into `<outDir>/attempt_<attempt>_seg_<NNN>.mkv` and keeps recording:
 * when ffmpeg dies it restarts after 1 s in the next segment number and reports the gap.
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

  const supervise = async (): Promise<void> => {
    for (;;) {
      await current.exited
      if (stopping) return
      const from = new Date()
      for (let failures = 0; ;) {
        await delay(RESTART_DELAY_MS, stopped)
        if (stopping) return
        const next = await launch()
        current = next.running
        if (stopping) {
          await interrupt(current) // stop() ran while the launch was under way and did not see this process
          return
        }
        if (await waitForFile(segmentFile(next.number), current, FIRST_SEGMENT_TIMEOUT_MS)) {
          const gap = { from, to: new Date() }
          await update((record) => {
            record.gaps = [...(record.gaps ?? []), { from: gap.from.toISOString(), to: gap.to.toISOString() }]
          })
          for (const cb of gapCallbacks) cb(gap)
          break
        }
        if (stopping) return
        failures += 1
        const stderr = current.stderr()
        await interrupt(current)
        if (failures >= MAX_FAILED_RESTARTS)
          throw new Error(
            `ffmpeg could not be restarted after ${failures} tries; recording stopped at ${from.toISOString()}${stderr ? `: ${stderr}` : ''}`
          )
      }
    }
  }
  const supervising = supervise().catch(async (error: unknown) => {
    fatal = error instanceof Error ? error : new Error(String(error))
    await interrupt(current)
    await update((record) => {
      record.stoppedAt = new Date().toISOString()
    })
    for (const cb of fatalCallbacks) cb(fatal)
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
