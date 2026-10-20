import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import {
  controlTokenHash,
  SigninJobSchema,
  vncSecret,
  type AccountKind,
  type SigninHeartbeat,
  type SigninReply
} from '@tm/core'
import { writeFileAtomic } from '../atomic'
import type { SecretStore } from '../secrets'
import {
  holderArgs,
  holderName,
  LOCAL_NETWORK,
  machineIdFile,
  machineIdFor,
  NOVNC_PORT,
  signinName,
  signinScope,
  type RunMounts
} from './containers'
import type { DockerLike } from './docker'
import { writeEphemeral, type Ephemeral } from './ephemeral'
import { startRelay, type Relay } from './relay'
import { HOLDER_READY_LINE, type LocalRunner } from './run'
import {
  checkpointsDir,
  checkpointVolume,
  ensureProfileKey,
  identityKeyFile,
  profileVolume,
  type LocalPaths
} from './vault'

// Signing in to an identity that lives on the member's own PC (plan 08 Task 10, the part without a window). Two ways:
//  - a meeting for the identity is running: the view attaches to that worker's desk through the noVNC port its network
//    holder publishes, and the worker pauses its automation (`pause_for_signin`) until the member is done;
//  - otherwise a short-lived sign-in container opens the identity's profile (the image's `--signin` mode). It sits behind
//    its own egress holder, like a meeting worker, and publishes noVNC on 127.0.0.1 at a port Docker picks.
// A sign-in container is never started while a meeting for the same identity runs on this PC: both would open one
// profile. On Done, timeout, a container that ended or the app closing, the profile is checkpointed (encrypted) and then
// every container, file, relay and port is removed.

/** A sign-in view closes by itself after this long, whatever the member is doing. */
export const SIGNIN_SESSION_MS = 60 * 60_000
/** `docker stop -t` for a sign-in container: it closes the browser and checkpoints the profile. */
export const SIGNIN_STOP_SECONDS = 60
/** The container has this long to print its first report (restore the profile, start the browser and the view). */
const SIGNIN_START_MS = 120_000
const HOLDER_READY_MS = 30_000
const HOLDER_POLL_MS = 200
const PIDS_LIMIT = '2048'
const WORKER_MEMORY = '5g'

/** The sign-in pages of each account kind (the same pages the worker opens on the desk, `SIGNIN_START_URLS`). */
export const SIGNIN_HOSTS: Record<AccountKind, readonly string[]> = {
  zoom: ['zoom.us'],
  microsoft: ['login.microsoftonline.com'],
  google: ['accounts.google.com'],
  whatsapp: ['web.whatsapp.com'],
  discord: ['discord.com'],
  teams: ['teams.microsoft.com']
}

/** Why a sign-in was not opened. The message is fixed text for the member; it holds no id and no Docker output. */
export type SigninRefusal = 'already_open' | 'meeting_running' | 'meeting_starting'
const REFUSALS: Record<SigninRefusal, string> = {
  already_open: 'A sign-in view is already open for this identity.',
  meeting_running: 'A meeting for this identity is running on this PC. Sign in through the meeting instead.',
  meeting_starting: 'A meeting for this identity is starting on this PC. Try again in a minute.'
}
export class SigninRefused extends Error {
  constructor(readonly reason: SigninRefusal) {
    super(REFUSALS[reason])
    this.name = 'SigninRefused'
  }
}

/**
 * The sign-in container. It joins the egress holder's network, mounts only the identity's profile volume, its
 * checkpoints, the read-only short-lived folder (`profile.key`, `signin.json`) and its machine id, and gets paths in
 * `-e`, never a secret. The same hardening as a meeting worker: no capabilities, no-new-privileges, a process limit
 * and a memory ceiling. The image's entrypoint takes `--signin <job file>`.
 */
export function signinArgs(o: { identityId: string; image: string; mounts: Omit<RunMounts, 'dataDir'> }): string[] {
  const id = o.identityId
  return [
    'run',
    '-d',
    '--name',
    signinName(id),
    '--label',
    `tm.identity=${id}`,
    '--shm-size=2g',
    '--network',
    `container:${holderName(signinScope(id))}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    PIDS_LIMIT,
    '--memory',
    WORKER_MEMORY,
    '-v',
    `${profileVolume(id)}:/tm/profiles/${id}/vol`,
    '-v',
    `${o.mounts.checkpointsDir}:/tm/profiles/${id}/checkpoints`,
    '-v',
    `${o.mounts.ephemeralDir}:/run/tm:ro`,
    '-v',
    `${o.mounts.machineIdFile}:/etc/machine-id:ro`,
    '-e',
    'TM_PROFILE_ROOT=/tm/profiles',
    '-e',
    'TM_PROFILE_KEY_FILE=/run/tm/profile.key',
    o.image,
    '--signin',
    '/run/tm/signin.json'
  ]
}

const VNC_PASSWORD = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The noVNC page on this PC. The port is Docker's published loopback port and the host is the literal `127.0.0.1`
 * (never a name). The password sits in the fragment only: a fragment is not sent to the server, so it is in no request
 * line, no log and no `Referer`.
 */
export function vncUrl(port: number, password: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('not a port')
  if (!VNC_PASSWORD.test(password)) throw new RangeError('not a VNC password')
  return `http://127.0.0.1:${port}/vnc.html#autoconnect=1&resize=scale&password=${password}`
}

// The authority is checked on the raw text: `new URL` drops a default port and reads a backslash as a slash.
const AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i

/**
 * True for a URL the sign-in window may show: the noVNC page on `127.0.0.1:<port>` (http), or an exact sign-in host of
 * one of `accounts` (https, no user info, no port). The window itself passes no accounts: its only page is noVNC, and
 * the pages of each account are shown inside the remote browser, never in the PC's own window. Everything else is
 * refused, so a look-alike such as `zoom.us.evil.example` or `login.microsoftonline.com@evil.example` fails.
 */
export function isAllowedSigninUrl(url: string, port: number, accounts: readonly AccountKind[] = []): boolean {
  if (/[\\\s\p{Cc}]/u.test(url)) return false
  const raw = AUTHORITY.exec(url)
  if (raw === null) return false
  const authority = raw[2]!
  if (authority.includes('@')) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') return false
  if (raw[1]!.toLowerCase() === 'http') {
    return authority === `127.0.0.1:${port}` && parsed.hostname === '127.0.0.1' && parsed.port === String(port)
  }
  if (raw[1]!.toLowerCase() !== 'https' || parsed.protocol !== 'https:' || authority.includes(':')) return false
  // `hostname` is lower-cased; the raw text must say the same, so a trailing dot or an escape never passes.
  return (
    authority.toLowerCase() === parsed.hostname && accounts.some((kind) => SIGNIN_HOSTS[kind].includes(parsed.hostname))
  )
}

export interface SigninClosable {
  close(): void
}

export interface SigninDeps {
  /** The meeting runner: which identity it holds, the desk's noVNC port and the command channel to its worker. */
  runner: Pick<LocalRunner, 'activeIdentity' | 'inject' | 'noVncPort'>
  docker: DockerLike
  secrets: SecretStore
  paths: LocalPaths
  /** The worker image to run (already checked against the trusted prefix by the caller). */
  imageRef: () => string
  /**
   * Shows `url`. `onDone` is the window's Done button (or its closing). A window may return a handle so the controller
   * can close it when the session ends by itself.
   */
  openWindow(url: string, onDone: () => void): void | SigninClosable
  /** The password of the running meeting's desk view, or null when it is not up. The worker derives the same one. */
  deskPassword(identityId: string): string | null
  /** The loopback relay the sign-in container reports to. Default `startRelay` with no server upstream. */
  relay?: (o: { onSignin: (hb: SigninHeartbeat) => SigninReply | Promise<SigninReply> }) => Promise<Relay>
  /** The view closes after this long. Default `SIGNIN_SESSION_MS`. */
  sessionMs?: number
  /** How long the container has to report its first heartbeat. Default 120000. */
  startMs?: number
  holderReadyMs?: number
  holderPollMs?: number
  /** Gets what the controller cannot act on (a failure while a session ended by itself). Default `console.error`. */
  onError?: (error: unknown) => void
}

interface Session {
  identityId: string
  kind: 'attach' | 'container'
  /** Settles when `open` finished (or failed); `done` waits for it. */
  opening: Promise<void>
  finishing: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  window: SigninClosable | null
  // container sessions
  relay: Relay | null
  eph: Ephemeral | null
  stopping: boolean
  /** The worker's automation was paused for this view (`pause_for_signin` was accepted). */
  paused: boolean
  holder: string | null
  container: string | null
  volumeUsed: boolean
  exit: Promise<number | null> | null
  firstReport: Promise<void> | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const noServer: NonNullable<SigninDeps['relay']> = (o) =>
  startRelay({
    jobId: 'signin',
    occurrenceId: 'signin',
    onSignin: o.onSignin,
    api: { heartbeat: () => Promise.reject(new Error('A sign-in has no meeting to report to')) }
  })

/**
 * Opens and closes sign-in views for the identities on this PC. At most one session per identity. `open` returns once
 * the window was handed the URL; `done` (the window's Done button) and the 60-minute limit end it, and so does a
 * container that stops by itself (15 minutes idle). `closeAll` ends every session when the app quits.
 */
export class SigninController {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly d: SigninDeps) {}

  /** The identities with a view open or opening. */
  openIdentities(): string[] {
    return [...this.sessions.keys()]
  }

  /** Throws `SigninRefused` (nothing was started) or the failure of a start (everything it made was removed). */
  async open(identityId: string): Promise<void> {
    profileVolume(identityId) // refuses anything that is not an identity id before it reaches a path or a name
    if (this.sessions.has(identityId)) throw new SigninRefused('already_open')
    const session: Session = {
      identityId,
      kind: this.d.runner.activeIdentity() === identityId ? 'attach' : 'container',
      opening: Promise.resolve(),
      finishing: null,
      timer: null,
      window: null,
      relay: null,
      eph: null,
      stopping: false,
      paused: false,
      holder: null,
      container: null,
      volumeUsed: false,
      exit: null,
      firstReport: null
    }
    this.sessions.set(identityId, session)
    session.opening = session.kind === 'attach' ? this.attach(session) : this.startContainer(session)
    try {
      await session.opening
    } catch (e) {
      await this.finish(session).catch(this.onError)
      throw e
    }
    session.timer = setTimeout(
      () => void this.finish(session).catch(this.onError),
      this.d.sessionMs ?? SIGNIN_SESSION_MS
    )
    session.timer.unref?.()
  }

  /** The member pressed Done: checkpoint, remove everything, close the view. Does nothing without an open view. */
  async done(identityId: string): Promise<void> {
    const session = this.sessions.get(identityId)
    if (session === undefined) return
    await session.opening.catch(() => undefined)
    await this.finish(session)
  }

  /** The app is quitting: ends every session. Each is tried; the failures are thrown together afterwards. */
  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map(async (s) => {
        await s.opening.catch(() => undefined)
        await this.finish(s)
      })
    )
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    if (failures.length > 0)
      throw new AggregateError(failures, `${failures.length} sign-in view(s) did not close cleanly`)
  }

  private readonly onError = (error: unknown): void => (this.d.onError ?? console.error)(error)

  // --- A meeting is running: use its desk ---

  private async attach(s: Session): Promise<void> {
    const { runner } = this.d
    const port = runner.noVncPort(s.identityId)
    const password = this.d.deskPassword(s.identityId)
    if (port === null || password === null) throw new SigninRefused('meeting_starting')
    if (!runner.inject(s.identityId, 'pause_for_signin')) throw new SigninRefused('meeting_starting')
    s.paused = true
    // A failure here reaches `open`, whose cleanup resumes the worker.
    this.show(s, vncUrl(port, password))
  }

  // --- No meeting: a sign-in container ---

  private async startContainer(s: Session): Promise<void> {
    const { docker, paths } = this.d
    const id = s.identityId
    const image = this.d.imageRef()
    const sessionId = randomUUID()

    await docker.rm(signinName(id)) // leftovers of a crashed app
    await docker.rm(holderName(signinScope(id)))
    await docker.ensureNetwork(LOCAL_NETWORK)
    await mkdir(paths.runs, { recursive: true })
    await mkdir(checkpointsDir(paths, id), { recursive: true })
    await writeFileAtomic(machineIdFile(paths, id), `${machineIdFor(id)}\n`, 0o644)

    let firstReport!: () => void
    s.firstReport = new Promise<void>((resolve) => (firstReport = resolve))
    s.relay = await (this.d.relay ?? noServer)({
      onSignin: (hb) => {
        if (hb.sessionId !== sessionId) throw new Error('A report for another sign-in session')
        firstReport()
        return { commands: s.stopping ? ['stop'] : [] }
      }
    })
    const relay = s.relay

    const job = SigninJobSchema.parse({
      sessionId,
      identityId: id,
      profileDir: `/tm/profiles/${id}/vol/work`,
      checkpointsDir: `/tm/profiles/${id}/checkpoints`,
      control: { url: relay.containerUrl, token: relay.token }
    })
    const localKey = await ensureProfileKey(this.d.secrets)
    s.eph = await writeEphemeral(paths.runs, {
      'profile.key': identityKeyFile(localKey, id),
      'signin.json': JSON.stringify(job)
    })

    const holder = holderName(signinScope(id))
    s.holder = holder
    await docker.run(
      holderArgs({ scope: signinScope(id), identityId: id, image, allowTcp: [`host.docker.internal:${relay.port}`] })
    )
    const holderExit = docker.wait(holder).then(
      () => undefined,
      () => undefined
    )
    let holderGone = false
    void holderExit.then(() => (holderGone = true))
    await this.holderReady(holder, () => holderGone, holderExit)
    const port = await docker.port(holder, NOVNC_PORT)
    if (port === null) throw new Error('The sign-in view has no published port')

    // A meeting for this identity may have been claimed while the holder started: never share one profile.
    if (this.d.runner.activeIdentity() === id) throw new SigninRefused('meeting_running')

    const container = signinName(id)
    s.container = container
    await docker.run(
      signinArgs({
        identityId: id,
        image,
        mounts: {
          checkpointsDir: checkpointsDir(paths, id),
          ephemeralDir: s.eph.dir,
          machineIdFile: machineIdFile(paths, id)
        }
      })
    )
    // The volume exists from here on (a run that failed to start may still have left a container, removed at the end).
    s.volumeUsed = true
    const exit = docker.wait(container).then(
      (code) => code,
      () => null
    )
    s.exit = exit
    void exit.then(() => {
      // The container ended by itself (15 minutes idle, or it failed): checkpoint and clean up, close the view.
      if (!s.stopping) void this.finish(s).catch(this.onError)
    })

    // The profile key and the job were read before the first report; the files go as soon as it arrives.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => (timer = setTimeout(resolve, this.d.startMs ?? SIGNIN_START_MS, null)))
    const reported = await Promise.race([
      s.firstReport.then(() => true as const),
      exit.then(() => false as const),
      late
    ]).finally(() => clearTimeout(timer))
    if (reported === false) throw new Error('The sign-in container stopped before it was ready')
    if (reported === null) throw new Error('The sign-in container did not report in time')
    await s.eph.remove()

    // The view's password is derived from the control token, as the worker derives it. It is never written anywhere.
    this.show(s, vncUrl(port, vncSecret(controlTokenHash(relay.token))))
  }

  /** Polls the holder's stdout for the ready line (see `LocalRunner`); a holder that stops or stays silent fails closed. */
  private async holderReady(name: string, gone: () => boolean, exited: Promise<void>): Promise<void> {
    const deadline = Date.now() + (this.d.holderReadyMs ?? HOLDER_READY_MS)
    const pollMs = this.d.holderPollMs ?? HOLDER_POLL_MS
    for (;;) {
      if (gone()) throw new Error('The network holder stopped before it was ready')
      const out = await this.d.docker.logs(name)
      if (gone()) throw new Error('The network holder stopped before it was ready')
      if (out.split(/\r?\n/).includes(HOLDER_READY_LINE)) return
      if (Date.now() >= deadline) throw new Error('The network holder did not report its rules in time')
      await Promise.race([exited, sleep(pollMs)])
    }
  }

  private show(s: Session, url: string): void {
    // TODO(figma-gate): `openWindow` is where the sign-in BrowserWindow opens (renderer/signin.html with one `Done`
    // button; contextIsolation, no node integration, sandbox; `will-navigate` and `setWindowOpenHandler` refuse any
    // URL that fails `isAllowedSigninUrl(url, port)`). It waits for the approved design.
    const handle = this.d.openWindow(url, () => void this.done(s.identityId).catch(this.onError))
    s.window = handle ?? null
  }

  // --- The end ---

  private finish(s: Session): Promise<void> {
    s.finishing ??= this.teardown(s)
    return s.finishing
  }

  /**
   * Every step is tried even when an earlier one failed. The profile volume goes only when the profile is known to be
   * saved: the container exited 0 (it checkpoints before it exits), or the fallback checkpoint of the volume worked.
   */
  private async teardown(s: Session): Promise<void> {
    const { docker } = this.d
    const errors: unknown[] = []
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        errors.push(e)
      }
    }
    s.stopping = true
    if (s.timer !== null) clearTimeout(s.timer)
    await step(() => s.window?.close())

    if (s.kind === 'attach') {
      // False when the meeting already ended: nothing is left to resume.
      if (s.paused) await step(() => this.d.runner.inject(s.identityId, 'resume_after_signin'))
    } else {
      let saved = true
      if (s.container !== null) {
        const name = s.container
        const exit = s.exit
        let code: number | null = null
        // A container that never started has no profile to save.
        if (exit !== null) {
          await step(() => docker.stop(name, SIGNIN_STOP_SECONDS))
          await step(async () => void (code = await exit))
        }
        if (exit !== null && code !== 0) {
          saved = false
          const image = this.d.imageRef()
          await step(async () => {
            const localKey = await ensureProfileKey(this.d.secrets)
            await checkpointVolume({ docker, image, paths: this.d.paths, localKey }, s.identityId)
            saved = true
          })
        }
        await step(() => docker.rm(name))
      }
      const holder = s.holder
      if (holder !== null) await step(() => docker.rm(holder))
      if (s.volumeUsed && saved) await step(() => docker.volumeRm(profileVolume(s.identityId)))
      const relay = s.relay
      if (relay !== null) await step(() => relay.close())
      await step(() => s.eph?.remove())
    }
    this.sessions.delete(s.identityId)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'The sign-in view did not close cleanly')
  }
}
