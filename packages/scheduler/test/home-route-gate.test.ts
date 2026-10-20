import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOME_ROUTE_IMAGE,
  WORKER_IMAGE,
  buildSidecarBody,
  containerName,
  containerSpec,
  serveGate,
  sidecarName,
  validateRequest,
  type GateConfig,
  type SpecParams
} from '../src/index'

const VERSION = '1.102.5'
const cfg: GateConfig = {
  dataRoot: '/srv/tolongmeeting/data',
  profileRoot: '/srv/tolongmeeting/profiles',
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example',
  tailscaleVersion: VERSION
}
const occ = '11111111-1111-4111-8111-111111111111'
const other = '99999999-9999-4999-8999-999999999999'
const idn = '22222222-2222-4222-8222-222222222222'
const HOST = 'tm-home-0123456789abcdef01234567'
const name = sidecarName(occ)
const worker: SpecParams = { kind: 'worker', occurrenceId: occ, attempt: 1, identityId: idn, env: cfg }
const viaWorker: SpecParams = { ...worker, via: { sidecar: name } }

const sidecar = () =>
  buildSidecarBody({
    occurrenceId: occ,
    identityId: idn,
    exitNodeId: 'nHOME1CNTRL',
    exitNodeHostname: HOST,
    tailscaleVersion: VERSION,
    profileRoot: cfg.profileRoot,
    hosts: ['tm.example', 'ntfy.tm.example']
  })
const createSidecar = (body: unknown, n = name, c: GateConfig = cfg) =>
  validateRequest({ method: 'POST', path: `/v1.47/containers/create?name=${n}`, body }, c)
const createWorker = (body: unknown, p: SpecParams = viaWorker) =>
  validateRequest({ method: 'POST', path: `/containers/create?name=${containerName(p)}`, body }, cfg)
const mutated = <T>(base: T, change: (b: any) => void): T => {
  const b: any = structuredClone(base)
  change(b)
  return b
}

describe('the sidecar the gate accepts', () => {
  test('exactly the fixed body', () => {
    expect(createSidecar(sidecar())).toEqual({ ok: true, kind: 'create' })
  })

  test.each([
    ['an extra capability', (b: any) => b.HostConfig.CapAdd.push('SYS_ADMIN')],
    ['NET_RAW instead of nothing extra', (b: any) => b.HostConfig.CapAdd.push('NET_RAW')],
    ['no capability drop', (b: any) => (b.HostConfig.CapDrop = [])],
    ['privileged', (b: any) => (b.HostConfig.Privileged = true)],
    ['host networking', (b: any) => (b.HostConfig.NetworkMode = 'host')],
    ['another network', (b: any) => (b.HostConfig.NetworkMode = 'bridge')],
    ['host pid', (b: any) => (b.HostConfig.PidMode = 'host')],
    ['an extra mount', (b: any) => b.HostConfig.Binds.push('/:/host')],
    ['the Docker socket', (b: any) => b.HostConfig.Binds.push('/var/run/docker.sock:/var/run/docker.sock')],
    ['a writable key mount', (b: any) => (b.HostConfig.Binds[0] = b.HostConfig.Binds[0].replace(':ro', ''))],
    ['another occurrence key file', (b: any) => (b.HostConfig.Binds[0] = b.HostConfig.Binds[0].replace(occ, other))],
    ['a key file outside .home-keys', (b: any) => (b.HostConfig.Binds[0] = `/etc/shadow:/run/tm/authkey:ro`)],
    [
      'a second device',
      (b: any) =>
        b.HostConfig.Devices.push({ PathOnHost: '/dev/mem', PathInContainer: '/dev/mem', CgroupPermissions: 'rwm' })
    ],
    ['another device', (b: any) => (b.HostConfig.Devices[0].PathOnHost = '/dev/kvm')],
    ['a Tailscale auth key in the environment', (b: any) => (b.Env[0] = 'TS_AUTHKEY=tskey-auth-abc')],
    ['an exit node on the command line', (b: any) => (b.Env[4] += ' --exit-node=100.1.1.1')],
    ['an extra environment variable', (b: any) => b.Env.push('TS_SOCKET=/var/run/tailscale/tailscaled.sock')],
    ['a command', (b: any) => (b.Cmd = ['sh'])],
    ['an entrypoint', (b: any) => (b.Entrypoint = ['sh'])],
    ['a user', (b: any) => (b.User = '0')],
    ['another image', (b: any) => (b.Image = 'alpine')],
    ['another version', (b: any) => (b.Image = `${HOME_ROUTE_IMAGE}:1.0.0`)],
    ['the latest tag', (b: any) => (b.Image = `${HOME_ROUTE_IMAGE}:latest`)],
    ['the worker image', (b: any) => (b.Image = WORKER_IMAGE)],
    ['a different hostname', (b: any) => (b.Hostname = 'tm-someone-else')],
    ['no memory limit', (b: any) => delete b.HostConfig.Memory],
    ['a relaxed health check', (b: any) => (b.Healthcheck.Test = ['NONE'])],
    ['no AutoRemove', (b: any) => (b.HostConfig.AutoRemove = false)],
    ['sysctls beyond IPv6', (b: any) => (b.HostConfig.Sysctls['net.ipv4.ip_forward'] = '1')]
  ])('refuses %s', (_label, change) => {
    const v = createSidecar(mutated(sidecar(), change))
    expect(v.ok).toBe(false)
  })

  test('refuses an exit node that is not a Tailscale id and a keyed home hostname', () => {
    expect(createSidecar(mutated(sidecar(), (b) => (b.Env[5] = 'TM_EXIT_NODE_ID=n1;rm'))).ok).toBe(false)
    expect(createSidecar(mutated(sidecar(), (b) => (b.Env[6] = 'TM_EXIT_NODE_HOSTNAME=my-laptop'))).ok).toBe(false)
    expect(createSidecar(mutated(sidecar(), (b) => b.Env.splice(5, 2))).ok).toBe(false)
  })

  test('refuses a name for another occurrence or in the worker form', () => {
    expect(createSidecar(sidecar(), sidecarName(other)).ok).toBe(false)
    expect(createSidecar(sidecar(), `tm-worker-${occ}-a1`).ok).toBe(false)
    expect(createSidecar(sidecar(), 'tm-home-x').ok).toBe(false)
  })

  test('is refused outright when the gate has no TAILSCALE_VERSION', () => {
    const v = createSidecar(sidecar(), name, { ...cfg, tailscaleVersion: undefined })
    expect(v).toEqual({ ok: false, reason: expect.stringContaining('not enabled') })
  })

  test('can be started, stopped, inspected and removed by name', () => {
    for (const [method, path, kind] of [
      ['POST', `/containers/${name}/start`, 'start'],
      ['POST', `/containers/${name}/stop?t=5`, 'stop'],
      ['GET', `/containers/${name}/json`, 'inspect'],
      ['DELETE', `/containers/${name}`, 'remove']
    ] as const) {
      expect(validateRequest({ method, path, body: null }, cfg)).toEqual({ ok: true, kind, id: name })
    }
  })
})

describe('the worker the gate accepts behind a sidecar', () => {
  test('the via body for its own sidecar, and the plain body, are the only two shapes', () => {
    expect(createWorker(containerSpec(viaWorker))).toEqual({ ok: true, kind: 'create' })
    expect(createWorker(containerSpec(worker), worker)).toEqual({ ok: true, kind: 'create' })
  })

  test.each([
    ['another occurrence sidecar', (b: any) => (b.HostConfig.NetworkMode = `container:${sidecarName(other)}`)],
    ['any other container', (b: any) => (b.HostConfig.NetworkMode = 'container:tm-worker-x')],
    ['the host network', (b: any) => (b.HostConfig.NetworkMode = 'host')],
    ['a capability', (b: any) => (b.HostConfig.CapAdd = ['NET_ADMIN'])],
    ['a device', (b: any) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/net/tun' }])],
    ['a hostname Docker would reject', (b: any) => (b.Hostname = `tm-${idn.slice(0, 20)}`)],
    ['DNS settings', (b: any) => (b.HostConfig.Dns = ['1.1.1.1'])],
    ['extra hosts', (b: any) => (b.HostConfig.ExtraHosts = ['tm.example:172.30.0.2'])],
    ['sysctls', (b: any) => (b.HostConfig.Sysctls = { 'net.ipv6.conf.all.disable_ipv6': '1' })],
    ['a Tailscale socket mount', (b: any) => b.HostConfig.Binds.push('/var/run/tailscale:/var/run/tailscale')],
    ['a Tailscale variable', (b: any) => b.Env.push('TS_SOCKET=/var/run/tailscale/tailscaled.sock')]
  ])('refuses %s', (_label, change) => {
    expect(createWorker(mutated(containerSpec(viaWorker), change)).ok).toBe(false)
  })

  test('a plain worker may not ask for a capability or for a sidecar namespace without the via body', () => {
    expect(
      createWorker(
        mutated(containerSpec(worker), (b) => (b.HostConfig.CapAdd = ['NET_ADMIN'])),
        worker
      ).ok
    ).toBe(false)
    // NetworkMode of the sidecar with the plain body's Hostname, Dns, ExtraHosts and Sysctls left in.
    expect(
      createWorker(
        mutated(containerSpec(worker), (b) => (b.HostConfig.NetworkMode = `container:${name}`)),
        worker
      ).ok
    ).toBe(false)
  })
})

// --- The gate in front of a Docker: the sidecar is managed, and only with the pinned image --------------------------

describe('the gate server and a sidecar container', () => {
  const FULL_ID = 'b'.repeat(64)
  let dir: string
  let daemon: ReturnType<typeof Bun.serve>
  let gate: ReturnType<typeof Bun.serve>
  let unpinned: ReturnType<typeof Bun.serve>
  let seen: string[] = []
  let image = `${HOME_ROUTE_IMAGE}:${VERSION}`

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tm-home-gate-'))
    const socketPath = join(dir, 'docker.sock')
    daemon = Bun.serve({
      unix: socketPath,
      fetch(req) {
        const u = new URL(req.url)
        seen.push(`${req.method} ${u.pathname}`)
        if (u.pathname.endsWith('/json')) {
          return Response.json({
            Id: FULL_ID,
            Name: `/${name}`,
            Config: { Image: image, Labels: { 'tm.role': 'sidecar' } },
            HostConfig: { Privileged: false },
            State: { Running: true }
          })
        }
        return new Response(null, { status: 204 })
      }
    })
    const log = () => {}
    gate = serveGate({ ...cfg, socketPath, log, port: 0, hostname: '127.0.0.1' })
    unpinned = serveGate({ ...cfg, tailscaleVersion: undefined, socketPath, log, port: 0, hostname: '127.0.0.1' })
  })
  afterAll(() => {
    void gate.stop(true)
    void unpinned.stop(true)
    void daemon.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    seen = []
    image = `${HOME_ROUTE_IMAGE}:${VERSION}`
  })

  test('stops the sidecar by its full id', async () => {
    const res = await fetch(`http://127.0.0.1:${gate.port}/containers/${name}/stop?t=5`, { method: 'POST' })
    expect(res.status).toBe(204)
    expect(seen).toEqual([`GET /containers/${name}/json`, `POST /containers/${FULL_ID}/stop`])
  })

  test('refuses a container with the sidecar label but another image', async () => {
    image = 'alpine:3'
    const res = await fetch(`http://127.0.0.1:${gate.port}/containers/${name}/stop?t=5`, { method: 'POST' })
    expect(res.status).toBe(403)
    expect(seen).toEqual([`GET /containers/${name}/json`])
  })

  test('refuses a sidecar when the gate has no pin', async () => {
    const res = await fetch(`http://127.0.0.1:${unpinned.port}/containers/${name}/stop?t=5`, { method: 'POST' })
    expect(res.status).toBe(403)
  })
})
