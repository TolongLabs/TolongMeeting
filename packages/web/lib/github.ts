import { z } from 'zod'

/** Thrown when GitHub rejects a token (revoked, expired or never valid). The message is fixed and carries no token. */
export class GitHubTokenError extends Error {
  constructor() {
    super('GitHub rejected the access token')
    this.name = 'GitHubTokenError'
  }
}

/** The two GitHub calls sign-in and the daily check need. */
export interface GitHubApi {
  user(token: string): Promise<{ id: number; login: string }>
  orgMembership(token: string, org: string): Promise<'active' | 'pending' | 'none'>
}

const API = 'https://api.github.com'
const UserSchema = z.object({ id: z.number().int(), login: z.string().min(1) })
const MembershipSchema = z.object({ state: z.enum(['active', 'pending']) })

/**
 * `GitHubApi` over `fetchFn`. 403 and 404 on the membership call mean "not a member"; 401 throws `GitHubTokenError`. A
 * 403 that is GitHub's rate limit (`x-ratelimit-remaining: 0`, or a `retry-after` header) is an outage, not a removal,
 * so it throws a plain error.
 */
export function githubApi(fetchFn: typeof fetch = fetch): GitHubApi {
  async function get(path: string, token: string): Promise<Response> {
    const res = await fetchFn(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (res.status === 401) throw new GitHubTokenError()
    return res
  }

  return {
    async user(token) {
      const res = await get('/user', token)
      if (!res.ok) throw new Error(`GitHub /user failed with status ${res.status}`)
      return UserSchema.parse(await res.json())
    },

    async orgMembership(token, org) {
      const res = await get(`/user/memberships/orgs/${encodeURIComponent(org)}`, token)
      if (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))) {
        throw new Error('GitHub membership check was rate limited')
      }
      if (res.status === 403 || res.status === 404) return 'none'
      if (!res.ok) throw new Error(`GitHub membership check failed with status ${res.status}`)
      return MembershipSchema.parse(await res.json()).state
    }
  }
}
