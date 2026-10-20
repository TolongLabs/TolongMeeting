import { handleHeartbeatRequest, localRunDeps } from '../../../../../../lib/companion/local-runs'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC forwards the heartbeat of the local worker it runs. */
export const POST = withDevice(async (request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleHeartbeatRequest(request, scope, await localRunDeps(), (await ctx.params).id)
)
