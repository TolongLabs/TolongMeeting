import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

// An OpenAI-compatible /chat/completions endpoint that answers every request with `reply` (as the message content, in
// JSON) after `delayMs`. `requests` holds the parsed body of each request that arrived.
export async function startModelStub(opts: {
  delayMs: number
  reply: unknown
}): Promise<{ url: string; requests: unknown[]; close(): Promise<void> }> {
  const requests: unknown[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const body = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    body(req).then(
      (parsed) => {
        requests.push(parsed)
        const timer = setTimeout(() => {
          timers.delete(timer)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(opts.reply) } }] }))
        }, opts.delayMs)
        timers.add(timer)
      },
      () => res.writeHead(400).end()
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}
