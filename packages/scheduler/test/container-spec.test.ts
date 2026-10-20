import { expect, test } from 'bun:test'
import {
  CADDY_WORKER_IP,
  WORKER_IMAGE,
  WORKER_NETWORK,
  containerName,
  containerSpec,
  jobFileBase,
  machineIdPath,
  type SpecParams
} from '../src/index'

const env = {
  dataRoot: '/srv/tolongmeeting/data',
  profileRoot: '/srv/tolongmeeting/profiles',
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example'
}
const occ = '11111111-1111-4111-8111-111111111111'
const idn = '22222222-2222-4222-8222-222222222222'
const worker: SpecParams = { kind: 'worker', occurrenceId: occ, attempt: 1, identityId: idn, env }
const signin: SpecParams = { kind: 'signin', sessionId: occ, identityId: idn, env }

test('the worker spec keeps host paths, the shm size and no secrets in its environment', () => {
  const b = containerSpec(worker)
  expect(b.Image).toBe(WORKER_IMAGE)
  expect(b.HostConfig.Binds).toEqual([
    `/srv/tolongmeeting/data/occurrences/${occ}:/srv/tolongmeeting/data/occurrences/${occ}`,
    `/srv/tolongmeeting/profiles/${idn}:/srv/tolongmeeting/profiles/${idn}`,
    `/srv/tolongmeeting/profiles/.machine-ids/${idn}:/etc/machine-id:ro`
  ])
  expect(b.HostConfig.ShmSize).toBe(2147483648)
  expect(b.HostConfig.NetworkMode).toBe(WORKER_NETWORK)
  expect(b.HostConfig.ExtraHosts).toEqual([`tm.example:${CADDY_WORKER_IP}`, `ntfy.tm.example:${CADDY_WORKER_IP}`])
  expect(b.Env.some((e) => /KEY=|TOKEN=|SECRET=/.test(e))).toBe(false)
  expect(containerName(worker)).toBe(`tm-worker-${occ}-a1`)
})

test('the worker spec has the same limits as run-job.sh', () => {
  const b = containerSpec(worker)
  expect(b.Hostname).toBe(`tm-${idn.slice(0, 20)}`)
  expect(b.StopTimeout).toBe(60)
  expect(b.HostConfig.CapDrop).toEqual(['ALL'])
  expect(b.HostConfig.SecurityOpt).toEqual(['no-new-privileges'])
  expect(b.HostConfig.PidsLimit).toBe(2048)
  expect(b.HostConfig.AutoRemove).toBe(true)
  expect(b.HostConfig.Memory).toBe(5368709120)
  expect(b.HostConfig.NanoCpus).toBe(3500000000)
})

test('the worker job, key file and command sit in the identity profile directory', () => {
  const b = containerSpec(worker)
  const base = `/srv/tolongmeeting/profiles/${idn}/job/tm-worker-${occ}-a1`
  expect(jobFileBase(worker)).toBe(base)
  expect(b.Cmd).toEqual(['--job', `${base}.json`])
  expect(b.Env).toEqual([
    'TM_DATA_ROOT=/srv/tolongmeeting/data',
    'TM_PROFILE_ROOT=/srv/tolongmeeting/profiles',
    `TM_PROFILE_KEY_FILE=${base}.key`,
    'TM_PUBLIC_URL=https://tm.example'
  ])
  expect(b.Labels).toEqual({ 'tm.role': 'worker', 'tm.occurrence': occ, 'tm.attempt': '1' })
})

test('the sign-in spec mounts only the profile and gets a smaller box', () => {
  const b = containerSpec(signin)
  const base = `/srv/tolongmeeting/profiles/${idn}/job/tm-signin-${occ}`
  expect(containerName(signin)).toBe(`tm-signin-${occ}`)
  expect(b.Cmd).toEqual(['--signin', `${base}.json`])
  expect(b.Env.some((e) => e.startsWith('TM_DATA_ROOT='))).toBe(false)
  expect(b.Labels).toEqual({ 'tm.role': 'signin', 'tm.session': occ })
  expect(b.HostConfig.Binds).toEqual([
    `/srv/tolongmeeting/profiles/${idn}:/srv/tolongmeeting/profiles/${idn}`,
    `/srv/tolongmeeting/profiles/.machine-ids/${idn}:/etc/machine-id:ro`
  ])
  expect(b.HostConfig.Memory).toBe(2147483648)
  expect(b.HostConfig.NanoCpus).toBe(1000000000)
  expect(b.HostConfig.CapDrop).toEqual(['ALL'])
})

test.each([
  ['an id with a path part', { ...worker, identityId: '../../etc' }],
  ['an upper-case id', { ...worker, identityId: 'AAAAAAAA-2222-4222-8222-222222222222' }],
  ['an occurrence id with a slash', { ...worker, occurrenceId: `${occ}/..` }],
  ['attempt 0', { ...worker, attempt: 0 }],
  ['a fractional attempt', { ...worker, attempt: 1.5 }],
  ['a relative data root', { ...worker, env: { ...env, dataRoot: 'data' } }],
  ['a data root with ..', { ...worker, env: { ...env, dataRoot: '/srv/../etc' } }],
  ['a trailing slash on the profile root', { ...worker, env: { ...env, profileRoot: '/srv/profiles/' } }],
  ['the filesystem root as a root', { ...worker, env: { ...env, dataRoot: '/' } }],
  ['a public URL that is not a URL', { ...worker, env: { ...env, publicUrl: 'tm.example' } }]
] as [string, SpecParams][])('a spec with %s throws', (_name, p) => {
  expect(() => containerSpec(p)).toThrow()
})

test('the machine id file sits outside every directory a container can write', () => {
  const file = machineIdPath(env.profileRoot, idn)
  expect(file).toBe(`/srv/tolongmeeting/profiles/.machine-ids/${idn}`)
  for (const p of [worker, signin]) {
    const writable = containerSpec(p)
      .HostConfig.Binds.filter((b) => !b.endsWith(':ro'))
      .map((b) => b.split(':')[0]!)
    expect(writable.some((dir) => file.startsWith(`${dir}/`) || file === dir)).toBe(false)
  }
})
