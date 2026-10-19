import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durationSeconds, killFfmpeg, lastPacketEnd, probe } from './helpers/media'
import { joinRecording } from '../src/recorder/join'
import { recorderArgs, startRecorder } from '../src/recorder/recorder'
import { startScreen } from '../src/display/screen'
import type { Screen } from '../src/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeScreen: Screen = {
  display: ':99',
  width: 3840,
  height: 1080,
  stage: { x: 0, y: 0, width: 1920, height: 1080 },
  desk: { x: 1920, y: 0, width: 1920, height: 1080 },
  stop: async () => {}
}

test('ffmpeg arguments record the stage and the sink into Matroska segments', () => {
  expect(recorderArgs(fakeScreen, '/d/recording', 2, 0)).toEqual([
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
    '1920x1080',
    '-draw_mouse',
    '0',
    '-use_wallclock_as_timestamps',
    '1',
    '-i',
    ':99.0+0,0',
    '-thread_queue_size',
    '1024',
    '-f',
    'pulse',
    '-use_wallclock_as_timestamps',
    '1',
    '-i',
    'tm_sink.monitor',
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
    '300',
    '-segment_format',
    'matroska',
    '-segment_format_options',
    'flush_packets=1:cluster_time_limit=1000',
    '-reset_timestamps',
    '1',
    '-segment_start_number',
    '0',
    '/d/recording/attempt_2_seg_%03d.mkv'
  ])
})

test('a restart passes its segment number and segment length', () => {
  const args = recorderArgs(fakeScreen, '/d/recording', 1, 4, 5)
  expect(args.slice(args.indexOf('-segment_time'), args.indexOf('-segment_time') + 2)).toEqual(['-segment_time', '5'])
  expect(args.slice(args.indexOf('-segment_start_number'), args.indexOf('-segment_start_number') + 2)).toEqual([
    '-segment_start_number',
    '4'
  ])
})

const has = (bin: string) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Host tests: a real Xvfb display, real ffmpeg, silent test audio (the host has no PulseAudio).
// ffplay paints a moving test pattern on the display, so the recorded segments carry real data like a meeting does.
const canRecord = has('ffmpeg') && has('ffprobe') && has('ffplay') && has('Xvfb') && has('xdpyinfo')

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(100)
  }
}

const segments = async (dir: string) =>
  (await readdir(dir)).filter((f) => f.endsWith('.mkv') && f.startsWith('attempt_')).sort()

describe.skipIf(!canRecord)('recording a real Xvfb display', () => {
  let dir: string
  let screen: Screen
  let pattern: ChildProcess
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-recorder-'))
    screen = await startScreen({ windowManager: 'none' })
    pattern = spawn(
      'ffplay',
      [
        '-loglevel',
        'error',
        '-an',
        '-noborder',
        '-left',
        '0',
        '-top',
        '0',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30'
      ],
      { env: { ...process.env, DISPLAY: screen.display, SDL_AUDIODRIVER: 'dummy' }, stdio: 'ignore' }
    )
    await sleep(1000)
  })
  const stopPattern = async () => {
    if (pattern.exitCode === null && pattern.signalCode === null) {
      const gone = new Promise((resolve) => pattern.once('exit', resolve))
      pattern.kill('SIGTERM')
      await gone
    }
  }
  afterEach(async () => {
    await stopPattern()
    await screen.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('records the stage, survives an ffmpeg kill in the next segment, logs the gap, and joins', async () => {
    const gaps: { from: Date; to: Date }[] = []
    const r = await startRecorder(screen, dir, 1, { segmentSeconds: 2, testAudio: 'silence' })
    r.onGap((g) => gaps.push(g))
    // Segment 0 is closed once segment 1 exists; ffmpeg dies part-way into segment 1 or later.
    await waitFor(async () => (await segments(dir)).includes('attempt_1_seg_001.mkv'))
    await sleep(500)
    const before = await segments(dir)
    const lastBefore = Number(/seg_(\d+)/.exec(before.at(-1)!)![1])
    expect(before[0]).toBe('attempt_1_seg_000.mkv')
    const killedAt = Date.now()
    killFfmpeg(dir)
    await waitFor(() => gaps.length > 0)
    await sleep(2500)
    await r.stop()

    // The new ffmpeg started in the NEXT segment number, no file was overwritten, and the gap was reported.
    const after = await segments(dir)
    expect(after).toContain(`attempt_1_seg_${String(lastBefore + 1).padStart(3, '0')}.mkv`)
    expect(new Set(after).size).toBe(after.length)
    expect(gaps).toHaveLength(1)
    // The gap brackets the real loss: the data stopped no later than the kill and (with flushed packets) within a
    // few seconds of it, and the new segment's first frame came after the 1 s restart delay.
    expect(+gaps[0]!.from).toBeLessThanOrEqual(killedAt + 200)
    expect(+gaps[0]!.from).toBeGreaterThan(killedAt - 4000)
    expect(+gaps[0]!.to).toBeGreaterThan(killedAt + 900)
    expect(+gaps[0]!.to).toBeLessThan(killedAt + 12_000)

    // attempts.json: the shape the pipeline reads, plus the gap.
    const attempts = JSON.parse(await readFile(join(dir, 'attempts.json'), 'utf8'))
    expect(attempts).toEqual([
      {
        attempt: 1,
        startedAt: r.startedAt.toISOString(),
        stoppedAt: expect.any(String),
        gaps: [{ from: gaps[0]!.from.toISOString(), to: gaps[0]!.to.toISOString() }]
      }
    ])
    expect(+new Date(attempts[0].stoppedAt)).toBeGreaterThan(+gaps[0]!.to)

    expect(await probe(join(dir, 'attempt_1_seg_000.mkv'))).toMatchObject({
      video: 'h264',
      width: 1920,
      height: 1080,
      fps: 15,
      audio: 'aac'
    })

    // The segment ffmpeg was killed in is truncated; the join repairs it.
    const out = await joinRecording(dir)
    expect(out).toBe(join(dir, 'meeting.mkv'))
    expect(await durationSeconds(out)).toBeGreaterThan(4)
    expect(await probe(out)).toMatchObject({ video: 'h264', width: 1920, height: 1080, audio: 'aac' })
  }, 40_000)

  test('a second attempt records into its own segments and attempts.json keeps both', async () => {
    const first = await startRecorder(screen, dir, 1, { segmentSeconds: 2, testAudio: 'silence' })
    await sleep(1500)
    await first.stop()
    const second = await startRecorder(screen, dir, 2, { segmentSeconds: 2, testAudio: 'silence' })
    await sleep(1500)
    await second.stop()
    expect((await segments(dir)).filter((f) => f.startsWith('attempt_2_'))[0]).toBe('attempt_2_seg_000.mkv')
    const attempts = JSON.parse(await readFile(join(dir, 'attempts.json'), 'utf8'))
    expect(attempts.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2])
    expect(attempts.every((a: { stoppedAt: unknown }) => typeof a.stoppedAt === 'string')).toBe(true)
    await expect(startRecorder(screen, dir, 2, { segmentSeconds: 2, testAudio: 'silence' })).rejects.toThrow(
      'attempt 2 is already recorded'
    )
  }, 30_000)

  test('when ffmpeg cannot be restarted, the recorder reports it and stop() fails', async () => {
    const r = await startRecorder(screen, dir, 1, { segmentSeconds: 2, testAudio: 'silence', restartBudgetMs: 5000 })
    const fatal = new Promise<Error>((resolve) => r.onFatal(resolve))
    const path = process.env.PATH
    try {
      killFfmpeg(dir)
      process.env.PATH = '/nonexistent' // every restart now fails to spawn
      expect((await fatal).message).toContain('could not be restarted')
    } finally {
      process.env.PATH = path
    }
    await expect(r.stop()).rejects.toThrow('could not be restarted')
    // the attempt is closed, and the failure is not a silent gap
    const attempts = JSON.parse(await readFile(join(dir, 'attempts.json'), 'utf8'))
    expect(attempts[0].stoppedAt).toBeString()
  }, 40_000)

  test('a SIGKILLed ffmpeg on a static silent stage loses only a few seconds', async () => {
    await stopPattern() // nothing moves on the stage
    const r = await startRecorder(screen, dir, 1, { testAudio: 'silence' })
    await sleep(10_000)
    const killedAt = Date.now()
    killFfmpeg(dir)
    const recorded = await lastPacketEnd(join(dir, 'attempt_1_seg_000.mkv'))
    const elapsed = (killedAt - +r.startedAt) / 1000
    expect(recorded).toBeGreaterThan(elapsed - 4)
    await r.stop()
  }, 40_000)

  test('a throwing listener is logged and the recording continues', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await startRecorder(screen, dir, 1, { segmentSeconds: 2, testAudio: 'silence' })
      const gaps: { from: Date; to: Date }[] = []
      r.onGap(() => {
        throw new Error('listener bug')
      })
      r.onGap((g) => gaps.push(g))
      killFfmpeg(dir)
      await waitFor(() => gaps.length > 0)
      expect(logged.mock.calls.flat().join('\n')).toContain('onGap listener failed: listener bug')
      // ffmpeg is recording again: the newest segment keeps growing
      const newest = async () => {
        const name = (await segments(dir)).at(-1)!
        return (await stat(join(dir, name))).size
      }
      const size = await newest()
      await waitFor(async () => (await newest()) !== size, 5000)
      await r.stop()
    } finally {
      logged.mockRestore()
    }
  }, 40_000)

  test('an ffmpeg that keeps dying after 1 s ends in one onFatal within the budget, and stop() fails', async () => {
    const fake = await mkdtemp(join(tmpdir(), 'tm-fake-ffmpeg-'))
    await writeFile(join(fake, 'ffmpeg'), '#!/bin/sh\necho "fake ffmpeg is failing" >&2\nsleep 1\nexit 1\n')
    await chmod(join(fake, 'ffmpeg'), 0o755)
    const path = process.env.PATH
    const r = await startRecorder(screen, dir, 1, { segmentSeconds: 2, testAudio: 'silence', restartBudgetMs: 8000 })
    const fatals: Error[] = []
    r.onFatal((e) => fatals.push(e))
    try {
      const killedAt = Date.now()
      killFfmpeg(dir)
      process.env.PATH = `${fake}:${path}` // every restart is now the failing fake
      await waitFor(() => fatals.length > 0, 20_000)
      expect(Date.now() - killedAt).toBeLessThan(8000 + 1500)
    } finally {
      process.env.PATH = path
      await rm(fake, { recursive: true, force: true })
    }
    await sleep(2500) // no second call
    expect(fatals).toHaveLength(1)
    expect(fatals[0]!.message).toContain('could not be restarted within 8 s')
    expect(fatals[0]!.message).toContain('fake ffmpeg is failing')
    await expect(r.stop()).rejects.toThrow('could not be restarted')
  }, 40_000)

  test('an ffmpeg that hangs (stopped) is killed and restarted by the watchdog', async () => {
    const r = await startRecorder(screen, dir, 1, { segmentSeconds: 2, testAudio: 'silence', stallMs: 4000 })
    const gaps: { from: Date; to: Date }[] = []
    r.onGap((g) => gaps.push(g))
    await sleep(2500)
    const stoppedAt = Date.now()
    killFfmpeg(dir, 'SIGSTOP')
    await waitFor(() => gaps.length > 0, 25_000)
    // data stopped when ffmpeg did; the new segment came after the stall was noticed (4 s) and the restart
    expect(+gaps[0]!.from).toBeLessThanOrEqual(stoppedAt + 200)
    expect(+gaps[0]!.from).toBeGreaterThan(stoppedAt - 4000)
    expect(+gaps[0]!.to).toBeGreaterThan(stoppedAt + 4000)
    await r.stop() // the hung process is gone: pgrep would find exactly one ffmpeg while recording, none now
    expect(() => killFfmpeg(dir, 'SIGCONT')).toThrow()
  }, 50_000)

  test.skipIf(has('pactl'))('without the PulseAudio sink and without the test option, it fails loudly', async () => {
    await expect(startRecorder(screen, dir, 1)).rejects.toThrow(/PulseAudio|pactl/)
    expect(await segments(dir)).toEqual([])
  })
})
