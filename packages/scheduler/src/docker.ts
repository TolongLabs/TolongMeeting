import type { CreateBody } from './container-spec'

/** The four Docker calls the launcher makes. Each one passes through the gate in `docker-gate/`. */
export interface DockerClient {
  /** Creates a container with this name and body; resolves to its id. */
  create(name: string, body: CreateBody): Promise<string>
  start(id: string): Promise<void>
  stop(id: string, timeoutS: number): Promise<void>
  /** `null` when Docker has no such container (it exited and `AutoRemove` removed it). */
  inspect(id: string): Promise<{ running: boolean } | null>
}

/** A refused or failed Docker call. The message carries the call, the status and Docker's own short message only. */
export class DockerError extends Error {
  readonly status: number

  constructor(call: string, status: number, detail: string) {
    super(`docker ${call} failed (${status})${detail ? `: ${detail}` : ''}`)
    this.name = 'DockerError'
    this.status = status
  }
}

async function failure(call: string, res: Response): Promise<DockerError> {
  const text = await res.text().catch(() => '')
  let message = ''
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message.slice(0, 200)
  } catch {
    // The gate answers some refusals as plain text; keep the text out of the message.
  }
  return new DockerError(call, res.status, message)
}

/** How long a Docker call may take before it counts as failed. */
export type DockerTimeouts = {
  /** `inspect`, `stop`; default 10 s. */
  quickMs: number
  /** `create`, `start` (a slow image or a busy host); default 60 s. */
  slowMs: number
}

export const DEFAULT_DOCKER_TIMEOUTS: DockerTimeouts = { quickMs: 10_000, slowMs: 60_000 }

/**
 * A `DockerClient` over the Docker socket proxy at `baseUrl` (`DOCKER_PROXY_URL`). Every request is aborted after its
 * timeout and an unreachable proxy or a timeout is a `DockerError` with status 0. `fetchFn` and `timeouts` are for tests.
 */
export function dockerClient(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  timeouts: DockerTimeouts = DEFAULT_DOCKER_TIMEOUTS
): DockerClient {
  const root = baseUrl.replace(/\/+$/, '')
  const target = (id: string) => encodeURIComponent(id)

  /** Runs one Docker call, `read` included, inside the request's time limit. */
  async function call<T>(
    name: string,
    ms: number,
    path: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>
  ): Promise<T> {
    try {
      return await read(await fetchFn(`${root}${path}`, { ...init, signal: AbortSignal.timeout(ms) }))
    } catch (e) {
      if (e instanceof DockerError) throw e
      // Only the kind of failure is kept: a fetch error can carry the URL.
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new DockerError(name, 0, timedOut ? `no answer within ${ms} ms` : 'proxy unreachable')
    }
  }
  const post = <T>(name: string, ms: number, path: string, body: unknown, read: (res: Response) => Promise<T>) =>
    call(
      name,
      ms,
      path,
      {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      },
      read
    )

  return {
    create: (name, body) =>
      post('create', timeouts.slowMs, `/containers/create?name=${encodeURIComponent(name)}`, body, async (res) => {
        if (res.status !== 201) throw await failure('create', res)
        const json = (await res.json()) as { Id?: unknown }
        if (typeof json.Id !== 'string' || json.Id === '')
          throw new DockerError('create', res.status, 'no container id')
        return json.Id
      }),
    start: (id) =>
      post('start', timeouts.slowMs, `/containers/${target(id)}/start`, undefined, async (res) => {
        // 304: already started.
        if (res.status !== 204 && res.status !== 304) throw await failure('start', res)
      }),
    stop: (id, timeoutS) =>
      post(
        'stop',
        timeouts.quickMs,
        `/containers/${target(id)}/stop?t=${Math.trunc(timeoutS)}`,
        undefined,
        async (res) => {
          // 304: already stopped.
          if (res.status !== 204 && res.status !== 304) throw await failure('stop', res)
        }
      ),
    inspect: (id) =>
      call('inspect', timeouts.quickMs, `/containers/${target(id)}/json`, {}, async (res) => {
        if (res.status === 404) {
          await res.body?.cancel()
          return null
        }
        if (res.status !== 200) throw await failure('inspect', res)
        const json = (await res.json()) as { State?: { Running?: unknown } }
        return { running: json.State?.Running === true }
      })
  }
}

/** A Docker that records its calls instead of making them. Nothing here creates a real container. */
export class FakeDocker implements DockerClient {
  readonly created: { id: string; name: string; body: CreateBody }[] = []
  readonly started: string[] = []
  readonly stopped: { id: string; timeoutS: number }[] = []
  /** What `inspect` answers per id or name. An id not in the map is running once started and unknown before. */
  readonly inspectResults = new Map<string, { running: boolean } | null>()
  /** When set, `create` rejects with it. */
  createError: Error | null = null
  /** When set, `start` rejects with it. */
  startError: Error | null = null

  async create(name: string, body: CreateBody): Promise<string> {
    if (this.createError) throw this.createError
    const id = `fake-${this.created.length + 1}`
    this.created.push({ id, name, body })
    return id
  }

  async start(id: string): Promise<void> {
    if (this.startError) throw this.startError
    this.started.push(id)
  }

  async stop(id: string, timeoutS: number): Promise<void> {
    this.stopped.push({ id, timeoutS })
  }

  async inspect(id: string): Promise<{ running: boolean } | null> {
    if (this.inspectResults.has(id)) return this.inspectResults.get(id)!
    const known = this.created.some((c) => c.id === id || c.name === id)
    return known ? { running: true } : null
  }
}
