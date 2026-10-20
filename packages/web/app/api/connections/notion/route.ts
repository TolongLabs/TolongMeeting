import { exportStores, removeConnectionResponse } from '../../../../lib/exports'
import { assertSameOrigin } from '../../../../lib/same-origin'
import { requireMember } from '../../../../lib/session'

/** Removes the member's Notion connection and asks Notion to revoke the access token. Cookie-authenticated, so the request must be same-origin. */
export async function DELETE(request: Request): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  return removeConnectionResponse(exportStores(await requireMember()), 'notion')
}
