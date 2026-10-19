import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { Screen } from '../types'

const run = promisify(execFile)

export interface ScreenOptions {
  /** X display to start. Production uses the default `:99`; tests pick a free one. */
  display?: string
  /** `openbox` is required in the worker image. `none` is only for hosts without it (tests). */
  windowManager?: 'openbox' | 'none'
}

const READY_TIMEOUT_MS = 10_000

interface Started {
  name: string
  child: ChildProcess
  exited: Promise<void>
  stderr: () => string
}

// Spawns a process and rejects if it cannot start (for example, the binary is missing).
async function start(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<Started> {
  const child = spawn(name, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString()).slice(-2000)
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (error) => reject(new Error(`cannot start ${name}: ${error.message}`)))
  })
  return { name, child, exited, stderr: () => err.trim() }
}

async function terminate(p: Started): Promise<void> {
  if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGTERM')
  await p.exited
}

async function waitForDisplay(display: string, xvfb: Started): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (xvfb.child.exitCode !== null) throw new Error(`Xvfb exited with code ${xvfb.child.exitCode}: ${xvfb.stderr()}`)
    const info = await run('xdpyinfo', ['-display', display]).then(
      (r) => r.stdout,
      () => ''
    )
    if (/dimensions:\s+3840x1080 pixels/.test(info)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`display ${display} did not report 3840x1080 within ${READY_TIMEOUT_MS / 1000} s`)
}

// Starts Xvfb 3840x1080 and openbox, and sets DISPLAY. The left half is the stage, the right half the desk.
export async function startScreen(options: ScreenOptions = {}): Promise<Screen> {
  const display = options.display ?? ':99'
  const windowManager = options.windowManager ?? 'openbox'
  const env = { ...process.env, DISPLAY: display }
  const started: Started[] = []
  try {
    const xvfb = await start('Xvfb', [display, '-screen', '0', '3840x1080x24', '-nolisten', 'tcp'], env)
    started.push(xvfb)
    await waitForDisplay(display, xvfb)
    if (windowManager === 'openbox') {
      const openbox = await start('openbox', [], env)
      started.push(openbox)
      // openbox exits at once when it cannot manage the display (for example, another window manager is running)
      await Promise.race([openbox.exited, new Promise((resolve) => setTimeout(resolve, 300))])
      if (openbox.child.exitCode !== null)
        throw new Error(`openbox exited with code ${openbox.child.exitCode}: ${openbox.stderr()}`)
    }
  } catch (error) {
    for (const p of started.reverse()) await terminate(p)
    throw error
  }
  process.env.DISPLAY = display
  return {
    display,
    width: 3840,
    height: 1080,
    stage: { x: 0, y: 0, width: 1920, height: 1080 },
    desk: { x: 1920, y: 0, width: 1920, height: 1080 },
    async stop() {
      for (const p of [...started].reverse()) await terminate(p)
    }
  }
}
