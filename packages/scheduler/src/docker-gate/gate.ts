import { validateRequest, type GateConfig } from './validate'

export type GateOptions = GateConfig & {
  /** The Docker Engine socket, e.g. `/var/run/docker.sock`. */
  socketPath: string
  /** Receives one line per request: method, path and the refusal reason. Never a body. */
  log: (line: string) => void
}

const MAX_BODY = 64 * 1024
const MANAGED_ROLES = new Set(['worker', 'signin'])
const PREFIX_RE = /^\/v[0-9]+\.[0-9]+/

const deny = (status: number, message: string): Response => Response.json({ message }, { status })

/**
 * The request handler of the `docker-proxy` service: it lets the scheduler create, start, stop and inspect worker and
 * sign-in containers and nothing else. Create bodies are re-serialised from the parsed, validated object, so what the
 * gate checked is exactly what Docker reads.
 */
export function createGate(o: GateOptions): (req: Request) => Promise<Response> {
  const docker = (path: string, init: { method: string; body?: string } = { method: 'GET' }): Promise<Response> =>
    fetch(`http://docker${path}`, {
      unix: o.socketPath,
      method: init.method,
      body: init.body,
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' }
    })

  return async (req) => {
    const url = new URL(req.url)
    const target = url.pathname + url.search
    const line = `${req.method} ${target}`

    let body: unknown = null
    let text = ''
    if (req.method === 'POST' && url.pathname.endsWith('/containers/create')) {
      text = await req.text()
      if (text.length > MAX_BODY) {
        o.log(`${line} refused: body too large`)
        return deny(413, 'body too large')
      }
      try {
        body = JSON.parse(text)
      } catch {
        o.log(`${line} refused: body is not JSON`)
        return deny(400, 'body is not JSON')
      }
    }

    const verdict = validateRequest({ method: req.method, path: target, body }, o)
    if (!verdict.ok) {
      o.log(`${line} refused: ${verdict.reason}`)
      return deny(403, verdict.reason)
    }

    if (verdict.kind === 'ping') return docker(target, { method: req.method })
    if (verdict.kind === 'create') return docker(target, { method: 'POST', body: JSON.stringify(body) })

    // start, stop and inspect: look at the target's own labels first, then act on its full id so a name can't move.
    const inspected = await docker(`/containers/${verdict.id}/json`)
    if (inspected.status === 404) return inspected
    if (!inspected.ok) {
      o.log(`${line} failed: inspect answered ${inspected.status}`)
      return deny(502, 'docker inspect failed')
    }
    const info = (await inspected.json()) as { Id?: unknown; Config?: { Labels?: Record<string, string> | null } }
    const role = info.Config?.Labels?.['tm.role']
    if (typeof info.Id !== 'string' || !/^[0-9a-f]{64}$/.test(info.Id) || !role || !MANAGED_ROLES.has(role)) {
      o.log(`${line} refused: container is not a worker or sign-in container`)
      return deny(403, 'container is not a worker or sign-in container')
    }
    if (verdict.kind === 'inspect') return Response.json(info)
    const prefix = PREFIX_RE.exec(url.pathname)?.[0] ?? ''
    return docker(`${prefix}/containers/${info.Id}/${verdict.kind}${url.search}`, { method: 'POST' })
  }
}
