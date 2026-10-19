// Local stand-ins for the AI provider and ntfy: real HTTP servers on random ports that record what they receive.
export interface Seen {
  path: string
  headers: Headers
  json: Record<string, any>
}

export interface FakeServer {
  url: string
  requests: Seen[]
  stop(): void
}

export interface FakeAi extends FakeServer {
  // Replies with this JSON content for every chat call (default) or with an HTTP error status.
  reply(content: unknown): void
  fail(status: number): void
  // Rejects calls for one model with this status; other models still get the normal reply.
  failModel(model: string, status: number): void
}

export function startFakeAi(): FakeAi {
  const requests: Seen[] = []
  const failing = new Map<string, number>()
  let mode: { status: number; content: string } = { status: 200, content: '{}' }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ path: new URL(req.url).pathname, headers: req.headers, json: (await req.json()) as any })
      const forModel = failing.get(requests.at(-1)!.json.model)
      if (forModel !== undefined) return new Response('rejected', { status: forModel })
      if (mode.status !== 200) return new Response('rejected', { status: mode.status })
      return Response.json({ choices: [{ message: { content: mode.content } }] })
    }
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    requests,
    stop: () => void server.stop(true),
    reply: (content) => void (mode = { status: 200, content: JSON.stringify(content) }),
    failModel: (model, status) => void failing.set(model, status),
    fail: (status) => void (mode = { status, content: '' })
  }
}

export function startFakeNtfy(): FakeServer {
  const requests: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({ path: new URL(req.url).pathname, headers: req.headers, json: (await req.json()) as any })
      return Response.json({ id: 'x' })
    }
  })
  return { url: `http://localhost:${server.port}`, requests, stop: () => void server.stop(true) }
}
