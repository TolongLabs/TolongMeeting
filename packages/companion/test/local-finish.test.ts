import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionJob, LocalRunPayload, NtfyConfig } from '@tm/core'
import { CompanionApi } from '../src/api'
import { KeepAwake } from '../src/keep-awake'
import type { SpawnLike } from '../src/jobs/whisper'
import { resumeOutcome, type LocalJob } from '../src/local/after'
import { checkRunArgs, type DockerLike } from '../src/local/docker'
import { startRelay } from '../src/local/relay'
import { HOLDER_READY_LINE, LocalRunner, localAfter } from '../src/local/run'
import { localPaths } from '../src/local/vault'
import { Loops, type LoopImpl } from '../src/main/loops'
import type { DesktopNotifier } from '../src/notifier'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { defaultSettings } from '../src/settings'
import { StateStore } from '../src/state'
import { fakeServer, type FakeServer } from './fake-upload-server'

// A local meeting from the end of the run to the website, with a fake Docker and the fake upload server: the runner's
// `after` hook uploads and cleans up; a restart, an unpair or a quit in the middle of the upload leaves the files; the
// next start sends the rest once.

const REF = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'
const OCC = '11111111-1111-4111-8111-111111111111'
const ntfy: NtfyConfig = { url: 'https://ntfy.example.com', topic: 'tm-topic', token: 'tk_ntfy_secret' }
const CHUNK = 4
const EVENTS = '{"a":1}\n' // 8 bytes: 2 chunks
const RECORDING = Buffer.from('mkv-bytes-12') // 12 bytes: 3 chunks

const payload: LocalRunPayload = {
  occurrenceId: OCC,
  identityId: 'u1',
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
    identity: { id: 'u1', name: 'Ali', zoomGuestName: 'Ali', formProviders: [], organisation: null },
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
const job: LocalJob = { id: 'j1', state: 'claimed', occurrenceId: OCC, attempts: 1, kind: 'local_run', payload }

const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const noSpawn: SpawnLike = () => {
  throw new Error('no transcriber in a live meeting')
}

const roots: string[] = []
const servers: FakeServer[] = []
afterAll(() => Promise.all(roots.map((d) => rm(d, { recursive: true, force: true }))))
afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

interface World {
  base: string
  server: FakeServer
  paths: ReturnType<typeof localPaths>
  occ: string
  secrets: SecretStore
  /** Container names Docker reports as running; `docker` calls in order. */
  running: string[]
  dockerCalls: string[]
  dockerUp: { value: boolean }
  docker: DockerLike
  /** Runs for each `PUT` the app sends (1-based); a Response replaces the real answer. */
  onPut: { fn: (n: number) => Response | void }
  fetch: typeof fetch
}

async function world(): Promise<World> {
  const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-finish-'))
  roots.push(base)
  const server = fakeServer()
  servers.push(server)
  const paths = localPaths(join(base, 'Local'))
  const secrets = new SecretStore(join(base, 'secrets.json'), safe)
  await secrets.set('deviceToken', 'tmd_secret_device_token')
  await secrets.set('ntfyToken', 'ntfy_secret')
  const running: string[] = []
  const dockerCalls: string[] = []
  const dockerUp = { value: true }
  const call = <T>(name: string, value: T): T => {
    dockerCalls.push(name)
    return value
  }
  const docker: DockerLike = {
    info: async () => call('info', dockerUp.value ? { memTotal: 8 * 1024 ** 3 } : null),
    imagePresent: async () => true,
    pull: async () => true,
    run: async (args) => {
      checkRunArgs(args)
      return call('run', '')
    },
    wait: async () => 0,
    logs: async () => `${HOLDER_READY_LINE}\n`,
    stop: async () => {},
    rm: async () => {},
    volumeRm: async () => {},
    volumes: async () => [],
    running: async () =>
      call(
        'running',
        running.map((name) => ({ name, identityId: 'u1' }))
      ),
    port: async () => 49153,
    ensureNetwork: async () => {}
  }
  const onPut: World['onPut'] = { fn: () => {} }
  let puts = 0
  const wrapped = async (input: Request): Promise<Response> => {
    if (input.method === 'PUT') {
      const replaced = onPut.fn(++puts)
      if (replaced) return replaced
    }
    return fetch(input)
  }
  return {
    base,
    server,
    paths,
    occ: join(paths.data, 'occurrences', OCC),
    secrets,
    running,
    dockerCalls,
    dockerUp,
    docker,
    onPut,
    fetch: wrapped as unknown as typeof fetch
  }
}

async function writeRun(w: World, o: { recording?: boolean } = {}): Promise<void> {
  await mkdir(join(w.occ, 'recording'), { recursive: true })
  await writeFile(join(w.occ, 'events.jsonl'), EVENTS)
  if (o.recording !== false) await writeFile(join(w.occ, 'recording', 'meeting.mkv'), RECORDING)
}

function apiFor(w: World, onRevoked: () => void = () => {}): CompanionApi {
  return new CompanionApi({
    serverUrl: w.server.url,
    token: () => w.secrets.get('deviceToken'),
    onRevoked,
    fetch: w.fetch
  })
}

const afterFor = (w: World, signal?: AbortSignal) =>
  localAfter({
    api: apiFor(w),
    docker: w.docker,
    settings: () => defaultSettings(w.base, w.server.url),
    spawn: noSpawn,
    retryMs: 10,
    chunkBytes: CHUNK,
    signal
  })

/** The app's loops with fakes for everything but the resume path. `jobs()` feeds the poller's first list. */
async function app(w: World) {
  const log: string[] = []
  const errors: string[] = []
  const state = new StateStore(join(w.base, 'state.json'))
  await state.update({ summariesAfter: '2026-10-21T00:00:00.000Z', ntfy: { url: ntfy.url, topic: ntfy.topic } })
  let poller!: Parameters<LoopImpl['startPoller']>[0]
  const impl: Partial<LoopImpl> = {
    makeApi: (o) => new CompanionApi({ ...o, fetch: w.fetch }),
    startNtfy: () => ({ stop: () => void log.push('ntfy.stop') }),
    startStream: () => ({ stop: () => void log.push('stream.stop') }),
    startPoller: (d) => {
      poller = d
      return { trigger: () => {}, stop: () => void log.push('poller.stop') }
    },
    makeRunner: () => ({
      busy: false,
      offer: () => {},
      pause: async () => void log.push('native.pause'),
      resume: () => void log.push('native.resume'),
      stop: async () => void log.push('runner.stop')
    }),
    sync: async () => []
  }
  const notifier: DesktopNotifier = { show: (n) => void log.push(`note: ${n.title}`) }
  const loops = new Loops({
    settings: defaultSettings(w.base, w.server.url),
    state,
    secrets: w.secrets,
    notifier,
    keepAwake: new KeepAwake({ start: () => 1, stop: () => {} }),
    shell: { openPath: async () => {}, openExternal: async () => {} },
    jobsDir: join(w.base, 'jobs'),
    openPairing: () => void log.push('openPairing'),
    openSettings: () => {},
    onError: (e) => void errors.push(e.message),
    local: { docker: w.docker, dataDir: w.paths.data, retryMs: 10, chunkBytes: CHUNK },
    impl,
    restartDelayMs: () => 5
  })
  /** The poller lists the jobs; waits until the resume that follows has ended. */
  const list = async (jobs: CompanionJob[]) => {
    await poller.onJobs(jobs)
    for (let i = 0; i < 400 && !loopsIdle(); i++) await sleep(5)
  }
  const loopsIdle = () => (loops as unknown as { resuming: unknown }).resuming === null
  return { loops, log, errors, list }
}

const completes = (w: World) => w.server.log.filter((l) => l === 'complete').length
const sentWhole = (w: World) => {
  expect(w.server.files.get('events.jsonl')?.toString()).toBe(EVENTS)
  expect(w.server.files.get('recording/meeting.mkv')?.equals(RECORDING)).toBe(true)
  // Every chunk once: no byte went twice.
  expect(new Set(w.server.ranges).size).toBe(w.server.ranges.length)
  expect(w.server.ranges).toHaveLength(2 + 3)
}

/** A `LocalRunner` over the fake Docker whose worker writes the run's files and exits at once. */
function runner(w: World, after: ReturnType<typeof afterFor>, o: { exit?: number; recording?: boolean } = {}) {
  const log: string[] = []
  const problems: unknown[] = []
  const docker: DockerLike = {
    ...w.docker,
    run: async (args) => {
      await w.docker.run(args)
      if (args[args.indexOf('--name') + 1]?.startsWith('tm-run-')) await writeRun(w, { recording: o.recording })
      return ''
    },
    wait: async (name) =>
      name.startsWith('tm-run-') ? (o.exit ?? 0) : name.startsWith('tm-ckpt-') ? 0 : new Promise<number>(() => {}) // the network holder lives until it is removed
  }
  const r = new LocalRunner({
    api: {
      claim: async () => job as CompanionJob,
      preflight: async () => {},
      secrets: async () => ({ apiKey: 'sk-secret', details: [] }),
      fail: async () => {}
    },
    docker,
    secrets: w.secrets,
    state: new StateStore(join(w.base, 'runner-state.json')),
    paths: w.paths,
    keepAwake: { acquire: () => () => {} },
    native: { pause: async () => void log.push('pause native'), resume: () => void log.push('resume native') },
    ntfy: async () => ntfy,
    relay: (o) =>
      startRelay({
        jobId: o.jobId,
        occurrenceId: o.occurrenceId,
        api: { heartbeat: async () => ({ ackedEvents: 0, commands: [], link: null }) }
      }),
    after: async (j, dataDir, outcome) => {
      log.push(`after ${outcome}`)
      await after(j, dataDir, outcome)
    },
    holderPollMs: 5,
    restartNoticeMs: 10,
    ephemeralMaxMs: 50,
    tickMs: 10,
    onError: (e) => problems.push(e)
  })
  return { r, log, problems }
}

describe('a local meeting from its end to the website', () => {
  test('run, after, upload, cleanup: the files arrive whole, the folder goes, the data root stays', async () => {
    const w = await world()
    const { r, log, problems } = runner(w, afterFor(w))
    await r.run(job)
    expect(log).toEqual(['pause native', 'after ended', 'resume native'])
    expect(w.server.log).toEqual([
      'report uploading',
      'upload events.jsonl',
      'upload recording/meeting.mkv',
      'complete'
    ])
    sentWhole(w)
    expect(existsSync(w.occ)).toBe(false)
    expect(existsSync(w.paths.data)).toBe(true)
    expect(problems).toEqual([])
  })

  test('a run whose worker never joined its recording is sent as crashed', async () => {
    const w = await world()
    const { r } = runner(w, afterFor(w), { exit: 1, recording: false })
    await r.run(job)
    expect(w.server.log).toContain('fail worker_crashed')
    expect(completes(w)).toBe(0)
    expect(existsSync(w.occ)).toBe(false)
  })

  test('a quit in the middle of the upload leaves the files; the next start sends the rest once', async () => {
    const w = await world()
    const quit = new AbortController()
    w.onPut.fn = (n) => {
      if (n === 1) queueMicrotask(() => quit.abort())
    }
    const { r, problems } = runner(w, afterFor(w, quit.signal))
    await r.run(job)
    expect(problems).toEqual([])
    expect(completes(w)).toBe(0)
    expect(existsSync(w.occ)).toBe(true)
    expect(await resumeOutcome(job, w.paths.data)).toBe('ended')
    expect(w.server.ranges).toHaveLength(1)

    // The next start: the website still lists the job as claimed and no worker container is left.
    w.onPut.fn = () => {}
    const next = await app(w)
    expect(await next.loops.start()).toBe(true)
    await next.list([job])
    expect(next.errors).toEqual([])
    expect(completes(w)).toBe(1)
    sentWhole(w)
    expect(existsSync(w.occ)).toBe(false)
    expect(next.log).toEqual(expect.arrayContaining(['native.pause', 'native.resume']))

    // A third start finds nothing left to do and sends nothing.
    const before = w.server.requests.length
    const third = await app(w)
    await third.loops.start()
    await third.list([job])
    expect(w.server.requests).toHaveLength(before)
    expect(completes(w)).toBe(1)
    await next.loops.stop()
    await third.loops.stop()
  })

  test('the website refusing `complete` for a while is retried; the files are not sent twice', async () => {
    const w = await world()
    await writeRun(w)
    w.server.completeFailures = 2
    const a = await app(w)
    await a.loops.start()
    await a.list([job])
    expect(completes(w)).toBe(1)
    sentWhole(w)
    expect(existsSync(w.occ)).toBe(false)
    await a.loops.stop()
  })

  test('an unpair in the middle of the upload stops it, leaves the files and keeps the app quiet', async () => {
    const w = await world()
    await writeRun(w)
    w.onPut.fn = (n) => (n === 2 ? Response.json({ error: 'device_revoked_or_unknown' }, { status: 401 }) : undefined)
    const a = await app(w)
    await a.loops.start()
    await a.list([job])
    for (let i = 0; i < 200 && !a.log.includes('poller.stop'); i++) await sleep(5)
    expect(a.log).toEqual(expect.arrayContaining(['poller.stop', 'stream.stop', 'ntfy.stop', 'runner.stop']))
    expect(a.log).toContain('note: TolongMeeting is unpaired')
    expect(await w.secrets.get('deviceToken')).toBeNull()
    expect(completes(w)).toBe(0)
    expect(existsSync(w.occ)).toBe(true)
    expect(a.errors).toEqual([])
    const sent = w.server.ranges.length

    // The member pairs again: the next start carries on from the offsets the website holds.
    w.onPut.fn = () => {}
    await w.secrets.set('deviceToken', 'tmd_secret_device_token')
    await w.secrets.set('ntfyToken', 'ntfy_secret')
    const b = await app(w)
    expect(await b.loops.start()).toBe(true)
    await b.list([job])
    expect(b.errors).toEqual([])
    expect(w.server.ranges.length).toBeGreaterThan(sent)
    expect(completes(w)).toBe(1)
    sentWhole(w)
    expect(existsSync(w.occ)).toBe(false)
    await b.loops.stop()
  })

  test('quitting the app in the middle of the upload stops it cleanly and leaves the files', async () => {
    const w = await world()
    await writeRun(w)
    const a = await app(w)
    w.onPut.fn = (n) => {
      if (n === 1) void a.loops.stop()
    }
    await a.loops.start()
    await a.list([job])
    await a.loops.stop()
    expect(a.errors).toEqual([])
    expect(completes(w)).toBe(0)
    expect(existsSync(w.occ)).toBe(true)
    expect(w.server.ranges.length).toBeLessThan(5)

    w.onPut.fn = () => {}
    const b = await app(w)
    await b.loops.start()
    await b.list([job])
    expect(completes(w)).toBe(1)
    sentWhole(w)
    expect(existsSync(w.occ)).toBe(false)
    await b.loops.stop()
  })
})

describe('what the start leaves alone', () => {
  test('nothing runs before pairing', async () => {
    const w = await world()
    await writeRun(w)
    await w.secrets.clear()
    const a = await app(w)
    expect(await a.loops.start()).toBe(false)
    expect(w.dockerCalls).toEqual([])
    expect(w.server.requests).toEqual([])
    expect(existsSync(w.occ)).toBe(true)
  })

  test('a job whose worker container still runs is not finished behind its back', async () => {
    const w = await world()
    await writeRun(w)
    w.running.push(`tm-run-${OCC}-2`)
    const a = await app(w)
    await a.loops.start()
    await a.list([job])
    expect(w.server.requests).toEqual([])
    expect(existsSync(w.occ)).toBe(true)
    expect(a.log).not.toContain('native.pause')
    await a.loops.stop()
  })

  test('only claimed local jobs with files on disk are resumed', async () => {
    const w = await world()
    const a = await app(w)
    await a.loops.start()
    await a.list([{ ...job, state: 'pending' }, job]) // no folder on disk for the claimed one
    expect(w.server.requests).toEqual([])
    expect(a.errors).toEqual([])
    await a.loops.stop()
  })

  test('Docker not ready: nothing is sent; the next list tries again', async () => {
    const w = await world()
    await writeRun(w)
    w.dockerUp.value = false
    const a = await app(w)
    await a.loops.start()
    await a.list([job])
    expect(w.server.requests).toEqual([])
    expect(existsSync(w.occ)).toBe(true)
    w.dockerUp.value = true
    await a.list([job])
    expect(completes(w)).toBe(1)
    expect(existsSync(w.occ)).toBe(false)
    await a.loops.stop()
  })

  test('a recording that never joined is sent as crashed on the next start', async () => {
    const w = await world()
    await writeRun(w, { recording: false })
    const a = await app(w)
    await a.loops.start()
    await a.list([job])
    expect(w.server.log).toEqual(['report uploading', 'upload events.jsonl', 'fail worker_crashed'])
    expect(existsSync(w.occ)).toBe(false)
    await a.loops.stop()
  })
})
