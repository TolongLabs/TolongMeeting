import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
async function rig(opts: { paired?: boolean; ntfyThrows?: number; runnerStopMs?: number } = {}) {
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
  const impl: LoopImpl = {
    makeApi: (o) => {
      apiOpts = o
      log.push('api')
      return {} as CompanionApi
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
    restartDelayMs: () => 5
  })
  return {
    loops,
    secrets,
    keepAwake,
    log,
    errors,
    shown,
    offered,
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
})
