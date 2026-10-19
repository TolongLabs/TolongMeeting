import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobConfig } from '@tm/core'
import { setupProfile } from './profile-setup'
import { defaultDeps, type RunDeps } from './run-deps'

const SIGNIN_URL = 'https://zoom.us/signin'
const VNC_PORT = 5900

// Resolves on a line from stdin, or on SIGINT or SIGTERM, whichever comes first.
function waitForEnd(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.stdin.off('data', done)
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.stdin.once('data', done)
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Seeds an identity's profile by hand. Restores or prepares the profile, opens the Zoom sign-in page on the desk,
 * serves the desk over VNC with a one-time password (printed once, to the terminal), waits for Enter or a signal, then
 * closes the browser and writes a checkpoint. The VNC port is published only on the host's 127.0.0.1 by run-job.sh.
 */
export async function seedProfile(cfg: JobConfig, overrides: Partial<RunDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides }
  // The first cleanup failure is thrown once the cleanup is done, unless the seed itself already threw.
  let failure: Error | null = null
  const cleanup = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return true
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error))
      console.error(`seed: could not ${what}: ${e.message}`)
      failure ??= new Error(`could not ${what}`, { cause: e })
      return false
    }
  }
  const profile = await setupProfile(cfg, deps)
  const screen = await deps.startScreen()
  let context: Awaited<ReturnType<RunDeps['launchBrowser']>>['context'] | null = null
  const passDir = await mkdtemp(join(tmpdir(), 'tm-vnc-'))
  let vnc: ReturnType<typeof spawn> | null = null
  try {
    const browser = await deps.launchBrowser(cfg.profileDir, screen)
    context = browser.context
    await browser.desk.goto(SIGNIN_URL)

    const password = randomBytes(6).toString('hex')
    const passFile = join(passDir, 'passwd')
    await writeFile(passFile, `${password}\n`, { mode: 0o600 })
    vnc = spawn(
      'x11vnc',
      [
        '-display',
        screen.display,
        '-clip',
        '1920x1080+1920+0',
        '-rfbport',
        String(VNC_PORT),
        '-forever',
        '-shared',
        '-passwdfile',
        passFile
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )
    const started = new Promise<never>((_, reject) =>
      vnc!.once('error', (e) => reject(new Error(`cannot start x11vnc: ${e.message}`)))
    )
    // The password goes to the terminal once and nowhere else.
    process.stdout.write(
      `VNC on 127.0.0.1:${VNC_PORT}, password ${password}\nSign in to Zoom, then press Enter here.\n`
    )
    await Promise.race([waitForEnd(deps.signal), started])
  } finally {
    // Each cleanup step has its own try: one that fails must not skip the checkpoint or leave Xvfb running.
    if (vnc && vnc.exitCode === null && vnc.signalCode === null) vnc.kill('SIGTERM')
    await cleanup('remove the password file', () => rm(passDir, { recursive: true, force: true }))
    if (context) {
      // The profile is copied only once the browser has closed: an open profile could be copied half-written.
      const closed = await cleanup('close the browser', () => context!.close())
      if (closed)
        await cleanup('write the checkpoint', () =>
          deps.checkpointProfile(cfg.profileDir, profile.checkpointsDir, profile.key)
        )
    }
    await cleanup('stop the screen', () => screen.stop())
  }
  if (failure !== null) throw failure
}
