import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlTokenHash,
  profileKey,
  type CompanionJob,
  type Heartbeat,
  type HeartbeatReply,
  type JobConfig,
  type LocalRunPayload,
  type NtfyConfig,
  type PreflightReport,
  vncSecret
} from '@tm/core'
import { hostnameFor as workerHostnameFor, machineIdFor as workerMachineIdFor } from '../../worker/src/profile/keys'
import { CompanionApiError } from '../src/api'
import {
  holderArgs,
  holderName,
  hostnameFor,
  LOCAL_NETWORK,
  localJobConfig,
  machineIdFile,
  machineIdFor,
  signinName,
  workerArgs
} from '../src/local/containers'
import { checkRunArgs, type DockerLike } from '../src/local/docker'
import {
  HOLDER_READY_LINE,
  LocalRunner,
  MAX_LOCAL_ATTEMPTS,
  type LocalOutcome,
  type LocalRunApi
} from '../src/local/run'
import { startRelay } from '../src/local/relay'
import { localPaths } from '../src/local/vault'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { StateStore } from '../src/state'
import { fileURLToPath } from 'node:url'

const REF = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'
const OCC = '11111111-1111-4111-8111-111111111111'
const ID = 'u1'

const ntfy: NtfyConfig = { url: 'https://ntfy.example.com', topic: 'tm-topic', token: 'tk_ntfy_secret' }
const details = [{ key: 'student_id', value: 'S123', labels: ['Student ID'] }]
const payload: LocalRunPayload = {
  occurrenceId: OCC,
  identityId: ID,
  identityName: 'Ali',
  image: REF,
  job: {
    occurrenceId: OCC,
    attempt: 1,
    entry: {
      name: 'Data Mining',
      type: 'lecture',
      start: '2026-10-21T09:00:00+08:00',
      end: '2026-10-21T10:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      link: { kind: 'fixed', url: 'https://zoom.us/j/123456789' },
      trustedSenders: [],
      transcription: 'live',
      formDetails: {},
      attendanceKeywords: []
    },
    identity: { id: ID, name: 'Ali', zoomGuestName: 'Ali', formProviders: [], organisation: null },
    member: { id: 'm1', displayName: 'Ali', mentionNames: [] },
    ai: {
      baseUrl: 'https://ai.example.com/v1',
      asrUrl: 'wss://asr.example.com/ws',
      models: { summary: 's', vision: 'v', formMatch: 'f', asr: 'a' }
    },
    ntfy: { url: ntfy.url, topic: ntfy.topic },
    dataDir: `/tm/data/occurrences/${OCC}`,
    profileDir: '/tm/profiles/u1/work'
  }
}
const localJob: CompanionJob = {
  id: 'j1',
  state: 'claimed',
  occurrenceId: OCC,
  attempts: 1,
  kind: 'local_run',
  payload
}

// --- Argument lists, checked against what the image and the egress script really accept ---

const root = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const entrypoint = readFileSync(root('docker/worker/entrypoint.sh'), 'utf8')
const modeLine = entrypoint.split('\n').find((l) => l.startsWith('# Modes:')) ?? ''
const denyPrivate = readFileSync(root('docker/egress/deny-private.sh'), 'utf8')
const denyUsage = denyPrivate.split('\n').find((l) => l.startsWith('#   deny-private.sh')) ?? ''

const mounts = {
  dataDir: '/pc/data',
  checkpointsDir: '/pc/profiles/u1/checkpoints',
  ephemeralDir: '/pc/runs/r1',
  machineIdFile: '/pc/machine-ids/u1'
}
const tailOf = (args: string[]): string[] => args.slice(args.indexOf(REF) + 1)
const flagValues = (args: string[], flag: string): string[] => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []))

describe('container argument lists', () => {
  const worker = workerArgs({ occurrenceId: OCC, identityId: ID, attempt: 2, image: REF, mounts })
  const holder = holderArgs({ scope: OCC, identityId: ID, image: REF, allowTcp: ['host.docker.internal:41234'] })

  test('the worker passes paths, never secrets, takes the --job mode and joins the holder', () => {
    checkRunArgs(worker, 'ghcr.io/tl/', ['/pc'])
    expect(worker).toEqual(
      expect.arrayContaining([
        '--name',
        `tm-run-${OCC}-2`,
        '--label',
        'tm.identity=u1',
        '--shm-size=2g',
        '--network',
        `container:tm-net-${OCC}`,
        '-v',
        'tm-profile-u1:/tm/profiles/u1/vol',
        '-v',
        '/pc/profiles/u1/checkpoints:/tm/profiles/u1/checkpoints',
        '-v',
        '/pc/data:/tm/data',
        '-v',
        '/pc/runs/r1:/run/tm:ro',
        '-v',
        '/pc/machine-ids/u1:/etc/machine-id:ro'
      ])
    )
    expect(flagValues(worker, '-e')).toEqual([
      'TM_DATA_ROOT=/tm/data',
      'TM_PROFILE_ROOT=/tm/profiles',
      'TM_PROFILE_KEY_FILE=/run/tm/profile.key'
    ])
    // The entrypoint's mode `--job <path>` comes right after the image; the mode exists in entrypoint.sh.
    expect(tailOf(worker)).toEqual(['--job', '/run/tm/job.json'])
    expect(modeLine).toContain('--job <path>')
  })

  test('the worker is hardened like the server body and gets no way to leave its mounts', () => {
    expect(flagValues(worker, '--cap-drop')).toEqual(['ALL'])
    expect(flagValues(worker, '--security-opt')).toEqual(['no-new-privileges'])
    expect(flagValues(worker, '--pids-limit')).toEqual(['2048'])
    expect(flagValues(worker, '--memory')).toEqual(['5g'])
    expect(worker.join(' ')).not.toMatch(/--cap-add|--privileged|--user|-p |--hostname|--add-host|--dns/)
    // Only the profile volume of its own identity, never the volume as the restore target.
    const binds = flagValues(worker, '-v')
    expect(binds.filter((b) => b.startsWith('tm-profile-'))).toEqual(['tm-profile-u1:/tm/profiles/u1/vol'])
    expect(binds.some((b) => b.endsWith('/work'))).toBe(false)
  })

  test('the holder owns the rules, the host name and noVNC on 127.0.0.1 only', () => {
    checkRunArgs(holder, 'ghcr.io/tl/', ['/pc'])
    expect(holder).toEqual(
      expect.arrayContaining([
        '--name',
        `tm-net-${OCC}`,
        '--network',
        LOCAL_NETWORK,
        '--hostname',
        hostnameFor(ID),
        '--cap-drop',
        'ALL',
        '--cap-add',
        'NET_ADMIN',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '0',
        '-p',
        '127.0.0.1::6080',
        '--entrypoint',
        'deny-private.sh'
      ])
    )
    expect(flagValues(holder, '--pids-limit')).toHaveLength(1)
    // The script is not an entrypoint mode: the holder replaces the entrypoint and passes the script's own flags.
    expect(tailOf(holder)).toEqual(['--allow-tcp', 'host.docker.internal:41234', '--hold'])
    for (const flag of ['--allow-tcp', '--hold']) expect(denyUsage).toContain(flag)
    expect(denyPrivate).toContain('exec sleep infinity')
    // The line the runner waits for is the one the script prints, right before it sleeps.
    expect(denyPrivate).toContain(`echo "${HOLDER_READY_LINE}"\n  exec sleep infinity`)
  })

  test('host name and machine id match what the worker checks before it opens a profile', () => {
    expect(hostnameFor(ID)).toBe(workerHostnameFor(ID))
    expect(machineIdFor(ID)).toBe(workerMachineIdFor(ID))
    const long = '123e4567-e89b-42d3-a456-426614174000'
    expect(hostnameFor(long)).toBe(workerHostnameFor(long))
    expect(machineIdFor(long)).toBe(workerMachineIdFor(long))
  })

  test('localJobConfig fills secrets, the relay origin and container paths', () => {
    const cfg = localJobConfig(
      payload,
      { apiKey: 'sk-x', details },
      ntfy,
      { containerUrl: 'http://host.docker.internal:41234', token: 'rt' },
      2
    )
    expect(cfg).toMatchObject({
      attempt: 2,
      ai: { apiKey: 'sk-x' },
      ntfy,
      control: { url: 'http://host.docker.internal:41234', token: 'rt' },
      dataDir: `/tm/data/occurrences/${OCC}`,
      profileDir: '/tm/profiles/u1/vol/work'
    })
    expect(cfg.member.details).toEqual(details)
  })

  test('a payload that names another meeting is refused', () => {
    const other = { ...payload, job: { ...payload.job, occurrenceId: 'o2' } }
    expect(() =>
      localJobConfig(other, { apiKey: 'k', details }, ntfy, { containerUrl: 'http://h:1', token: 't' }, 1)
    ).toThrow()
  })
})

// --- A run over a fake Docker, a real relay and a fake worker that talks to it ---

type Behaviour =
  | { kind: 'exit'; code: number } // one heartbeat, then exits
  | { kind: 'silent' } // one heartbeat, then nothing until it is stopped
  | { kind: 'run' } // heartbeats every 10 ms; exits 0 on a `stop` command
  | { kind: 'nobeat'; code: number } // exits without a heartbeat

interface Opts {
  behaviours?: Behaviour[] // one per attempt; the last repeats
  info?: ({ memTotal: number } | null)[]
  running?: { name: string; identityId: string | null }[]
  silenceMs?: number
  holderExitsAtStart?: boolean
  holderOut?: string // what the holder prints to stdout at start, instead of the ready line ('' for nothing)
  holderReadyAfterMs?: number // the ready line comes this long after the holder starts (default: at once)
  holderExitsAfterMs?: number // the holder exits (code 1, no ready line) this long after it starts
  holderReadyMs?: number // the deadline for the ready line (default 2000)
  failWorkerRun?: boolean
  preflightRejects?: Error
  now?: () => number
  afterThrows?: boolean
}

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-localrun-'))
})
afterEach(() => rm(tmp, { recursive: true, force: true }))

const fakeSafe = (): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
})

interface Container {
  name: string
  args: string[]
  running: boolean
  removed: boolean
  exit: Promise<number>
  out: string // stdout, as `docker logs` returns it
  end: (code: number) => void
}

function build(opts: Opts = {}) {
  const log: string[] = []
  const argv: string[][] = []
  const jobsSeen: JobConfig[] = []
  const keysSeen: string[] = []
  const heartbeats: Heartbeat[] = []
  const preflights: PreflightReport[] = []
  const failures: string[] = []
  const afterCalls: { dataDir: string; outcome: LocalOutcome }[] = []
  const ephGone: boolean[] = []
  const problems: unknown[] = []
  const containers = new Map<string, Container>()
  const volumesUsed = new Set<string>()
  const volumesGone = new Set<string>()
  const beatAttempts = new Set<number>()
  const info = [...(opts.info ?? [{ memTotal: 8 * 1024 ** 3 }])]
  let relayHandle: Awaited<ReturnType<typeof startRelay>> | null = null
  let releasedAwake = 0
  let acquiredAwake = 0
  let paused = 0
  let resumed = 0

  const behaviourFor = (attempt: number): Behaviour =>
    (opts.behaviours ?? [{ kind: 'exit', code: 0 }])[Math.min(attempt, (opts.behaviours ?? [1]).length) - 1]!

  const nameOf = (args: string[]): string => args[args.indexOf('--name') + 1]!

  async function worker(c: Container, attempt: number): Promise<void> {
    const b = behaviourFor(attempt)
    const folder = flagValues(c.args, '-v')
      .find((v) => v.endsWith(':/run/tm:ro'))!
      .slice(0, -':/run/tm:ro'.length)
    // The files exist while the container starts.
    const cfg = JSON.parse(readFileSync(join(folder, 'job.json'), 'utf8')) as JobConfig
    jobsSeen.push(cfg)
    keysSeen.push(readFileSync(join(folder, 'profile.key'), 'utf8'))
    if (b.kind === 'nobeat') return c.end(b.code)
    const url = `${cfg.control!.url.replace('host.docker.internal', '127.0.0.1')}/heartbeat`
    const beat = async (): Promise<HeartbeatReply> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.control!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          occurrenceId: cfg.occurrenceId,
          attempt: cfg.attempt,
          state: 'in_meeting',
          recording: true,
          participants: 2,
          events: []
        })
      })
      return (await res.json()) as HeartbeatReply
    }
    await beat()
    if (b.kind === 'silent') return
    if (b.kind === 'exit') {
      // The first heartbeat must have removed the short-lived files by now.
      for (let i = 0; i < 100 && existsSync(folder); i++) await Bun.sleep(5)
      ephGone.push(!existsSync(folder))
      return c.end(b.code)
    }
    while (c.running) {
      const reply = await beat()
      if (reply.commands.includes('stop')) return c.end(0)
      await Bun.sleep(10)
    }
  }

  const docker: DockerLike = {
    async info() {
      return info.length > 1 ? info.shift()! : (info[0] ?? null)
    },
    imagePresent: async () => true,
    pull: async () => true,
    async run(args) {
      checkRunArgs(args, 'ghcr.io/tl/', [tmp, '/pc']) // the real allow-list judges every list
      argv.push(args)
      const name = nameOf(args)
      log.push(`run ${name}`)
      let end!: (code: number) => void
      const exit = new Promise<number>((r) => (end = r))
      const c: Container = {
        name,
        args,
        running: true,
        removed: false,
        exit,
        out: '',
        end: (code) => {
          c.running = false
          end(code)
        }
      }
      if (name.startsWith('tm-run-') && opts.failWorkerRun) throw new Error('docker run failed')
      containers.set(name, c)
      if (name.startsWith('tm-net-')) {
        if (opts.holderExitsAtStart) c.end(1)
        else if (opts.holderExitsAfterMs !== undefined) setTimeout(() => c.end(1), opts.holderExitsAfterMs)
        else if (opts.holderOut !== undefined) c.out = opts.holderOut
        else if (opts.holderReadyAfterMs !== undefined) {
          setTimeout(() => {
            if (!c.running) return
            log.push('holder ready')
            c.out = `${HOLDER_READY_LINE}\n`
          }, opts.holderReadyAfterMs)
        } else c.out = `${HOLDER_READY_LINE}\n`
      } else if (name.startsWith('tm-run-')) {
        volumesUsed.add('tm-profile-u1')
        const attempt = Number(name.split('-').at(-1))
        worker(c, attempt).catch((e: unknown) => problems.push(e))
      } else if (name.startsWith('tm-ckpt-')) {
        const tail = tailOf(args)
        expect(modeLine).toContain('checkpoint-only <identityId>')
        expect(tail).toEqual(['checkpoint-only', ID])
        expect(flagValues(args, '--network')).toEqual(['none'])
        c.end(0)
      }
      return `id-${name}`
    },
    async wait(name) {
      const c = containers.get(name)
      if (!c) throw new Error(`no such container ${name}`)
      return c.exit
    },
    async logs(name) {
      const c = containers.get(name)
      if (!c) throw new Error(`no such container ${name}`)
      return c.out
    },
    async stop(name, seconds) {
      log.push(`stop ${name} ${seconds}`)
      const c = containers.get(name)
      if (c?.running) c.end(143)
    },
    async rm(name) {
      const c = containers.get(name)
      if (!c) {
        if (opts.running?.some((r) => r.name === name)) log.push(`rm ${name}`) // started by an earlier session
        return
      }
      log.push(`rm ${name}`)
      if (c.running) c.end(137)
      c.removed = true
      containers.delete(name)
    },
    async volumeRm(name) {
      for (const c of containers.values()) {
        if (c.args.some((a) => a.startsWith(`${name}:`))) throw new Error('volume in use')
      }
      log.push(`volume rm ${name}`)
      volumesGone.add(name)
    },
    volumes: async () => [],
    async running() {
      const fromRun = [...containers.values()]
        .filter((c) => c.running)
        .map((c) => ({
          name: c.name,
          identityId: flagValues(c.args, '--label').includes('tm.identity=u1') ? ID : null
        }))
      return [...(opts.running ?? []), ...fromRun]
    },
    port: async () => 49153,
    ensureNetwork: async (n) => {
      log.push(`network ${n}`)
    }
  }

  const api: LocalRunApi = {
    async claim() {
      log.push('claim')
      return localJob
    },
    async preflight(_id, report) {
      if (opts.preflightRejects) throw opts.preflightRejects
      preflights.push(report)
      log.push(`preflight ${report.reason}`)
    },
    async secrets() {
      log.push('secrets')
      return { apiKey: 'sk-secret-ai-key', details }
    },
    async fail(_id, error) {
      failures.push(error)
    }
  }

  const secrets = new SecretStore(join(tmp, 'secrets.json'), fakeSafe())
  const paths = localPaths(join(tmp, 'Local'))
  const runner = new LocalRunner({
    api,
    docker,
    secrets,
    state: new StateStore(join(tmp, 'state.json')),
    paths,
    keepAwake: {
      acquire: () => {
        acquiredAwake++
        log.push('keep awake')
        return () => {
          releasedAwake++
          log.push('release keep awake')
        }
      }
    },
    native: {
      pause: async () => {
        paused++
        log.push('pause native')
      },
      resume: () => {
        resumed++
        log.push('resume native')
      }
    },
    ntfy: async () => ntfy,
    relay: async (o) => {
      relayHandle = await startRelay({
        jobId: o.jobId,
        occurrenceId: o.occurrenceId,
        ...(opts.now ? { now: opts.now } : {}),
        api: {
          async heartbeat(_jobId, hb): Promise<HeartbeatReply> {
            heartbeats.push(hb)
            if (hb.state === 'restarting') log.push(`synthetic restarting ${hb.attempt}`)
            else if (!beatAttempts.has(hb.attempt)) {
              beatAttempts.add(hb.attempt)
              log.push(`first heartbeat ${hb.attempt}`)
            }
            return { ackedEvents: 0, commands: [], link: null }
          }
        }
      })
      return relayHandle
    },
    after: async (_job, dataDir, outcome) => {
      log.push(`after ${outcome}`)
      afterCalls.push({ dataDir, outcome })
      if (opts.afterThrows) throw new Error('upload failed')
    },
    preflightRetryMs: 10,
    silenceMs: opts.silenceMs ?? 5000,
    tickMs: 10,
    holderReadyMs: opts.holderReadyMs ?? 2000,
    holderPollMs: 5,
    restartNoticeMs: 10,
    ephemeralMaxMs: 2000,
    ...(opts.now ? { now: opts.now } : {}),
    onError: (e) => problems.push(e)
  })

  /** Nothing of the run may be left: containers, the profile volume, short-lived files, the awake lock, the relay. */
  const expectNothingLeft = async () => {
    expect([...containers.keys()]).toEqual([])
    expect(volumesUsed.size === 0 || volumesGone.has('tm-profile-u1')).toBe(true)
    expect(existsSync(paths.runs) ? readdirSync(paths.runs) : []).toEqual([])
    expect(releasedAwake).toBe(acquiredAwake)
    expect(resumed).toBe(paused)
    expect(runner.activeIdentity()).toBeNull()
    if (relayHandle) {
      await expect(fetch(`http://127.0.0.1:${relayHandle.port}/heartbeat`, { method: 'POST' })).rejects.toThrow()
    }
    expect(problems).toEqual([])
  }
  const kill = (name: string, code: number) => containers.get(name)?.end(code)
  const until = async (cond: () => boolean, ms = 4000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error(`condition not met in time\n${log.join('\n')}`)
      await Bun.sleep(5)
    }
  }
  return {
    runner,
    docker,
    log,
    argv,
    jobsSeen,
    keysSeen,
    heartbeats,
    preflights,
    failures,
    afterCalls,
    ephGone,
    problems,
    paths,
    kill,
    until,
    expectNothingLeft
  }
}

const inOrder = (log: string[], wanted: string[]) => {
  let at = -1
  for (const w of wanted) {
    const i = log.indexOf(w, at + 1)
    expect(i, `${w} after position ${at}\n${log.join('\n')}`).toBeGreaterThan(at)
    at = i
  }
}

describe('a local run', () => {
  test('happy path: claim, preflight, secrets, holder, worker, files gone after the first heartbeat', async () => {
    const w = build()
    await w.runner.run(localJob)
    inOrder(w.log, [
      'claim',
      'preflight ok',
      'secrets',
      'pause native',
      'keep awake',
      `network ${LOCAL_NETWORK}`,
      `run tm-net-${OCC}`,
      `run tm-run-${OCC}-1`,
      'first heartbeat 1',
      `rm tm-run-${OCC}-1`,
      `rm tm-net-${OCC}`,
      'volume rm tm-profile-u1',
      'after ended',
      'release keep awake',
      'resume native'
    ])
    expect(w.ephGone).toEqual([true])
    expect(w.afterCalls).toEqual([{ dataDir: w.paths.data, outcome: 'ended' }])
    expect(w.jobsSeen[0]).toMatchObject({
      attempt: 1,
      ai: { apiKey: 'sk-secret-ai-key' },
      dataDir: `/tm/data/occurrences/${OCC}`,
      profileDir: '/tm/profiles/u1/vol/work'
    })
    expect(w.jobsSeen[0]!.control!.url).toStartWith('http://host.docker.internal:')
    // The machine id the worker checks sits outside every mounted folder.
    expect(readFileSync(machineIdFile(w.paths, ID), 'utf8')).toBe(`${machineIdFor(ID)}\n`)
    await w.expectNothingLeft()
  })

  test('no secret reaches an argument list, and the key file holds the identity key', async () => {
    const w = build()
    await w.runner.run(localJob)
    const everything = w.argv.flat().join('\n')
    const token = w.jobsSeen[0]!.control!.token
    for (const secret of ['sk-secret-ai-key', token, ntfy.token, w.keysSeen[0]!, 'S123']) {
      expect(everything).not.toContain(secret)
    }
    // Derived from the PC's key, 32 bytes.
    expect(Buffer.from(w.keysSeen[0]!, 'base64')).toHaveLength(32)
    expect(w.keysSeen[0]).not.toBe(profileKey(Buffer.alloc(32), ID).toString('base64'))
    // The holder starts before the worker and only the worker mounts the short-lived folder.
    const holder = w.argv.find((a) => a.includes(`tm-net-${OCC}`) && a.includes('--name'))!
    expect(holder.join(' ')).not.toContain('/run/tm')
    await w.expectNothingLeft()
  })

  test('the holder allows only the relay port through the private-range rules', async () => {
    const w = build()
    await w.runner.run(localJob)
    const holder = w.argv.find((a) => a[a.indexOf('--name') + 1] === holderName(OCC))!
    const url = new URL(w.jobsSeen[0]!.control!.url)
    expect(tailOf(holder)).toEqual(['--allow-tcp', `host.docker.internal:${url.port}`, '--hold'])
  })

  test('Docker not running is reported, retried, and the run starts once it is up', async () => {
    const w = build({ info: [null, null, { memTotal: 8 * 1024 ** 3 }] })
    await w.runner.run(localJob)
    expect(w.preflights.map((p) => p.reason)).toEqual(['docker_unavailable', 'docker_unavailable', 'ok'])
    expect(w.log).toContain(`run tm-run-${OCC}-1`)
    await w.expectNothingLeft()
  })

  test('low memory reports and stops before any container starts', async () => {
    const w = build({ info: [{ memTotal: 2 * 1024 ** 3 }] })
    await w.runner.run(localJob)
    expect(w.preflights.map((p) => p.reason)).toEqual(['docker_memory_low'])
    expect(w.log.some((l) => l.startsWith('run '))).toBe(false)
    expect(w.log).not.toContain('keep awake')
    expect(w.log).not.toContain('secrets')
    await w.expectNothingLeft()
  })

  test('a job the website cancelled (404) ends the wait without a run', async () => {
    const w = build({ preflightRejects: new CompanionApiError(404) })
    await w.runner.run(localJob)
    expect(w.log.some((l) => l.startsWith('run '))).toBe(false)
    await w.expectNothingLeft()
  })

  test('an open sign-in container for the identity is stopped before the run', async () => {
    const w = build({ running: [{ name: signinName(ID), identityId: ID }] })
    await w.runner.run(localJob)
    inOrder(w.log, ['stop tm-signin-u1 60', 'rm tm-signin-u1', `run tm-net-${OCC}`, `run tm-run-${OCC}-1`])
  })

  test('a holder left by an earlier crash is removed at once, not waited for', async () => {
    const w = build({ running: [{ name: 'tm-net-old', identityId: ID }] })
    await w.runner.run(localJob)
    expect(w.log).not.toContain('stop tm-net-old 60')
  })

  test('a second run while one is active is refused', async () => {
    const w = build({ behaviours: [{ kind: 'run' }] })
    const first = w.runner.run(localJob)
    expect(w.runner.activeIdentity()).toBe(ID)
    await expect(w.runner.run(localJob)).rejects.toThrow('already active')
    await w.until(() => w.log.includes('first heartbeat 1'))
    expect(w.runner.inject(ID, 'stop')).toBe(true)
    expect(w.runner.inject('someone-else', 'stop')).toBe(false)
    await first
  })

  test('the noVNC port of the running holder is known while the run lasts', async () => {
    const w = build({ behaviours: [{ kind: 'run' }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    expect(w.runner.noVncPort(ID)).toBe(49153)
    expect(w.runner.noVncPort('other')).toBeNull()
    w.runner.inject(ID, 'stop')
    await run
    expect(w.runner.noVncPort(ID)).toBeNull()
  })
})

describe('the desk password', () => {
  test('is null without an active run', () => {
    const w = build({ behaviours: [{ kind: 'run' }] })
    expect(w.runner.deskPassword(ID)).toBeNull()
  })

  test('is the one the worker derives from its control token, for the running identity only', async () => {
    const w = build({ behaviours: [{ kind: 'run' }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    const token = w.jobsSeen[0]!.control!.token
    expect(w.runner.deskPassword(ID)).toBe(vncSecret(controlTokenHash(token)))
    expect(w.runner.deskPassword('other')).toBeNull()
    w.runner.inject(ID, 'stop')
    await run
    expect(w.runner.deskPassword(ID)).toBeNull()
  })
})

describe('a worker that crashes', () => {
  test('restarts as the next attempt with fresh files, reporting restarting until its heartbeat', async () => {
    const w = build({
      behaviours: [
        { kind: 'exit', code: 137 },
        { kind: 'exit', code: 0 }
      ]
    })
    await w.runner.run(localJob)
    inOrder(w.log, [
      `run tm-run-${OCC}-1`,
      'first heartbeat 1',
      `rm tm-run-${OCC}-1`,
      'synthetic restarting 2',
      `run tm-run-${OCC}-2`,
      'first heartbeat 2',
      `rm tm-run-${OCC}-2`
    ])
    expect(w.log.filter((l) => l === `run tm-net-${OCC}`)).toHaveLength(1)
    expect(w.jobsSeen.map((j) => j.attempt)).toEqual([1, 2])
    // Secrets are fetched again for each attempt, not kept from the first (R12).
    expect(w.log.filter((l) => l === 'secrets')).toHaveLength(2)
    // Fresh files per attempt: two different folders, neither left behind.
    expect(w.ephGone).toEqual([true, true])
    expect(w.afterCalls.map((a) => a.outcome)).toEqual(['ended'])
    expect(w.log).not.toContain('run tm-ckpt-u1')
    await w.expectNothingLeft()
  })

  test('a worker that dies before any heartbeat still has its files removed', async () => {
    const w = build({
      behaviours: [
        { kind: 'nobeat', code: 1 },
        { kind: 'exit', code: 0 }
      ]
    })
    await w.runner.run(localJob)
    expect(w.jobsSeen.map((j) => j.attempt)).toEqual([1, 2])
    await w.expectNothingLeft()
  })

  test('after the third restart fails, the profile is checkpointed and the outputs go on as crashed', async () => {
    const w = build({ behaviours: [{ kind: 'exit', code: 1 }] })
    await w.runner.run(localJob)
    expect(w.log.filter((l) => l.startsWith(`run tm-run-${OCC}-`))).toHaveLength(MAX_LOCAL_ATTEMPTS)
    inOrder(w.log, [
      `run tm-run-${OCC}-4`,
      'run tm-ckpt-u1',
      `rm tm-net-${OCC}`,
      'volume rm tm-profile-u1',
      'after crashed'
    ])
    expect(w.afterCalls.map((a) => a.outcome)).toEqual(['crashed'])
    await w.expectNothingLeft()
  })

  test('30 s without a heartbeat counts as a crash: stopped with a short grace, then restarted', async () => {
    const w = build({
      silenceMs: 200,
      behaviours: [{ kind: 'silent' }, { kind: 'exit', code: 0 }]
    })
    await w.runner.run(localJob)
    inOrder(w.log, [`run tm-run-${OCC}-1`, `stop tm-run-${OCC}-1 10`, `rm tm-run-${OCC}-1`, `run tm-run-${OCC}-2`])
    expect(w.afterCalls.map((a) => a.outcome)).toEqual(['ended'])
    await w.expectNothingLeft()
  })

  test('the holder exiting first stops the worker, and the restart gets a new holder', async () => {
    const w = build({
      behaviours: [{ kind: 'run' }, { kind: 'exit', code: 0 }]
    })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    w.kill(`tm-net-${OCC}`, 137)
    await run
    inOrder(w.log, [
      `run tm-run-${OCC}-1`,
      `stop tm-run-${OCC}-1 60`,
      `rm tm-run-${OCC}-1`,
      'synthetic restarting 2',
      `run tm-net-${OCC}`,
      `run tm-run-${OCC}-2`,
      'after ended'
    ])
    expect(w.log.filter((l) => l === `run tm-net-${OCC}`)).toHaveLength(2)
    await w.expectNothingLeft()
  })

  test('a holder that stops while it starts (rules not in) means no worker ever runs', async () => {
    const w = build({ holderExitsAtStart: true })
    await expect(w.runner.run(localJob)).rejects.toThrow('holder')
    expect(w.log.some((l) => l.startsWith('run tm-run-'))).toBe(false)
    expect(w.failures).toEqual(['The PC could not run the meeting'])
    expect(w.afterCalls).toEqual([])
    await w.expectNothingLeft()
  })
})

describe('the holder must report its rules before a worker starts', () => {
  const noWorker = (w: ReturnType<typeof build>) => expect(w.log.some((l) => l.startsWith('run tm-run-'))).toBe(false)

  test('a ready line that comes late makes the worker wait for it', async () => {
    const w = build({ holderReadyAfterMs: 150 })
    await w.runner.run(localJob)
    const at = (entry: string) => w.log.indexOf(entry)
    expect(at('holder ready')).toBeGreaterThan(at(`run tm-net-${OCC}`))
    expect(at(`run tm-run-${OCC}-1`)).toBeGreaterThan(at('holder ready'))
    await w.expectNothingLeft()
  })

  test('a holder that stays up but never reports is not trusted: no worker, holder removed, failure reported', async () => {
    const w = build({ holderOut: '', holderReadyMs: 80 })
    await expect(w.runner.run(localJob)).rejects.toThrow('holder did not report')
    noWorker(w)
    expect(w.log).toContain(`rm ${holderName(OCC)}`)
    expect(w.failures).toEqual(['The PC could not run the meeting'])
    expect(w.afterCalls).toEqual([])
    await w.expectNothingLeft()
  })

  // By construction nothing else can print the line: the fake `logs` returns only what the holder container wrote, as
  // the real `docker logs` reader does (the container's stdout, not its stderr), and the worker is not started yet.
  test('the ready line counts only as a whole line of the holder stdout', async () => {
    const lookalikes = [`${HOLDER_READY_LINE} soon`, `xx ${HOLDER_READY_LINE}`, HOLDER_READY_LINE.toUpperCase()]
    const w = build({ holderOut: `${lookalikes.join('\n')}\n`, holderReadyMs: 80 })
    await expect(w.runner.run(localJob)).rejects.toThrow('holder did not report')
    noWorker(w)
    await w.expectNothingLeft()
  })

  test('a holder that exits before it reports (rules failed) means no worker, holder removed, failure reported', async () => {
    const w = build({ holderOut: '', holderExitsAfterMs: 40, holderReadyMs: 2000 })
    await expect(w.runner.run(localJob)).rejects.toThrow('holder stopped before it was ready')
    noWorker(w)
    expect(w.log).toContain(`rm ${holderName(OCC)}`)
    expect(w.failures).toEqual(['The PC could not run the meeting'])
    await w.expectNothingLeft()
  })

  test('a holder whose logs cannot be read is not trusted', async () => {
    const w = build({ holderOut: '', holderReadyMs: 2000 })
    const logs = w.docker.logs
    w.docker.logs = async (name) => {
      await logs(name)
      throw new Error('docker logs failed')
    }
    await expect(w.runner.run(localJob)).rejects.toThrow('docker logs failed')
    noWorker(w)
    await w.expectNothingLeft()
  })
})

describe('sleep, stop and failures', () => {
  test('a PC that slept is not silence: the window restarts when the timers wake', async () => {
    let skew = 0
    const w = build({ silenceMs: 400, now: () => Date.now() + skew, behaviours: [{ kind: 'run' }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    // An hour passes in the clock while the PC sleeps; the worker keeps beating after the wake.
    skew += 3_600_000
    await Bun.sleep(600)
    expect(w.log).not.toContain(`stop tm-run-${OCC}-1 10`)
    expect(w.log.filter((l) => l.startsWith('run tm-run-'))).toEqual([`run tm-run-${OCC}-1`])
    w.runner.inject(ID, 'stop')
    await run
    expect(w.afterCalls.map((a) => a.outcome)).toEqual(['ended'])
    await w.expectNothingLeft()
  })

  test('the app can say the PC woke up, which also restarts the window', async () => {
    const w = build({ silenceMs: 700, behaviours: [{ kind: 'silent' }, { kind: 'exit', code: 0 }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    await Bun.sleep(400)
    w.runner.resumed()
    await Bun.sleep(400)
    // 800 ms since the last heartbeat, but only 400 ms since the wake: still within the window.
    expect(w.log).not.toContain(`stop tm-run-${OCC}-1 10`)
    await run
    expect(w.log).toContain(`stop tm-run-${OCC}-1 10`)
  })

  test('a stop during the meeting reaches the worker, ends it without a restart and uploads as ended', async () => {
    const w = build({ behaviours: [{ kind: 'run' }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    expect(w.runner.inject(ID, 'stop')).toBe(true)
    await run
    expect(w.log.filter((l) => l.startsWith('run tm-run-'))).toEqual([`run tm-run-${OCC}-1`])
    expect(w.log).not.toContain('synthetic restarting 2')
    expect(w.afterCalls.map((a) => a.outcome)).toEqual(['ended'])
    await w.expectNothingLeft()
  })

  test('a stop whose worker exits with an error is not restarted and the profile is checkpointed', async () => {
    const w = build({ behaviours: [{ kind: 'silent' }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    w.runner.inject(ID, 'leave_now')
    w.kill(`tm-run-${OCC}-1`, 2)
    await run
    expect(w.log.filter((l) => l.startsWith('run tm-run-'))).toEqual([`run tm-run-${OCC}-1`])
    inOrder(w.log, ['run tm-ckpt-u1', 'volume rm tm-profile-u1', 'after crashed'])
    await w.expectNothingLeft()
  })

  test('stopping the app stops the worker within 60 s, checkpoints, and cleans up', async () => {
    const w = build({ behaviours: [{ kind: 'silent' }] })
    const run = w.runner.run(localJob)
    await w.until(() => w.log.includes('first heartbeat 1'))
    await w.runner.stop()
    await run
    inOrder(w.log, [
      `stop tm-run-${OCC}-1 60`,
      `rm tm-run-${OCC}-1`,
      'run tm-ckpt-u1',
      `rm tm-net-${OCC}`,
      'volume rm tm-profile-u1'
    ])
    expect(w.log.filter((l) => l.startsWith('run tm-run-'))).toEqual([`run tm-run-${OCC}-1`])
    await w.expectNothingLeft()
  })

  test('a stop during the Docker wait ends it without a run', async () => {
    const w = build({ info: [null] })
    const run = w.runner.run(localJob)
    await w.until(() => w.preflights.length >= 1)
    await w.runner.stop()
    await run
    expect(w.log.some((l) => l.startsWith('run '))).toBe(false)
    await w.expectNothingLeft()
  })

  test('a failing docker run reports, checkpoints, and still removes everything it made', async () => {
    const w = build({ failWorkerRun: true })
    await expect(w.runner.run(localJob)).rejects.toThrow('docker run failed')
    expect(w.failures).toEqual(['The PC could not run the meeting'])
    inOrder(w.log, [
      `run tm-net-${OCC}`,
      'run tm-ckpt-u1',
      `rm tm-net-${OCC}`,
      'volume rm tm-profile-u1',
      'release keep awake',
      'resume native'
    ])
    expect(w.afterCalls).toEqual([])
    await w.expectNothingLeft()
  })

  test('a failing upload step still cleans up first, then rejects', async () => {
    const w = build({ afterThrows: true })
    await expect(w.runner.run(localJob)).rejects.toThrow('upload failed')
    inOrder(w.log, [
      `rm tm-net-${OCC}`,
      'volume rm tm-profile-u1',
      'after ended',
      'release keep awake',
      'resume native'
    ])
    await w.expectNothingLeft()
  })
})
