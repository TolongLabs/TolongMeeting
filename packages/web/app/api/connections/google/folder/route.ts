import { googleFolderResponse } from '../../../../../lib/google'
import { assertSameOrigin } from '../../../../../lib/same-origin'
import { requireMember } from '../../../../../lib/session'

/** Saves the export folder the member picked (`{ folderId }`) or goes back to the default (`{ useDefault: true }`). */
export async function PUT(request: Request): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  return googleFolderResponse(await requireMember(), request)
}
