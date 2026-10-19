import { APIError } from 'better-auth/api'
import { GitHubTokenError, type GitHubApi } from './github'
import type { AuthScope } from './scope'

export interface AuthoriseDeps {
  github: GitHubApi
  auth: AuthScope
  org: string
}

export const NOT_A_MEMBER = 'Not an active TolongLabs member. Ask an admin to add you.'

function refuse(): never {
  throw new APIError('FORBIDDEN', { message: NOT_A_MEMBER })
}

/**
 * Runs before Better Auth stores a session. Allows it only for a GitHub user whom an admin added (`add-member`) and who
 * is an active member of the organisation, and links that member to the auth user. Anything else throws a 403 and no
 * session exists, so `scopeForAuthUser` finds no member and no data is reachable.
 */
export async function authoriseSession(deps: AuthoriseDeps, authUserId: string): Promise<void> {
  const { github, auth, org } = deps
  const token = await auth.githubToken(authUserId)
  if (!token) return refuse()
  let user: { id: number; login: string }
  let status: 'active' | 'pending' | 'none'
  try {
    user = await github.user(token)
    status = await github.orgMembership(token, org)
  } catch (error) {
    if (error instanceof GitHubTokenError) return refuse()
    throw error
  }
  if (status !== 'active') return refuse()
  const member = await auth.memberForGithub(user.id, user.login)
  if (!member) return refuse()
  await auth.linkMember(member.id, user.id, authUserId)
}

/**
 * The daily check: ends the sessions of every linked member who left the organisation (or never was active) or whose
 * GitHub token is revoked. Returns the member ids it ended. A GitHub failure for one member is raised after the rest
 * have been checked, so one outage can't leave the others' access in place.
 */
export async function checkMemberships(deps: AuthoriseDeps): Promise<{ ended: string[] }> {
  const { github, auth, org } = deps
  const ended: string[] = []
  const failures: unknown[] = []
  for (const { memberId, authUserId } of await auth.linkedMembers()) {
    try {
      const token = await auth.githubToken(authUserId)
      let keep = false
      if (token) {
        try {
          await github.user(token)
          keep = (await github.orgMembership(token, org)) === 'active'
        } catch (error) {
          if (!(error instanceof GitHubTokenError)) throw error
        }
      }
      if (!keep) {
        await auth.endSessions(authUserId)
        ended.push(memberId)
      }
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Organisation check failed for ${failures.length} member(s); the rest were checked`
    )
  }
  return { ended }
}
