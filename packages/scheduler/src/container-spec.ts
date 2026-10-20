import type { SpecEnv } from '@tm/core'

export const WORKER_IMAGE = 'tolongmeeting/worker:current'
export const WORKER_NETWORK = 'tm-workers'
export const CADDY_WORKER_IP = '172.30.0.2'

export type SpecParams =
  | {
      kind: 'worker'
      occurrenceId: string
      attempt: number
      identityId: string
      env: SpecEnv
      /** Run in the network namespace of this home-route sidecar (`sidecarName(occurrenceId)`), not on `tm-workers`. */
      via?: { sidecar: string }
    }
  | { kind: 'signin'; sessionId: string; identityId: string; env: SpecEnv }

export type CreateBody = {
  Image: string
  /** Left out of a body that joins a sidecar's namespace: Docker rejects it there, the sidecar carries it. */
  Hostname?: string
  Cmd: string[]
  Env: string[]
  Labels: Record<string, string>
  StopTimeout: number
  HostConfig: {
    Binds: string[]
    ShmSize: number
    NetworkMode: string
    /** `Dns`, `ExtraHosts` and `Sysctls` are left out with `Hostname` of a body that joins a sidecar's namespace. */
    Dns?: string[]
    ExtraHosts?: string[]
    Sysctls?: Record<string, string>
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
const SIDECAR_NAME_RE = /^tm-home-([0-9a-f-]{36})$/
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

export type ContainerKind = 'worker' | 'signin' | 'sidecar'

/**
 * A container name this system creates: `tm-worker-<occurrenceId>-a<attempt>`, `tm-signin-<sessionId>` or the home-route
 * sidecar `tm-home-<occurrenceId>` (attempt 0).
 */
export function parseName(name: string): { kind: ContainerKind; subjectId: string; attempt: number } | null {
  const worker = WORKER_NAME_RE.exec(name)
  const signin = worker ? null : SIGNIN_NAME_RE.exec(name)
  const match = worker ?? signin ?? SIDECAR_NAME_RE.exec(name)
  if (!match || !UUID_RE.test(match[1]!)) return null
  return {
    kind: worker ? 'worker' : signin ? 'signin' : 'sidecar',
    subjectId: match[1]!,
    attempt: worker ? Number(worker[2]) : 0
  }
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
  /** A worker only: the sidecar whose network namespace it joins. */
  via?: string
}

const DNS = ['1.1.1.1', '8.8.8.8']
const NO_IPV6 = { 'net.ipv6.conf.all.disable_ipv6': '1' }
const extraHosts = (hosts: string[]): string[] => hosts.map((host) => `${host}:${CADDY_WORKER_IP}`)

export const nameFor = (kind: 'worker' | 'signin', subjectId: string, attempt: number): string =>
  kind === 'worker' ? `tm-worker-${subjectId}-a${attempt}` : `tm-signin-${subjectId}`

/** The one place the fixed container body is written. The gate rebuilds this and refuses any request that differs. */
export function buildCreateBody(i: BodyInput): CreateBody {
  const worker = i.kind === 'worker'
  const profileDir = `${i.profileRoot}/${i.identityId}`
  const dataDir = `${i.dataRoot}/occurrences/${i.subjectId}`
  const base = `${profileDir}/job/${nameFor(i.kind, i.subjectId, i.attempt)}`
  // Docker refuses these four on a container that joins another's namespace: the sidecar carries them (`buildSidecarBody`).
  const own = i.via === undefined
  return {
    Image: WORKER_IMAGE,
    ...(own ? { Hostname: `tm-${i.identityId.slice(0, 20)}` } : {}),
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
      NetworkMode: own ? WORKER_NETWORK : `container:${i.via}`,
      ...(own ? { Dns: [...DNS], ExtraHosts: extraHosts(i.hosts), Sysctls: { ...NO_IPV6 } } : {}),
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
  if (p.kind === 'worker' && p.via && p.via.sidecar !== sidecarName(subjectId)) {
    throw new Error('a worker may join only the home-route sidecar of its own occurrence')
  }
  return {
    kind: p.kind,
    subjectId,
    attempt,
    identityId: p.identityId,
    dataRoot: p.env.dataRoot,
    profileRoot: p.env.profileRoot,
    publicUrl,
    hosts,
    ...(p.kind === 'worker' && p.via ? { via: p.via.sidecar } : {})
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

// --- The home-route sidecar ----------------------------------------------------------------------------------------

export const HOME_ROUTE_IMAGE = 'tm-home-route'
/** Where the sidecar reads its one-time Tailscale auth key. The key is never in its environment or arguments. */
export const SIDECAR_KEY_TARGET = '/run/tm/authkey'
const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/
/** The member's home node: Tailscale's stable node id (`n` and letters or digits) and the keyed hostname. */
const NODE_ID_RE = /^[A-Za-z0-9]{1,40}$/
const HOME_HOSTNAME_RE = /^tm-home-[0-9a-f]{24}$/

/** `tm-home-<occurrenceId>`: the sidecar of one occurrence. */
export const sidecarName = (occurrenceId: string): string => `tm-home-${occurrenceId}`

/** The host file the sidecar's auth key is written to, in `<profileRoot>/.home-keys/`, a tree no worker mounts. */
export const authKeyPath = (profileRoot: string, occurrenceId: string): string =>
  `${profileRoot}/.home-keys/${sidecarName(occurrenceId)}`

export type SidecarInput = {
  occurrenceId: string
  identityId: string
  /** The member's home node by Tailscale's stable node id, and the keyed hostname it must have (`homeHostname`). */
  exitNodeId: string
  exitNodeHostname: string
  tailscaleVersion: string
  profileRoot: string
  hosts: string[]
}

export type SidecarBody = {
  Image: string
  Hostname: string
  Env: string[]
  Labels: Record<string, string>
  Healthcheck: { Test: string[]; Interval: number; Timeout: number; Retries: number; StartPeriod: number }
  HostConfig: {
    Binds: string[]
    NetworkMode: string
    Dns: string[]
    ExtraHosts: string[]
    Sysctls: Record<string, string>
    CapAdd: string[]
    CapDrop: string[]
    SecurityOpt: string[]
    Devices: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[]
    Memory: number
    PidsLimit: number
    AutoRemove: boolean
  }
}

/**
 * The one place the sidecar body is written; the gate rebuilds it and refuses any difference. The sidecar gets NET_ADMIN
 * and the tun device and nothing else (every other capability dropped, no privilege gain, no host network, one read-only
 * file mount for its key). It carries the hostname, hosts, DNS and IPv6 setting of the worker that joins it. It, not the
 * worker, pins the exit node: `start.sh` takes the peer whose node id AND hostname match `TM_EXIT_NODE_*`.
 */
export function buildSidecarBody(i: SidecarInput): SidecarBody {
  if (!VERSION_RE.test(i.tailscaleVersion)) throw new Error('TAILSCALE_VERSION must look like 1.102.5')
  if (!NODE_ID_RE.test(i.exitNodeId)) throw new Error('the exit node id is not a Tailscale node id')
  if (!HOME_HOSTNAME_RE.test(i.exitNodeHostname)) throw new Error('the exit node hostname is not a home hostname')
  if (!UUID_RE.test(i.occurrenceId) || !UUID_RE.test(i.identityId)) throw new Error('ids must be lower-case UUIDs')
  assertRoot('profileRoot', i.profileRoot)
  return {
    Image: `${HOME_ROUTE_IMAGE}:${i.tailscaleVersion}`,
    Hostname: `tm-${i.identityId.slice(0, 20)}`,
    Env: [
      `TS_AUTHKEY=file:${SIDECAR_KEY_TARGET}`,
      `TS_HOSTNAME=tm-worker-${i.occurrenceId}`,
      'TS_USERSPACE=false',
      'TS_TAILSCALED_EXTRA_ARGS=--state=mem:',
      'TS_EXTRA_ARGS=--accept-dns=false --advertise-tags=tag:tm-worker',
      `TM_EXIT_NODE_ID=${i.exitNodeId}`,
      `TM_EXIT_NODE_HOSTNAME=${i.exitNodeHostname}`
    ],
    Labels: { 'tm.role': 'sidecar', 'tm.occurrence': i.occurrenceId, 'tm.identity': i.identityId },
    // Healthy only once start.sh has seen the tunnel Running through the pinned exit node (it writes /tmp/tm-ready).
    Healthcheck: {
      Test: ['CMD', 'test', '-f', '/tmp/tm-ready'],
      Interval: 1e9,
      Timeout: 3e9,
      Retries: 3,
      StartPeriod: 5e9
    },
    HostConfig: {
      Binds: [`${authKeyPath(i.profileRoot, i.occurrenceId)}:${SIDECAR_KEY_TARGET}:ro`],
      NetworkMode: WORKER_NETWORK,
      Dns: [...DNS],
      ExtraHosts: extraHosts(i.hosts),
      Sysctls: { ...NO_IPV6 },
      CapAdd: ['NET_ADMIN'],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      Memory: 268435456,
      PidsLimit: 256,
      AutoRemove: true
    }
  }
}
