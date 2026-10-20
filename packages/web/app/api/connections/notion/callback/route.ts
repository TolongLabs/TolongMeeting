import { notionCallbackResponse } from '../../../../../lib/notion'
import { requireMember } from '../../../../../lib/session'

/** Where Notion sends the browser back. Cross-site by nature: the sealed state is the check. */
export async function GET(request: Request): Promise<Response> {
  return notionCallbackResponse(await requireMember(), request)
}
