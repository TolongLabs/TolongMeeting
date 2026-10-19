import { expect, test } from 'bun:test'
import { containerName, containerSpec, validateRequest, type SpecParams } from '../src/index'

const cfg = {
  dataRoot: '/srv/tolongmeeting/data',
  profileRoot: '/srv/tolongmeeting/profiles',
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example'
}
const env = cfg
const occ = '11111111-1111-4111-8111-111111111111'
const idn = '22222222-2222-4222-8222-222222222222'
const spec = { kind: 'worker', occurrenceId: occ, attempt: 1, identityId: idn, env } as const
const sign = { kind: 'signin', sessionId: occ, identityId: idn, env } as const

const createFor = (p: SpecParams, body: unknown, name = containerName(p)) =>
  validateRequest({ method: 'POST', path: `/v1.47/containers/create?name=${name}`, body }, cfg)
const create = (body: unknown) => createFor(spec, body)
const mutated = (mutate: (b: any) => void, p: SpecParams = spec) => {
  const b: any = structuredClone(containerSpec(p))
  mutate(b)
  return b
}

test('the fixed worker and sign-in specs pass', () => {
  expect(create(containerSpec(spec))).toEqual({ ok: true, kind: 'create' })
  expect(
    validateRequest(
      { method: 'POST', path: `/containers/create?name=${containerName(sign)}`, body: containerSpec(sign) },
      cfg
    )
  ).toEqual({ ok: true, kind: 'create' })
})

test.each([
  ['privileged', (b: any) => (b.HostConfig.Privileged = true)],
  ['another image', (b: any) => (b.Image = 'alpine')],
  ['a tag other than current', (b: any) => (b.Image = 'tolongmeeting/worker:latest')],
  ['an extra bind', (b: any) => b.HostConfig.Binds.push('/:/host')],
  ['a bind outside the roots', (b: any) => (b.HostConfig.Binds[0] = '/etc:/etc')],
  ['the data root itself as a bind', (b: any) => (b.HostConfig.Binds[0] = `${cfg.dataRoot}:${cfg.dataRoot}`)],
  ['the profile root itself as a bind', (b: any) => (b.HostConfig.Binds[1] = `${cfg.profileRoot}:${cfg.profileRoot}`)],
  [
    'a data bind climbing out with ..',
    (b: any) => (b.HostConfig.Binds[0] = `${cfg.dataRoot}/occurrences/${occ}/..:${cfg.dataRoot}/occurrences/${occ}/..`)
  ],
  [
    'a data bind with a doubled slash',
    (b: any) => (b.HostConfig.Binds[0] = `${cfg.dataRoot}//occurrences/${occ}:${cfg.dataRoot}//occurrences/${occ}`)
  ],
  [
    'a data bind with a trailing slash',
    (b: any) => (b.HostConfig.Binds[0] = `${cfg.dataRoot}/occurrences/${occ}/:${cfg.dataRoot}/occurrences/${occ}/`)
  ],
  [
    'a bind for another identity profile',
    (b: any) => {
      const other = '33333333-3333-4333-8333-333333333333'
      b.HostConfig.Binds[1] = `${cfg.profileRoot}/${other}:${cfg.profileRoot}/${other}`
    }
  ],
  ['a bind whose target differs', (b: any) => (b.HostConfig.Binds[1] = `${cfg.profileRoot}/${idn}:/root`)],
  ['a bind with options', (b: any) => (b.HostConfig.Binds[0] += ':rw')],
  ['a writable machine id', (b: any) => (b.HostConfig.Binds[2] = b.HostConfig.Binds[2].replace(':ro', ''))],
  ['a machine id from /etc/shadow', (b: any) => (b.HostConfig.Binds[2] = '/etc/shadow:/etc/machine-id:ro')],
  [
    'a machine id file inside the mounted profile directory',
    (b: any) => (b.HostConfig.Binds[2] = `${cfg.profileRoot}/${idn}/machine-id:/etc/machine-id:ro`)
  ],
  [
    'the machine id of another identity',
    (b: any) =>
      (b.HostConfig.Binds[2] = `${cfg.profileRoot}/.machine-ids/33333333-3333-4333-8333-333333333333:/etc/machine-id:ro`)
  ],
  ['a missing machine id bind', (b: any) => b.HostConfig.Binds.pop()],
  ['a mounts list', (b: any) => (b.HostConfig.Mounts = [{ Type: 'bind', Source: '/', Target: '/h' }])],
  ['volumes from another container', (b: any) => (b.HostConfig.VolumesFrom = ['other'])],
  ['a top-level Volumes entry', (b: any) => (b.Volumes = { '/x': {} })],
  ['added capabilities', (b: any) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
  ['capabilities not dropped', (b: any) => (b.HostConfig.CapDrop = [])],
  ['no-new-privileges removed', (b: any) => (b.HostConfig.SecurityOpt = ['seccomp=unconfined'])],
  ['an apparmor opt added', (b: any) => b.HostConfig.SecurityOpt.push('apparmor=unconfined')],
  ['a higher pids limit', (b: any) => (b.HostConfig.PidsLimit = -1)],
  ['a shorter stop timeout', (b: any) => (b.StopTimeout = 1)],
  ['a missing stop timeout', (b: any) => delete b.StopTimeout],
  ['the host network', (b: any) => (b.HostConfig.NetworkMode = 'host')],
  ['the host pid namespace', (b: any) => (b.HostConfig.PidMode = 'host')],
  ['the host ipc namespace', (b: any) => (b.HostConfig.IpcMode = 'host')],
  ['the host uts namespace', (b: any) => (b.HostConfig.UTSMode = 'host')],
  ['a device', (b: any) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }])],
  ['a device cgroup rule', (b: any) => (b.HostConfig.DeviceCgroupRules = ['c *:* rwm'])],
  ['a secret in the environment', (b: any) => b.Env.push('TM_MASTER_KEY_FILE=/run/secrets/tm_master_key')],
  ['a duplicate environment name', (b: any) => b.Env.push('TM_PUBLIC_URL=https://evil.example')],
  ['an environment entry with no name', (b: any) => b.Env.push('=x')],
  ['a different data root in the environment', (b: any) => (b.Env[0] = 'TM_DATA_ROOT=/')],
  ['a key file in another place', (b: any) => (b.Env[2] = 'TM_PROFILE_KEY_FILE=/run/secrets/tm_master_key')],
  ['a smaller shm', (b: any) => (b.HostConfig.ShmSize = 67108864)],
  ['a bigger memory limit', (b: any) => (b.HostConfig.Memory = 0)],
  ['more cpu', (b: any) => (b.HostConfig.NanoCpus = 64000000000)],
  ['another dns server', (b: any) => (b.HostConfig.Dns = ['9.9.9.9'])],
  ['a public host pointing at another address', (b: any) => (b.HostConfig.ExtraHosts[0] = 'tm.example:10.0.0.1')],
  ['another public host pinned to Caddy', (b: any) => (b.HostConfig.ExtraHosts[0] = `evil.example:172.30.0.2`)],
  ['another ntfy host pinned to Caddy', (b: any) => (b.HostConfig.ExtraHosts[1] = `evil.example:172.30.0.2`)],
  ['another public URL in the environment', (b: any) => (b.Env[3] = 'TM_PUBLIC_URL=https://evil.example')],
  ['a public URL with a path', (b: any) => (b.Env[3] = 'TM_PUBLIC_URL=https://tm.example/x')],
  ['an extra host pointing elsewhere', (b: any) => b.HostConfig.ExtraHosts.push('evil.example:10.0.0.1')],
  ['a different sysctl', (b: any) => (b.HostConfig.Sysctls = { 'kernel.core_pattern': '|/x' })],
  ['an extra sysctl', (b: any) => (b.HostConfig.Sysctls['net.ipv4.ip_forward'] = '1')],
  ['no auto remove', (b: any) => (b.HostConfig.AutoRemove = false)],
  ['a user override', (b: any) => (b.User = 'root')],
  ['an entrypoint', (b: any) => (b.Entrypoint = ['/bin/sh'])],
  ['a changed hostname', (b: any) => (b.Hostname = 'tm-other')],
  ['a lower-case key spelling', (b: any) => (b.image = 'alpine')],
  ['a command that is not a job', (b: any) => (b.Cmd = ['--job', '/etc/passwd'])],
  ['a command with an extra argument', (b: any) => b.Cmd.push('--evil')],
  [
    'a job file of another identity',
    (b: any) => (b.Cmd[1] = `${cfg.profileRoot}/${occ}/job/${containerName(spec)}.json`)
  ],
  ['a job file path with ..', (b: any) => (b.Cmd[1] = `${cfg.profileRoot}/${idn}/job/../../x.json`)],
  ['the sign-in command on a worker', (b: any) => (b.Cmd[0] = '--signin')],
  ['a label that disagrees', (b: any) => (b.Labels['tm.role'] = 'signin')],
  ['an occurrence label that disagrees', (b: any) => (b.Labels['tm.occurrence'] = idn)],
  ['an extra label', (b: any) => (b.Labels['com.docker.x'] = 'y')]
])('a create with %s is refused', (_n, mutate) => {
  expect(create(mutated(mutate)).ok).toBe(false)
})

test.each([
  [
    'a data bind on a sign-in',
    (b: any) => b.HostConfig.Binds.unshift(`${cfg.dataRoot}/occurrences/${occ}:${cfg.dataRoot}/occurrences/${occ}`)
  ],
  ['a data root in the environment', (b: any) => b.Env.unshift(`TM_DATA_ROOT=${cfg.dataRoot}`)],
  ['the worker command', (b: any) => (b.Cmd[0] = '--job')],
  ['a bigger box', (b: any) => (b.HostConfig.Memory = 5368709120)]
])('a sign-in create with %s is refused', (_n, mutate) => {
  expect(createFor(sign, mutated(mutate, sign)).ok).toBe(false)
})

test('a body that is not a JSON object is refused', () => {
  for (const body of [null, 'x', 5, [], undefined]) expect(create(body).ok).toBe(false)
})

test('the container name must match the spec', () => {
  const body = containerSpec(spec)
  expect(createFor(spec, body, `tm-worker-${occ}-a2`).ok).toBe(false)
  expect(createFor(spec, body, 'evil').ok).toBe(false)
  expect(validateRequest({ method: 'POST', path: '/containers/create', body }, cfg).ok).toBe(false)
  const path = `/containers/create?name=${containerName(spec)}`
  expect(validateRequest({ method: 'POST', path: `${path}&platform=linux`, body }, cfg).ok).toBe(false)
  expect(validateRequest({ method: 'POST', path: `${path}&name=other`, body }, cfg).ok).toBe(false)
})

test('a sign-in create under a worker name is refused', () => {
  expect(createFor(sign, containerSpec(sign), containerName(spec)).ok).toBe(false)
})

test('roots that are not clean absolute paths throw', () => {
  const body = containerSpec(spec)
  const req = { method: 'POST', path: `/containers/create?name=${containerName(spec)}`, body }
  expect(() => validateRequest(req, { ...cfg, dataRoot: cfg.dataRoot + '/' })).toThrow()
  expect(() => validateRequest(req, { ...cfg, profileRoot: 'profiles' })).toThrow()
  expect(() => validateRequest(req, { ...cfg, profileRoot: '/srv/../profiles' })).toThrow()
})

test('the allowed lifecycle calls pass, with or without a version prefix', () => {
  const id = containerName(spec)
  expect(validateRequest({ method: 'GET', path: '/_ping', body: null }, cfg)).toEqual({ ok: true, kind: 'ping' })
  expect(validateRequest({ method: 'GET', path: '/v1.47/_ping', body: null }, cfg)).toEqual({ ok: true, kind: 'ping' })
  expect(validateRequest({ method: 'POST', path: `/containers/${id}/start`, body: null }, cfg)).toEqual({
    ok: true,
    kind: 'start',
    id
  })
  expect(validateRequest({ method: 'POST', path: `/v1.44/containers/${id}/stop?t=60`, body: null }, cfg)).toEqual({
    ok: true,
    kind: 'stop',
    id
  })
  expect(validateRequest({ method: 'POST', path: `/containers/${id}/stop`, body: null }, cfg)).toEqual({
    ok: true,
    kind: 'stop',
    id
  })
  expect(validateRequest({ method: 'GET', path: `/containers/${id}/json`, body: null }, cfg)).toEqual({
    ok: true,
    kind: 'inspect',
    id
  })
})

test.each([
  ['POST', `/containers/${occ}/stop?t=abc`],
  ['POST', `/containers/${occ}/stop?t=60&signal=SIGKILL`],
  ['POST', `/containers/${occ}/start?detachKeys=x`],
  ['GET', `/containers/${occ}/json?size=1`]
])('%s %s is refused for its query', (method, path) => {
  expect(validateRequest({ method, path, body: null }, cfg).ok).toBe(false)
})

test.each([
  ['POST', `/containers/${occ}/exec`],
  ['POST', `/containers/${occ}/kill`],
  ['POST', `/containers/${occ}/restart`],
  ['POST', `/containers/${occ}/update`],
  ['POST', `/containers/${occ}/attach`],
  ['GET', `/containers/${occ}/archive`],
  ['PUT', `/containers/${occ}/archive`],
  ['GET', `/containers/${occ}/logs`],
  ['DELETE', `/containers/${occ}`],
  ['POST', '/images/create'],
  ['POST', '/build'],
  ['GET', '/containers/json'],
  ['GET', '/info'],
  ['POST', '/networks/create'],
  ['POST', '/volumes/create'],
  ['GET', '/containers/../images/json'],
  ['GET', '/containers/%2e%2e/json'],
  ['GET', `/containers/${occ}/../json`],
  ['GET', '/containers//json'],
  ['POST', `//containers/${occ}/start`],
  ['POST', `/v1.47/v1.47/containers/${occ}/start`],
  ['POST', `/vx/containers/${occ}/start`],
  ['GET', `/containers/${occ}/json/`],
  ['GET', `/containers/${occ}/JSON`]
])('%s %s is refused', (method, path) => {
  expect(validateRequest({ method, path, body: null }, cfg)).toEqual({ ok: false, reason: 'endpoint not allowed' })
})

test('the right path with the wrong method is refused', () => {
  const id = containerName(spec)
  expect(validateRequest({ method: 'GET', path: `/containers/${id}/start`, body: null }, cfg).ok).toBe(false)
  expect(validateRequest({ method: 'POST', path: `/containers/${id}/json`, body: null }, cfg).ok).toBe(false)
  expect(validateRequest({ method: 'GET', path: `/containers/create?name=${id}`, body: null }, cfg).ok).toBe(false)
  expect(validateRequest({ method: 'POST', path: '/_ping', body: null }, cfg).ok).toBe(false)
})

test('the gate speaks Docker API v1.41 to v1.51 only', () => {
  const id = containerName(spec)
  for (const v of ['v1.41', 'v1.47', 'v1.51']) {
    expect(validateRequest({ method: 'GET', path: `/${v}/containers/${id}/json`, body: null }, cfg).ok).toBe(true)
  }
  for (const v of ['v1.40', 'v1.52', 'v1.99', 'v2.0', 'v1.4', 'v1.470']) {
    expect(validateRequest({ method: 'GET', path: `/${v}/containers/${id}/json`, body: null }, cfg)).toEqual({
      ok: false,
      reason: 'endpoint not allowed'
    })
  }
})

test('a create is judged against the configured URLs, not the request', () => {
  const body = containerSpec(spec)
  const req = { method: 'POST', path: `/containers/create?name=${containerName(spec)}`, body }
  expect(validateRequest(req, cfg).ok).toBe(true)
  expect(validateRequest(req, { ...cfg, publicUrl: 'https://other.example' }).ok).toBe(false)
  expect(validateRequest(req, { ...cfg, ntfyUrl: 'https://ntfy.other.example' }).ok).toBe(false)
  expect(() => validateRequest(req, { ...cfg, publicUrl: 'https://tm.example/path' })).toThrow()
  expect(() => validateRequest(req, { ...cfg, ntfyUrl: 'ntfy' })).toThrow()
})
