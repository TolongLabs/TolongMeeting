import { handlePreflightRequest, localRunDeps } from '../../../../../../lib/companion/local-runs'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC says whether it can start the meeting (Docker running, enough memory, image pulled). */
export const POST = withDevice(async (request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handlePreflightRequest(request, scope, await localRunDeps(), (await ctx.params).id)
)
