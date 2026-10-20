import { getQueue } from '../../../../../lib/queue'
import { handleRunLocationRequest } from '../../../../../lib/run-locations/settings'
import { requireMember } from '../../../../../lib/session'

/** Moves one of the signed-in member's identities to the server, the server through home, or one of their PCs. */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const scope = await requireMember()
  const { id } = await ctx.params
  return handleRunLocationRequest(request, scope, await getQueue(), id)
}
