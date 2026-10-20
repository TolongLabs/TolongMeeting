import { afterEach, expect, test } from 'bun:test'
import type { SigninHeartbeat } from '@tm/core'
import { signinPoster } from '../src/signin/post'

const hb: SigninHeartbeat = { sessionId: '11111111-1111-4111-8111-111111111111', idleMs: 5, ended: false }
const servers: { stop(force: boolean): void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function serve(answer: (req: Request, body: unknown) => Response) {
  const seen: { path: string; auth: string | null; body: unknown }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = await req.json()
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body })
      return answer(req, body)
    }
  })
  servers.push(server)
  return { seen, url: `http://127.0.0.1:${server.port}/api/control` }
}

test('a report goes to <control>/signin with the token as the bearer, and the commands come back', async () => {
  const s = serve(() => Response.json({ commands: ['stop'] }))
  const post = signinPoster({ url: s.url, token: 'T0KEN' })
  expect(await post(hb)).toEqual({ commands: ['stop'] })
  expect(s.seen).toEqual([{ path: '/api/control/signin', auth: 'Bearer T0KEN', body: hb }])
})

test('a refused or invalid reply is an error that carries neither the token nor the URL', async () => {
  const refused = serve(() => new Response(null, { status: 401 }))
  const bad = serve(() => Response.json({ commands: ['explode'] }))
  const text = serve(() => new Response('not json'))
  const big = serve(() => new Response('x'.repeat(20_000)))
  for (const [s, message] of [
    [refused, 'refused (401)'],
    [bad, 'not valid'],
    [text, 'not JSON'],
    [big, 'too long']
  ] as const) {
    const error = await signinPoster({ url: s.url, token: 'T0KEN' })(hb).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toContain('T0KEN')
    expect((error as Error).message).not.toContain('127.0.0.1')
  }
})

test('a server that cannot be reached is an error without the URL', async () => {
  const s = serve(() => Response.json({ commands: [] }))
  const url = s.url
  servers.pop()!.stop(true)
  const error = await signinPoster({ url, token: 'T0KEN' })(hb).catch((e: Error) => e)
  expect((error as Error).message).toContain('not delivered')
  expect((error as Error).message).not.toContain('127.0.0.1')
})

test('a control URL that is not https is refused before any token is sent', () => {
  expect(() => signinPoster({ url: 'http://tolong.example.com/api/control', token: 'T0KEN' })).toThrow('https')
})
