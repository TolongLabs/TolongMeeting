import { handleOpenSigninRequest } from '../../../../../lib/run-locations/signin'
import { assertSameOrigin } from '../../../../../lib/same-origin'
import { requireMember } from '../../../../../lib/session'

/**
 * Asks the member's own PC to open the sign-in view for one of their identities. Cookie-authenticated, so the request
 * must be same-origin. It only queues a command for the PC the identity is bound to; it never reaches another PC.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const scope = await requireMember()
  return handleOpenSigninRequest(scope, (await ctx.params).id)
}
