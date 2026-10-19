import { loadMasterKey } from '@tm/web/db/secrets'
import { checkMemberships } from '@tm/web/lib/authorise'
import { githubApi, type GitHubApi } from '@tm/web/lib/github'
import { authScope } from '@tm/web/lib/scope'

export { checkMemberships }

/**
 * The daily check on the real database and GitHub: `DATABASE_URL`, `GITHUB_ORG` and `TM_MASTER_KEY_FILE` come from the
 * environment (the master key opens the stored GitHub tokens).
 */
export async function runOrgCheck(
  github: GitHubApi = githubApi(),
  master: Buffer = loadMasterKey()
): Promise<{ ended: string[] }> {
  const org = process.env.GITHUB_ORG
  if (!org) throw new Error('GITHUB_ORG is not set')
  return checkMemberships({ github, auth: authScope(master), org })
}
