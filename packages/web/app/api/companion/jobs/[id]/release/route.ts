import { handleReleaseRequest, localDeps } from '../../../../../../lib/companion/local'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC gives back a job it holds without finishing it; the attempt count does not change. */
export const POST = withDevice(async (_request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleReleaseRequest(scope, localDeps(), (await ctx.params).id)
)
