import type { SpecEnv } from '@tm/core'
import {
  UUID_RE,
  buildCreateBody,
  buildSidecarBody,
  nameFor,
  parseName,
  sidecarName,
  resolveEnv,
  type BodyInput
} from '../container-spec'

/**
 * The gate's fixed configuration: the roots and the two URLs. A create body may not choose any of them. With
 * `tailscaleVersion` (`TAILSCALE_VERSION`) set, the gate also accepts the home-route sidecar of that version; without it,
 * no sidecar can be created.
 */
export type GateConfig = SpecEnv & { tailscaleVersion?: string }
export type GateRequest = { method: string; path: string; body: unknown }
export type GateVerdict =
  | { ok: true; kind: 'ping' | 'create' | 'start' | 'stop' | 'inspect' | 'remove'; id?: string }
  | { ok: false; reason: string }

const NOT_ALLOWED: GateVerdict = { ok: false, reason: 'endpoint not allowed' }
const refuse = (reason: string): GateVerdict => ({ ok: false, reason })

/** Docker API versions the gate speaks: v1.41 to v1.51, or no prefix. */
export const API_PREFIX_RE = /^\/v1\.(?:4[1-9]|5[01])(?=\/)/
const PATH_RE = /^\/[A-Za-z0-9_./-]*$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Decides whether the scheduler may send this request to Docker. Throws when the configured roots are unusable. */
export function validateRequest(r: GateRequest, cfg: GateConfig): GateVerdict {
  const { publicUrl, hosts } = resolveEnv(cfg)

  const q = r.path.indexOf('?')
  const rawPath = q < 0 ? r.path : r.path.slice(0, q)
  const query = q < 0 ? '' : r.path.slice(q + 1)
  const path = rawPath.replace(API_PREFIX_RE, '')
  if (!PATH_RE.test(path)) return NOT_ALLOWED

  if (path === '/_ping') {
    return (r.method === 'GET' || r.method === 'HEAD') && query === '' ? { ok: true, kind: 'ping' } : NOT_ALLOWED
  }
  if (path === '/containers/create')
    return r.method === 'POST' ? validateCreate(query, r.body, cfg, { publicUrl, hosts }) : NOT_ALLOWED

  // DELETE /containers/<id>: no `force`, no `v`, no other query. The gate also requires the container to be stopped.
  const rm = /^\/containers\/([^/]+)$/.exec(path)
  if (rm && r.method === 'DELETE' && ID_RE.test(rm[1]!)) {
    return query === '' ? { ok: true, kind: 'remove', id: rm[1]! } : refuse('query not allowed')
  }

  const c = /^\/containers\/([^/]+)\/(start|stop|json)$/.exec(path)
  if (!c || !ID_RE.test(c[1]!)) return NOT_ALLOWED
  const id = c[1]!
  const action = c[2]!
  if (action === 'json') return r.method === 'GET' && query === '' ? { ok: true, kind: 'inspect', id } : NOT_ALLOWED
  if (r.method !== 'POST') return NOT_ALLOWED
  if (action === 'start') return query === '' ? { ok: true, kind: 'start', id } : refuse('query not allowed')
  return query === '' || /^t=[0-9]{1,4}$/.test(query) ? { ok: true, kind: 'stop', id } : refuse('query not allowed')
}

function validateCreate(
  query: string,
  body: unknown,
  cfg: GateConfig,
  resolved: { publicUrl: string; hosts: string[] }
): GateVerdict {
  const params = new URLSearchParams(query)
  const names = params.getAll('name')
  if (names.length !== 1 || [...params.keys()].length !== 1 || query !== `name=${names[0]}`) {
    return refuse('create needs exactly the name query')
  }
  const name = names[0]!
  const parsed = parseName(name)
  if (!parsed) return refuse('container name not allowed')

  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('create body must be an object')
  const b = body as Record<string, unknown>
  if (parsed.kind === 'sidecar') return validateSidecar(name, parsed.subjectId, b, cfg, resolved.hosts)

  // The identity comes from the job file path; everything else must then equal the fixed body for this name.
  const cmd = b.Cmd
  const jobRe = new RegExp(`^${escapeRe(cfg.profileRoot)}/([0-9a-f-]{36})/job/${escapeRe(name)}\\.json$`)
  const identity = Array.isArray(cmd) && typeof cmd[1] === 'string' ? jobRe.exec(cmd[1]) : null
  if (!identity || !UUID_RE.test(identity[1]!)) return refuse('Cmd: job file not allowed')

  // A worker is either on `tm-workers` or in the namespace of the sidecar of its own occurrence, and nowhere else.
  const network = (b.HostConfig as { NetworkMode?: unknown } | null | undefined)?.NetworkMode
  const sidecar = sidecarName(parsed.subjectId)
  const via = parsed.kind === 'worker' && network === `container:${sidecar}` ? sidecar : undefined
  const input: BodyInput = {
    kind: parsed.kind,
    subjectId: parsed.subjectId,
    attempt: parsed.attempt,
    identityId: identity[1]!,
    dataRoot: cfg.dataRoot,
    profileRoot: cfg.profileRoot,
    ...resolved,
    ...(via ? { via } : {})
  }
  if (nameFor(input.kind, input.subjectId, input.attempt) !== name) return refuse('container name not allowed')
  const diff = firstDiff(b, buildCreateBody(input), '')
  return diff === null ? { ok: true, kind: 'create' } : refuse(`create body differs from the fixed spec at ${diff}`)
}

const EXIT_NODE_ENV = /^TM_EXIT_NODE_(ID|HOSTNAME)=(.*)$/

/**
 * The home-route sidecar of one occurrence. Its identity (hostname) and exit node come from the request, because the gate
 * can't know them; their shapes are checked, and everything else must then equal `buildSidecarBody` exactly: the image,
 * one capability, the tun device, one read-only key file mount, no extra field.
 */
function validateSidecar(
  name: string,
  occurrenceId: string,
  b: Record<string, unknown>,
  cfg: GateConfig,
  hosts: string[]
): GateVerdict {
  if (cfg.tailscaleVersion === undefined) return refuse('the home route is not enabled (TAILSCALE_VERSION)')
  const labels = b.Labels as Record<string, unknown> | null | undefined
  const identityId = labels?.['tm.identity']
  if (typeof identityId !== 'string' || !UUID_RE.test(identityId)) return refuse('Labels: identity not allowed')
  const env = Array.isArray(b.Env) ? b.Env.filter((e): e is string => typeof e === 'string') : []
  const pick = (key: string) => env.map((e) => EXIT_NODE_ENV.exec(e)).find((m) => m?.[1] === key)?.[2]
  const exitNodeId = pick('ID')
  const exitNodeHostname = pick('HOSTNAME')
  if (exitNodeId === undefined || exitNodeHostname === undefined) return refuse('Env: the exit node is missing')
  let want: ReturnType<typeof buildSidecarBody>
  try {
    want = buildSidecarBody({
      occurrenceId,
      identityId,
      exitNodeId,
      exitNodeHostname,
      tailscaleVersion: cfg.tailscaleVersion,
      profileRoot: cfg.profileRoot,
      hosts
    })
  } catch (e) {
    return refuse(`Env: ${e instanceof Error ? e.message : 'the sidecar body is not allowed'}`)
  }
  if (sidecarName(occurrenceId) !== name) return refuse('container name not allowed')
  const diff = firstDiff(b, want, '')
  return diff === null ? { ok: true, kind: 'create' } : refuse(`create body differs from the fixed spec at ${diff}`)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The path of the first difference between the request and the fixed body, or null when they are identical. */
function firstDiff(got: unknown, want: unknown, at: string): string | null {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return at || '(root)'
    for (let i = 0; i < want.length; i++) {
      const d = firstDiff(got[i], want[i], `${at}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  if (typeof want === 'object' && want !== null) {
    if (typeof got !== 'object' || got === null || Array.isArray(got)) return at || '(root)'
    const keys = new Set([...Object.keys(got), ...Object.keys(want)])
    for (const k of keys) {
      const here = at ? `${at}.${k}` : k
      if (!Object.hasOwn(want, k) || !Object.hasOwn(got, k)) return here
      const d = firstDiff((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], here)
      if (d !== null) return d
    }
    return null
  }
  return got === want ? null : at || '(root)'
}
