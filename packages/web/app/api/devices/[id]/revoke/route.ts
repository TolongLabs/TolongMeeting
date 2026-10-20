import { handleRevokeRequest } from '../../../../../lib/companion/tokens'
import { getQueue } from '../../../../../lib/queue'
import { requireMember } from '../../../../../lib/session'

/** Revokes one of the signed-in member's devices. Its token stops working on the next request. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const scope = await requireMember()
  const { id } = await ctx.params
  return handleRevokeRequest(request, scope, id, await getQueue())
}
