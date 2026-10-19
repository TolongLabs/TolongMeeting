import type { SpecEnv } from '@tm/core'

export const WORKER_IMAGE = 'tolongmeeting/worker:current'
export const WORKER_NETWORK = 'tm-workers'
export const CADDY_WORKER_IP = '172.30.0.2'

export type SpecParams =
  | { kind: 'worker'; occurrenceId: string; attempt: number; identityId: string; env: SpecEnv }
  | { kind: 'signin'; sessionId: string; identityId: string; env: SpecEnv }

export type CreateBody = {
  Image: string
  Hostname: string
  Cmd: string[]
  Env: string[]
  Labels: Record<string, string>
  StopTimeout: number
  HostConfig: {
    Binds: string[]
    ShmSize: number
    NetworkMode: string
    Dns: string[]
    ExtraHosts: string[]
    Sysctls: Record<string, string>
    Memory: number
    NanoCpus: number
    AutoRemove: boolean
    CapDrop: string[]
    SecurityOpt: string[]
    PidsLimit: number
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORKER_NAME_RE = /^tm-worker-([0-9a-f-]{36})-a([1-9][0-9]{0,8})$/
const SIGNIN_NAME_RE = /^tm-signin-([0-9a-f-]{36})$/
const ROOT_RE = /^(?:\/[A-Za-z0-9._@+-]+)+$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

/** A root is a clean absolute path: no `..` or `.` part, no trailing or doubled slash, no `:` (it would split a bind). */
export function assertRoot(label: string, path: string): void {
  if (!ROOT_RE.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`${label} must be a clean absolute path, got ${JSON.stringify(path)}`)
  }
}

/** A URL a container may be told about: http(s), no credentials, no path, query or fragment, plain ASCII. */
export function parseOrigin(label: string, value: string): URL {
  const url = /^[\x21-\x7e]+$/.test(value) ? URL.parse(value) : null
  if (
    !url ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !HOST_RE.test(url.hostname)
  ) {
    throw new Error(`${label} must be an http(s) origin, got ${JSON.stringify(value)}`)
  }
  return url
}

/** A container name this system creates: `tm-worker-<occurrenceId>-a<attempt>` or `tm-signin-<sessionId>`. */
export function parseName(name: string): { kind: 'worker' | 'signin'; subjectId: string; attempt: number } | null {
  const worker = WORKER_NAME_RE.exec(name)
  const match = worker ?? SIGNIN_NAME_RE.exec(name)
  if (!match || !UUID_RE.test(match[1]!)) return null
  return { kind: worker ? 'worker' : 'signin', subjectId: match[1]!, attempt: worker ? Number(worker[2]) : 0 }
}

/** Checks the roots and URLs a spec depends on; returns the public origin and the two hosts pinned to Caddy. */
export function resolveEnv(env: SpecEnv): { publicUrl: string; hosts: string[] } {
  assertRoot('dataRoot', env.dataRoot)
  assertRoot('profileRoot', env.profileRoot)
  const pub = parseOrigin('publicUrl', env.publicUrl)
  return { publicUrl: pub.origin, hosts: [pub.hostname, parseOrigin('ntfyUrl', env.ntfyUrl).hostname] }
}

/**
 * The host file bound read-only at `/etc/machine-id`. It sits in `<profileRoot>/.machine-ids/`, a tree no container
 * mounts, so a compromised worker can't replace it with a symlink that the next launch would bind-mount.
 */
export const machineIdPath = (profileRoot: string, identityId: string): string =>
  `${profileRoot}/.machine-ids/${identityId}`

export type BodyInput = {
  kind: 'worker' | 'signin'
  /** The occurrence id (worker) or the sign-in session id (signin). */
  subjectId: string
  attempt: number
  identityId: string
  dataRoot: string
  profileRoot: string
  publicUrl: string
  /** Host names pinned to Caddy, in order: the public host, then the ntfy host. */
  hosts: string[]
}

export const nameFor = (kind: 'worker' | 'signin', subjectId: string, attempt: number): string =>
  kind === 'worker' ? `tm-worker-${subjectId}-a${attempt}` : `tm-signin-${subjectId}`

/** The one place the fixed container body is written. The gate rebuilds this and refuses any request that differs. */
export function buildCreateBody(i: BodyInput): CreateBody {
  const worker = i.kind === 'worker'
  const profileDir = `${i.profileRoot}/${i.identityId}`
  const dataDir = `${i.dataRoot}/occurrences/${i.subjectId}`
  const base = `${profileDir}/job/${nameFor(i.kind, i.subjectId, i.attempt)}`
  return {
    Image: WORKER_IMAGE,
    Hostname: `tm-${i.identityId.slice(0, 20)}`,
    Cmd: [worker ? '--job' : '--signin', `${base}.json`],
    Env: [
      ...(worker ? [`TM_DATA_ROOT=${i.dataRoot}`] : []),
      `TM_PROFILE_ROOT=${i.profileRoot}`,
      `TM_PROFILE_KEY_FILE=${base}.key`,
      `TM_PUBLIC_URL=${i.publicUrl}`
    ],
    Labels: worker
      ? { 'tm.role': 'worker', 'tm.occurrence': i.subjectId, 'tm.attempt': String(i.attempt) }
      : { 'tm.role': 'signin', 'tm.session': i.subjectId },
    StopTimeout: 60,
    HostConfig: {
      Binds: [
        ...(worker ? [`${dataDir}:${dataDir}`] : []),
        `${profileDir}:${profileDir}`,
        `${machineIdPath(i.profileRoot, i.identityId)}:/etc/machine-id:ro`
      ],
      ShmSize: 2147483648,
      NetworkMode: WORKER_NETWORK,
      Dns: ['1.1.1.1', '8.8.8.8'],
      ExtraHosts: i.hosts.map((host) => `${host}:${CADDY_WORKER_IP}`),
      Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1' },
      Memory: worker ? 5368709120 : 2147483648,
      NanoCpus: worker ? 3500000000 : 1000000000,
      AutoRemove: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 2048
    }
  }
}

function toInput(p: SpecParams): BodyInput {
  const { publicUrl, hosts } = resolveEnv(p.env)
  if (!UUID_RE.test(p.identityId)) throw new Error('identityId must be a lower-case UUID')
  const subjectId = p.kind === 'worker' ? p.occurrenceId : p.sessionId
  if (!UUID_RE.test(subjectId)) throw new Error('occurrenceId and sessionId must be lower-case UUIDs')
  const attempt = p.kind === 'worker' ? p.attempt : 0
  if (p.kind === 'worker' && !(Number.isSafeInteger(attempt) && attempt >= 1)) {
    throw new Error('attempt must be a positive integer')
  }
  return {
    kind: p.kind,
    subjectId,
    attempt,
    identityId: p.identityId,
    dataRoot: p.env.dataRoot,
    profileRoot: p.env.profileRoot,
    publicUrl,
    hosts
  }
}

export const containerSpec = (p: SpecParams): CreateBody => buildCreateBody(toInput(p))

export function containerName(p: SpecParams): string {
  const i = toInput(p)
  return nameFor(i.kind, i.subjectId, i.attempt)
}

/** `<profileRoot>/<identityId>/job/<containerName>`: the launcher writes `.json` and `.key` next to this base. */
export function jobFileBase(p: SpecParams): string {
  const i = toInput(p)
  return `${i.profileRoot}/${i.identityId}/job/${nameFor(i.kind, i.subjectId, i.attempt)}`
}
