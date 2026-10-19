import { checkMemberships } from '@tm/web/lib/authorise'
import { githubApi, type GitHubApi } from '@tm/web/lib/github'
import { authScope } from '@tm/web/lib/scope'

export { checkMemberships }

/** The daily check on the real database and GitHub: `DATABASE_URL` and `GITHUB_ORG` come from the environment. */
export async function runOrgCheck(github: GitHubApi = githubApi()): Promise<{ ended: string[] }> {
  const org = process.env.GITHUB_ORG
  if (!org) throw new Error('GITHUB_ORG is not set')
  return checkMemberships({ github, auth: authScope(), org })
}
