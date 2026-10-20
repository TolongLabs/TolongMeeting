import { handleClaimRequest } from '../../../../../../lib/companion/jobs'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC takes a job. Only one device can win it. */
export const POST = withDevice(async (_request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleClaimRequest(scope, (await ctx.params).id)
)
