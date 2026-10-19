import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerName, containerSpec, createGate } from '../src/index'

const cfg = { dataRoot: '/srv/tolongmeeting/data', profileRoot: '/srv/tolongmeeting/profiles' }
const env = { ...cfg, publicUrl: 'https://tm.example', ntfyUrl: 'https://ntfy.tm.example' }
const occ = '11111111-1111-4111-8111-111111111111'
const idn = '22222222-2222-4222-8222-222222222222'
const spec = { kind: 'worker', occurrenceId: occ, attempt: 1, identityId: idn, env } as const
const FULL_ID = 'a'.repeat(64)

// A stand-in Docker daemon on a Unix socket, so the gate's own forwarding and inspection code runs for real.
type Seen = { method: string; path: string; body: string }
let seen: Seen[] = []
let roleLabel: string | undefined
let dir: string
let daemon: ReturnType<typeof Bun.serve>
let lines: string[] = []
let gate: (req: Request) => Promise<Response>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-gate-'))
  const socketPath = join(dir, 'docker.sock')
  daemon = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const u = new URL(req.url)
      seen.push({ method: req.method, path: u.pathname + u.search, body: await req.text() })
      const path = u.pathname.replace(/^\/v[0-9.]+/, '')
      if (path === '/_ping') return new Response('OK')
      if (path === '/containers/create') return Response.json({ Id: FULL_ID }, { status: 201 })
      if (path === '/containers/missing/json') return Response.json({ message: 'No such container' }, { status: 404 })
      if (path.endsWith('/json')) {
        return Response.json({ Id: FULL_ID, Config: { Labels: roleLabel ? { 'tm.role': roleLabel } : {} } })
      }
      return new Response(null, { status: 204 })
    }
  })
  gate = createGate({ ...cfg, socketPath, log: (line) => lines.push(line) })
})
afterAll(() => {
  void daemon.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  seen = []
  lines = []
  roleLabel = 'worker'
})

const post = (path: string, body?: string) => gate(new Request(`http://gate${path}`, { method: 'POST', body }))

test('a ping and a valid create reach the daemon', async () => {
  expect(await (await gate(new Request('http://gate/v1.47/_ping'))).text()).toBe('OK')
  const res = await post(`/v1.47/containers/create?name=${containerName(spec)}`, JSON.stringify(containerSpec(spec)))
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({ Id: FULL_ID })
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    'GET /v1.47/_ping',
    `POST /v1.47/containers/create?name=${containerName(spec)}`
  ])
  expect(JSON.parse(seen[1]!.body)).toEqual(containerSpec(spec))
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

test('endpoints outside the list get 403 endpoint not allowed', async () => {
  for (const [method, path] of [
    ['GET', '/info'],
    ['POST', `/containers/${FULL_ID}/exec`],
    ['DELETE', `/containers/${FULL_ID}`],
    ['GET', '/containers/%2e%2e/json']
  ] as const) {
    const res = await gate(new Request(`http://gate${path}`, { method }))
    expect(res.status).toBe(403)
    expect((await res.json()) as unknown).toEqual({ message: 'endpoint not allowed' })
  }
  expect(seen).toEqual([])
})

test('a body that is not JSON gets 400 and a huge body gets 413', async () => {
  expect((await post(`/containers/create?name=${containerName(spec)}`, '{nope')).status).toBe(400)
  expect((await post(`/containers/create?name=${containerName(spec)}`, 'x'.repeat(70_000))).status).toBe(413)
  expect(seen).toEqual([])
})

test.each(['start', 'stop?t=60'])('%s of a worker is forwarded by full container id', async (action) => {
  const res = await post(`/v1.47/containers/${containerName(spec)}/${action}`)
  expect(res.status).toBe(204)
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    `GET /containers/${containerName(spec)}/json`,
    `POST /v1.47/containers/${FULL_ID}/${action}`
  ])
})

test('a sign-in container may be started', async () => {
  roleLabel = 'signin'
  expect((await post(`/containers/${FULL_ID}/start`)).status).toBe(204)
})

test.each([undefined, 'other', 'WORKER'])(
  'start, stop and inspect of a container with role %s are refused',
  async (role) => {
    roleLabel = role
    for (const res of [
      await post(`/containers/${FULL_ID}/start`),
      await post(`/containers/${FULL_ID}/stop`),
      await gate(new Request(`http://gate/containers/${FULL_ID}/json`))
    ]) {
      expect(res.status).toBe(403)
    }
    expect(seen.every((s) => s.method === 'GET')).toBe(true)
  }
)

test('inspect of a managed container returns the daemon answer; a missing container gives 404', async () => {
  const ok = await gate(new Request(`http://gate/containers/${FULL_ID}/json`))
  expect(ok.status).toBe(200)
  expect(((await ok.json()) as { Id: string }).Id).toBe(FULL_ID)
  const missing = await gate(new Request('http://gate/containers/missing/json'))
  expect(missing.status).toBe(404)
  expect(seen.filter((s) => s.method !== 'GET')).toEqual([])
})
