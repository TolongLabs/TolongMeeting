import {
  CADDY_WORKER_IP,
  UUID_RE,
  assertRoot,
  buildCreateBody,
  nameFor,
  parseOrigin,
  type BodyInput
} from '../container-spec'

export type GateConfig = { dataRoot: string; profileRoot: string }
export type GateRequest = { method: string; path: string; body: unknown }
export type GateVerdict =
  { ok: true; kind: 'ping' | 'create' | 'start' | 'stop' | 'inspect'; id?: string } | { ok: false; reason: string }

const NOT_ALLOWED: GateVerdict = { ok: false, reason: 'endpoint not allowed' }
const refuse = (reason: string): GateVerdict => ({ ok: false, reason })

const PREFIX_RE = /^(?:\/v[0-9]+\.[0-9]+)?(\/[A-Za-z0-9_./-]*)$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const WORKER_NAME_RE = /^tm-worker-([0-9a-f-]{36})-a([1-9][0-9]{0,8})$/
const SIGNIN_NAME_RE = /^tm-signin-([0-9a-f-]{36})$/
const HOST_ENTRY_RE = new RegExp(`^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):${CADDY_WORKER_IP.replaceAll('.', '\\.')}$`)

/** Decides whether the scheduler may send this request to Docker. Throws when the configured roots are unusable. */
export function validateRequest(r: GateRequest, cfg: GateConfig): GateVerdict {
  assertRoot('dataRoot', cfg.dataRoot)
  assertRoot('profileRoot', cfg.profileRoot)

  const q = r.path.indexOf('?')
  const rawPath = q < 0 ? r.path : r.path.slice(0, q)
  const query = q < 0 ? '' : r.path.slice(q + 1)
  const m = PREFIX_RE.exec(rawPath)
  if (!m) return NOT_ALLOWED
  const path = m[1]!

  if (path === '/_ping') {
    return (r.method === 'GET' || r.method === 'HEAD') && query === '' ? { ok: true, kind: 'ping' } : NOT_ALLOWED
  }
  if (path === '/containers/create') return r.method === 'POST' ? validateCreate(query, r.body, cfg) : NOT_ALLOWED

  const c = /^\/containers\/([^/]+)\/(start|stop|json)$/.exec(path)
  if (!c || !ID_RE.test(c[1]!)) return NOT_ALLOWED
  const id = c[1]!
  const action = c[2]!
  if (action === 'json') return r.method === 'GET' && query === '' ? { ok: true, kind: 'inspect', id } : NOT_ALLOWED
  if (r.method !== 'POST') return NOT_ALLOWED
  if (action === 'start') return query === '' ? { ok: true, kind: 'start', id } : refuse('query not allowed')
  return query === '' || /^t=[0-9]{1,4}$/.test(query) ? { ok: true, kind: 'stop', id } : refuse('query not allowed')
}

function validateCreate(query: string, body: unknown, cfg: GateConfig): GateVerdict {
  const params = new URLSearchParams(query)
  const names = params.getAll('name')
  if (names.length !== 1 || [...params.keys()].length !== 1 || query !== `name=${names[0]}`) {
    return refuse('create needs exactly the name query')
  }
  const name = names[0]!
  const worker = WORKER_NAME_RE.exec(name)
  const signin = worker ? null : SIGNIN_NAME_RE.exec(name)
  const match = worker ?? signin
  if (!match || !UUID_RE.test(match[1]!)) return refuse('container name not allowed')
  const kind = worker ? 'worker' : 'signin'

  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('create body must be an object')
  const b = body as Record<string, unknown>

  // The identity comes from the job file path; everything else must then match the fixed body for this name.
  const cmd = b.Cmd
  const jobRe = new RegExp(`^${escapeRe(cfg.profileRoot)}/([0-9a-f-]{36})/job/${escapeRe(name)}\\.json$`)
  const identity = Array.isArray(cmd) && typeof cmd[1] === 'string' ? jobRe.exec(cmd[1]) : null
  if (!identity || !UUID_RE.test(identity[1]!)) return refuse('Cmd: job file not allowed')

  // The public URL and the pinned hosts are the only free values; each is checked before the body is rebuilt.
  const env = Array.isArray(b.Env) ? b.Env : []
  const urlEntries = env.filter((e): e is string => typeof e === 'string' && e.startsWith('TM_PUBLIC_URL='))
  const hc = b.HostConfig
  const extra = typeof hc === 'object' && hc !== null ? (hc as Record<string, unknown>).ExtraHosts : undefined
  if (urlEntries.length !== 1) return refuse('Env: TM_PUBLIC_URL missing or repeated')
  if (!Array.isArray(extra) || extra.length !== 2) return refuse('HostConfig.ExtraHosts: two entries needed')
  const hosts = extra.map((e) => (typeof e === 'string' ? HOST_ENTRY_RE.exec(e)?.[1] : undefined))
  if (hosts.some((h) => !h)) return refuse(`HostConfig.ExtraHosts: entries must end :${CADDY_WORKER_IP}`)
  const publicUrl = urlEntries[0]!.slice('TM_PUBLIC_URL='.length)
  try {
    if (parseOrigin('TM_PUBLIC_URL', publicUrl).hostname !== hosts[0]) throw new Error('host mismatch')
  } catch {
    return refuse('Env: TM_PUBLIC_URL not allowed')
  }

  const input: BodyInput = {
    kind,
    subjectId: match[1]!,
    attempt: worker ? Number(worker[2]) : 0,
    identityId: identity[1]!,
    dataRoot: cfg.dataRoot,
    profileRoot: cfg.profileRoot,
    publicUrl,
    hosts: hosts as string[]
  }
  if (nameFor(kind, input.subjectId, input.attempt) !== name) return refuse('container name not allowed')
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
