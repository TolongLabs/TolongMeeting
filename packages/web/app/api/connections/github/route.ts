import { exportStores, removeConnectionResponse, saveGitHubResponse } from '../../../../lib/exports'
import { assertSameOrigin } from '../../../../lib/same-origin'
import { requireMember } from '../../../../lib/session'

/**
 * Saves the member's GitHub connection: `{ owner, repo, branch, folder, token? }`. Cookie-authenticated, so the request
 * must be same-origin. The token is checked against GitHub, sealed for this member and never sent back.
 */
export async function PUT(request: Request): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  return saveGitHubResponse(exportStores(await requireMember()), request)
}

/** Removes the member's GitHub connection. The member deletes the token on GitHub themselves: an app cannot revoke it. */
export async function DELETE(request: Request): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  return removeConnectionResponse(exportStores(await requireMember()), 'github')
}
