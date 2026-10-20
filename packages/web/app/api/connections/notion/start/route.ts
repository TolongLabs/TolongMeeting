import { notionStartResponse } from '../../../../../lib/notion'
import { assertSameOriginRead } from '../../../../../lib/same-origin-read'
import { requireMember } from '../../../../../lib/session'

/** Starts the Notion sign-in for the signed-in member. */
export async function GET(request: Request): Promise<Response> {
  const refused = assertSameOriginRead(request)
  if (refused) return refused
  return notionStartResponse(await requireMember())
}
