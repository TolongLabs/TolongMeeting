import type { SpecEnv } from '@tm/core'
import { UUID_RE, buildCreateBody, nameFor, parseName, resolveEnv, type BodyInput } from '../container-spec'

/** The gate's fixed configuration: the roots and the two URLs. A create body may not choose any of them. */
export type GateConfig = SpecEnv
export type GateRequest = { method: string; path: string; body: unknown }
export type GateVerdict =
  { ok: true; kind: 'ping' | 'create' | 'start' | 'stop' | 'inspect'; id?: string } | { ok: false; reason: string }

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

  // The identity comes from the job file path; everything else must then equal the fixed body for this name.
  const cmd = b.Cmd
  const jobRe = new RegExp(`^${escapeRe(cfg.profileRoot)}/([0-9a-f-]{36})/job/${escapeRe(name)}\\.json$`)
  const identity = Array.isArray(cmd) && typeof cmd[1] === 'string' ? jobRe.exec(cmd[1]) : null
  if (!identity || !UUID_RE.test(identity[1]!)) return refuse('Cmd: job file not allowed')

  const input: BodyInput = {
    ...parsed,
    identityId: identity[1]!,
    dataRoot: cfg.dataRoot,
    profileRoot: cfg.profileRoot,
    ...resolved
  }
  if (nameFor(input.kind, input.subjectId, input.attempt) !== name) return refuse('container name not allowed')
  const diff = firstDiff(b, buildCreateBody(input), '')
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
