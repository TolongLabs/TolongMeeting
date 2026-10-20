import { describe, expect, test } from 'bun:test'
import { CompanionApi, CompanionApiError, InvalidResponseError } from '../src/api'

function apiWith(respond: (r: Request) => Response, seen: Request[] = []) {
  const f = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(request)
      return respond(request)
    },
    { preconnect: () => {} }
  ) as typeof fetch
  return new CompanionApi({
    serverUrl: 'https://tm.example',
    token: async () => 'tmd_x',
    onRevoked: () => {},
    fetch: f
  })
}

describe('local run endpoints', () => {
  test('identities asks with the device token and checks the answer', async () => {
    const seen: Request[] = []
    const answer = { identities: [{ id: 'i1', name: 'Alice' }], image: 'ghcr.io/tl/tolongmeeting-worker:1.0.0' }
    const api = apiWith(() => Response.json(answer), seen)
    expect(await api.identities()).toEqual(answer)
    expect(seen[0]!.url).toBe('https://tm.example/api/companion/identities')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tmd_x')
    await expect(
      apiWith(() => Response.json({ identities: [], image: '--privileged' })).identities()
    ).rejects.toBeInstanceOf(InvalidResponseError)
  })
  test('preflight posts the report as JSON and expects 204', async () => {
    const seen: Request[] = []
    const api = apiWith(() => new Response(null, { status: 204 }), seen)
    await api.preflight('j1', { reason: 'docker_memory_low', dockerMemBytes: 2_000_000_000 })
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe('https://tm.example/api/companion/jobs/j1/preflight')
    expect(await seen[0]!.json()).toEqual({ reason: 'docker_memory_low', dockerMemBytes: 2_000_000_000 })
    await expect(
      apiWith(() => new Response(null, { status: 404 })).preflight('j1', { reason: 'ok', dockerMemBytes: 1 })
    ).rejects.toBeInstanceOf(CompanionApiError)
  })
})
