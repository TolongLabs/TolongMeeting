import { googlePickerResponse } from '../../../../../lib/google'
import { assertSameOriginRead } from '../../../../../lib/same-origin-read'
import { requireMember } from '../../../../../lib/session'

/** The Picker's access token, API key and app id for the signed-in member. Never cached. */
export async function GET(request: Request): Promise<Response> {
  const refused = assertSameOriginRead(request)
  if (refused) return refused
  return googlePickerResponse(await requireMember())
}
