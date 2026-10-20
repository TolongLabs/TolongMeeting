import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionJob } from '@tm/core'
import { DeviceRevokedError, type CompanionApi, type CompanionApiOptions } from '../src/api'
import { KeepAwake } from '../src/keep-awake'
import { Loops, type LoopImpl } from '../src/main/loops'
import type { DesktopNotification, DesktopNotifier, NotificationHandlers } from '../src/notifier'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { defaultSettings } from '../src/settings'
import { StateStore } from '../src/state'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fakes for every loop. Each one writes to `log` when it starts and when it stops, so the order can be checked. */
const IMAGE_PREFIX = 'ghcr.io/tl/'
const localJob = (id: string, state: CompanionJob['state'] = 'pending'): CompanionJob => ({
  id,
  kind: 'local_run',
  state,
  occurrenceId: `occ-${id}`,
  attempts: 0,
  payload: {
    occurrenceId: `occ-${id}`,
    identityId: 'u1',
    identityName: 'University',
    image: 'ghcr.io/tl/worker:1',
    job: {} as never
  }
})

async function rig(
  opts: {
    paired?: boolean
    ntfyThrows?: number
    runnerStopMs?: number
    local?: { signin?: boolean; image?: string }
  } = {}
) {
  const base = await mkdtemp(join(tmpdir(), 'tm-loops-'))
  dirs.push(base)
  await mkdir(base, { recursive: true })
  const settings = { ...defaultSettings(join(base, 'notes'), 'https://tm.example') }
  const state = new StateStore(join(base, 'state.json'))
  const secrets = new SecretStore(join(base, 'secrets.json'), safe)
  if (opts.paired !== false) {
    await secrets.set('deviceToken', 'tmd_secret')
    await secrets.set('ntfyToken', 'ntfy_secret')
    await state.update({
      summariesAfter: '2026-10-21T00:00:00.000Z',
      ntfy: { url: 'https://ntfy.example', topic: 'tm-abc' }
    })
  }
  const log: string[] = []
  const errors: string[] = []
  const shown: DesktopNotification[] = []
  const notifier: DesktopNotifier = {
    show: (n: DesktopNotification, _on: NotificationHandlers) => void shown.push(n)
  }
  const keepAwake = new KeepAwake({ start: () => 1, stop: () => {} })
  let apiOpts!: CompanionApiOptions
  let streamDeps!: Parameters<LoopImpl['startStream']>[0]
  let pollerDeps!: Parameters<LoopImpl['startPoller']>[0]
  let ntfyDeps!: Parameters<LoopImpl['startNtfy']>[0]
  let ntfyStarts = 0
  let triggers = 0
  let syncs = 0
  const offered: unknown[] = []
  const localRuns: string[] = []
  const localEnds: Array<() => void> = []
  const signinOpened: string[] = []
  let localStopped = false
  let signinDeps!: Parameters<LoopImpl['makeSignin']>[0]
  let localDeps!: Parameters<LoopImpl['makeLocal']>[0]
  const impl: LoopImpl = {
    makeApi: (o) => {
      apiOpts = o
      log.push('api')
      return {
        identities: async () => ({ identities: [], image: opts.local?.image ?? 'ghcr.io/tl/worker:1' })
      } as unknown as CompanionApi
    },
    startNtfy: (d) => {
      ntfyDeps = d
      if (ntfyStarts++ < (opts.ntfyThrows ?? 0)) throw new Error('bad ntfy address')
      log.push('ntfy.start')
      return { stop: () => void log.push('ntfy.stop') }
    },
    startStream: (d) => {
      streamDeps = d
      log.push('stream.start')
      return { stop: () => void log.push('stream.stop') }
    },
    startPoller: (d) => {
      pollerDeps = d
      log.push('poller.start')
      return {
        trigger: () => void triggers++,
        stop: () => void log.push('poller.stop')
      }
    },
    makeRunner: () => {
      log.push('runner.create')
      const release = keepAwake.acquire('job-1')
      return {
        busy: true,
        offer: (jobs) => void offered.push(jobs),
        pause: async () => {},
        resume: () => {},
        stop: async () => {
          log.push('runner.stop')
          await sleep(opts.runnerStopMs ?? 0)
          release()
          log.push('runner.released')
        }
      }
    },
    makeLocal: (d) => {
      localDeps = d
      log.push('local.create')
      return {
        run: (job) =>
          new Promise<void>((resolve) => {
            localRuns.push(job.id)
            localEnds.push(resolve)
          }),
        activeIdentity: () => null,
        inject: () => false,
        noVncPort: () => null,
        deskPassword: () => null,
        stop: async () => {
          localStopped = true
          log.push('local.stop')
          for (const end of localEnds) end()
        }
      }
    },
    makeSignin: (d) => {
      signinDeps = d
      return {
        open: async (identityId) => void signinOpened.push(identityId),
        closeAll: async () => void log.push('signin.closeAll')
      }
    },
    sync: async () => {
      syncs++
      log.push('sync')
      return []
    }
  }
  const loops = new Loops({
    settings,
    state,
    secrets,
    notifier,
    keepAwake,
    shell: { openPath: async () => {}, openExternal: async () => {} },
    jobsDir: join(base, 'jobs'),
    openPairing: () => log.push('openPairing'),
    openSettings: () => {},
    onError: (e) => void errors.push(e.message),
    impl,
    restartDelayMs: () => 5,
    ...(opts.local
      ? {
          local: {
            docker: {} as never,
            dataDir: join(base, 'data'),
            paths: { root: base, data: join(base, 'data'), runs: join(base, 'runs'), profiles: join(base, 'profiles') },
            imagePrefix: IMAGE_PREFIX,
            ...(opts.local.signin ? { openSigninWindow: () => {} } : {})
          }
        }
      : {})
  })
  return {
    loops,
    secrets,
    keepAwake,
    log,
    errors,
    shown,
    offered,
    localRuns,
    localEnds,
    signinOpened,
    get localStopped() {
      return localStopped
    },
    get signinDeps() {
      return signinDeps
    },
    get localDeps() {
      return localDeps
    },
    get apiOpts() {
      return apiOpts
    },
    get streamDeps() {
      return streamDeps
    },
    get pollerDeps() {
      return pollerDeps
    },
    get ntfyDeps() {
      return ntfyDeps
    },
    get triggers() {
      return triggers
    },
    get syncs() {
      return syncs
    }
  }
}

describe('Loops', () => {
  test('an unpaired PC starts nothing', async () => {
    const r = await rig({ paired: false })
    expect(await r.loops.start()).toBe(false)
    expect(r.log).toEqual([])
  })

  test('a paired PC starts ntfy, the command stream, the runner and the poller in that order, then syncs summaries', async () => {
    const r = await rig()
    expect(await r.loops.start()).toBe(true)
    await sleep(5)
    expect(r.log).toEqual(['api', 'ntfy.start', 'stream.start', 'runner.create', 'poller.start', 'sync'])
    expect(r.ntfyDeps.cfg).toEqual({ url: 'https://ntfy.example', topic: 'tm-abc', token: 'ntfy_secret' })
    expect(await r.apiOpts.token()).toBe('tmd_secret')
    await r.loops.stop()
  })

  test('the poller hands its jobs to the runner and the stream wakes the poller', async () => {
    const r = await rig()
    await r.loops.start()
    await r.pollerDeps.onJobs([])
    expect(r.offered).toEqual([[]])
    expect(r.pollerDeps.busy?.()).toBe(true)
    await r.streamDeps.onEvent({ id: 1, command: { type: 'job_available', jobId: 'j' } })
    expect(r.triggers).toBe(1)
    await r.loops.stop()
  })

  test('the stream opening, and a summary ntfy message, each start a summary sync', async () => {
    const r = await rig()
    await r.loops.start()
    await sleep(5)
    const before = r.syncs
    r.streamDeps.onStatus(true)
    await sleep(5)
    expect(r.syncs).toBe(before + 1)
    r.ntfyDeps.onMessage({ id: 'm1', time: Math.floor(Date.now() / 1000), tags: ['tm_summary'] })
    await sleep(5)
    expect(r.syncs).toBe(before + 2)
    await r.loops.stop()
  })

  test('a revoked 401 from any loop stops every loop, clears the token and notifies once', async () => {
    const r = await rig()
    await r.loops.start()
    await sleep(5)
    r.log.length = 0
    // Three sources report it at once: the API, the stream and the poller.
    r.apiOpts.onRevoked()
    r.streamDeps.onRevoked?.(new DeviceRevokedError())
    r.pollerDeps.onRevoked?.(new DeviceRevokedError())
    await sleep(20) // the revoke handler runs by itself; nothing here calls stop()
    expect(r.log).toEqual(['runner.stop', 'poller.stop', 'stream.stop', 'ntfy.stop', 'runner.released'])
    expect(await r.secrets.get('deviceToken')).toBeNull()
    expect(r.shown).toHaveLength(1)
    expect(r.shown[0]!.title).toBe('TolongMeeting is unpaired')
    expect(r.keepAwake.active).toEqual([])
  })

  test('quit stops the loops in reverse order and waits for the runner to release the keep-awake hold', async () => {
    const r = await rig({ runnerStopMs: 30 })
    await r.loops.start()
    await sleep(5)
    expect(r.keepAwake.active).toEqual(['job-1'])
    r.log.length = 0
    await r.loops.stop()
    expect(r.log).toEqual(['runner.stop', 'poller.stop', 'stream.stop', 'ntfy.stop', 'runner.released'])
    expect(r.keepAwake.active).toEqual([])
    await r.loops.stop() // a second quit changes nothing
    expect(r.log).toHaveLength(5)
  })

  test('a loop that crashes on start is reported and restarted with backoff; the others keep running', async () => {
    const r = await rig({ ntfyThrows: 2 })
    await r.loops.start()
    expect(r.errors).toEqual(['the ntfy loop crashed: bad ntfy address'])
    expect(r.log).toContain('stream.start')
    expect(r.log).toContain('poller.start')
    expect(r.log).not.toContain('ntfy.start')
    await sleep(60)
    expect(r.errors).toHaveLength(2)
    expect(r.log).toContain('ntfy.start')
    await r.loops.stop()
  })

  test('a restart that is still waiting when the app quits never fires', async () => {
    const r = await rig({ ntfyThrows: 5 })
    await r.loops.start()
    await r.loops.stop()
    await sleep(30)
    expect(r.errors).toHaveLength(1)
  })

  test('errors from a loop are reported without the token', async () => {
    const r = await rig()
    await r.loops.start()
    r.pollerDeps.onError?.(new Error('The website answered with HTTP 503'))
    expect(r.errors).toEqual(['the poller loop: The website answered with HTTP 503'])
    expect(r.errors.join()).not.toContain('tmd_secret')
    await r.loops.stop()
  })

  test('a PC with no local setup, or one that is not paired, makes no local runner', async () => {
    const plain = await rig()
    await plain.loops.start()
    expect(plain.log).not.toContain('local.create')
    await plain.pollerDeps.onJobs([localJob('j1')])
    expect(plain.localRuns).toEqual([])
    await plain.loops.stop()

    const unpaired = await rig({ paired: false, local: {} })
    expect(await unpaired.loops.start()).toBe(false)
    expect(unpaired.log).toEqual([])
  })

  test('a pending local_run job goes to the local runner, one at a time, and never a native or claimed one', async () => {
    const r = await rig({ local: {} })
    await r.loops.start()
    expect(r.log.indexOf('runner.create')).toBeLessThan(r.log.indexOf('local.create'))
    expect(r.log.indexOf('local.create')).toBeLessThan(r.log.indexOf('poller.start'))
    expect(r.localDeps.imagePrefix).toBe(IMAGE_PREFIX)

    await r.pollerDeps.onJobs([
      localJob('claimed', 'claimed'),
      { ...localJob('n'), kind: 'native_transcription' } as never
    ])
    expect(r.localRuns).toEqual([])
    await r.pollerDeps.onJobs([localJob('j1'), localJob('j2')])
    expect(r.localRuns).toEqual(['j1'])
    // The same list again while the run goes on starts nothing more, and still reaches the native runner.
    await r.pollerDeps.onJobs([localJob('j2')])
    expect(r.localRuns).toEqual(['j1'])
    expect(r.offered).toHaveLength(3)
    r.localEnds[0]!()
    await sleep(5)
    await r.pollerDeps.onJobs([localJob('j2')])
    expect(r.localRuns).toEqual(['j1', 'j2'])
    await r.loops.stop()
  })

  test('quit ends the local run and closes sign-in views; it waits for both', async () => {
    const r = await rig({ local: { signin: true } })
    await r.loops.start()
    await r.pollerDeps.onJobs([localJob('j1')])
    r.log.length = 0
    await r.loops.stop()
    expect(r.localStopped).toBe(true)
    expect(r.log).toContain('signin.closeAll')
    expect(r.log).toContain('local.stop')
  })

  test('a sign-in request opens the view with the website’s image, and an image outside the prefix is refused', async () => {
    const r = await rig({ local: { signin: true } })
    await r.loops.start()
    await r.streamDeps.onEvent({ id: 1, command: { type: 'open_signin', identityId: 'u1' } })
    await sleep(5)
    expect(r.signinOpened).toEqual(['u1'])
    expect(r.signinDeps.imageRef()).toBe('ghcr.io/tl/worker:1')
    // The desk password comes from the runner, which has no run.
    expect(r.signinDeps.deskPassword('u1')).toBeNull()
    await r.loops.stop()

    const bad = await rig({ local: { signin: true, image: 'ghcr.io/evil/worker:1' } })
    await bad.loops.start()
    await bad.streamDeps.onEvent({ id: 1, command: { type: 'open_signin', identityId: 'u1' } })
    await sleep(5)
    expect(bad.signinOpened).toEqual([])
    expect(bad.errors).toEqual([
      'could not open the sign-in view: the website named a worker image outside the trusted repository'
    ])
    await bad.loops.stop()
  })

  test('without a sign-in window, open_signin is ignored', async () => {
    const r = await rig({ local: {} })
    await r.loops.start()
    await r.streamDeps.onEvent({ id: 1, command: { type: 'open_signin', identityId: 'u1' } })
    await sleep(5)
    expect(r.signinOpened).toEqual([])
    expect(r.errors).toEqual([])
    await r.loops.stop()
  })
})
