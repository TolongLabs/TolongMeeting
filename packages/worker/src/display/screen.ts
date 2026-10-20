import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { Screen } from '../types'

const run = promisify(execFile)

export interface ScreenOptions {
  /** `openbox` is required in the worker image. `none` is only for hosts without it (tests). */
  windowManager?: 'openbox' | 'none'
}

const READY_TIMEOUT_MS = 10_000
const KILL_AFTER_MS = 5_000

interface Started {
  name: string
  child: ChildProcess
  exited: Promise<void>
  stderr: () => string
}

// Spawns a process and rejects if it cannot start (for example, the binary is missing). `extraFds` adds pipes after
// stdio 2 (fd 3 and up), for Xvfb's -displayfd.
async function start(name: string, args: string[], env: NodeJS.ProcessEnv, extraFds = 0): Promise<Started> {
  const stdio: ('ignore' | 'pipe')[] = ['ignore', 'ignore', 'pipe', ...Array<'pipe'>(extraFds).fill('pipe')]
  const child = spawn(name, args, { env, stdio })
  let err = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString()).slice(-2000)
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    // A started child has a pid at once; a failed start has none and emits 'error'. (Bun under `bun test` never emits
    // 'spawn', so do not wait for it.)
    child.once('error', (error) => reject(new Error(`cannot start ${name}: ${error.message}`)))
    if (child.pid !== undefined) resolve()
  })
  return { name, child, exited, stderr: () => err.trim() }
}

// SIGTERM, then SIGKILL when the process has not exited after KILL_AFTER_MS.
async function terminate(p: Started): Promise<void> {
  if (p.child.exitCode === null && p.child.signalCode === null) {
    p.child.kill('SIGTERM')
    const timer = setTimeout(() => p.child.kill('SIGKILL'), KILL_AFTER_MS)
    await p.exited
    clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Xvfb writes the display number and a newline to the -displayfd pipe once it listens, so the display is one that
// this Xvfb started and no other server can be mistaken for it.
async function readDisplay(xvfb: Started, pipe: Readable): Promise<string> {
  let text = ''
  const reported = new Promise<string>((resolve) => {
    pipe.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      const match = /^(\d+)\n/.exec(text)
      if (match) resolve(`:${match[1]}`)
    })
  })
  const failed = xvfb.exited.then((): never => {
    throw new Error(`Xvfb exited with code ${xvfb.child.exitCode}: ${xvfb.stderr()}`)
  })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Xvfb did not report a display within ${READY_TIMEOUT_MS / 1000} s`)),
      READY_TIMEOUT_MS
    )
  })
  try {
    return await Promise.race([reported, failed, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForDisplay(display: string, xvfb: Started): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const info = await run('xdpyinfo', ['-display', display]).then(
      (r) => r.stdout,
      () => ''
    )
    // Check after the probe: a probe that succeeded may have reached a server that is not ours.
    if (xvfb.child.exitCode !== null) throw new Error(`Xvfb exited with code ${xvfb.child.exitCode}: ${xvfb.stderr()}`)
    if (/dimensions:\s+3840x1080 pixels/.test(info)) return
    await sleep(100)
  }
  throw new Error(`display ${display} did not report 3840x1080 within ${READY_TIMEOUT_MS / 1000} s`)
}

// openbox sets _NET_SUPPORTING_WM_CHECK on the root window once it manages the display, and exits at once when it
// cannot (for example, another window manager is running).
async function waitForWindowManager(display: string, openbox: Started): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (openbox.child.exitCode !== null)
      throw new Error(`openbox exited with code ${openbox.child.exitCode}: ${openbox.stderr()}`)
    const check = await run('xprop', ['-display', display, '-root', '_NET_SUPPORTING_WM_CHECK']).then(
      (r) => r.stdout,
      () => ''
    )
    if (/_NET_SUPPORTING_WM_CHECK\(WINDOW\): window id # 0x[0-9a-f]+/i.test(check)) return
    await sleep(50)
  }
  throw new Error(`openbox did not manage ${display} within ${READY_TIMEOUT_MS / 1000} s`)
}

// openbox now and then exits with code 1 and no message right after it starts on a fresh Xvfb (seen in the image on
// CI, about one start in fifty; not reproduced by hand). A second start on the same display works, so a start that
// exits early is tried up to three times; a window manager that never manages the display still fails at once.
const OPENBOX_ATTEMPTS = 3

async function startOpenbox(display: string): Promise<Started> {
  for (let attempt = 1; ; attempt++) {
    const openbox = await start('openbox', [], { ...process.env, DISPLAY: display })
    try {
      await waitForWindowManager(display, openbox)
      return openbox
    } catch (error) {
      const exitedEarly = openbox.child.exitCode !== null
      await terminate(openbox)
      if (!exitedEarly || attempt >= OPENBOX_ATTEMPTS) throw error
      await sleep(200)
    }
  }
}

// DISPLAY belongs to the most recently started live screen; stopping a screen hands it back to the one before it, or
// to the value it had before the first screen started.
const live: string[] = []
let originalDisplay: string | undefined

function claimDisplay(display: string): void {
  if (live.length === 0) originalDisplay = process.env.DISPLAY
  live.push(display)
  process.env.DISPLAY = display
}

function releaseDisplay(display: string): void {
  live.splice(live.indexOf(display), 1)
  if (process.env.DISPLAY !== display) return
  const next = live.at(-1) ?? originalDisplay
  if (next === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = next
}

// Starts Xvfb 3840x1080 on a free display (Xvfb picks it with -displayfd) and openbox, and sets DISPLAY. The left half
// is the stage, the right half the desk.
export async function startScreen(options: ScreenOptions = {}): Promise<Screen> {
  const windowManager = options.windowManager ?? 'openbox'
  const started: Started[] = []
  let display: string
  try {
    const xvfb = await start(
      'Xvfb',
      ['-displayfd', '3', '-screen', '0', '3840x1080x24', '-nolisten', 'tcp'],
      process.env,
      1
    )
    started.push(xvfb)
    display = await readDisplay(xvfb, xvfb.child.stdio[3] as Readable)
    await waitForDisplay(display, xvfb)
    if (windowManager === 'openbox') started.push(await startOpenbox(display))
  } catch (error) {
    for (const p of started.reverse()) await terminate(p)
    throw error
  }
  claimDisplay(display)
  let stopped: Promise<void> | null = null
  return {
    display,
    width: 3840,
    height: 1080,
    stage: { x: 0, y: 0, width: 1920, height: 1080 },
    desk: { x: 1920, y: 0, width: 1920, height: 1080 },
    stop() {
      stopped ??= (async () => {
        releaseDisplay(display)
        for (const p of [...started].reverse()) await terminate(p)
      })()
      return stopped
    }
  }
}
