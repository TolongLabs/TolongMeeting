import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import sharp from 'sharp'
import { levelOf, startAudioSource } from '../src/audio/source'
import { startScreen } from '../src/display/screen'
import { startFrameLoop, type Frame } from '../src/frames/frames'
import type { Screen } from '../src/types'

// Real captures take seconds: a frame arrives after about two intervals.
setDefaultTimeout(30_000)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const has = (bin: string) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
// Host tests skip when a tool is missing, except under CI, where a missing tool fails the file instead.
const hostHas = (bins: string[]): boolean => {
  const missing = bins.filter((b) => !has(b))
  if (missing.length === 0) return true
  if (process.env.CI) throw new Error(`CI host is missing ${missing.join(', ')}`)
  return false
}

// Host tests: a real Xvfb display and real ffmpeg. The host has no PulseAudio, so audio uses a generated signal.
const canGrab = hostHas(['ffmpeg', 'ffplay', 'Xvfb', 'xdpyinfo'])
const hasFfmpeg = hostHas(['ffmpeg'])

async function pixels(png: Buffer): Promise<{ width: number; height: number; rgb: Buffer }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, rgb: data }
}

// ffplay paints a solid colour in a borderless window at a fixed place on the display.
function paint(display: string, colour: string, left: number): ChildProcess {
  return spawn(
    'ffplay',
    ['-loglevel', 'error', '-an', '-noborder', '-left', String(left), '-top', '0', '-x', '1920', '-y', '1080'].concat([
      '-f',
      'lavfi',
      '-i',
      `color=c=${colour}:s=1920x1080:r=5`
    ]),
    { env: { ...process.env, DISPLAY: display, SDL_AUDIODRIVER: 'dummy' }, stdio: 'ignore' }
  )
}

describe.skipIf(!canGrab)('frames from a real Xvfb display', () => {
  let screen: Screen
  let painters: ChildProcess[]
  beforeEach(async () => {
    screen = await startScreen({ windowManager: 'none' })
    // stage page red, desk page blue
    painters = [paint(screen.display, 'red', screen.stage.x), paint(screen.display, 'blue', screen.desk.x)]
    await sleep(1500)
  })
  afterEach(async () => {
    for (const p of painters) {
      const gone = new Promise((resolve) => p.once('exit', resolve))
      p.kill('SIGKILL')
      await gone
    }
    await screen.stop()
  })

  test('frames arrive at the interval and show the stage only', async () => {
    const frames: Frame[] = []
    const loop = startFrameLoop(
      screen,
      async (f) => {
        frames.push(f)
      },
      1000
    )
    // ffmpeg's x11grab delivers the first frame after about two intervals, then one per interval
    await sleep(5500)
    await loop.stop()
    // about 4 frames; the window is wide so a loaded host does not flake
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames.length).toBeLessThanOrEqual(6)
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i]!.at.getTime() - frames[i - 1]!.at.getTime()
      expect(gap).toBeGreaterThan(700)
      expect(gap).toBeLessThan(1300)
    }
    const { width, height, rgb } = await pixels(frames.at(-1)!.png)
    expect([width, height]).toEqual([1920, 1080])
    const at = (x: number, y: number) => [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)]
    // red everywhere that matters, including the stage's right edge; no blue desk pixels anywhere
    for (const [x, y] of [
      [960, 540],
      [1919, 540],
      [0, 1079]
    ] as const) {
      const [r, g, b] = at(x, y) as [number, number, number]
      expect([r > 240, g < 15, b < 15]).toEqual([true, true, true])
    }
    let blue = 0
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i + 2]! > 200) blue++
    expect(blue).toBe(0)
  })

  test('large frames that arrive in many reads are cut into whole PNG files', async () => {
    // a busy picture on top of the red stage makes each PNG several hundred kilobytes
    const busy = spawn(
      'ffplay',
      ['-loglevel', 'error', '-an', '-noborder', '-left', '0', '-top', '0', '-x', '1920', '-y', '1080'].concat([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1920x1080:rate=10'
      ]),
      { env: { ...process.env, DISPLAY: screen.display, SDL_AUDIODRIVER: 'dummy' }, stdio: 'ignore' }
    )
    painters.push(busy)
    await sleep(1500)
    const frames: Frame[] = []
    const loop = startFrameLoop(
      screen,
      async (f) => {
        frames.push(f)
      },
      500
    )
    await sleep(3500)
    await loop.stop()
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const f of frames) {
      expect(f.png.length).toBeGreaterThan(200_000)
      const meta = await sharp(f.png).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 1920, 1080])
      await sharp(f.png).raw().toBuffer() // decodes completely: not truncated or glued to the next file
    }
  })

  test('a slow onFrame never overlaps and drops the frames that arrive meanwhile', async () => {
    let active = 0
    let overlapped = false
    const starts: number[] = []
    const loop = startFrameLoop(
      screen,
      async () => {
        active++
        overlapped ||= active > 1
        starts.push(Date.now())
        await sleep(1800)
        active--
      },
      500
    )
    await sleep(4500)
    await loop.stop()
    expect(overlapped).toBe(false)
    expect(starts.length).toBeGreaterThanOrEqual(2)
    expect(starts.length).toBeLessThanOrEqual(3) // 4 s at 1 per 1.8 s, not 8 frames
  })

  test('an onFrame that throws stops the loop and is reported', async () => {
    const loop = startFrameLoop(
      screen,
      async () => {
        throw new Error('detector broke')
      },
      500
    )
    const fatal = new Promise<Error>((resolve) => loop.onFatal(resolve))
    expect((await fatal).message).toBe('detector broke')
    await expect(loop.stop()).rejects.toThrow('detector broke')
  })

  test('an onFrame that throws synchronously stops the loop and is reported', async () => {
    const throwsAtOnce = (): Promise<void> => {
      throw new Error('detector broke at once')
    }
    const loop = startFrameLoop(screen, throwsAtOnce, 500)
    const fatal = new Promise<Error>((resolve) => loop.onFatal(resolve))
    expect((await fatal).message).toBe('detector broke at once')
    await expect(loop.stop()).rejects.toThrow('detector broke at once')
  })

  test('a late onFrame rejection after stop has resolved is ignored', async () => {
    let fatalCalls = 0
    let inFlight = false
    const loop = startFrameLoop(
      screen,
      async () => {
        inFlight = true
        await sleep(7000)
        throw new Error('late detector break')
      },
      500
    )
    loop.onFatal(() => fatalCalls++)
    while (!inFlight) await sleep(50)
    // stop waits 5 s for the in-flight onFrame, then proceeds without it
    await loop.stop()
    await sleep(2500) // the rejection lands after stop has resolved
    expect(fatalCalls).toBe(0)
  })

  test('an onFatal added after the loop failed is called at once with the stored error', async () => {
    const loop = startFrameLoop(
      screen,
      async () => {
        throw new Error('detector broke late')
      },
      500
    )
    const failed = await new Promise<Error>((resolve) => loop.onFatal(resolve))
    let late: Error | undefined
    loop.onFatal((e) => (late = e))
    expect(late).toBe(failed)
    await expect(loop.stop()).rejects.toThrow('detector broke late')
  })

  test('a fatal listener that throws does not stop the later listeners', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dead: Screen = {
        display: ':97',
        width: 3840,
        height: 1080,
        stage: { x: 0, y: 0, width: 1920, height: 1080 },
        desk: { x: 1920, y: 0, width: 1920, height: 1080 },
        stop: async () => {}
      }
      const loop = startFrameLoop(dead, async () => {})
      loop.onFatal(() => {
        throw new Error('first listener broke')
      })
      const died = await new Promise<Error>((resolve) => loop.onFatal(resolve))
      expect(died.message).toMatch(/^ffmpeg exited/)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('first listener broke'))
      await expect(loop.stop()).rejects.toThrow(/^ffmpeg exited/)
    } finally {
      logged.mockRestore()
    }
  })

  test('the level of a test tone is high and silence is -120 dB', async () => {
    const tone = await startAudioSource({ testInput: 'sine' })
    const heard: Buffer[] = []
    const off = tone.onChunk((c) => {
      heard.push(c)
    })
    await sleep(1500)
    off()
    expect(tone.levelDb(1000)).toBeGreaterThan(-30)
    expect(tone.levelDb(1000)).toBeLessThan(0)
    expect(heard.length).toBeGreaterThan(0)
    expect(heard.every((c) => c.length % 2 === 0)).toBe(true)
    expect(Math.abs(Date.now() - tone.startedAt.getTime())).toBeLessThan(3000)
    await tone.stop()

    const quiet = await startAudioSource({ testInput: 'silence' })
    await sleep(500)
    expect(quiet.levelDb(300)).toBe(-120)
    await quiet.stop()
  })
})

describe.skipIf(!hasFfmpeg)('frame loop on a display that cannot be opened', () => {
  test('ffmpeg dying fails the loop; an onFatal added afterwards is called at once', async () => {
    const dead: Screen = {
      display: ':97',
      width: 3840,
      height: 1080,
      stage: { x: 0, y: 0, width: 1920, height: 1080 },
      desk: { x: 1920, y: 0, width: 1920, height: 1080 },
      stop: async () => {}
    }
    const loop = startFrameLoop(dead, async () => {})
    const died = await new Promise<Error>((resolve) => loop.onFatal(resolve))
    expect(died.message).toMatch(/^ffmpeg exited/)
    let late: Error | undefined
    loop.onFatal((e) => (late = e))
    expect(late).toBe(died)
    await expect(loop.stop()).rejects.toThrow(/^ffmpeg exited/)
  })
})

describe.skipIf(!hasFfmpeg)('audio source', () => {
  test('delivers 16 kHz mono PCM in real time', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    let bytes = 0
    a.onChunk((c) => {
      bytes += c.length
    })
    await sleep(2000)
    await a.stop()
    // 2 s at 16 kHz, 16-bit mono is 64000 bytes; ffmpeg -re runs a little ahead at the start
    expect(bytes).toBeGreaterThan(40_000)
    expect(bytes).toBeLessThan(100_000)
  })

  test('levelDb rejects windows outside 0 to 10 s, and windows holding no whole sample', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    try {
      expect(() => a.levelDb(0)).toThrow(RangeError)
      expect(() => a.levelDb(10_001)).toThrow(RangeError)
      expect(() => a.levelDb(0.01)).toThrow(/at least one sample/)
      expect(() => a.levelDb(Number.NaN)).toThrow(RangeError)
    } finally {
      await a.stop()
    }
  })

  test('stop is final and a subscriber that throws is reported', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    a.onChunk(() => {
      throw new Error('asr broke')
    })
    await sleep(300)
    await expect(a.stop()).rejects.toThrow('asr broke')
  })

  test('a subscriber that throws fails the source once; onFatal added later is called at once', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    const early: string[] = []
    a.onFatal((e) => early.push(e.message))
    a.onChunk(() => {
      throw new Error('asr broke')
    })
    await sleep(300)
    expect(early).toEqual(['asr broke'])
    const late: string[] = []
    a.onFatal((e) => late.push(e.message))
    expect(late).toEqual(['asr broke'])
    expect(a.levelDb(1000)).toBeNull()
    expect(() => a.levelDb(0)).toThrow(RangeError)
    await expect(a.stop()).rejects.toThrow('asr broke')
    expect(early).toEqual(['asr broke'])
  })

  test('levelDb is null while the window is not yet full', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    try {
      // the first chunk has arrived, but not 10 s of audio
      expect(a.levelDb(10_000)).toBeNull()
      expect(a.levelDb(10_000)).toBeNull()
    } finally {
      await a.stop()
    }
  })

  test('a fatal listener that throws does not stop the later listeners', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const a = await startAudioSource({ testInput: 'sine' })
      a.onFatal(() => {
        throw new Error('first listener broke')
      })
      const second = new Promise<Error>((resolve) => a.onFatal(resolve))
      a.onChunk(() => {
        throw new Error('asr broke')
      })
      expect((await second).message).toBe('asr broke')
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('first listener broke'))
      await expect(a.stop()).rejects.toThrow('asr broke')
    } finally {
      logged.mockRestore()
    }
  })

  test('a subscriber rejection that lands after stop has resolved is ignored', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    let fatalCalls = 0
    a.onFatal(() => fatalCalls++)
    a.onChunk(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late asr')), 800)))
    await sleep(300)
    await a.stop()
    await sleep(1200) // every pending rejection lands after stop has resolved
    expect(fatalCalls).toBe(0)
  })

  test('a subscriber whose promise rejects fails the source the same way', async () => {
    const a = await startAudioSource({ testInput: 'sine' })
    const fatal = new Promise<Error>((resolve) => a.onFatal(resolve))
    a.onChunk(async () => {
      throw new Error('async asr broke')
    })
    expect((await fatal).message).toBe('async asr broke')
    await expect(a.stop()).rejects.toThrow('async asr broke')
  })
})

describe.skipIf(has('parec'))('production audio on a host without PulseAudio', () => {
  test('fails loudly instead of inventing audio', async () => {
    await expect(startAudioSource()).rejects.toThrow(/parec/)
  })
})

test('levelOf is the RMS in dBFS', () => {
  const half = Buffer.alloc(4)
  half.writeInt16LE(16384, 0)
  half.writeInt16LE(-16384, 2)
  expect(levelOf(half)).toBeCloseTo(-6.02, 1)
  expect(levelOf(Buffer.alloc(8))).toBe(-120)
})
