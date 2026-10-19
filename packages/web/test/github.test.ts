import { expect, test } from 'bun:test'
import { githubApi, GitHubTokenError } from '../lib/github'

type Call = { url: string; headers: Record<string, string> }

function fake(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: Call[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> })
    return new Response(JSON.stringify(body), { status, headers })
  }) as typeof fetch
  return { api: githubApi(fetchFn), calls }
}

test('user() asks GitHub for the signed-in user with the documented headers', async () => {
  const { api, calls } = fake(200, { id: 42, login: 'octo', node_id: 'ignored' })
  expect(await api.user('gho_secret')).toEqual({ id: 42, login: 'octo' })
  expect(calls).toEqual([
    {
      url: 'https://api.github.com/user',
      headers: {
        Authorization: 'Bearer gho_secret',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  ])
})

test('orgMembership() reads the state and keeps the token out of the URL', async () => {
  const active = fake(200, { state: 'active' })
  expect(await active.api.orgMembership('gho_secret', 'tolonglabs')).toBe('active')
  expect(active.calls[0]!.url).toBe('https://api.github.com/user/memberships/orgs/tolonglabs')
  expect(fake(200, { state: 'pending' }).api.orgMembership('t', 'o')).resolves.toBe('pending')
})

test('403 and 404 mean no membership', async () => {
  expect(await fake(404).api.orgMembership('t', 'o')).toBe('none')
  expect(await fake(403).api.orgMembership('t', 'o')).toBe('none')
})

test('a 403 that is the rate limit is an outage, not "none"', async () => {
  await expect(fake(403, {}, { 'x-ratelimit-remaining': '0' }).api.orgMembership('t', 'o')).rejects.toThrow(
    'rate limited'
  )
  await expect(fake(403, {}, { 'retry-after': '60' }).api.orgMembership('t', 'o')).rejects.toThrow('rate limited')
  expect(await fake(403, {}, { 'x-ratelimit-remaining': '4999' }).api.orgMembership('t', 'o')).toBe('none')
})

test('401 throws GitHubTokenError without the token in the message', async () => {
  const { api } = fake(401)
  const error = await api.orgMembership('gho_secret', 'o').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(GitHubTokenError)
  expect(String((error as Error).message)).not.toContain('gho_secret')
  await expect(api.user('gho_secret')).rejects.toBeInstanceOf(GitHubTokenError)
})

test('any other failure throws, and a malformed body is not trusted', async () => {
  await expect(fake(500).api.user('t')).rejects.toThrow('status 500')
  await expect(fake(502).api.orgMembership('t', 'o')).rejects.toThrow('status 502')
  await expect(fake(200, { id: 'x' }).api.user('t')).rejects.toThrow()
})
