import { notionParentResponse } from '../../../../../lib/notion'
import { assertSameOrigin } from '../../../../../lib/same-origin'
import { requireMember } from '../../../../../lib/session'

/** Saves the member's chosen parent, `{ type, id }`. Cookie-authenticated, so the request must be same-origin. */
export async function PUT(request: Request): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  return notionParentResponse(await requireMember(), request)
}
