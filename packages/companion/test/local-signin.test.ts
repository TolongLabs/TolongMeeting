import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlTokenHash, vncSecret, type ControlCommand, type SigninJob } from '@tm/core'
import { holderName, signinName, signinScope } from '../src/local/containers'
import { checkRunArgs, type DockerLike } from '../src/local/docker'
import { HOLDER_READY_LINE } from '../src/local/run'
import {
  isAllowedSigninUrl,
  SIGNIN_HOSTS,
  signinArgs,
  SigninController,
  SigninRefused,
  vncUrl,
  type SigninDeps
} from '../src/local/signin'
import { localPaths } from '../src/local/vault'
import { SecretStore, type SafeStorageLike } from '../src/secrets'

const REF = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'
const ID = '7d4f3c1e-0b52-4c6e-9a1d-3b8f2a6c5e10'
const OTHER = '0e9a1f52-6d3b-4c7a-8b2e-5f1c9d4a7b33'
const NOVNC_HOST_PORT = 49152

const fakeSafe = (): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
})

// --- Pure helpers ---

const mounts = {
  checkpointsDir: '/pc/profiles/x/checkpoints',
  ephemeralDir: '/pc/runs/r1',
  machineIdFile: '/pc/machine-ids/x'
}
const flagValues = (args: string[], flag: string): string[] => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []))

describe('signinArgs', () => {
  const args = signinArgs({ identityId: ID, image: REF, mounts })

  test('passes the same run-argument check as every other PC container', () => {
    checkRunArgs(args)
    expect(flagValues(args, '--cap-drop')).toEqual(['ALL'])
    expect(flagValues(args, '--security-opt')).toEqual(['no-new-privileges'])
    expect(flagValues(args, '--pids-limit')).toEqual(['2048'])
    expect(flagValues(args, '--memory')).toEqual(['5g'])
    expect(flagValues(args, '--name')).toEqual([signinName(ID)])
    expect(flagValues(args, '--label')).toEqual([`tm.identity=${ID}`])
  })

  test('joins the holder behind the egress rules, publishes nothing, and runs the image in --signin mode', () => {
    expect(flagValues(args, '--network')).toEqual([`container:${holderName(signinScope(ID))}`])
    expect(args).not.toContain('-p')
    expect(args.slice(args.indexOf(REF))).toEqual([REF, '--signin', '/run/tm/signin.json'])
  })

  test('mounts only its own volume, checkpoints, short-lived folder and machine id, and names files, not secrets', () => {
    expect(flagValues(args, '-v')).toEqual([
      `tm-profile-${ID}:/tm/profiles/${ID}/vol`,
      `${mounts.checkpointsDir}:/tm/profiles/${ID}/checkpoints`,
      `${mounts.ephemeralDir}:/run/tm:ro`,
      `${mounts.machineIdFile}:/etc/machine-id:ro`
    ])
    expect(flagValues(args, '-e')).toEqual(['TM_PROFILE_ROOT=/tm/profiles', 'TM_PROFILE_KEY_FILE=/run/tm/profile.key'])
  })

  test('an identity id that is not a plain id is refused before it reaches a name or a path', () => {
    expect(() => signinArgs({ identityId: '../x', image: REF, mounts })).toThrow()
  })
})

describe('vncUrl', () => {
  test('is the loopback noVNC page, with the password in the fragment and nowhere else', () => {
    const u = new URL(vncUrl(49152, 'pw-Ab_9'))
    expect(u.origin).toBe('http://127.0.0.1:49152')
    expect(u.pathname).toBe('/vnc.html')
    expect(u.search).toBe('')
    expect(u.username + u.password).toBe('')
    expect(u.hash).toBe('#autoconnect=1&resize=scale&password=pw-Ab_9')
    expect(u.href.replace(u.hash, '')).not.toContain('pw-Ab_9')
  })

  test('refuses a port that is not a port and a password that could change the URL', () => {
    for (const port of [0, 65536, 1.5, Number.NaN]) expect(() => vncUrl(port, 'pw')).toThrow(RangeError)
    for (const pw of ['', 'a&b', 'a b', 'a#b', 'a/b', 'a%20b', 'x'.repeat(65)])
      expect(() => vncUrl(49152, pw)).toThrow()
  })
})

describe('isAllowedSigninUrl', () => {
  test('the window stays on the loopback noVNC page', () => {
    expect(isAllowedSigninUrl('http://127.0.0.1:49152/vnc.html#x', 49152)).toBe(true)
    expect(isAllowedSigninUrl(vncUrl(49152, 'pw'), 49152)).toBe(true)
    expect(isAllowedSigninUrl('http://127.0.0.1:49153/', 49152)).toBe(false)
    expect(isAllowedSigninUrl('https://login.microsoftonline.com/', 49152)).toBe(false)
    for (const url of [
      'http://localhost:49152/',
      'http://[::1]:49152/',
      'http://127.0.0.2:49152/',
      'https://127.0.0.1:49152/',
      'http://127.0.0.1/',
      'http://user@127.0.0.1:49152/',
      'http://127.0.0.1:49152@evil.example/',
      'http://127.0.0.1.evil.example:49152/',
      'http://127.0.0.1:49152\\@evil.example/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank',
      ''
    ]) {
      expect(isAllowedSigninUrl(url, 49152, ['microsoft'])).toBe(false)
    }
  })

  test('sign-in pages are allowed only for the identity accounts, by exact host, over https', () => {
    expect(isAllowedSigninUrl('https://login.microsoftonline.com/common/oauth2?x=1#y', 1, ['microsoft'])).toBe(true)
    expect(isAllowedSigninUrl('https://accounts.google.com/', 1, ['google', 'zoom'])).toBe(true)
    expect(isAllowedSigninUrl('https://ZOOM.US/signin', 1, ['zoom'])).toBe(true)
    // An account the identity does not have.
    expect(isAllowedSigninUrl('https://accounts.google.com/', 1, ['microsoft'])).toBe(false)
    expect(isAllowedSigninUrl('https://accounts.google.com/', 1, [])).toBe(false)
    expect(isAllowedSigninUrl('https://accounts.google.com/', 1)).toBe(false)
  })

  test('look-alike hosts, user info, ports and other schemes are refused', () => {
    const lookAlikes = [
      'https://zoom.us.evil.example/signin',
      'https://evil-zoom.us/',
      'https://xzoom.us/',
      'https://notzoom.us/',
      'https://zoom.us.:443/',
      'https://zoom.us./signin',
      'https://zoom.us@evil.example/',
      'https://zoom.us:pw@evil.example/',
      'https://evil.example@zoom.us/',
      'https://user@zoom.us/',
      'https://zoom.us:443/',
      'https://zoom.us:8443/',
      'https://zoom.us\\@evil.example/',
      'https://zoom.us%2f@evil.example/',
      'https://zoom.us%00.evil.example/',
      'https://zооm.us/', // Cyrillic o
      'https://xn--zom-8cd.us/',
      'http://zoom.us/signin',
      'wss://zoom.us/',
      'ftp://zoom.us/',
      '//zoom.us/',
      'zoom.us',
      ' https://zoom.us/',
      'https://zoom.us/ x',
      'https://sub.zoom.us/',
      'https://us04web.zoom.us/'
    ]
    for (const url of lookAlikes) expect(isAllowedSigninUrl(url, 49152, ['zoom'])).toBe(false)
    // The other accounts' real hosts do not unlock this one.
    expect(isAllowedSigninUrl('https://discord.com/login', 49152, ['zoom'])).toBe(false)
  })

  test('every account kind has exact, plain hosts only', () => {
    for (const hosts of Object.values(SIGNIN_HOSTS)) {
      expect(hosts.length).toBeGreaterThan(0)
      for (const host of hosts) expect(host).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/)
    }
  })
})

// --- The controller, over a fake Docker and a fake sign-in container ---

interface Opts {
  active?: () => string | null
  stopCode?: number
  silent?: boolean // the container never reports
  deskPort?: number | null
  deskPassword?: string | null
  holderOut?: string
  sessionMs?: number
  startMs?: number
  checkpointCode?: number
  failRun?: string
}

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tm-signin-'))
})
afterEach(() => rm(tmp, { recursive: true, force: true }))

async function rig(opts: Opts = {}) {
  const log: string[] = []
  const argv: string[][] = []
  const injected: [string, ControlCommand][] = []
  const opened: string[] = []
  const closed: string[] = []
  const errors: unknown[] = []
  const exits = new Map<string, (code: number) => void>()
  const exited = new Map<string, Promise<number>>()
  const out = new Map<string, string>()
  const seen: { job: SigninJob | null; ephDir: string | null; keyBytes: number; replies: unknown[] } = {
    job: null,
    ephDir: null,
    keyBytes: 0,
    replies: []
  }
  const volumes = new Set<string>()
  let done: (() => void) | null = null

  const nameOf = (args: string[]): string => args[args.indexOf('--name') + 1]!
  const end = (name: string, code: number) => exits.get(name)?.(code)

  async function container(args: string[]) {
    const dir = flagValues(args, '-v')
      .find((v) => v.endsWith(':/run/tm:ro'))!
      .slice(0, -':/run/tm:ro'.length)
    const job = JSON.parse(await readFile(join(dir, 'signin.json'), 'utf8')) as SigninJob
    seen.ephDir = dir
    seen.job = job
    seen.keyBytes = (await readFile(join(dir, 'profile.key'))).length
    if (opts.silent) return
    const url = new URL(job.control.url)
    const res = await fetch(`http://127.0.0.1:${url.port}/signin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${job.control.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: job.sessionId, idleMs: 0, ended: false })
    })
    seen.replies.push(await res.json())
  }

  const docker: DockerLike = {
    info: async () => ({ memTotal: 8e9 }),
    imagePresent: async () => true,
    pull: async () => true,
    async run(args) {
      checkRunArgs(args)
      argv.push(args)
      const name = nameOf(args)
      log.push(`run ${name}`)
      if (name === opts.failRun) throw new Error('docker run failed')
      exited.set(name, new Promise<number>((r) => exits.set(name, r)))
      if (name.startsWith('tm-net-')) out.set(name, opts.holderOut ?? `${HOLDER_READY_LINE}\n`)
      if (name.startsWith('tm-signin-')) {
        volumes.add(`tm-profile-${ID}`)
        container(args).catch((e: unknown) => errors.push(e))
      }
      if (name.startsWith('tm-ckpt-')) end(name, opts.checkpointCode ?? 0)
      return `id-${name}`
    },
    async wait(name) {
      const p = exited.get(name)
      if (!p) throw new Error(`no such container ${name}`)
      return p
    },
    async logs(name) {
      return out.get(name) ?? ''
    },
    async stop(name, sec) {
      log.push(`stop ${name} ${sec}`)
      end(name, opts.stopCode ?? 0)
    },
    async rm(name) {
      if (exited.has(name)) log.push(`rm ${name}`)
      end(name, 0)
    },
    async volumeRm(name) {
      log.push(`volume rm ${name}`)
      volumes.delete(name)
    },
    volumes: async () => [...volumes],
    running: async () => [],
    async port(name, containerPort) {
      return name.startsWith('tm-net-') && containerPort === 6080 ? NOVNC_HOST_PORT : null
    },
    ensureNetwork: async (name) => void log.push(`network ${name}`)
  }

  const runner: SigninDeps['runner'] = {
    activeIdentity: opts.active ?? (() => null),
    inject: (id, c) => {
      injected.push([id, c])
      return true
    },
    noVncPort: () => (opts.deskPort === undefined ? 43210 : opts.deskPort)
  }
  const secrets = new SecretStore(join(tmp, 'secrets.json'), fakeSafe())
  const controller = new SigninController({
    runner,
    docker,
    secrets,
    paths: localPaths(tmp),
    imageRef: () => REF,
    deskPassword: () => (opts.deskPassword === undefined ? 'Desk_pw1' : opts.deskPassword),
    openWindow: (url, onDone) => {
      opened.push(url)
      done = onDone
      return { close: () => void closed.push(url) }
    },
    holderPollMs: 5,
    holderReadyMs: 200,
    onError: (e) => void errors.push(e),
    ...(opts.sessionMs === undefined ? {} : { sessionMs: opts.sessionMs }),
    ...(opts.startMs === undefined ? {} : { startMs: opts.startMs })
  })
  return {
    controller,
    log,
    argv,
    injected,
    opened,
    closed,
    errors,
    seen,
    volumes,
    end,
    pressDone: () => done!(),
    docker,
    runsDir: localPaths(tmp).runs
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits (up to 5 s) for `ok`; the machine may be loaded, so no case depends on a fixed delay. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ok(); i++) await tick(10)
}
const relayPortOf = (job: SigninJob) => Number(new URL(job.control.url).port)
const refused = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    if (e instanceof SigninRefused) return e.reason
    throw e
  }
  throw new Error('was not refused')
}

describe('during a local meeting of the identity', () => {
  test('the view attaches to the worker desk and pauses automation; no container starts', async () => {
    const r = await rig({ active: () => ID })
    await r.controller.open(ID)
    expect(r.injected).toEqual([[ID, 'pause_for_signin']])
    expect(r.opened).toEqual([vncUrl(43210, 'Desk_pw1')])
    expect(r.log).toEqual([])
    await r.pressDone()
    await until(() => r.controller.openIdentities().length === 0)
    expect(r.injected.at(-1)).toEqual([ID, 'resume_after_signin'])
    expect(r.closed).toHaveLength(1)
    expect(r.controller.openIdentities()).toEqual([])
    expect(r.log).toEqual([])
  })

  test('a desk that is not up yet is refused with a clear status, and nothing is paused or opened', async () => {
    for (const o of [{ deskPort: null }, { deskPassword: null }]) {
      const r = await rig({ active: () => ID, ...o })
      expect(await refused(r.controller.open(ID))).toBe('meeting_starting')
      expect(r.injected).toEqual([])
      expect(r.opened).toEqual([])
      expect(r.log).toEqual([])
      expect(r.controller.openIdentities()).toEqual([])
    }
  })

  test('a meeting claimed while the holder starts stops the sign-in container before it exists', async () => {
    let active: string | null = null
    const r = await rig({ active: () => active })
    const origRun = r.docker.run.bind(r.docker)
    r.docker.run = async (args) => {
      const id = await origRun(args)
      if (args.includes('--entrypoint')) active = ID // the meeting runner took the identity
      return id
    }
    expect(await refused(r.controller.open(ID))).toBe('meeting_running')
    expect(r.log.filter((l) => l.startsWith('run tm-signin-'))).toEqual([])
    expect(r.log).toContain(`rm ${holderName(signinScope(ID))}`)
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('a meeting of another identity does not block the sign-in container', async () => {
    const r = await rig({ active: () => OTHER })
    await r.controller.open(ID)
    expect(r.log).toContain(`run ${signinName(ID)}`)
    expect(r.injected).toEqual([])
    await r.controller.done(ID)
  })
})

describe('without a meeting: a sign-in container', () => {
  test('starts the holder, then the container; the view is on 127.0.0.1 and the password is never in an argument', async () => {
    const r = await rig()
    await r.controller.open(ID)
    const runs = r.log.filter((l) => l.startsWith('run '))
    expect(runs).toEqual([`run ${holderName(signinScope(ID))}`, `run ${signinName(ID)}`])
    const holder = r.argv[0]!
    // noVNC is published on loopback, on a port Docker picks (no host port in the flag).
    expect(flagValues(holder, '-p')).toEqual(['127.0.0.1::6080'])
    const job = r.seen.job!
    const password = vncSecret(controlTokenHash(job.control.token))
    expect(r.opened).toEqual([vncUrl(NOVNC_HOST_PORT, password)])
    expect(new URL(r.opened[0]!).hostname).toBe('127.0.0.1')
    // The holder lets the container reach the relay and nothing else on the PC.
    expect(holder.slice(holder.indexOf('--hold') - 2)).toEqual([
      '--allow-tcp',
      `host.docker.internal:${relayPortOf(job)}`,
      '--hold'
    ])
    // Neither the token nor the password is in any argument.
    const words = r.argv.flat().join('\n')
    expect(words).not.toContain(job.control.token)
    expect(words).not.toContain(password)
    expect(JSON.stringify(r.log)).not.toContain(password)
    expect(r.errors).toEqual([])
    await r.controller.done(ID)
  })

  test('the profile key and the job arrive as files, and the files are gone once the container reported', async () => {
    const r = await rig()
    await r.controller.open(ID)
    expect(r.seen.keyBytes).toBeGreaterThan(20)
    expect(r.seen.job).toMatchObject({
      identityId: ID,
      profileDir: `/tm/profiles/${ID}/vol/work`,
      checkpointsDir: `/tm/profiles/${ID}/checkpoints`
    })
    expect(existsSync(r.seen.ephDir!)).toBe(false)
    await r.controller.done(ID)
  })

  test('Done checkpoints through the container, then removes the container, the holder, the volume, the relay and the files', async () => {
    const r = await rig()
    await r.controller.open(ID)
    const port = relayPortOf(r.seen.job!)
    expect((await fetch(`http://127.0.0.1:${port}/nothing`)).status).toBe(404) // the relay is up
    await r.pressDone()
    await until(() => r.controller.openIdentities().length === 0)
    expect(r.log.slice(r.log.indexOf(`run ${signinName(ID)}`) + 1)).toEqual([
      `stop ${signinName(ID)} 60`,
      `rm ${signinName(ID)}`,
      `rm ${holderName(signinScope(ID))}`,
      `volume rm tm-profile-${ID}`
    ])
    // The container's exit 0 is its own checkpoint: no second container reads the volume.
    expect(r.log.some((l) => l.startsWith('run tm-ckpt-'))).toBe(false)
    expect(r.closed).toHaveLength(1)
    expect(existsSync(r.seen.ephDir!)).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/nothing`)).rejects.toThrow() // the port is closed
    expect(r.controller.openIdentities()).toEqual([])
    expect(r.errors).toEqual([])
  })

  test('only one container per identity, even for two opens at once', async () => {
    const r = await rig()
    const results = await Promise.allSettled([r.controller.open(ID), r.controller.open(ID)])
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await refused(r.controller.open(ID))).toBe('already_open')
    expect(r.log.filter((l) => l === `run ${signinName(ID)}`)).toHaveLength(1)
    expect(r.opened).toHaveLength(1)
    await r.controller.done(ID)
    // After Done the identity can be opened again.
    await r.controller.open(ID)
    await r.controller.done(ID)
  })

  test('two identities have their own containers, holders and ports', async () => {
    const r = await rig()
    await Promise.all([r.controller.open(ID), r.controller.open(OTHER)])
    expect(r.log.filter((l) => l.startsWith('run tm-signin-')).sort()).toEqual(
      [`run ${signinName(ID)}`, `run ${signinName(OTHER)}`].sort()
    )
    await r.controller.closeAll()
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('the 60 minute limit ends the view the same way Done does', async () => {
    const r = await rig({ sessionMs: 30 })
    await r.controller.open(ID)
    await until(() => r.controller.openIdentities().length === 0)
    expect(r.log).toContain(`stop ${signinName(ID)} 60`)
    expect(r.log).toContain(`volume rm tm-profile-${ID}`)
    expect(r.closed).toHaveLength(1)
    expect(r.controller.openIdentities()).toEqual([])
    expect(r.errors).toEqual([])
  })

  test('a container that ends by itself (idle) is cleaned up and its view closed', async () => {
    const r = await rig()
    await r.controller.open(ID)
    r.end(signinName(ID), 0)
    await until(() => r.controller.openIdentities().length === 0)
    expect(r.log).toContain(`rm ${signinName(ID)}`)
    expect(r.log).toContain(`rm ${holderName(signinScope(ID))}`)
    expect(r.log).toContain(`volume rm tm-profile-${ID}`)
    expect(r.closed).toHaveLength(1)
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('quitting the app ends every view', async () => {
    const r = await rig()
    await r.controller.open(ID)
    await r.controller.closeAll()
    expect(r.log).toContain(`stop ${signinName(ID)} 60`)
    expect(r.log).toContain(`volume rm tm-profile-${ID}`)
    expect(r.closed).toHaveLength(1)
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('a container that failed to checkpoint is checkpointed from its volume; if that fails too the volume stays', async () => {
    const r = await rig({ stopCode: 1 })
    await r.controller.open(ID)
    await r.controller.done(ID)
    expect(r.log.some((l) => l.startsWith('run tm-ckpt-'))).toBe(true)
    expect(r.log).toContain(`volume rm tm-profile-${ID}`)

    const bad = await rig({ stopCode: 1, checkpointCode: 1 })
    await bad.controller.open(ID)
    await expect(bad.controller.done(ID)).rejects.toThrow()
    expect(bad.log.some((l) => l.startsWith('volume rm'))).toBe(false)
    expect(bad.volumes.has(`tm-profile-${ID}`)).toBe(true)
    // Everything else is still removed, and the identity can be opened again.
    expect(bad.log).toContain(`rm ${signinName(ID)}`)
    expect(bad.log).toContain(`rm ${holderName(signinScope(ID))}`)
    expect(existsSync(bad.seen.ephDir!)).toBe(false)
    expect(bad.controller.openIdentities()).toEqual([])
  })

  test('a container that never reports fails the open and leaves nothing behind', async () => {
    const r = await rig({ silent: true, startMs: 50 })
    await expect(r.controller.open(ID)).rejects.toThrow('did not report in time')
    expect(r.opened).toEqual([])
    expect(r.log).toContain(`stop ${signinName(ID)} 60`)
    expect(r.log).toContain(`rm ${signinName(ID)}`)
    expect(r.log).toContain(`rm ${holderName(signinScope(ID))}`)
    expect(existsSync(r.seen.ephDir!)).toBe(false)
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('a holder that never prints its ready line fails the open, and no container starts', async () => {
    const r = await rig({ holderOut: 'something else\n' })
    await expect(r.controller.open(ID)).rejects.toThrow('did not report its rules')
    expect(r.log.some((l) => l.startsWith(`run ${signinName(ID)}`))).toBe(false)
    expect(r.log).toContain(`rm ${holderName(signinScope(ID))}`)
    expect(r.opened).toEqual([])
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('a container that fails to start is removed and its volume is left alone', async () => {
    const r = await rig({ failRun: signinName(ID) })
    await expect(r.controller.open(ID)).rejects.toThrow('docker run failed')
    expect(r.log).toContain(`rm ${holderName(signinScope(ID))}`)
    expect(r.log.some((l) => l.startsWith('volume rm'))).toBe(false)
    expect(r.controller.openIdentities()).toEqual([])
  })

  test('an id that is not an identity id never reaches Docker', async () => {
    const r = await rig()
    await expect(r.controller.open('../x')).rejects.toThrow()
    expect(r.log).toEqual([])
  })
})
