import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Rect } from '../adapters/types'
import type { Stopper } from '../types'

const run = promisify(execFile)

/** The member's remote view closes after this long without input (TRD "Remote view"). */
export const IDLE_CLOSE_MS = 900_000

/** The pages a sign-in opens on the desk: one per account kind the website lists. */
export const SIGNIN_START_URLS = [
  'https://zoom.us/signin',
  'https://login.microsoftonline.com/',
  'https://accounts.google.com/',
  'https://web.whatsapp.com/',
  'https://discord.com/login',
  'https://teams.microsoft.com/'
]

const VNC_PORT = 5900
const WS_PORT = 6080
const READY_TIMEOUT_MS = 10_000
const KILL_AFTER_MS = 5_000

export interface VncOptions {
  /** The member only watches. Sign-ins and desk pauses leave this false: the member types. */
  viewOnly?: boolean
  vncPort?: number
  wsPort?: number
}

/**
 * The two command lines of the remote view. x11vnc shows only the desk half of the screen, listens on 127.0.0.1 and
 * asks for the password in `passwordFile` (never in an argument, where `ps` would show it). websockify turns the
 * VNC port into a WebSocket for noVNC; it listens on all interfaces of the container, which has no published ports:
 * only Caddy, on the worker network, reaches it, behind the website's check.
 */
export function vncArgs(
  display: string,
  desk: Rect,
  passwordFile: string,
  opts: VncOptions = {}
): { x11vnc: string[]; websockify: string[] } {
  const vncPort = opts.vncPort ?? VNC_PORT
  const wsPort = opts.wsPort ?? WS_PORT
  return {
    x11vnc: [
      '-display',
      display,
      '-clip',
      `${desk.width}x${desk.height}+${desk.x}+${desk.y}`,
      '-rfbport',
      String(vncPort),
      '-localhost',
      '-passwdfile',
      passwordFile,
      ...(opts.viewOnly ? ['-viewonly'] : []),
      '-forever',
      '-shared',
      '-noxdamage',
      '-quiet'
    ],
    websockify: [`0.0.0.0:${wsPort}`, `localhost:${vncPort}`]
  }
}

interface Started {
  name: string
  child: ChildProcess
  exited: Promise<void>
  stderr: () => string
}

// Spawns a process; rejects when it cannot start (the binary is missing). Its stderr tail is kept for the error
// message of a process that dies early: x11vnc never prints the password.
async function start(name: string, args: string[]): Promise<Started> {
  const child = spawn(name, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString()).slice(-2000)
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`cannot start ${name}: ${error.message}`)))
    if (child.pid !== undefined) resolve()
  })
  return { name, child, exited, stderr: () => err.trim() }
}

async function terminate(p: Started): Promise<void> {
  if (p.child.exitCode === null && p.child.signalCode === null) {
    p.child.kill('SIGTERM')
    const timer = setTimeout(() => p.child.kill('SIGKILL'), KILL_AFTER_MS)
    await p.exited
    clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

// Waits until the process accepts connections on 127.0.0.1:<port>, or fails when it exits first or takes too long.
async function waitListening(p: Started, port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (p.child.exitCode !== null || p.child.signalCode !== null) {
      throw new Error(`${p.name} exited with code ${p.child.exitCode}: ${p.stderr()}`)
    }
    if (await accepts(port)) return
    await sleep(100)
  }
  throw new Error(`${p.name} did not listen on port ${port} within ${READY_TIMEOUT_MS / 1000} s`)
}

/**
 * Starts the remote view of the desk: x11vnc, then websockify. `secret` is the VNC password; it goes into a 0600 file in
 * a private directory that is removed when the view stops, and nowhere else (not an argument, not a log line). The
 * returned stopper is safe to call twice.
 */
export async function startVnc(display: string, desk: Rect, secret: string, opts: VncOptions = {}): Promise<Stopper> {
  const dir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'tm-vnc-'))
  const started: Started[] = []
  const cleanup = async (): Promise<void> => {
    for (const p of started.reverse()) await terminate(p)
    await rm(dir, { recursive: true, force: true })
  }
  try {
    const file = join(dir, 'passwd')
    await writeFile(file, `${secret}\n`, { mode: 0o600 })
    const args = vncArgs(display, desk, file, opts)
    const x11vnc = await start('x11vnc', args.x11vnc)
    started.push(x11vnc)
    await waitListening(x11vnc, opts.vncPort ?? VNC_PORT)
    const websockify = await start('websockify', args.websockify)
    started.push(websockify)
    await waitListening(websockify, opts.wsPort ?? WS_PORT)
  } catch (error) {
    await cleanup()
    throw error
  }
  let stopped: Promise<void> | null = null
  return { stop: () => (stopped ??= cleanup()) }
}

/**
 * Milliseconds since the last X input on the display. noVNC input reaches Xvfb as X input; Playwright's CDP input does
 * not, so the bot's own clicks never count as the member being there.
 */
export async function idleMs(display: string): Promise<number> {
  const { stdout } = await run('xprintidle', [], { env: { ...process.env, DISPLAY: display }, timeout: 5000 })
  const ms = Number(stdout.trim())
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('xprintidle printed something that is not a number of ms')
  return ms
}
