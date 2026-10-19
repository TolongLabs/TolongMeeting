import { spawn } from 'node:child_process'
import type { Screen, Stopper } from '../types'

export interface Frame {
  /** When the frame arrived from ffmpeg. */
  at: Date
  /** The stage only (1920x1080), never the desk. */
  png: Buffer
}

export interface FrameLoop extends Stopper {
  /**
   * Called once if the loop cannot go on: ffmpeg died or `onFrame` threw. No more frames are delivered after this,
   * and `stop()` rejects with the same error.
   */
  onFatal(cb: (error: Error) => void): void
}

const STOP_TIMEOUT_MS = 5000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Cuts a byte stream of back-to-back PNG files into files. It walks the chunk structure (length, type, data, CRC), so
// image data that happens to contain the letters IEND is never mistaken for the end.
class PngSplitter {
  private pending: Buffer[] = []
  private size = 0
  /** Bytes that must be buffered before there is anything new to learn; avoids re-joining on every small read. */
  private need = PNG_SIGNATURE.length

  push(data: Buffer): Buffer[] {
    this.pending.push(data)
    this.size += data.length
    if (this.size < this.need) return []
    const buf = Buffer.concat(this.pending)
    const files: Buffer[] = []
    let start = 0
    for (;;) {
      const end = this.fileEnd(buf, start)
      if (end === null) break
      files.push(buf.subarray(start, end))
      start = end
    }
    const rest = buf.subarray(start)
    this.pending = rest.length > 0 ? [rest] : []
    this.size = rest.length
    return files
  }

  // The offset just past the PNG that starts at `start`, or null when it is not all here yet (and sets `need`).
  private fileEnd(buf: Buffer, start: number): number | null {
    if (buf.length - start < PNG_SIGNATURE.length) {
      this.need = PNG_SIGNATURE.length
      return null
    }
    if (!buf.subarray(start, start + PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
      throw new Error('ffmpeg output is not a PNG stream')
    let at = start + PNG_SIGNATURE.length
    for (;;) {
      if (buf.length - at < 8) {
        this.need = at + 8 - start
        return null
      }
      const next = at + 8 + buf.readUInt32BE(at) + 4
      if (buf.length < next) {
        this.need = next - start
        return null
      }
      if (buf.toString('latin1', at + 4, at + 8) === 'IEND') return next
      at = next
    }
  }
}

/**
 * Grabs the stage with one ffmpeg every `intervalMs` and calls `onFrame` one frame at a time. A frame that arrives
 * while `onFrame` is still running is dropped. Frames show the stage rectangle only, never the desk.
 */
export function startFrameLoop(screen: Screen, onFrame: (f: Frame) => Promise<void>, intervalMs = 2000): FrameLoop {
  const { stage } = screen
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      'x11grab',
      '-framerate',
      String(1000 / intervalMs),
      '-video_size',
      `${stage.width}x${stage.height}`,
      '-draw_mouse',
      '0',
      '-i',
      `${screen.display}.0+${stage.x},${stage.y}`,
      '-fps_mode',
      'passthrough',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-2000)
  })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))

  let stopping = false
  let failure: Error | null = null
  const fatalListeners: ((error: Error) => void)[] = []
  const fail = (error: Error) => {
    if (failure !== null) return
    failure = error
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const cb of fatalListeners) cb(error)
  }
  child.once('error', (e) => fail(new Error(`cannot start ffmpeg: ${e.message}`)))
  child.once('close', (code, signal) => {
    if (!stopping) fail(new Error(`ffmpeg exited (${code ?? signal}) before stop: ${stderr.trim()}`))
  })

  const splitter = new PngSplitter()
  let running: Promise<void> | null = null
  child.stdout.on('data', (data: Buffer) => {
    let pngs: Buffer[]
    try {
      pngs = splitter.push(data)
    } catch (error) {
      fail(error as Error)
      return
    }
    for (const png of pngs) {
      if (stopping || failure !== null || running !== null) continue
      running = onFrame({ at: new Date(), png }).then(
        () => {
          running = null
        },
        (error) => {
          running = null
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      )
    }
  })

  return {
    onFatal(cb) {
      fatalListeners.push(cb)
    },
    async stop() {
      stopping = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT')
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
      await exited
      clearTimeout(timer)
      await running
      if (failure !== null) throw failure
    }
  }
}
