import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER_IMAGE, containerName, containerSpec, serveGate } from '../src/index'

const cfg = {
  dataRoot: '/srv/tolongmeeting/data',
  profileRoot: '/srv/tolongmeeting/profiles',
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example'
}
const occ = '11111111-1111-4111-8111-111111111111'
const idn = '22222222-2222-4222-8222-222222222222'
const spec = { kind: 'worker', occurrenceId: occ, attempt: 1, identityId: idn, env: cfg } as const
const signinName = `tm-signin-${occ}`
const FULL_ID = 'a'.repeat(64)

// A stand-in Docker daemon on a Unix socket and the gate served by Bun on a real port, so the gate's URL handling,
// body limit, forwarding and inspection all run for real.
type Seen = { method: string; path: string; body: string }
type Container = { role?: string; image: string; privileged: boolean; name: string; running?: boolean }
let seen: Seen[] = []
let target: Container
let dir: string
let daemon: ReturnType<typeof Bun.serve>
let gate: ReturnType<typeof Bun.serve>
let deadGate: ReturnType<typeof Bun.serve>
let lines: string[] = []
let base: string

const workerContainer = (): Container => ({
  role: 'worker',
  image: WORKER_IMAGE,
  privileged: false,
  name: `/${containerName(spec)}`
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-gate-'))
  const socketPath = join(dir, 'docker.sock')
  daemon = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const u = new URL(req.url)
      seen.push({ method: req.method, path: u.pathname + u.search, body: await req.text() })
      const path = u.pathname.replace(/^\/v[0-9.]+/, '')
      if (path === '/_ping') return new Response(req.method === 'HEAD' ? null : 'OK')
      if (path === '/containers/create') return Response.json({ Id: FULL_ID }, { status: 201 })
      if (path === '/containers/missing/json') return Response.json({ message: 'No such container' }, { status: 404 })
      if (path === '/containers/badjson/json') return new Response('garbage-from-docker', { status: 200 })
      if (path.endsWith('/json')) {
        return Response.json({
          Id: FULL_ID,
          Name: target.name,
          Config: { Image: target.image, Labels: target.role ? { 'tm.role': target.role } : {} },
          HostConfig: { Privileged: target.privileged },
          State: target.running === undefined ? {} : { Running: target.running }
        })
      }
      return new Response(null, { status: 204 })
    }
  })
  const log = (line: string) => lines.push(line)
  gate = serveGate({ ...cfg, socketPath, log, port: 0, hostname: '127.0.0.1' })
  deadGate = serveGate({ ...cfg, socketPath: join(dir, 'nothing.sock'), log, port: 0, hostname: '127.0.0.1' })
  base = `http://127.0.0.1:${gate.port}`
})
afterAll(() => {
  void gate.stop(true)
  void deadGate.stop(true)
  void daemon.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  seen = []
  lines = []
  target = workerContainer()
})

const get = (path: string, method = 'GET') => fetch(`${base}${path}`, { method })
const post = (path: string, body?: string) => fetch(`${base}${path}`, { method: 'POST', body })
const calls = () => seen.map((s) => `${s.method} ${s.path}`)

/** Sends the request line exactly as written, with no client-side URL clean-up, and returns the status code. */
function raw(requestLine: string, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(gate.port!, '127.0.0.1', () => {
      sock.write(`${requestLine}\r\nHost: gate\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
    })
    let data = ''
    sock.on('data', (d) => (data += d))
    sock.on('end', () => resolve(Number(data.split(' ')[1])))
    sock.on('error', reject)
  })
}

test('a ping and a valid create reach the daemon', async () => {
  expect(await (await get('/v1.47/_ping')).text()).toBe('OK')
  const res = await post(`/v1.47/containers/create?name=${containerName(spec)}`, JSON.stringify(containerSpec(spec)))
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({ Id: FULL_ID })
  expect(calls()).toEqual(['GET /v1.47/_ping', `POST /v1.47/containers/create?name=${containerName(spec)}`])
  expect(JSON.parse(seen[1]!.body)).toEqual(containerSpec(spec))
})

test('HEAD /_ping is forwarded as HEAD', async () => {
  const res = await get('/_ping', 'HEAD')
  expect(res.status).toBe(200)
  expect(calls()).toEqual(['HEAD /_ping'])
})

test('a refused create never reaches the daemon and its body is not logged', async () => {
  const body: any = containerSpec(spec)
  body.HostConfig.Privileged = true
  body.Env.push('SENTINEL=do-not-log')
  const res = await post(`/containers/create?name=${containerName(spec)}`, JSON.stringify(body))
  expect(res.status).toBe(403)
  expect(seen).toEqual([])
  expect(lines.join('\n')).toContain('POST /containers/create')
  expect(lines.join('\n')).not.toContain('SENTINEL')
})

test('a create with a URL other than the configured one is refused', async () => {
  const other = containerSpec({ ...spec, env: { ...cfg, publicUrl: 'https://evil.example' } })
  const res = await post(`/containers/create?name=${containerName(spec)}`, JSON.stringify(other))
  expect(res.status).toBe(403)
  expect(seen).toEqual([])
})

test('endpoints outside the list get 403 endpoint not allowed', async () => {
  for (const [method, path] of [
    ['GET', '/info'],
    ['POST', `/containers/${FULL_ID}/exec`],
    ['DELETE', `/containers/${FULL_ID}/json`],
    ['GET', '/v1.40/_ping'],
    ['GET', '/v1.52/_ping']
  ] as const) {
    const res = await get(path, method)
    expect(res.status).toBe(403)
    expect((await res.json()) as unknown).toEqual({ message: 'endpoint not allowed' })
  }
  expect(seen).toEqual([])
})

test.each([
  'GET /containers/../images/json HTTP/1.1',
  'GET /v1.47/containers/x/../../../info HTTP/1.1',
  'GET /containers/%2e%2e/images/json HTTP/1.1',
  'GET /containers/%2E%2E/json HTTP/1.1',
  'POST /containers/%2e%2e/start HTTP/1.1',
  'GET /containers/x%2fy/json HTTP/1.1',
  'GET /containers\\..\\images\\json HTTP/1.1',
  'GET //containers/json HTTP/1.1',
  'GET http://evil.example/containers/json HTTP/1.1',
  'GET /containers/json?all=1 HTTP/1.1',
  'GET /containers/./json HTTP/1.1'
])('raw request %s never reaches the daemon', async (line) => {
  const status = await raw(line)
  expect(status).toBeGreaterThanOrEqual(400)
  expect(status).toBeLessThan(500)
  expect(seen).toEqual([])
})

test('a dot-segment path is cleaned before the check, and the daemon sees the clean path', async () => {
  const status = await raw(`GET /v1.47/images/../containers/${FULL_ID}/json HTTP/1.1`)
  expect(status).toBe(200)
  expect(calls()).toEqual([`GET /containers/${FULL_ID}/json`])
})

test('a body that is not JSON gets 400 and a body over 64 KiB is refused', async () => {
  expect((await post(`/containers/create?name=${containerName(spec)}`, '{nope')).status).toBe(400)
  expect((await post(`/containers/create?name=${containerName(spec)}`, 'x'.repeat(70_000))).status).toBe(413)
  expect(seen).toEqual([])
})

test.each(['start', 'stop?t=60'])('%s of a worker is forwarded by full container id', async (action) => {
  const res = await post(`/v1.47/containers/${containerName(spec)}/${action}`)
  expect(res.status).toBe(204)
  expect(calls()).toEqual([
    `GET /containers/${containerName(spec)}/json`,
    `POST /v1.47/containers/${FULL_ID}/${action}`
  ])
})

test.each(['start', 'stop?t=60'])('a client body sent with %s is dropped', async (action) => {
  const res = await post(
    `/containers/${containerName(spec)}/${action}`,
    JSON.stringify({ HostConfig: { Privileged: true } })
  )
  expect(res.status).toBe(204)
  const forwarded = seen.at(-1)!
  expect(forwarded.method).toBe('POST')
  expect(forwarded.body).toBe('')
})

test('remove of a stopped worker is forwarded by full id, as a bare DELETE', async () => {
  target.running = false
  const res = await fetch(`${base}/v1.47/containers/${containerName(spec)}`, { method: 'DELETE' })
  expect(res.status).toBe(204)
  expect(calls()).toEqual([`GET /containers/${containerName(spec)}/json`, `DELETE /v1.47/containers/${FULL_ID}`])
})

test('a stopped sign-in container may be removed', async () => {
  target = { ...workerContainer(), role: 'signin', name: `/${signinName}`, running: false }
  expect((await get(`/containers/${FULL_ID}`, 'DELETE')).status).toBe(204)
  expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/containers/${FULL_ID}` })
})

test.each([
  ['running', true],
  ['no state in the answer', undefined]
])('remove of a container that is %s is refused and never deleted', async (_n, running) => {
  target.running = running
  const res = await get(`/containers/${FULL_ID}`, 'DELETE')
  expect(res.status).toBe(403)
  expect((await res.json()) as unknown).toEqual({ message: 'container is not stopped' })
  expect(seen.filter((s) => s.method === 'DELETE')).toEqual([])
  expect(lines.join('\n')).toContain('refused: container is not stopped')
})

test.each(['force=1', 'force=true', 'v=1', 'link=1', 'x=y'])('remove with the query %s is refused', async (query) => {
  target.running = false
  const res = await get(`/containers/${FULL_ID}?${query}`, 'DELETE')
  expect(res.status).toBe(403)
  expect(seen).toEqual([])
})

test('remove of a missing container gives 404 and no DELETE', async () => {
  const res = await get('/containers/missing', 'DELETE')
  expect(res.status).toBe(404)
  expect(seen.filter((s) => s.method === 'DELETE')).toEqual([])
})

test('a sign-in container may be started', async () => {
  target = { ...workerContainer(), role: 'signin', name: `/${signinName}` }
  expect((await post(`/containers/${signinName}/start`)).status).toBe(204)
})

const refusals: [string, (c: Container) => void][] = [
  ['no role label', (c) => (c.role = undefined)],
  ['another role', (c) => (c.role = 'other')],
  ['an upper-case role', (c) => (c.role = 'WORKER')],
  ['another image', (c) => (c.image = 'alpine')],
  ['another tag of the worker image', (c) => (c.image = 'tolongmeeting/worker:latest')],
  ['privileged mode', (c) => (c.privileged = true)],
  ['a name outside the patterns', (c) => (c.name = '/postgres')],
  ['a sign-in name under the worker role', (c) => (c.name = `/${signinName}`)],
  ['a worker name under the sign-in role', (c) => (c.role = 'signin')]
]
test.each(refusals)('start, stop and inspect of a container with %s are refused', async (_n, mutate) => {
  mutate(target)
  for (const res of [
    await post(`/containers/${FULL_ID}/start`),
    await post(`/containers/${FULL_ID}/stop`),
    await get(`/containers/${FULL_ID}/json`)
  ]) {
    expect(res.status).toBe(403)
  }
  expect(seen.every((s) => s.method === 'GET')).toBe(true)
})

test.each(refusals)('remove of a stopped container with %s is refused', async (_n, mutate) => {
  target.running = false
  mutate(target)
  const res = await get(`/containers/${FULL_ID}`, 'DELETE')
  expect(res.status).toBe(403)
  expect(seen.every((s) => s.method === 'GET')).toBe(true)
})

test('inspect of a managed container returns the daemon answer; a missing container gives 404', async () => {
  const ok = await get(`/containers/${FULL_ID}/json`)
  expect(ok.status).toBe(200)
  expect(((await ok.json()) as { Id: string }).Id).toBe(FULL_ID)
  const missing = await get('/containers/missing/json')
  expect(missing.status).toBe(404)
  expect(seen.filter((s) => s.method !== 'GET')).toEqual([])
})

test('an unreachable Docker gives a bare 502', async () => {
  for (const res of [
    await fetch(`http://127.0.0.1:${deadGate.port}/_ping`),
    await fetch(`http://127.0.0.1:${deadGate.port}/containers/${FULL_ID}/start`, { method: 'POST' })
  ]) {
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('bad gateway\n')
  }
})

test('an inspect answer that is not JSON gives a bare 502 with no detail', async () => {
  const res = await post('/containers/badjson/start')
  expect(res.status).toBe(502)
  expect(await res.text()).toBe('bad gateway\n')
  expect(lines.join('\n')).not.toContain('garbage-from-docker')
})

test('the gate refuses to start with an unusable URL', () => {
  expect(() => serveGate({ ...cfg, publicUrl: 'tm.example', socketPath: '/x', log: () => {}, port: 0 })).toThrow()
})
