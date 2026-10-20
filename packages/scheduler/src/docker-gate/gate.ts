import { HOME_ROUTE_IMAGE, WORKER_IMAGE, parseName, resolveEnv } from '../container-spec'
import { API_PREFIX_RE, validateRequest, type GateConfig } from './validate'

export type GateOptions = GateConfig & {
  /** The Docker Engine socket, e.g. `/var/run/docker.sock`. */
  socketPath: string
  /** Receives one line per request: method, path and the refusal reason. Never a body. */
  log: (line: string) => void
}

const MAX_BODY = 64 * 1024
type Inspect = {
  Id?: unknown
  Name?: unknown
  Config?: { Image?: unknown; Labels?: Record<string, unknown> | null } | null
  HostConfig?: { Privileged?: unknown } | null
  State?: { Running?: unknown } | null
}

/**
 * True when the container is one this system made: a worker or sign-in role on the worker image, or the home-route
 * sidecar on the pinned `tm-home-route` image; not privileged, a matching name.
 */
function isManaged(info: Inspect, tailscaleVersion: string | undefined): boolean {
  const role = info.Config?.Labels?.['tm.role']
  const name = typeof info.Name === 'string' ? parseName(info.Name.replace(/^\//, '')) : null
  const image =
    role === 'sidecar' && tailscaleVersion !== undefined ? `${HOME_ROUTE_IMAGE}:${tailscaleVersion}` : WORKER_IMAGE
  return (
    typeof info.Id === 'string' &&
    /^[0-9a-f]{64}$/.test(info.Id) &&
    (role === 'worker' || role === 'signin' || role === 'sidecar') &&
    info.Config?.Image === image &&
    typeof info.HostConfig === 'object' &&
    info.HostConfig !== null &&
    info.HostConfig.Privileged !== true &&
    name?.kind === role
  )
}

const deny = (status: number, message: string): Response => Response.json({ message }, { status })

/**
 * The request handler of the `docker-proxy` service: it lets the scheduler create, start, stop and inspect worker and
 * sign-in containers and nothing else. Create bodies are re-serialised from the parsed, validated object, so what the
 * gate checked is exactly what Docker reads.
 */
export function createGate(o: GateOptions): (req: Request) => Promise<Response> {
  resolveEnv(o) // fail at start-up, not on the first request, when a root or URL is unusable
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

    // start, stop, inspect and remove: look at the target's own labels first, then act on its full id so a name can't move.
    const inspected = await docker(`/containers/${verdict.id}/json`)
    if (inspected.status === 404) return inspected
    if (!inspected.ok) {
      o.log(`${line} failed: inspect answered ${inspected.status}`)
      return deny(502, 'docker inspect failed')
    }
    const info = (await inspected.json()) as Inspect
    if (!isManaged(info, o.tailscaleVersion)) {
      o.log(`${line} refused: container is not a worker, sign-in or home-route container`)
      return deny(403, 'container is not a worker, sign-in or home-route container')
    }
    if (verdict.kind === 'inspect') return Response.json(info)
    const prefix = API_PREFIX_RE.exec(url.pathname)?.[0] ?? ''
    if (verdict.kind === 'remove') {
      // Only a container that has stopped: a running one (or an answer that doesn't say) is never removed. No query is sent.
      if (info.State?.Running !== false) {
        o.log(`${line} refused: container is not stopped`)
        return deny(403, 'container is not stopped')
      }
      return docker(`${prefix}/containers/${info.Id as string}`, { method: 'DELETE' })
    }
    return docker(`${prefix}/containers/${info.Id as string}/${verdict.kind}${url.search}`, { method: 'POST' })
  }
}

export type ServeOptions = GateOptions & { port: number; hostname?: string }

/**
 * Serves the gate. Bun refuses bodies over 64 KiB itself, development mode is off so errors carry no stack page, and an
 * error thrown by the handler (Docker unreachable, inspect answered with bad JSON) becomes a bare 502.
 */
export function serveGate(o: ServeOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: o.port,
    hostname: o.hostname,
    maxRequestBodySize: MAX_BODY,
    development: false,
    fetch: createGate(o),
    error(err) {
      o.log(`failed: ${err.name}`)
      return new Response('bad gateway\n', { status: 502, headers: { 'Content-Type': 'text/plain' } })
    }
  })
}
