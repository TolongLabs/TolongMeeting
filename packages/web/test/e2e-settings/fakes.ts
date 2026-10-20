// The servers the settings pages talk to in the browser tests: a fake ntfy, and a fake DashScope and ModelScope. A key
// that contains "bad" is rejected with 401; any other key passes.

export interface Fakes {
  ntfyOrigin: string
  providersOrigin: string
  stop(): void
}

export function startFakes(): Fakes {
  const received: unknown[] = []

  const ntfy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (req.method === 'GET' && pathname === '/__pings') return Response.json(received)
      if (req.method === 'POST' && pathname === '/v1/users') return Response.json({})
      if (req.method === 'PUT' && pathname === '/v1/users/access') return Response.json({})
      if (req.method === 'POST' && pathname === '/v1/account/token')
        return Response.json({ token: 'tk_e2e_secret_token' })
      if (req.method === 'POST' && pathname === '/') {
        // A publish: only the sealed-token header and the message are kept, so the spec can check them.
        const body = (await req.json()) as { topic: string; title: string }
        received.push({ topic: body.topic, title: body.title, auth: req.headers.get('authorization') })
        return Response.json({})
      }
      return new Response('not found', { status: 404 })
    }
  })

  const providers = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const { pathname } = new URL(req.url)
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      if (key.includes('bad')) return new Response('{}', { status: 401 })
      if (pathname === '/dashscope/chat/completions') {
        return Response.json({ choices: [{ message: { content: 'OK' } }] })
      }
      if (pathname === '/modelscope/models') return Response.json({ data: [] })
      return new Response('not found', { status: 404 })
    }
  })

  return {
    ntfyOrigin: `http://127.0.0.1:${ntfy.port}`,
    providersOrigin: `http://127.0.0.1:${providers.port}`,
    stop() {
      void ntfy.stop(true)
      void providers.stop(true)
    }
  }
}
