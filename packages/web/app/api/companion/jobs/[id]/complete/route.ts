import { handleCompleteRequest, localRunDeps } from '../../../../../../lib/companion/local-runs'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC says every file of the local run is uploaded. */
export const POST = withDevice(async (_request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleCompleteRequest(scope, await localRunDeps(), (await ctx.params).id)
)
