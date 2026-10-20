import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { profiles, schema, signinSessions, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember } from '../db/testing'
import { authoriseVncRequest } from '../lib/control'

// The remote view's Caddy contract, end to end: the real docker/caddy/Caddyfile in the real Caddy image, in front of a
// fake website whose /api/vnc/authorize is the real route handler over a seeded database, and fake worker noVNC servers.
// It needs Docker and the image named in docker/compose.yaml, and skips with a message when either is missing (CI pulls
// the image first).

const root = join(import.meta.dir, '..', '..', '..')
const caddyfile = join(root, 'docker', 'caddy', 'Caddyfile')
const image = /image:\s*(caddy:\S+)/.exec(await Bun.file(join(root, 'docker', 'compose.yaml')).text())?.[1]
if (!image) throw new Error('docker/compose.yaml names no caddy image')

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })

/** Why this suite cannot run here, or `null`. */
function unavailable(): string | null {
  let info
  try {
    info = docker('info', '--format', '{{.ServerVersion}}')
  } catch {
    return 'the docker command is not installed'
  }
  if (info.exitCode !== 0) return 'docker does not work for this user'
  if (docker('image', 'inspect', image!).exitCode !== 0)
    return `the image ${image} is not present (docker pull ${image})`
  return null
}

const reason = unavailable()
// CI pulls the image first, so a missing one there is a failure, not a skip.
if (reason && process.env.CI) throw new Error(`caddy-vnc.test.ts cannot run in CI: ${reason}`)
if (reason) console.warn(`caddy-vnc.test.ts skipped: ${reason}`)
const suite = reason ? describe.skip : describe

afterAll(dropAllTestDbs, 60_000)

// --- Fixture ---------------------------------------------------------------------------------------------------------

// Caddy runs on the host network so the fakes can listen on loopback addresses of their own. Every address is drawn from
// 127.0.0.0/8 at random, so a developer's own server on port 3000 or 6080 is not in the way.
const net = `127.${randomInt(100, 250)}.${randomInt(1, 250)}`
const WEB_IP = `${net}.1`
const PUBLIC_IP = `${net}.2`
const NTFY_IP = `${net}.3`
const OWN_IP = `${net}.4`
const OTHER_IP = `${net}.5`
const DECOY_IP = `${net}.6`

type Hit = { path: string; headers: Headers }

type FakeWorker = { hits: Hit[]; stop(): void }

/** A noVNC stand-in: upgrades only `/websockify`, records what it was asked for, and echoes messages. */
function fakeWorker(hostname: string): FakeWorker {
  const hits: Hit[] = []
  const server = Bun.serve<undefined>({
    hostname,
    port: 6080,
    fetch(request, server) {
      const url = new URL(request.url)
      hits.push({ path: url.pathname + url.search, headers: request.headers })
      if (url.pathname === '/websockify' && server.upgrade(request, { data: undefined })) return undefined
      return new Response('not a websocket', { status: 400 })
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`)
      }
    }
  })
  return { hits, stop: () => void server.stop(true) }
}

const cookieName = 'tm_test_user'

type Raw = { status: number; headers: Headers }

/** Sends one hand-written HTTP/1.1 request and reads the response head, so no client normalises the path or headers. */
async function raw(port: number, target: string, headers: Record<string, string>, upgrade = true): Promise<Raw> {
  const lines = [`GET ${target} HTTP/1.1`, `Host: ${PUBLIC_IP}:${port}`, 'Connection: close']
  if (upgrade) {
    lines[2] = 'Connection: Upgrade'
    lines.push(
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`
    )
  }
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  const request = lines.join('\r\n') + '\r\n\r\n'
  return await new Promise<Raw>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`no response to ${target}`)), 10_000)
    void Bun.connect({
      hostname: PUBLIC_IP,
      port,
      socket: {
        open: (socket) => void socket.write(request),
        data(socket, chunk) {
          text += Buffer.from(chunk).toString('latin1')
          const end = text.indexOf('\r\n\r\n')
          if (end < 0) return
          clearTimeout(timer)
          const [status, ...rest] = text.slice(0, end).split('\r\n')
          const parsed = new Headers()
          for (const line of rest) {
            const colon = line.indexOf(':')
            parsed.append(line.slice(0, colon), line.slice(colon + 1).trim())
          }
          socket.end()
          resolve({ status: Number(status!.split(' ')[1]), headers: parsed })
        },
        error: (_socket, error) => reject(error),
        connectError: (_socket, error) => reject(error)
      }
    })
  })
}

type Fixture = {
  db: Db
  port: number
  origin: string
  ownerCookie: string
  otherCookie: string
  ownSession: string
  otherSession: string
  own: FakeWorker
  other: FakeWorker
  decoy: FakeWorker
  web: { hits: Hit[] }
  stop(): Promise<void>
}

async function seedSession(db: Db, memberId: string, identityId: string, host: 'tm-signin' | 'tm-worker') {
  const [row] = await db
    .insert(signinSessions)
    .values({
      memberId,
      identityId,
      mode: 'container',
      state: 'ready',
      controlTokenHash: 'a'.repeat(64),
      lastHeartbeatAt: new Date()
    })
    .returning()
  const upstream = `${host}-${row!.id}:6080`
  await db.update(signinSessions).set({ upstream }).where(eq(signinSessions.id, row!.id))
  await db
    .update(profiles)
    .set({ heldBy: `signin:${row!.id}` })
    .where(eq(profiles.identityId, identityId))
  return { id: row!.id, upstream }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port!
  await probe.stop(true)
  return port
}

async function listening(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const up = await new Promise<boolean>((resolve) => {
      void Bun.connect({
        hostname: PUBLIC_IP,
        port,
        socket: {
          open: (s) => (s.end(), resolve(true)),
          data() {},
          error: () => resolve(false),
          connectError: () => resolve(false)
        }
      }).catch(() => resolve(false))
    })
    if (up) return true
    await Bun.sleep(100)
  }
  return false
}

const savedPublicUrl = process.env.TM_PUBLIC_URL
let f: Fixture
const containers: string[] = []

beforeAll(async () => {
  if (reason) return
  // Caddy's admin endpoint listens on localhost:2019, which on the host network is shared with everything else there.
  const adminBusy = await new Promise<boolean>((resolve) => {
    void Bun.connect({
      hostname: '127.0.0.1',
      port: 2019,
      socket: {
        open: (s) => (s.end(), resolve(true)),
        data() {},
        error: () => resolve(false),
        connectError: () => resolve(false)
      }
    }).catch(() => resolve(false))
  })
  if (adminBusy) throw new Error('port 2019 (the Caddy admin endpoint) is in use on this host; stop that Caddy first')

  const db = await createTestDb()
  const owner = await seedMember(db, { full: false })
  const other = await seedMember(db, { full: false })
  const ownerUser = await seedAuthUser(db)
  const otherUser = await seedAuthUser(db)
  await db.update(schema.members).set({ authUserId: ownerUser }).where(eq(schema.members.id, owner.memberId))
  await db.update(schema.members).set({ authUserId: otherUser }).where(eq(schema.members.id, other.memberId))
  const ownSession = await seedSession(db, owner.memberId, owner.identityId, 'tm-signin')
  const otherSession = await seedSession(db, other.memberId, other.identityId, 'tm-worker')

  const port = await freePort()
  const origin = `http://${PUBLIC_IP}:${port}`
  // authoriseVnc compares Origin with this.
  process.env.TM_PUBLIC_URL = origin

  const web: { hits: Hit[] } = { hits: [] }
  const webServer = Bun.serve({
    hostname: WEB_IP,
    port: 3000,
    async fetch(request) {
      const url = new URL(request.url)
      web.hits.push({ path: url.pathname, headers: request.headers })
      if (url.pathname !== '/api/vnc/authorize') return new Response('the website', { status: 200 })
      const cookie = new RegExp(`${cookieName}=([0-9a-f]+)`).exec(request.headers.get('cookie') ?? '')?.[1]
      return authoriseVncRequest(request, { db, getSession: async () => (cookie ? { userId: cookie } : null) })
    }
  })
  const own = fakeWorker(OWN_IP)
  const otherWorker = fakeWorker(OTHER_IP)
  const decoy = fakeWorker(DECOY_IP)

  const name = `tm-caddy-vnc-test-${process.pid}-${port}`
  containers.push(name)
  const run = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '-e',
    `TM_PUBLIC_URL=${origin}`,
    '-e',
    `NTFY_URL=http://${NTFY_IP}:${port}`,
    '--add-host',
    `web:${WEB_IP}`,
    '--add-host',
    `${ownSession.upstream.replace(/:6080$/, '')}:${OWN_IP}`,
    '--add-host',
    `${otherSession.upstream.replace(/:6080$/, '')}:${OTHER_IP}`,
    // A valid-looking upstream that only an attacker's header could name.
    '--add-host',
    `tm-worker-0badc0de-0001:${DECOY_IP}`,
    '-v',
    `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    image!
  )
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`)
  if (!(await listening(port, 20_000))) {
    throw new Error(`Caddy did not start:\n${docker('logs', name).stderr.toString().slice(-2000)}`)
  }

  f = {
    db,
    port,
    origin,
    ownerCookie: `${cookieName}=${ownerUser}`,
    otherCookie: `${cookieName}=${otherUser}`,
    ownSession: ownSession.id,
    otherSession: otherSession.id,
    own,
    other: otherWorker,
    decoy,
    web,
    stop: async () => {
      docker('rm', '-f', name)
      await webServer.stop(true)
      own.stop()
      otherWorker.stop()
      decoy.stop()
    }
  }
}, 60_000)

afterAll(async () => {
  if (savedPublicUrl === undefined) delete process.env.TM_PUBLIC_URL
  else process.env.TM_PUBLIC_URL = savedPublicUrl
  if (f) await f.stop()
  else for (const name of containers) docker('rm', '-f', name)
})

const path = (session: string) => `/vnc/${session}/websockify`
const total = () => f.own.hits.length + f.other.hits.length + f.decoy.hits.length

// --- The contract ----------------------------------------------------------------------------------------------------

suite('the remote view through Caddy', () => {
  test('the Caddyfile validates', () => {
    const result = docker(
      'run',
      '--rm',
      '-e',
      'TM_PUBLIC_URL=https://tm.example',
      '-e',
      'NTFY_URL=https://ntfy.tm.example',
      '-v',
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      image!,
      'caddy',
      'validate',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile'
    )
    expect(result.stdout.toString() + result.stderr.toString()).toContain('Valid configuration')
    expect(result.exitCode).toBe(0)
  })

  test('the owner reaches their own session: 101, the worker gets the path without /vnc/<id>, and frames flow', async () => {
    const before = f.own.hits.length
    const ws = new WebSocket(`ws://${PUBLIC_IP}:${f.port}${path(f.ownSession)}?a=1`, {
      headers: { cookie: f.ownerCookie, origin: f.origin }
    } as never)
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send('hello')
      ws.onmessage = (event) => resolve(String(event.data))
      ws.onerror = () => reject(new Error('the WebSocket was refused'))
    })
    ws.close()
    expect(echoed).toBe('echo:hello')
    expect(f.own.hits.length).toBe(before + 1)
    expect(f.own.hits.at(-1)!.path).toBe('/websockify?a=1')
  })

  test('another member’s session is 403 and never reaches its worker', async () => {
    const before = total()
    const r = await raw(f.port, path(f.otherSession), { Cookie: f.ownerCookie, Origin: f.origin })
    expect(r.status).toBe(403)
    expect(total()).toBe(before)
  })

  test('no session cookie is 401', async () => {
    const before = total()
    expect((await raw(f.port, path(f.ownSession), { Origin: f.origin })).status).toBe(401)
    expect((await raw(f.port, path(f.ownSession), { Origin: f.origin, Cookie: `${cookieName}=` })).status).toBe(401)
    expect(total()).toBe(before)
  })

  test('a session that is not ready is 403', async () => {
    const before = total()
    await f.db.update(signinSessions).set({ state: 'starting' }).where(eq(signinSessions.id, f.ownSession))
    try {
      expect((await raw(f.port, path(f.ownSession), { Cookie: f.ownerCookie, Origin: f.origin })).status).toBe(403)
    } finally {
      await f.db.update(signinSessions).set({ state: 'ready' }).where(eq(signinSessions.id, f.ownSession))
    }
    expect(total()).toBe(before)
  })

  test('a client cannot choose the upstream or the path that is authorised', async () => {
    // 1. A client-sent X-Vnc-Upstream does not move the proxy off the upstream the website named.
    const decoyBefore = f.decoy.hits.length
    const ownBefore = f.own.hits.length
    const named = await raw(f.port, path(f.ownSession), {
      Cookie: f.ownerCookie,
      Origin: f.origin,
      'X-Vnc-Upstream': 'tm-worker-0badc0de-0001:6080'
    })
    expect(named.status).toBe(101)
    expect(f.decoy.hits.length).toBe(decoyBefore)
    expect(f.own.hits.length).toBe(ownBefore + 1)

    // 2. It does not turn a refusal into a proxy either.
    const refused = await raw(f.port, path(f.otherSession), {
      Cookie: f.ownerCookie,
      Origin: f.origin,
      'X-Vnc-Upstream': 'tm-worker-0badc0de-0001:6080'
    })
    expect(refused.status).toBe(403)
    const anonymous = await raw(f.port, path(f.ownSession), {
      Origin: f.origin,
      'X-Vnc-Upstream': 'tm-worker-0badc0de-0001:6080'
    })
    expect(anonymous.status).toBe(401)

    // 3. A client-sent X-Forwarded-Uri does not change which session is checked: Caddy sets it from the real request.
    const otherBefore = f.other.hits.length
    const forged = await raw(f.port, path(f.otherSession), {
      Cookie: f.ownerCookie,
      Origin: f.origin,
      'X-Forwarded-Uri': path(f.ownSession),
      'X-Forwarded-Method': 'GET'
    })
    expect(forged.status).toBe(403)
    expect(f.other.hits.length).toBe(otherBefore)
    expect(f.decoy.hits.length).toBe(decoyBefore)
  })

  test('paths that try to escape /vnc/<id>/websockify are 403 and reach no worker', async () => {
    const before = total()
    for (const target of [
      `/VNC/${f.ownSession}/websockify`,
      `//vnc/${f.ownSession}/websockify`,
      `/vnc//${f.ownSession}/websockify`,
      `/vnc/${f.ownSession}/%2e%2e/%2e%2e/admin`,
      `/vnc/${f.ownSession}/../../admin`,
      `/vnc/${f.ownSession}/websockify/../../../api/health`,
      `/vnc/${f.ownSession.toUpperCase()}/websockify`,
      `/vnc/${f.ownSession}/websockify/extra`
    ]) {
      const r = await raw(f.port, target, { Cookie: f.ownerCookie, Origin: f.origin })
      expect([target, r.status]).toEqual([target, 403])
    }
    expect(total()).toBe(before)
  })

  test('a wrong Origin is 403, and so is an upgrade with no Origin', async () => {
    const before = total()
    for (const origin of ['https://evil.example', 'null', f.origin + '.evil.example', `${f.origin}/`]) {
      const r = await raw(f.port, path(f.ownSession), { Cookie: f.ownerCookie, Origin: origin })
      expect([origin, r.status]).toEqual([origin, 403])
    }
    expect((await raw(f.port, path(f.ownSession), { Cookie: f.ownerCookie })).status).toBe(403)
    expect(total()).toBe(before)
  })

  test('the website is served with security headers and its authorisation route is not public', async () => {
    const before = f.web.hits.length
    const home = await fetch(`${f.origin}/`)
    expect(home.status).toBe(200)
    expect(home.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
    expect(home.headers.get('x-content-type-options')).toBe('nosniff')
    expect(home.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(home.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(f.web.hits.length).toBe(before + 1)

    for (const target of ['/api/vnc/authorize', '/api/vnc/authorize/', '/API/vnc/authorize', '//api/vnc/authorize']) {
      const r = await fetch(`${f.origin}${target}`, { headers: { cookie: f.ownerCookie } })
      expect([target, r.status]).toEqual([target, 404])
    }
    expect(f.web.hits.length).toBe(before + 1)
  })
})
