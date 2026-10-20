import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { deviceTokens, occurrences, type Db } from '../db'
import { claimJob, createCompanionJob } from '../db/companion'
import { localRunPayload, seedCompanionFixture } from '../db/companion.fixtures'
import { createTestDb, dropAllTestDbs, testDbUrl, TEST_MASTER } from '../db/testing'
import { newDeviceToken } from '../lib/companion/tokens'
import { buildSite, startSite } from './e2e/serve'

// A local run's 12 MB chunk through the production path: the real docker/caddy/Caddyfile in the Caddy image named in
// docker/compose.yaml, in front of the real site built and started by `next start` over a scratch database. The upload
// route is excluded from `proxy.ts`, so its body must arrive whole; a route the proxy runs on must not take it.
// It needs Docker and that image, and skips with a message when either is missing (CI pulls the image first).

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
if (reason && process.env.CI) throw new Error(`caddy-upload.test.ts cannot run in CI: ${reason}`)
if (reason) console.warn(`caddy-upload.test.ts skipped: ${reason}`)
const suite = reason ? describe.skip : describe

afterAll(dropAllTestDbs, 60_000)

/** Next buffers a proxied body up to 10 MB (its default) and then cuts it: "Only the first 10MB will be available". */
const PROXY_BODY_LIMIT = 10 * 1024 * 1024
/** Bigger than that limit: the reason the upload routes are excluded from the proxy. */
const SIZE = 12 * 1024 * 1024

// Caddy runs on the host network so `next start` can listen on a loopback address of its own; every address is drawn
// from 127.0.0.0/8 at random, so a developer's own server on port 3000 is not in the way.
const net = `127.${randomInt(100, 250)}.${randomInt(1, 250)}`
const WEB_IP = `${net}.1`
const PUBLIC_IP = `${net}.2`
const NTFY_IP = `${net}.3`

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port!
  await probe.stop(true)
  return port
}

async function listening(hostname: string, port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const up = await new Promise<boolean>((resolve) => {
      void Bun.connect({
        hostname,
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

type Fixture = {
  db: Db
  port: number
  origin: string
  token: string
  jobId: string
  occurrenceId: string
  dataRoot: string
  web: ReturnType<typeof startSite>
}

let f: Fixture | undefined
const containers: string[] = []
let keyFile: string | undefined
let distDir: string | undefined

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
  const fixture = await seedCompanionFixture(db)
  // seedCompanionFixture stores only a random hash, so no real token exists. Give its first device a token this test
  // knows, the way pairing would.
  const { token, hash } = newDeviceToken()
  await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fixture.a1.deviceId))
  // A local run's upload is accepted only while its occurrence is running (as `local-runs.test.ts` seeds it).
  await db.update(occurrences).set({ state: 'starting' }).where(eq(occurrences.id, fixture.occA))
  await db.execute(sql`update device_tokens set last_used_at = now() where id = ${fixture.a1.deviceId}`)
  const payload = localRunPayload(fixture.occA)
  const jobId = await createCompanionJob(db, {
    memberId: fixture.a1.memberId,
    occurrenceId: fixture.occA,
    kind: 'local_run',
    payload,
    targetDeviceId: fixture.a1.deviceId
  })
  const claimed = await claimJob(db, fixture.a1, jobId)
  if (claimed === null || claimed === 'conflict') throw new Error('the seeded local_run job was not claimed')

  const port = await freePort()
  const origin = `http://${PUBLIC_IP}:${port}`
  const dataRoot = mkdtempSync(join(tmpdir(), 'tm-web-caddy-upload-'))
  keyFile = join(tmpdir(), `tm-web-caddy-upload-key-${randomBytes(4).toString('hex')}`)
  writeFileSync(keyFile, TEST_MASTER.toString('base64'), { mode: 0o600 })
  // A dist folder of its own: another build in this checkout (the browser specs) must not share it.
  const dist = `node_modules/.cache/tm-caddy-upload-${process.pid}`
  distDir = join(root, 'packages', 'web', dist)
  const env = {
    ...process.env,
    DATABASE_URL: testDbUrl(db),
    TM_PUBLIC_URL: origin,
    GITHUB_CLIENT_ID: 'e2e-client-id',
    GITHUB_CLIENT_SECRET: 'e2e-client-secret',
    GITHUB_ORG: 'tolonglabs',
    TM_MASTER_KEY_FILE: keyFile,
    TM_DATA_ROOT: dataRoot,
    NTFY_URL: `http://${NTFY_IP}:${port}`,
    NTFY_ADMIN_TOKEN: 'e2e-ntfy-admin',
    TM_NEXT_DIST_DIR: dist
  }

  await buildSite(env)
  const web = startSite(3000, env, WEB_IP)
  if (!(await listening(WEB_IP, 3000, 120_000))) {
    web.kill()
    await web.exited
    throw new Error('next start did not listen on its loopback address')
  }

  const name = `tm-caddy-upload-test-${process.pid}-${port}`
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
    '-v',
    `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    image!
  )
  if (run.exitCode !== 0) {
    web.kill()
    await web.exited
    throw new Error(`docker run failed: ${run.stderr.toString()}`)
  }
  if (!(await listening(PUBLIC_IP, port, 20_000))) {
    throw new Error(`Caddy did not start:\n${docker('logs', name).stderr.toString().slice(-2000)}`)
  }

  f = { db, port, origin, token, jobId, occurrenceId: fixture.occA, dataRoot, web }
}, 600_000)

afterAll(async () => {
  if (f) {
    f.web.kill()
    await f.web.exited
    rmSync(f.dataRoot, { recursive: true, force: true })
  }
  for (const name of containers) docker('rm', '-f', name)
  if (keyFile) rmSync(keyFile, { force: true })
  if (distDir) rmSync(distDir, { recursive: true, force: true })
})

const uploadUrl = (path: string) => `${f!.origin}/api/companion/jobs/${f!.jobId}/files/${path}`

suite('a 12 MB upload through Caddy and the real site', () => {
  test('the excluded upload route takes the whole chunk', async () => {
    const body = randomBytes(SIZE)
    expect(SIZE).toBeGreaterThan(PROXY_BODY_LIMIT)
    const response = await fetch(uploadUrl('recording/meeting.mkv'), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${f!.token}`,
        'content-range': `bytes 0-${SIZE - 1}/${SIZE}`,
        'content-type': 'application/octet-stream'
      },
      body
    })
    expect(response.status).toBe(204)

    const stored = readFileSync(join(f!.dataRoot, 'occurrences', f!.occurrenceId, 'recording', 'meeting.mkv'))
    expect(stored.length).toBe(SIZE)
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(body).digest('hex'))
  }, 120_000)

  test('the same body to a route the proxy runs on is refused', async () => {
    // Not excluded from `proxy.ts`: Next cuts the body at 10 MB (it logs "Only the first 10MB will be available"), and
    // the heartbeat route's own 1 MB cap, with the declared 12 MB length still in the header, refuses what is left. So
    // it is refused with 400, not stored or silently accepted.
    const response = await fetch(`${f!.origin}/api/companion/jobs/${f!.jobId}/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f!.token}`, 'content-type': 'application/octet-stream' },
      body: randomBytes(SIZE)
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid request' })
  }, 120_000)
})
