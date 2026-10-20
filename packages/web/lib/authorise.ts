import { APIError } from 'better-auth/api'
import { GitHubTokenError, type GitHubApi } from './github'
import type { AuthScope } from './scope'

export interface AuthoriseDeps {
  github: GitHubApi
  auth: AuthScope
  org: string
  /** Where `checkMemberships` reports a member it could not check (default `console.error`). Never receives a token. */
  log?: (message: string) => void
}

export const NOT_A_MEMBER = 'Not an active TolongLabs member. Ask an admin to add you.'

/** The `code` of the refusal. Better Auth turns an `APIError` with a code into a redirect to `/sign-in?error=<code>`. */
export const NOT_A_MEMBER_CODE = 'NOT_A_MEMBER'

/** The member this GitHub user is, or `null` for a refusal. Throws when GitHub or the database fails. */
async function findMember(deps: AuthoriseDeps, authUserId: string): Promise<{ id: string; githubId: number } | null> {
  const { github, auth, org } = deps
  const token = await auth.githubToken(authUserId)
  if (!token) return null
  let user: { id: number; login: string }
  let status: 'active' | 'pending' | 'none'
  try {
    user = await github.user(token)
    status = await github.orgMembership(token, org)
  } catch (error) {
    if (error instanceof GitHubTokenError) return null
    throw error
  }
  if (status !== 'active') return null
  const member = await auth.memberForGithub(user.id, user.login)
  return member ? { id: member.id, githubId: user.id } : null
}

/**
 * Runs before Better Auth stores a session. Allows it only for a GitHub user whom an admin added (`add-member`) and who
 * is an active member of the organisation, and links that member to the auth user. Anything else throws a 403 with code
 * `NOT_A_MEMBER` and no session exists, so `scopeForAuthUser` finds no member and no data is reachable.
 *
 * A refusal ends every session of that auth user (a linked member who left the organisation), and deletes the auth user
 * when no member is linked, so a non-member's GitHub token is not kept. A GitHub or database failure is raised as it is
 * (not as a refusal); it also deletes an unlinked auth user but leaves a linked member's sessions alone.
 */
export async function authoriseSession(deps: AuthoriseDeps, authUserId: string): Promise<void> {
  const { auth } = deps
  const member = await findMember(deps, authUserId).catch(async (error: unknown) => {
    await auth.discardUnlinkedUser(authUserId)
    throw error
  })
  if (!member) {
    await auth.endSessions(authUserId)
    await auth.discardUnlinkedUser(authUserId)
    throw new APIError('FORBIDDEN', { message: NOT_A_MEMBER, code: NOT_A_MEMBER_CODE })
  }
  await auth.linkMember(member.id, member.githubId, authUserId)
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
}

/**
 * The daily check: ends the sessions of every linked member who left the organisation (or never was active) or whose
 * GitHub token is revoked. Returns the member ids it ended. A failure for one member (a GitHub outage or rate limit, or
 * a token that can't be decrypted) is logged by member id without any token, leaves that member's sessions in place, and
 * is raised after the rest have been checked, so one failure can't leave the others' access in place.
 */
export async function checkMemberships(deps: AuthoriseDeps): Promise<{ ended: string[] }> {
  const { github, auth, org } = deps
  const log = deps.log ?? ((message: string) => console.error(message))
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
      log(`Organisation check failed for member ${memberId}: ${describe(error)}`)
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
