import { googleCallbackResponse } from '../../../../../lib/google'
import { requireMember } from '../../../../../lib/session'

/** Where Google sends the browser back. Cross-site by nature: the sealed state and PKCE verifier are the check. */
export async function GET(request: Request): Promise<Response> {
  return googleCallbackResponse(await requireMember(), request)
}
