import { googleStartResponse } from '../../../../../lib/google'
import { assertSameOriginRead } from '../../../../../lib/same-origin-read'
import { requireMember } from '../../../../../lib/session'

/** Starts the Google sign-in for the signed-in member (scope `drive.file` only). */
export async function GET(request: Request): Promise<Response> {
  const refused = assertSameOriginRead(request)
  if (refused) return refused
  return googleStartResponse(await requireMember())
}
