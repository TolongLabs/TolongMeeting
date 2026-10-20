import { notionParentsResponse } from '../../../../../lib/notion'
import { assertSameOriginRead } from '../../../../../lib/same-origin-read'
import { requireMember } from '../../../../../lib/session'

/** The pages and databases shared with the integration, for the member to choose a parent from. */
export async function GET(request: Request): Promise<Response> {
  const refused = assertSameOriginRead(request)
  if (refused) return refused
  return notionParentsResponse(await requireMember())
}
