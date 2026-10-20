import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { shortTime, type JobConfig } from '@tm/core'
import { and, eq } from 'drizzle-orm'
import { events, identities, occurrences, profiles, schema, type Db } from '@tm/web/db'
import { dbHomeNodeStore } from '@tm/web/db/home-route'
import { buildEntrySnapshot, loadJobConfig } from '@tm/web/db/job-config'
import { FakeNotifier } from '@tm/web/db/notifier'
import { QUEUES } from '@tm/web/db/queues'
import { sealColumn } from '@tm/web/db/secrets'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { HOME_TAG, homeHostname, TailscaleApi, type TailscaleDevice } from '@tm/web/lib/home-route'
import { expectNotLogged } from '../../web/test/no-log'
import { handleHomeRouteDead, handleHomeRouteRecheck, startViaHomeWith } from '../src/home-route/check'
import { HomeRouteUnavailable, type HomeDeps } from '../src/home-route/types'
import { FakeDocker, type LaunchDeps } from '../src/index'

const MASTER = Buffer.alloc(32, 3)
const SECRET = 'tskey-client-test-secret-0123456789'
const NODE_IP = '100.101.102.103'
const START = new Date('2026-10-21T06:00:00.000Z')
const at = (minutesBefore: number) => new Date(START.getTime() - minutesBefore * 60_000)
const T60 = at(60)

afterAll(dropAllTestDbs, 60_000)

// --- A Tailscale that answers the token and device endpoints, and records what it was asked ------------------------

const tailscale = {
  devices: [] as TailscaleDevice[],
  /** Answer the device list with this status. */
  status: 200,
  calls: 0
}
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init)
  const path = new URL(req.url).pathname
  if (path === '/api/v2/oauth/token') return Response.json({ access_token: 'tok-1', expires_in: 3600 })
  tailscale.calls++
  if (tailscale.status !== 200) return new Response(`denied for ${SECRET}`, { status: tailscale.status })
  return Response.json({ devices: tailscale.devices })
}) as typeof fetch

const device = (hostname: string, o: Partial<TailscaleDevice> = {}): TailscaleDevice => ({
  nodeId: 'nXYZ',
  hostname,
  addresses: [NODE_IP, 'fd7a:115c:a1e0::1'],
  tags: [HOME_TAG],
  connectedToControl: true,
  enabledRoutes: ['0.0.0.0/0', '::/0'],
  ...o
})

const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = fakeFetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})
afterEach(() => {
  tailscale.devices = []
  tailscale.status = 200
  tailscale.calls = 0
})

// --- One member whose identity runs via home -----------------------------------------------------------------------

async function fixture() {
  const db: Db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  await db
    .update(schema.members)
    .set({ ntfyTopic: 'tm-topic', ntfyTokenEnc: sealColumn(MASTER, memberId, 'members.ntfy_token', 'ntfy-secret') })
    .where(eq(schema.members.id, memberId))
  await db
    .update(schema.aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(MASTER, memberId, 'ai_keys.dashscope_key', 'sk-dash-secret') })
    .where(eq(schema.aiKeys.memberId, memberId))
  await db.update(identities).set({ runLocation: 'server_via_home' }).where(eq(identities.id, identityId))
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
      scheduledEnd: new Date(START.getTime() + 2 * 3_600_000),
      deleteAfter: new Date(START.getTime() + 30 * 24 * 3_600_000)
    })
    .returning()
  const id = occ!.id
  await db
    .update(occurrences)
    .set({ entrySnapshot: await buildEntrySnapshot(db, id) })
    .where(eq(occurrences.id, id))
  const env = {
    dataRoot: '/unused/data',
    profileRoot: '/unused/profiles',
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const queue = new FakeQueue()
  const notifier = new FakeNotifier()
  const launched: Array<[string, string]> = []
  const launch = { throws: null as Error | null }
  const home: HomeDeps = {
    db,
    queue,
    notifier,
    master: MASTER,
    env,
    api: new TailscaleApi({ clientId: 'client-id-1', clientSecret: SECRET, tailnet: '-' }, fakeFetch),
    launchViaHome: async (cfg: JobConfig, ip: string) => {
      if (launch.throws) throw launch.throws
      launched.push([cfg.occurrenceId, ip])
    }
  }
  const deps: LaunchDeps = {
    db,
    queue,
    notifier,
    master: MASTER,
    env,
    docker: new FakeDocker(),
    remux: async () => false
  }
  const cfg = await loadJobConfig(db, MASTER, id, { attempt: 1, control: null, env })
  const hostname = homeHostname(MASTER, memberId)
  return {
    db,
    id,
    memberId,
    identityId,
    home,
    deps,
    cfg,
    hostname,
    queue,
    notifier,
    launched,
    launch,
    state: async () => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!,
    alerts: () =>
      db
        .select()
        .from(events)
        .where(and(eq(events.occurrenceId, id), eq(events.type, 'alert'))),
    rechecks: () => queue.sent.filter((s) => s.name === QUEUES.homeRouteRecheck)
  }
}

describe('startViaHomeWith', () => {
  test('a ready exit node launches the worker through it', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname)]
    expect(await startViaHomeWith(f.home, f.cfg, T60)).toBe('launched')
    expect(f.launched).toEqual([[f.id, NODE_IP]])
    expect(f.notifier.sent).toEqual([])
    expect(f.rechecks()).toEqual([])
    // The node it launched through is the one the check stored for the member.
    expect(await dbHomeNodeStore(f.db, f.memberId).get()).toMatchObject({ nodeId: 'nXYZ', ipv4: NODE_IP })
  }, 60_000)

  test('an offline exit node pings once and rechecks every minute', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname, { connectedToControl: false })]
    expect(await startViaHomeWith(f.home, f.cfg, T60)).toBe('waiting')
    expect(await startViaHomeWith(f.home, f.cfg, new Date(T60.getTime() + 60_000))).toBe('waiting')
    expect(await startViaHomeWith(f.home, f.cfg, new Date(T60.getTime() + 120_000))).toBe('waiting')
    expect(f.notifier.sent).toHaveLength(1)
    const when = shortTime(f.cfg.entry.start, f.cfg.entry.timeZone)
    const deadline = shortTime(at(10).toISOString(), f.cfg.entry.timeZone)
    expect(f.notifier.sent[0]).toEqual({
      memberId: f.memberId,
      ping: {
        title: 'Home connection offline: Data Mining',
        message: `Data Mining (${when}) runs through your home device ${f.hostname}, which isn't online. Turn it on before ${deadline}, or the bot won't join.`,
        priority: 'high',
        actions: [{ label: 'Open meeting page', url: `https://tm.example/meetings/${f.id}` }]
      }
    })
    expect(f.rechecks().map((s) => [s.data, s.opts?.startAfter])).toEqual([
      [{ occurrenceId: f.id }, new Date(T60.getTime() + 60_000)],
      [{ occurrenceId: f.id }, new Date(T60.getTime() + 120_000)],
      [{ occurrenceId: f.id }, new Date(T60.getTime() + 180_000)]
    ])
    expect((await f.alerts()).map((e) => e.data)).toEqual([{ kind: 'home_route_offline', problem: 'offline' }])
    expect(f.launched).toEqual([])
    expect((await f.state()).state).toBe('scheduled')
  }, 60_000)

  test('the reason names what is wrong with the device', async () => {
    const f = await fixture()
    expect(await startViaHomeWith(f.home, f.cfg, T60)).toBe('waiting')
    expect(f.notifier.sent[0]!.ping.message).toContain("isn't set up")
    const g = await fixture()
    tailscale.devices = [device(g.hostname, { enabledRoutes: [] })]
    expect(await startViaHomeWith(g.home, g.cfg, T60)).toBe('waiting')
    expect(g.notifier.sent[0]!.ping.message).toContain("isn't sharing its connection")
  }, 60_000)

  test('still offline at T-10 fails the occurrence; the worker never starts without the exit node', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname, { connectedToControl: false })]
    await f.db
      .update(profiles)
      .set({ heldBy: `occ:${f.id}` })
      .where(eq(profiles.identityId, f.identityId))
    expect(await startViaHomeWith(f.home, f.cfg, at(10))).toBe('failed')
    expect(await f.state()).toMatchObject({ state: 'failed', stateReason: 'home_exit_node_offline' })
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Failed: Data Mining'])
    expect(f.notifier.sent[0]!.ping.message).toContain('your home connection was offline')
    expect(f.launched).toEqual([])
    expect(f.rechecks()).toEqual([])
    const [profile] = await f.db.select().from(profiles).where(eq(profiles.identityId, f.identityId))
    expect(profile!.heldBy).toBeNull()
  }, 60_000)

  test('a tunnel that does not come up counts as offline', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname)]
    f.launch.throws = new HomeRouteUnavailable()
    expect(await startViaHomeWith(f.home, f.cfg, T60)).toBe('waiting')
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Home connection offline: Data Mining'])
    expect(f.rechecks()).toHaveLength(1)
    expect(await startViaHomeWith(f.home, f.cfg, at(10))).toBe('failed')
  }, 60_000)

  test('any other launch error is thrown, so the queue retries', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname)]
    f.launch.throws = new Error('docker exploded')
    await expect(startViaHomeWith(f.home, f.cfg, T60)).rejects.toThrow('docker exploded')
    expect(f.notifier.sent).toEqual([])
    expect(f.rechecks()).toEqual([])
  }, 60_000)

  test('a Tailscale error is not the member’s fault: no ping, a recheck, and only its name and status are logged', async () => {
    const f = await fixture()
    tailscale.status = 503
    const logged: string[] = []
    // `expectNotLogged` fails if the OAuth secret (which the fake 503 body also echoes) reaches any log output.
    await expectNotLogged(SECRET, async () => {
      const lines = console.error
      console.error = (...args: unknown[]) => void logged.push(args.join(' '))
      try {
        expect(await startViaHomeWith(f.home, f.cfg, T60)).toBe('waiting')
        expect(await startViaHomeWith(f.home, f.cfg, T60)).toBe('waiting')
      } finally {
        console.error = lines
      }
    })
    expect(logged).toEqual([
      `home-route: ${f.id}: the Tailscale lookup failed (TailscaleApiError HTTP 503)`,
      `home-route: ${f.id}: the Tailscale lookup failed (TailscaleApiError HTTP 503)`
    ])
    expect(f.notifier.sent).toEqual([])
    expect(f.rechecks()).toHaveLength(2)
    expect(await startViaHomeWith(f.home, f.cfg, at(10))).toBe('failed')
    expect(await f.state()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Failed: Data Mining'])
  }, 60_000)

  test('a member whose ping could not be sent is tried again by the next check', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname, { connectedToControl: false })]
    let up = false
    f.home.notifier = {
      notify: async (memberId, ping) => {
        if (!up) return false
        return f.notifier.notify(memberId, ping)
      }
    }
    await startViaHomeWith(f.home, f.cfg, T60)
    expect(await f.alerts()).toEqual([])
    up = true
    await startViaHomeWith(f.home, f.cfg, new Date(T60.getTime() + 60_000))
    await startViaHomeWith(f.home, f.cfg, new Date(T60.getTime() + 120_000))
    expect(f.notifier.sent).toHaveLength(1)
    expect(await f.alerts()).toHaveLength(1)
  }, 60_000)
})

describe('the home-route jobs', () => {
  const savedEnv = { ...process.env }
  beforeAll(() => {
    process.env.TM_TAILSCALE_CLIENT_ID = 'client-id-1'
    process.env.TM_TAILSCALE_CLIENT_SECRET = SECRET
  })
  afterAll(() => {
    process.env.TM_TAILSCALE_CLIENT_ID = savedEnv.TM_TAILSCALE_CLIENT_ID
    process.env.TM_TAILSCALE_CLIENT_SECRET = savedEnv.TM_TAILSCALE_CLIENT_SECRET
    if (savedEnv.TM_TAILSCALE_CLIENT_ID === undefined) delete process.env.TM_TAILSCALE_CLIENT_ID
    if (savedEnv.TM_TAILSCALE_CLIENT_SECRET === undefined) delete process.env.TM_TAILSCALE_CLIENT_SECRET
  })

  test('a recheck rebuilds the job config, looks again and queues the next look', async () => {
    const f = await fixture()
    tailscale.devices = [device(f.hostname, { connectedToControl: false })]
    expect(await handleHomeRouteRecheck(f.deps, { occurrenceId: f.id }, T60)).toBe('waiting')
    expect(f.rechecks()).toHaveLength(1)
    expect(f.notifier.sent).toHaveLength(1)
    // Only the hash of the control token is stored.
    expect((await f.state()).controlTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await handleHomeRouteRecheck(f.deps, { occurrenceId: f.id }, at(10))).toBe('failed')
    expect((await f.state()).state).toBe('failed')
  }, 60_000)

  test('a recheck for an occurrence that is gone, moved on or malformed ends the chain or throws', async () => {
    const f = await fixture()
    await f.db.update(occurrences).set({ state: 'skipped_capacity' }).where(eq(occurrences.id, f.id))
    expect(await handleHomeRouteRecheck(f.deps, { occurrenceId: f.id }, T60)).toBe('stale')
    expect(await handleHomeRouteRecheck(f.deps, { occurrenceId: crypto.randomUUID() }, T60)).toBe('stale')
    await expect(handleHomeRouteRecheck(f.deps, { occurrenceId: 'nope' }, T60)).rejects.toThrow()
    expect(tailscale.calls).toBe(0)
  }, 60_000)

  test('a dead recheck is queued again before T-10 and fails the occurrence from T-10', async () => {
    const f = await fixture()
    expect(await handleHomeRouteDead(f.deps, { occurrenceId: f.id }, T60)).toBe('deferred')
    expect(f.rechecks().map((s) => s.opts?.startAfter)).toEqual([new Date(T60.getTime() + 60_000)])
    expect(await handleHomeRouteDead(f.deps, { occurrenceId: f.id }, at(10))).toBe('failed')
    expect(await f.state()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Failed: Data Mining'])
    expect(await handleHomeRouteDead(f.deps, { occurrenceId: f.id }, at(5))).toBe('stale')
  }, 60_000)
})
