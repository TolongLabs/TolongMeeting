import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { dbHomeNodeStore, scopeHomeNodeStore } from '../db/home-route'
import { homeExitNodes, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { AttemptLimiter } from '../lib/companion/tokens'
import {
  checkHomeRoute,
  enrolKey,
  handleCheckRequest,
  handleKeyRequest,
  homeHostname,
  homeRouteDeps,
  MAX_KEYS_PER_HOUR,
  TailscaleApi,
  TailscaleApiError,
  tailscaleConfigFromEnv,
  type HomeRouteDeps,
  type TailscaleDevice
} from '../lib/home-route'
import { createScope } from '../lib/scope'
import { expectNotLogged } from './no-log'

const t0 = new Date('2026-10-21T08:00:00Z')
const SECRET = 'tskey-client-test-secret-0123456789'
const KEY = 'tskey-auth-kTEST123CNTRL-abcdefghijklmnopqrstuvwxyz012345'
const MASTER = Buffer.alloc(32, 7)
const CFG = { clientId: 'client-id-1', clientSecret: SECRET, tailnet: '-' }
const READY = { connectedToControl: true, enabledRoutes: ['0.0.0.0/0', '::/0'] }

let db: Db
beforeAll(async () => {
  db = await createTestDb()
}, 60_000)
afterAll(dropAllTestDbs, 60_000)

interface FakeOptions {
  devices?: TailscaleDevice[]
  expiresIn?: number
  /** Answer every API call (not the token) with this status. */
  apiStatus?: number
}

/** A Tailscale answering the token, key and device endpoints with their documented shapes, and recording requests. */
function tsFake(seen: Request[], o: FakeOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push(req.clone())
    const path = new URL(req.url).pathname
    if (path === '/api/v2/oauth/token')
      return Response.json({
        access_token: 'tskey-api-test-access',
        token_type: 'Bearer',
        expires_in: o.expiresIn ?? 3600
      })
    if (o.apiStatus) return Response.json({ message: `leaky ${SECRET}` }, { status: o.apiStatus })
    if (req.method === 'POST' && path.endsWith('/keys')) return Response.json({ id: 'k1CNTRL', key: KEY })
    if (req.method === 'GET' && path.endsWith('/devices')) return Response.json({ devices: o.devices ?? [] })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

const device = (hostname: string, over: Partial<TailscaleDevice> = {}): TailscaleDevice => ({
  nodeId: `n-${hostname}`,
  hostname,
  addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  tags: ['tag:tm-home'],
  ...READY,
  ...over
})

async function member() {
  const { memberId } = await seedMember(db, { full: false })
  return { memberId, hostname: homeHostname(MASTER, memberId), scope: createScope(db, memberId) }
}

const row = async (memberId: string) =>
  (await db.select().from(homeExitNodes).where(eq(homeExitNodes.memberId, memberId)))[0]

describe('the Tailscale client', () => {
  test('the OAuth token is fetched once and keys are single-use, pre-authorised and tagged', async () => {
    const seen: Request[] = []
    const api = new TailscaleApi(CFG, tsFake(seen))
    const { key, hostname } = await enrolKey(api, MASTER, '1a2b3c4d-0000-4000-8000-000000000000')
    await api.devices()
    expect(seen.filter((r) => r.url.endsWith('/api/v2/oauth/token'))).toHaveLength(1)
    const create = seen.find((r) => r.url.endsWith('/api/v2/tailnet/-/keys'))!
    expect(await create.clone().json()).toEqual({
      capabilities: {
        devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: ['tag:tm-home'] } }
      },
      expirySeconds: 3600,
      description: 'tm-home 1a2b3c4d'
    })
    expect(key).toStartWith('tskey-auth-')
    expect(hostname).toBe(homeHostname(MASTER, '1a2b3c4d-0000-4000-8000-000000000000'))
  })

  test('the token request is a form body; the secret is in no URL; calls carry the bearer token', async () => {
    const seen: Request[] = []
    const api = new TailscaleApi({ ...CFG, tailnet: 'example.com' }, tsFake(seen))
    await api.devices()
    const [token, list] = seen as [Request, Request]
    expect(token.method).toBe('POST')
    expect(token.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(await token.text()))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-id-1',
      client_secret: SECRET
    })
    expect(list.url).toBe('https://api.tailscale.com/api/v2/tailnet/example.com/devices?fields=all')
    expect(list.headers.get('authorization')).toBe('Bearer tskey-api-test-access')
    expect(seen.some((r) => r.url.includes(SECRET))).toBe(false)
  })

  test('a token that has expired is fetched again', async () => {
    const seen: Request[] = []
    const api = new TailscaleApi(CFG, tsFake(seen, { expiresIn: 60 }))
    await api.devices()
    await api.devices()
    expect(seen.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(2)
  })

  test('concurrent calls share one token request', async () => {
    const seen: Request[] = []
    const api = new TailscaleApi(CFG, tsFake(seen))
    await Promise.all([api.devices(), api.devices(), api.devices()])
    expect(seen.filter((r) => r.url.endsWith('/oauth/token'))).toHaveLength(1)
  })

  test('an error names the call and the status, and carries neither the body nor the secret', async () => {
    const api = new TailscaleApi(CFG, tsFake([], { apiStatus: 403 }))
    const error = await api.devices().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TailscaleApiError)
    expect((error as Error).message).toBe('Tailscale device list failed (HTTP 403).')
    expect(JSON.stringify(error)).not.toContain(SECRET)
    const down = new TailscaleApi(CFG, (() => Promise.reject(new Error(`connect failed ${SECRET}`))) as never)
    expect(((await down.devices().catch((e: unknown) => e)) as Error).message).toBe(
      'Tailscale OAuth token request failed.'
    )
  })

  test('an OAuth token response that is not JSON is a fixed TailscaleApiError that quotes nothing', async () => {
    const html = (() => Promise.resolve(new Response(`<html>${SECRET}</html>`, { status: 200 }))) as never
    const error = await new TailscaleApi(CFG, html).devices().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TailscaleApiError)
    expect((error as Error).message).toBe('Tailscale OAuth token parse failed.')
    expect(JSON.stringify(error)).not.toContain(SECRET)
  })

  test('a key needs tags and an allowed description', async () => {
    const api = new TailscaleApi(CFG, tsFake([]))
    const base = { ephemeral: true, expirySeconds: 600, description: 'ok key' }
    await expect(api.createAuthKey({ ...base, tags: ['tag:x'], expirySeconds: 3601 })).rejects.toThrow('one hour')
    await expect(api.createAuthKey({ ...base, tags: ['tag:x'], expirySeconds: 0 })).rejects.toThrow('one hour')
    await expect(api.createAuthKey({ ...base, tags: [] })).rejects.toThrow('needs tags')
    await expect(api.createAuthKey({ ...base, tags: ['tm-home'] })).rejects.toThrow('needs tags')
    await expect(api.createAuthKey({ ...base, tags: ['tag:x'], description: 'bad;key' })).rejects.toThrow('description')
    await expect(api.createAuthKey({ ...base, tags: ['tag:x'] })).resolves.toBe(KEY)
  })

  test('the hostname is keyed: it differs per member and per master key, and does not hold the member id', () => {
    const id = '1a2b3c4d-0000-4000-8000-000000000000'
    const name = homeHostname(MASTER, id)
    expect(name).toMatch(/^tm-home-[0-9a-f]{24}$/)
    expect(name).not.toContain('1a2b3c4d')
    expect(homeHostname(MASTER, id.toUpperCase())).toBe(name)
    expect(homeHostname(MASTER, '1a2b3c4d-0000-4000-8000-000000000001')).not.toBe(name)
    expect(homeHostname(Buffer.alloc(32, 8), id)).not.toBe(name)
    expect(() => homeHostname(MASTER, '1a2b3c4d')).toThrow('Not a member id')
  })

  test('the config reads the environment, defaults the tailnet to "-" and is null without a client', () => {
    expect(tailscaleConfigFromEnv({ TM_TAILSCALE_CLIENT_ID: 'a', TM_TAILSCALE_CLIENT_SECRET: 'b' })).toEqual({
      clientId: 'a',
      clientSecret: 'b',
      tailnet: '-'
    })
    expect(
      tailscaleConfigFromEnv({
        TM_TAILSCALE_CLIENT_ID: 'a',
        TM_TAILSCALE_CLIENT_SECRET: 'b',
        TM_TAILSCALE_TAILNET: 'x.ts.net'
      })?.tailnet
    ).toBe('x.ts.net')
    expect(tailscaleConfigFromEnv({ TM_TAILSCALE_CLIENT_ID: 'a' })).toBeNull()
    expect(homeRouteDeps({})).toBeNull()
  })
})

describe('checkHomeRoute', () => {
  test.each([
    [{ connectedToControl: true, enabledRoutes: ['0.0.0.0/0', '::/0'] }, 'ready'],
    [{ connectedToControl: false, enabledRoutes: ['0.0.0.0/0', '::/0'] }, 'offline'],
    [{ connectedToControl: true, enabledRoutes: [] }, 'not_exit_node'],
    [{ connectedToControl: true, enabledRoutes: ['0.0.0.0/0'] }, 'not_exit_node']
  ] as const)('checkHomeRoute(%o) is %s', async (dev, status) => {
    const m = await member()
    const api = new TailscaleApi(
      CFG,
      tsFake([], { devices: [device(m.hostname, { ...dev, enabledRoutes: [...dev.enabledRoutes] })] })
    )
    const result = await checkHomeRoute(dbHomeNodeStore(db, m.memberId), api, MASTER, m.memberId)
    expect(result.status).toBe(status)
    expect(result.ipv4).toBe(status === 'ready' ? '100.101.102.103' : null)
  })

  test("another member's device or an untagged one never counts", async () => {
    const m = await member()
    const other = await member()
    const api = new TailscaleApi(
      CFG,
      tsFake([], {
        devices: [
          device(other.hostname, { nodeId: 'n2' }),
          device(m.hostname, { nodeId: 'n3', tags: [] }),
          device(m.hostname, { nodeId: 'n4', tags: ['tag:tm-worker'] })
        ]
      })
    )
    expect((await checkHomeRoute(dbHomeNodeStore(db, m.memberId), api, MASTER, m.memberId)).status).toBe('not_enrolled')
    expect(await row(m.memberId)).toBeUndefined()
  })

  test('a ready node is stored with its IPv4 address and refreshed; offline or vanished keeps it', async () => {
    const m = await member()
    const store = dbHomeNodeStore(db, m.memberId)
    const ready = new TailscaleApi(CFG, tsFake([], { devices: [device(m.hostname)] }))
    await checkHomeRoute(store, ready, MASTER, m.memberId, t0)
    expect(await row(m.memberId)).toMatchObject({
      nodeId: `n-${m.hostname}`,
      hostname: m.hostname,
      ipv4: '100.101.102.103',
      checkedAt: t0
    })

    const later = new Date(t0.getTime() + 60_000)
    await checkHomeRoute(
      store,
      new TailscaleApi(CFG, tsFake([], { devices: [device(m.hostname, { addresses: ['100.1.1.1'] })] })),
      MASTER,
      m.memberId,
      later
    )
    expect(await row(m.memberId)).toMatchObject({ nodeId: `n-${m.hostname}`, ipv4: '100.1.1.1', checkedAt: later })

    const offline = new TailscaleApi(CFG, tsFake([], { devices: [device(m.hostname, { connectedToControl: false })] }))
    expect((await checkHomeRoute(store, offline, MASTER, m.memberId)).status).toBe('offline')
    expect(await row(m.memberId)).toMatchObject({ nodeId: `n-${m.hostname}` })

    const gone = new TailscaleApi(CFG, tsFake([], { devices: [] }))
    expect((await checkHomeRoute(store, gone, MASTER, m.memberId)).status).toBe('offline')
    expect(await row(m.memberId)).toMatchObject({ nodeId: `n-${m.hostname}`, ipv4: '100.1.1.1' })
  })

  test('a pinned node that loses its tag is offline, keeps its pin and is not replaced by a lookalike', async () => {
    const m = await member()
    const store = dbHomeNodeStore(db, m.memberId)
    await checkHomeRoute(
      store,
      new TailscaleApi(CFG, tsFake([], { devices: [device(m.hostname)] })),
      MASTER,
      m.memberId
    )
    const untagged = [
      device(m.hostname, { tags: [] }),
      device(m.hostname, { nodeId: 'evil', addresses: ['100.66.6.6'] })
    ]
    const result = await checkHomeRoute(
      store,
      new TailscaleApi(CFG, tsFake([], { devices: untagged })),
      MASTER,
      m.memberId
    )
    expect(result).toEqual({ status: 'offline', hostname: m.hostname, ipv4: null })
    expect(await row(m.memberId)).toMatchObject({ nodeId: `n-${m.hostname}`, ipv4: '100.101.102.103' })
  })

  test("a device named with another member's member-id prefix, made with a different key, is refused", async () => {
    const m = await member()
    const other = await member()
    // The name the old scheme gave a member: anyone who knows the member id can type it into `tailscale up --hostname`.
    const guessable = `tm-home-${m.memberId.slice(0, 8)}`
    const api = new TailscaleApi(
      CFG,
      tsFake([], { devices: [device(guessable, { nodeId: 'evil' }), device(other.hostname, { nodeId: 'theirs' })] })
    )
    const result = await checkHomeRoute(dbHomeNodeStore(db, m.memberId), api, MASTER, m.memberId)
    expect(result).toEqual({ status: 'not_enrolled', hostname: m.hostname, ipv4: null })
    expect(await row(m.memberId)).toBeUndefined()
  })

  test('a stored node is the only one that counts: a later device with the same name never replaces it', async () => {
    const m = await member()
    const store = dbHomeNodeStore(db, m.memberId)
    await checkHomeRoute(
      store,
      new TailscaleApi(CFG, tsFake([], { devices: [device(m.hostname)] })),
      MASTER,
      m.memberId
    )
    const both = [device(m.hostname, { nodeId: 'evil', addresses: ['100.66.6.6'] }), device(m.hostname)]
    const ready = await checkHomeRoute(store, new TailscaleApi(CFG, tsFake([], { devices: both })), MASTER, m.memberId)
    expect(ready).toMatchObject({ status: 'ready', ipv4: '100.101.102.103' })
    expect(await row(m.memberId)).toMatchObject({ nodeId: `n-${m.hostname}`, ipv4: '100.101.102.103' })

    const offline = [
      device(m.hostname, { nodeId: 'evil', addresses: ['100.66.6.6'] }),
      device(m.hostname, { connectedToControl: false })
    ]
    const result = await checkHomeRoute(
      store,
      new TailscaleApi(CFG, tsFake([], { devices: offline })),
      MASTER,
      m.memberId
    )
    expect(result.status).toBe('offline')
    expect(await row(m.memberId)).toMatchObject({ nodeId: `n-${m.hostname}` })
  })

  test('two unpinned devices with the name are not trusted', async () => {
    const m = await member()
    const two = [device(m.hostname, { nodeId: 'a' }), device(m.hostname, { nodeId: 'b' })]
    const api = new TailscaleApi(CFG, tsFake([], { devices: two }))
    expect((await checkHomeRoute(dbHomeNodeStore(db, m.memberId), api, MASTER, m.memberId)).status).toBe('not_enrolled')
    expect(await row(m.memberId)).toBeUndefined()
  })

  test('a ready device with no IPv4 address is an error, not a stored node', async () => {
    const m = await member()
    const api = new TailscaleApi(CFG, tsFake([], { devices: [device(m.hostname, { addresses: ['fd7a::1'] })] }))
    await expect(checkHomeRoute(dbHomeNodeStore(db, m.memberId), api, MASTER, m.memberId)).rejects.toThrow('no IPv4')
    expect(await row(m.memberId)).toBeUndefined()
  })
})

describe('the home node store', () => {
  test("a member's scope reads and writes only their own row", async () => {
    const a = await member()
    const b = await member()
    const storeA = scopeHomeNodeStore(a.scope)
    const storeB = scopeHomeNodeStore(b.scope)
    expect(await storeA.get()).toBeNull()
    await storeA.save({ nodeId: 'a1', hostname: a.hostname, ipv4: '100.64.0.1', checkedAt: t0 })
    await storeA.save({ nodeId: 'a2', hostname: a.hostname, ipv4: '100.64.0.2', checkedAt: t0 })
    await storeB.save({ nodeId: 'b1', hostname: b.hostname, ipv4: '100.64.0.3', checkedAt: t0 })
    expect(await storeA.get()).toMatchObject({ nodeId: 'a2', ipv4: '100.64.0.2' })
    await storeA.clear()
    expect(await storeA.get()).toBeNull()
    expect(await storeB.get()).toMatchObject({ nodeId: 'b1' })
  })
})

describe('the member routes', () => {
  const post = (headers: Record<string, string> = {}) =>
    new Request('https://app.test/api/home-route/key', { method: 'POST', headers })
  const depsOf = (o: FakeOptions = {}, seen: Request[] = []): HomeRouteDeps => ({
    api: new TailscaleApi(CFG, tsFake(seen, o)),
    keyLimiter: new AttemptLimiter(MAX_KEYS_PER_HOUR, 3_600_000),
    master: MASTER,
    checkLimiter: new AttemptLimiter(30, 600_000),
    now: () => t0
  })

  test("the key route returns the key and the member's hostname once, uncached, and stores nothing", async () => {
    const m = await member()
    const res = await handleKeyRequest(post(), m.scope, depsOf())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ key: KEY, hostname: m.hostname })
    expect(await row(m.memberId)).toBeUndefined()
  })

  test('the key route asks Tailscale for a key named after the signed-in member only', async () => {
    const m = await member()
    const seen: Request[] = []
    await handleKeyRequest(post(), m.scope, depsOf({}, seen))
    const create = seen.find((r) => r.url.endsWith('/keys'))!
    expect(((await create.json()) as { description: string }).description).toBe(`tm-home ${m.memberId.slice(0, 8)}`)
  })

  test('a new setup key forgets the stored node, so a replacement device is adopted once the old one is gone', async () => {
    const m = await member()
    const store = scopeHomeNodeStore(m.scope)
    await store.save({ nodeId: 'old', hostname: m.hostname, ipv4: '100.64.0.1', checkedAt: t0 })
    const old = device(m.hostname, { nodeId: 'old', addresses: ['100.64.0.1'] })
    const fresh = device(m.hostname, { nodeId: 'new', addresses: ['100.64.0.2'] })
    const both = new TailscaleApi(CFG, tsFake([], { devices: [old, fresh] }))
    expect((await checkHomeRoute(store, both, MASTER, m.memberId)).ipv4).toBe('100.64.0.1')
    expect((await handleKeyRequest(post(), m.scope, depsOf())).status).toBe(200)
    expect(await store.get()).toBeNull()
    expect((await checkHomeRoute(store, both, MASTER, m.memberId)).status).toBe('not_enrolled')
    const onlyFresh = new TailscaleApi(CFG, tsFake([], { devices: [fresh] }))
    expect(await checkHomeRoute(store, onlyFresh, MASTER, m.memberId)).toMatchObject({
      status: 'ready',
      ipv4: '100.64.0.2'
    })
    expect(await store.get()).toMatchObject({ nodeId: 'new' })
  })

  test('a failed key request keeps the stored node', async () => {
    const m = await member()
    const store = scopeHomeNodeStore(m.scope)
    await store.save({ nodeId: 'old', hostname: m.hostname, ipv4: '100.64.0.1', checkedAt: t0 })
    expect((await handleKeyRequest(post(), m.scope, depsOf({ apiStatus: 500 }))).status).toBe(502)
    expect(await store.get()).toMatchObject({ nodeId: 'old' })
  })

  test('a fifth key an hour is the last', async () => {
    const m = await member()
    const deps = depsOf()
    for (let i = 0; i < MAX_KEYS_PER_HOUR; i++) expect((await handleKeyRequest(post(), m.scope, deps)).status).toBe(200)
    const res = await handleKeyRequest(post(), m.scope, deps)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'too_many_keys' })
    const other = await member()
    expect((await handleKeyRequest(post(), other.scope, deps)).status).toBe(200)
  })

  test('a cross-site request is refused, and an unconfigured server answers 503', async () => {
    const m = await member()
    const cross = await handleKeyRequest(post({ 'sec-fetch-site': 'cross-site' }), m.scope, depsOf())
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ error: 'forbidden' })
    const none = await handleCheckRequest(post(), m.scope, null)
    expect(none.status).toBe(503)
    expect(await none.json()).toEqual({ error: 'home_route_unavailable' })
  })

  test('a Tailscale failure is one fixed 502 that leaks nothing', async () => {
    const m = await member()
    for (const handle of [handleKeyRequest, handleCheckRequest]) {
      const res = await handle(post(), m.scope, depsOf({ apiStatus: 500 }))
      expect(res.status).toBe(502)
      const text = await res.text()
      expect(text).toBe('{"error":"tailscale_unavailable"}')
    }
  })

  test('the check route returns the status and hostname, stores a ready node and logs no secret', async () => {
    const m = await member()
    await expectNotLogged(SECRET, async () => {
      await expectNotLogged(KEY, async () => {
        const res = await handleCheckRequest(post(), m.scope, depsOf({ devices: [device(m.hostname)] }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: 'ready', hostname: m.hostname })
        expect(await row(m.memberId)).toMatchObject({ ipv4: '100.101.102.103' })
        await handleKeyRequest(post(), m.scope, depsOf({ apiStatus: 401 }))
        expect(await row(m.memberId)).toMatchObject({ ipv4: '100.101.102.103' })
        await handleKeyRequest(post(), m.scope, depsOf())
      })
    })
    expect(await row(m.memberId)).toBeUndefined()
  })
})

describe('the tailnet policy', () => {
  test('workers reach only the internet; home devices reach nothing; no node reaches another', async () => {
    const p = await Bun.file(new URL('../../../config/tailscale/policy.json', import.meta.url)).json()
    expect(p.acls).toEqual([{ action: 'accept', src: ['tag:tm-worker'], dst: ['autogroup:internet:*'] }])
    expect(p.autoApprovers).toEqual({ exitNode: ['tag:tm-home'] })
    expect(Object.keys(p.tagOwners).sort()).toEqual(['tag:tm-home', 'tag:tm-worker'])
    expect(Object.keys(p).sort()).toEqual(['acls', 'autoApprovers', 'hosts', 'tagOwners', 'tests'])
    // Tailscale's `tests` take a single numeric port per destination (no `:*`). An untagged device stands for a member's
    // own machine: a future broad grant, to a tag or to the tailnet, would make one of these deny cases fail on apply.
    const device = Object.keys(p.hosts)
    expect(device).toEqual(['tm-test-member-device'])
    const ports = [22, 443]
    const targets = ['tag:tm-worker', 'tag:tm-home', device[0]]
    const reach = (hosts: string[]) => hosts.flatMap((h) => ports.map((port) => `${h}:${port}`))
    expect(p.tests).toEqual([
      { src: 'tag:tm-worker', accept: ['1.1.1.1:443'], deny: reach(targets) },
      { src: 'tag:tm-home', deny: ['1.1.1.1:443', ...reach(['tag:tm-home', 'tag:tm-worker', device[0]])] }
    ])
    for (const t of p.tests) for (const d of [...(t.accept ?? []), ...t.deny]) expect(d).toMatch(/:\d+$/)
  })
})
