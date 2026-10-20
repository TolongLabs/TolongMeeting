import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type { JobConfig } from '@tm/core'
import { eq } from 'drizzle-orm'
import { identities, occurrences, schema } from '@tm/web/db'
import type { HomeNode } from '@tm/web/db/home-route'
import { FakeNotifier } from '@tm/web/db/notifier'
import { sealColumn } from '@tm/web/db/secrets'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { HOME_TAG, homeHostname } from '@tm/web/lib/home-route'
import { homeDepsOf } from '../src/home-route/check'
import {
  DockerError,
  FakeDocker,
  HOME_ROUTE_IMAGE,
  HomeRouteUnavailable,
  containerName,
  containerSpec,
  launchOccurrence,
  launchViaHome,
  monitorTick,
  removeSidecar,
  settleRemuxes,
  sidecarCreateBody,
  sidecarName,
  stopJobFileWatchers,
  type CreateBody,
  type LaunchDeps,
  type SidecarBody,
  type SidecarDeps
} from '../src/index'

const MASTER = Buffer.alloc(32, 3)
const VERSION = '1.102.5'
const OCC = '11111111-1111-4111-8111-111111111111'
const IDN = '22222222-2222-4222-8222-222222222222'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const NODE_ID = 'nHOME1CNTRL'
const NODE_IP = '100.101.102.103'
const AUTH_KEY = 'tskey-auth-SECRETSECRET'
const HOST = homeHostname(MASTER, MEMBER)
const NODE: HomeNode = { nodeId: NODE_ID, hostname: HOST, ipv4: NODE_IP, checkedAt: new Date() }

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/home-route-`)
})
afterEach(async () => {
  await settleRemuxes()
  await stopJobFileWatchers()
})
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

const specEnv = (root: string) => ({
  dataRoot: `${root}/data`,
  profileRoot: `${root}/profiles`,
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example'
})

/** A Docker whose sidecar becomes healthy after `healthyAfter` looks (never with Infinity) and goes on stop (AutoRemove). */
class SidecarDocker extends FakeDocker {
  looks = 0
  healthyAfter = 2
  /** What the key file held while the sidecar was being created. */
  keyAtCreate: string | null = null
  sidecarDies = false

  override async create(name: string, body: CreateBody | SidecarBody): Promise<string> {
    if (name.startsWith('tm-home-')) {
      const source = (body as SidecarBody).HostConfig.Binds[0]!.split(':')[0]!
      this.keyAtCreate = readFileSync(source, 'utf8')
    }
    return super.create(name, body)
  }

  override async stop(id: string, timeoutS: number): Promise<void> {
    await super.stop(id, timeoutS)
    if (id.startsWith('tm-home-')) this.inspectResults.set(id, null)
  }

  override async inspect(id: string) {
    if (id.startsWith('tm-home-') && !this.inspectResults.has(id) && this.sidecars.some((s) => s.name === id)) {
      if (this.sidecarDies) return null
      this.looks++
      return { running: true, health: this.looks >= this.healthyAfter ? ('healthy' as const) : ('starting' as const) }
    }
    return super.inspect(id)
  }
}

const cfgOf = (): JobConfig =>
  ({ occurrenceId: OCC, attempt: 1, identity: { id: IDN }, member: { id: MEMBER } }) as unknown as JobConfig

type Fixture = {
  docker: SidecarDocker
  keys: Array<Record<string, unknown>>
  workers: Array<{ sidecar: string }>
  env: ReturnType<typeof specEnv>
  deps: SidecarDeps
}
async function sidecarFixture(o: Partial<SidecarDeps> & { workerStarts?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(`${tmp}/s-`)
  const docker = new SidecarDocker()
  const keys: Array<Record<string, unknown>> = []
  const workers: Array<{ sidecar: string }> = []
  const env = specEnv(root)
  const deps: SidecarDeps = {
    api: {
      createAuthKey: async (k) => {
        keys.push(k)
        return AUTH_KEY
      }
    },
    docker,
    env,
    tailscaleVersion: VERSION,
    launchWorker: async (_cfg, via) => {
      workers.push(via)
      return o.workerStarts ?? true
    },
    pollMs: 1,
    healthTimeoutMs: 2_000,
    ...o
  }
  return { docker, keys, workers, env, deps }
}

// --- The bodies ----------------------------------------------------------------------------------------------------

describe('the sidecar body', () => {
  const body = () =>
    sidecarCreateBody({
      occurrenceId: OCC,
      identityId: IDN,
      node: NODE,
      tailscaleVersion: VERSION,
      env: specEnv('/srv/tm')
    })

  test('is the home-route image pinned by version, with NET_ADMIN and the tun device and nothing else', () => {
    const b = body()
    expect(b.Image).toBe(`${HOME_ROUTE_IMAGE}:${VERSION}`)
    expect(b.HostConfig.CapAdd).toEqual(['NET_ADMIN'])
    expect(b.HostConfig.CapDrop).toEqual(['ALL'])
    expect(b.HostConfig.SecurityOpt).toEqual(['no-new-privileges'])
    expect(b.HostConfig.Devices).toEqual([
      { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }
    ])
    expect(b.HostConfig.NetworkMode).toBe('tm-workers')
    expect(b.HostConfig.AutoRemove).toBe(true)
    expect(b.HostConfig).not.toHaveProperty('Privileged')
    expect(b).not.toHaveProperty('Cmd')
    expect(b).not.toHaveProperty('User')
  })

  test('has one mount: the auth key file, read only, outside every worker mount', () => {
    const b = body()
    expect(b.HostConfig.Binds).toEqual([`/srv/tm/profiles/.home-keys/tm-home-${OCC}:/run/tm/authkey:ro`])
    const worker = containerSpec({
      kind: 'worker',
      occurrenceId: OCC,
      attempt: 1,
      identityId: IDN,
      env: specEnv('/srv/tm')
    })
    expect(worker.HostConfig.Binds.some((m) => m.includes('.home-keys'))).toBe(false)
  })

  test('names the key by file and pins the exit node by id and keyed hostname; the key is in no Env entry', () => {
    const b = body()
    expect(b.Env).toEqual([
      'TS_AUTHKEY=file:/run/tm/authkey',
      `TS_HOSTNAME=tm-worker-${OCC}`,
      'TS_USERSPACE=false',
      'TS_TAILSCALED_EXTRA_ARGS=--state=mem:',
      'TS_EXTRA_ARGS=--accept-dns=false --advertise-tags=tag:tm-worker',
      `TM_EXIT_NODE_ID=${NODE_ID}`,
      `TM_EXIT_NODE_HOSTNAME=${HOST}`
    ])
    // No exit node on the command line: start.sh picks it after login, so the worker has nothing to influence.
    expect(b.Env.some((e) => e.includes('--exit-node'))).toBe(false)
    expect(JSON.stringify(b)).not.toContain('tskey-')
  })

  test('carries the hostname, hosts, DNS and IPv6 setting that Docker refuses on the worker that joins it', () => {
    const b = body()
    expect(b.Hostname).toBe(`tm-${IDN.slice(0, 20)}`)
    expect(b.HostConfig.ExtraHosts).toEqual(['tm.example:172.30.0.2', 'ntfy.tm.example:172.30.0.2'])
    expect(b.HostConfig.Dns).toEqual(['1.1.1.1', '8.8.8.8'])
    expect(b.HostConfig.Sysctls).toEqual({ 'net.ipv6.conf.all.disable_ipv6': '1' })
    expect(b.Healthcheck.Test).toEqual(['CMD', 'test', '-f', '/tmp/tm-ready'])
  })

  test('refuses a node id or hostname that is not a Tailscale id or a keyed home hostname', () => {
    for (const node of [
      { nodeId: 'n1 --exit-node=100.1.1.1', hostname: HOST },
      { nodeId: NODE_ID, hostname: 'tm-home-1234' },
      { nodeId: NODE_ID, hostname: 'laptop' }
    ]) {
      expect(() =>
        sidecarCreateBody({
          occurrenceId: OCC,
          identityId: IDN,
          node,
          tailscaleVersion: VERSION,
          env: specEnv('/srv/tm')
        })
      ).toThrow()
    }
    expect(() =>
      sidecarCreateBody({
        occurrenceId: OCC,
        identityId: IDN,
        node: NODE,
        tailscaleVersion: 'latest',
        env: specEnv('/srv/tm')
      })
    ).toThrow()
  })
})

describe('the worker behind the sidecar', () => {
  const via = containerSpec({
    kind: 'worker',
    occurrenceId: OCC,
    attempt: 1,
    identityId: IDN,
    env: specEnv('/srv/tm'),
    via: { sidecar: sidecarName(OCC) }
  })

  test('joins the sidecar network namespace and has no way to change the exit node', () => {
    expect(via.HostConfig.NetworkMode).toBe(`container:tm-home-${OCC}`)
    // No Tailscale socket or control API, no capability, no device, no extra mount, no Tailscale variable.
    expect(via.HostConfig.CapDrop).toEqual(['ALL'])
    expect(via.HostConfig).not.toHaveProperty('CapAdd')
    expect(via.HostConfig).not.toHaveProperty('Devices')
    expect(via.HostConfig.Binds.map((b) => b.split(':').slice(0, 1)[0])).toEqual([
      `/srv/tm/data/occurrences/${OCC}`,
      `/srv/tm/profiles/${IDN}`,
      `/srv/tm/profiles/.machine-ids/${IDN}`
    ])
    expect(JSON.stringify(via)).not.toMatch(/tailscale|TS_|\.sock|\/run\/tm/i)
  })

  test('drops the four settings Docker rejects on a joined namespace and keeps every limit', () => {
    for (const key of ['Hostname', 'Dns', 'ExtraHosts', 'Sysctls']) {
      expect(via).not.toHaveProperty(key)
      expect(via.HostConfig).not.toHaveProperty(key)
    }
    const own = containerSpec({
      kind: 'worker',
      occurrenceId: OCC,
      attempt: 1,
      identityId: IDN,
      env: specEnv('/srv/tm')
    })
    expect({ ...via.HostConfig, NetworkMode: 'x' }).toEqual({
      ...own.HostConfig,
      NetworkMode: 'x',
      Dns: undefined,
      ExtraHosts: undefined,
      Sysctls: undefined
    })
  })

  test('may join only the sidecar of its own occurrence', () => {
    expect(() =>
      containerSpec({
        kind: 'worker',
        occurrenceId: OCC,
        attempt: 1,
        identityId: IDN,
        env: specEnv('/srv/tm'),
        via: { sidecar: sidecarName('99999999-9999-4999-8999-999999999999') }
      })
    ).toThrow()
  })
})

// --- launchViaHome -------------------------------------------------------------------------------------------------

describe('launchViaHome', () => {
  test('mints an ephemeral worker key, hands it over by file, waits for the tunnel, then starts the worker behind it', async () => {
    const f = await sidecarFixture()
    await launchViaHome(cfgOf(), NODE, f.deps)
    expect(f.keys).toEqual([
      { tags: ['tag:tm-worker'], ephemeral: true, expirySeconds: 600, description: `tm-worker ${OCC}` }
    ])
    // The key was in the file while the sidecar was created, and in no part of the create body.
    expect(f.docker.keyAtCreate).toBe(`${AUTH_KEY}\n`)
    expect(JSON.stringify(f.docker.sidecars)).not.toContain(AUTH_KEY)
    expect(f.docker.sidecars.map((s) => s.name)).toEqual([`tm-home-${OCC}`])
    expect(f.docker.started).toEqual(['fake-1'])
    expect(f.workers).toEqual([{ sidecar: `tm-home-${OCC}` }])
    expect(f.docker.looks).toBeGreaterThanOrEqual(2)
  })

  test('removes the key file once the sidecar is up', async () => {
    const f = await sidecarFixture()
    await launchViaHome(cfgOf(), NODE, f.deps)
    expect(await readdir(`${f.env.profileRoot}/.home-keys`)).toEqual([])
  })

  test('a tunnel that is not healthy in time is removed and reported; no worker starts and no key file stays', async () => {
    const f = await sidecarFixture({ healthTimeoutMs: 20 })
    f.docker.healthyAfter = Infinity
    await expect(launchViaHome(cfgOf(), NODE, f.deps)).rejects.toBeInstanceOf(HomeRouteUnavailable)
    expect(f.docker.stopped.map((s) => s.id)).toEqual([`tm-home-${OCC}`])
    expect(f.workers).toEqual([])
    expect(await readdir(`${f.env.profileRoot}/.home-keys`)).toEqual([])
  })

  test('a sidecar that exits while the tunnel comes up is reported the same way', async () => {
    const f = await sidecarFixture()
    f.docker.sidecarDies = true
    await expect(launchViaHome(cfgOf(), NODE, f.deps)).rejects.toBeInstanceOf(HomeRouteUnavailable)
    expect(f.workers).toEqual([])
  })

  test('a Docker refusal removes the key file and the half-made sidecar, and starts no worker', async () => {
    const f = await sidecarFixture()
    f.docker.createError = new DockerError('create', 403, 'refused')
    await expect(launchViaHome(cfgOf(), NODE, f.deps)).rejects.toBeInstanceOf(DockerError)
    expect(await readdir(`${f.env.profileRoot}/.home-keys`)).toEqual([])
    expect(f.workers).toEqual([])
  })

  test('a worker that fails to start takes the sidecar with it', async () => {
    const f = await sidecarFixture({ workerStarts: false })
    await launchViaHome(cfgOf(), NODE, f.deps)
    expect(f.docker.stopped.map((s) => s.id)).toEqual([`tm-home-${OCC}`])
  })

  test('a worker that throws takes the sidecar with it too', async () => {
    const f = await sidecarFixture({
      launchWorker: async () => {
        throw new Error('boom')
      }
    })
    await expect(launchViaHome(cfgOf(), NODE, f.deps)).rejects.toThrow('boom')
    expect(f.docker.stopped.map((s) => s.id)).toEqual([`tm-home-${OCC}`])
  })

  test('a restart reuses a healthy sidecar and mints no new key', async () => {
    const f = await sidecarFixture()
    await launchViaHome(cfgOf(), NODE, f.deps)
    f.docker.looks = 99
    await launchViaHome({ ...cfgOf(), attempt: 2 }, NODE, f.deps)
    expect(f.keys).toHaveLength(1)
    expect(f.docker.sidecars).toHaveLength(1)
    expect(f.workers).toHaveLength(2)
  })

  test('a restart replaces a sidecar that is not healthy, with a fresh key', async () => {
    const f = await sidecarFixture()
    await launchViaHome(cfgOf(), NODE, f.deps)
    f.docker.looks = 0
    f.docker.healthyAfter = 2
    f.docker.inspectResults.set(`tm-home-${OCC}`, { running: true, health: 'unhealthy' })
    await launchViaHome({ ...cfgOf(), attempt: 2 }, NODE, f.deps)
    expect(f.keys).toHaveLength(2)
    expect(f.docker.sidecars).toHaveLength(2)
    expect(f.docker.stopped.map((s) => s.id)).toContain(`tm-home-${OCC}`)
  })
})

describe('removeSidecar', () => {
  test('stops a running sidecar and leaves nothing else alone', async () => {
    const f = await sidecarFixture()
    await launchViaHome(cfgOf(), NODE, f.deps)
    f.docker.stopped.length = 0
    await removeSidecar(f.docker, OCC)
    expect(f.docker.stopped.map((s) => s.id)).toEqual([`tm-home-${OCC}`])
  })

  test('does nothing when there is no sidecar', async () => {
    const docker = new FakeDocker()
    await removeSidecar(docker, OCC)
    expect(docker.stopped).toEqual([])
    expect(docker.removed).toEqual([])
  })

  test('removes one that was created and never started', async () => {
    const docker = new FakeDocker()
    docker.inspectResults.set(`tm-home-${OCC}`, { running: false })
    await removeSidecar(docker, OCC)
    expect(docker.removed).toEqual([`tm-home-${OCC}`])
  })
})

// --- The scheduler: home deps, restart and release -----------------------------------------------------------------

const START = new Date('2026-10-21T06:00:00Z')
const END = new Date('2026-10-21T08:00:00Z')
const now = new Date('2026-10-21T06:30:00Z')
const HOUR = 3_600_000

const tailscale = { devices: [] as unknown[] }
const realFetch = globalThis.fetch
const savedEnv = { ...process.env }
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname
    if (path === '/api/v2/oauth/token') return Response.json({ access_token: 'tok-1', expires_in: 3600 })
    if (path.endsWith('/keys')) return Response.json({ key: AUTH_KEY })
    return Response.json({ devices: tailscale.devices })
  }) as typeof fetch
  process.env.TM_TAILSCALE_CLIENT_ID = 'sidecar-test-client'
  process.env.TM_TAILSCALE_CLIENT_SECRET = 'sidecar-test-secret-0123456789'
  process.env.TAILSCALE_VERSION = VERSION
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const key of ['TM_TAILSCALE_CLIENT_ID', 'TM_TAILSCALE_CLIENT_SECRET', 'TAILSCALE_VERSION']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})
afterEach(() => {
  tailscale.devices = []
})

/** A member whose identity runs via home, launched once as a normal worker (real files), then put in mid-meeting. */
async function homeFixture(o: { heartbeatAgeMs?: number; sidecar?: 'healthy' | 'gone'; state?: string } = {}) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  await db
    .update(schema.members)
    .set({ ntfyTopic: 'tm-topic', ntfyTokenEnc: sealColumn(MASTER, memberId, 'members.ntfy_token', 'ntfy-secret') })
    .where(eq(schema.members.id, memberId))
  await db
    .update(schema.aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(MASTER, memberId, 'ai_keys.dashscope_key', 'sk-dash-secret') })
    .where(eq(schema.aiKeys.memberId, memberId))
  const [entry] = await db
    .insert(schema.timetableEntries)
    .values({
      memberId,
      identityId,
      name: 'Data Mining',
      type: 'lecture',
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '14:00',
      endTime: '16:00',
      link: { kind: 'fixed', url: 'https://example.zoom.us/j/11111111111' },
      transcription: 'live'
    })
    .returning()
  const [occ] = await db
    .insert(occurrences)
    .values({
      memberId,
      identityId,
      entryId: entry!.id,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: START,
      scheduledEnd: END,
      deleteAfter: new Date(END.getTime() + 30 * 24 * HOUR)
    })
    .returning()
  const id = occ!.id
  const root = await mkdtemp(`${tmp}/h-`)
  const env = specEnv(root)
  const docker = new SidecarDocker()
  const notifier = new FakeNotifier()
  const deps: LaunchDeps = {
    db,
    queue: new FakeQueue(),
    docker,
    notifier,
    master: MASTER,
    env,
    remux: async () => false,
    exitPollMs: 60_000
  }
  const launched = await launchOccurrence(
    deps,
    { occurrenceId: id, scheduledStart: START.toISOString() },
    new Date(START.getTime() - HOUR)
  )
  if (launched !== 'launched') throw new Error(`fixture launch: ${launched}`)
  await db.update(identities).set({ runLocation: 'server_via_home' }).where(eq(identities.id, identityId))
  const name = containerName({ kind: 'worker', occurrenceId: id, attempt: 1, identityId, env })
  await db
    .update(occurrences)
    .set({
      state: (o.state ?? 'in_meeting') as 'in_meeting',
      attempt: 1,
      containerName: name,
      lastHeartbeatAt: new Date(now.getTime() - (o.heartbeatAgeMs ?? 15_000))
    })
    .where(eq(occurrences.id, id))
  docker.inspectResults.set(name, { running: true })
  if (o.sidecar === 'healthy') docker.inspectResults.set(sidecarName(id), { running: true, health: 'healthy' })
  if (o.sidecar === 'gone') docker.inspectResults.set(sidecarName(id), null)
  docker.created.length = 0
  docker.started.length = 0
  notifier.sent.length = 0
  tailscale.devices = []
  return {
    db,
    deps,
    docker,
    notifier,
    id,
    memberId,
    identityId,
    name,
    occurrence: async () => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!,
    /** The member's home device as the Tailscale API shows it. */
    homeDevice: () => {
      tailscale.devices = [
        {
          nodeId: NODE_ID,
          hostname: homeHostname(MASTER, memberId),
          addresses: [NODE_IP],
          tags: [HOME_TAG],
          connectedToControl: true,
          enabledRoutes: ['0.0.0.0/0', '::/0']
        }
      ]
    }
  }
}

describe('homeDepsOf', () => {
  test('launches through the node the check stored, not an address the caller names', async () => {
    const f = await homeFixture()
    f.homeDevice()
    const home = homeDepsOf(f.deps)
    const { dbHomeNodeStore } = await import('@tm/web/db/home-route')
    await dbHomeNodeStore(f.db, f.memberId).save({
      nodeId: NODE_ID,
      hostname: homeHostname(MASTER, f.memberId),
      ipv4: NODE_IP,
      checkedAt: now
    })
    const cfg = {
      ...cfgOf(),
      occurrenceId: f.id,
      identity: { id: f.identityId },
      member: { id: f.memberId }
    } as JobConfig
    // A different address than the stored node's: the launch refuses before anything is made.
    await expect(home.launchViaHome(cfg, '100.99.99.99')).rejects.toBeInstanceOf(HomeRouteUnavailable)
    expect(f.docker.sidecars).toEqual([])
    expect(f.docker.created).toEqual([])
  }, 60_000)

  test('a missing TAILSCALE_VERSION is an error, never a default image', async () => {
    const f = await homeFixture()
    const home = homeDepsOf(f.deps, { ...process.env, TAILSCALE_VERSION: undefined })
    await expect(home.launchViaHome(cfgOf(), NODE_IP)).rejects.toThrow('TAILSCALE_VERSION')
  }, 60_000)
})

describe('restart and teardown of a home-route worker', () => {
  test('a dead sidecar is a worker crash: the worker is stopped and attempt 2 comes up behind a fresh sidecar', async () => {
    const f = await homeFixture({ sidecar: 'gone' })
    f.homeDevice()
    const { dbHomeNodeStore } = await import('@tm/web/db/home-route')
    expect((await monitorTick(f.deps, now)).restarted).toEqual([f.id])
    expect(f.docker.stopped.map((s) => s.id)).toContain(f.name)
    expect(f.docker.sidecars.map((s) => s.name)).toEqual([sidecarName(f.id)])
    const worker = f.docker.created.at(-1)!
    expect(worker.name).toBe(`tm-worker-${f.id}-a2`)
    expect(worker.body.HostConfig.NetworkMode).toBe(`container:${sidecarName(f.id)}`)
    expect(await f.occurrence()).toMatchObject({ state: 'restarting', attempt: 2, restarts: 1 })
    // The sidecar was pinned to the node the check stored for this member.
    expect((await dbHomeNodeStore(f.db, f.memberId).get())?.nodeId).toBe(NODE_ID)
    expect(f.docker.sidecars[0]!.body.Env).toContain(`TM_EXIT_NODE_ID=${NODE_ID}`)
  }, 60_000)

  test('with the home device offline the restart fails the occurrence; no worker starts outside the tunnel', async () => {
    const f = await homeFixture({ sidecar: 'gone' })
    expect((await monitorTick(f.deps, now)).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'home_exit_node_offline' })
    expect(f.docker.created).toEqual([])
    expect(f.docker.sidecars).toEqual([])
    expect(f.notifier.sent.at(-1)!.ping.message).toContain('home connection was offline')
  }, 60_000)

  test('a healthy sidecar with a working worker is left alone', async () => {
    const f = await homeFixture({ sidecar: 'healthy' })
    expect(await monitorTick(f.deps, now)).toEqual({ restarted: [], failed: [], released: [] })
    expect(f.docker.stopped).toEqual([])
  }, 60_000)

  test('a finished occurrence takes its sidecar down once the worker is gone', async () => {
    const f = await homeFixture({ sidecar: 'healthy', state: 'left_by_member' })
    f.docker.inspectResults.set(f.name, null)
    await monitorTick(f.deps, now)
    await settleRemuxes() // a meeting that ends without the pipeline is released after its remux
    expect(f.docker.stopped.map((s) => s.id)).toEqual([sidecarName(f.id)])
    expect((await f.occurrence()).containerName).toBeNull()
  }, 60_000)

  test('the sidecar stays up while the worker still runs', async () => {
    const f = await homeFixture({ sidecar: 'healthy', state: 'left_by_member' })
    await monitorTick(f.deps, now)
    expect(f.docker.stopped).toEqual([])
  }, 60_000)
})

test('the key file is mode 0444 in a private directory', async () => {
  const f = await sidecarFixture()
  let mode = 0
  const create = f.docker.create.bind(f.docker)
  f.docker.create = async (name, body) => {
    mode = (await stat((body as SidecarBody).HostConfig.Binds[0]!.split(':')[0]!)).mode & 0o777
    return create(name, body)
  }
  await launchViaHome(cfgOf(), NODE, f.deps)
  expect(mode).toBe(0o444)
  expect((await stat(`${f.env.profileRoot}/.home-keys`)).mode & 0o777).toBe(0o700)
  expect(await readFile(`${f.env.profileRoot}/.machine-ids`, 'utf8').catch(() => 'absent')).toBe('absent')
})
