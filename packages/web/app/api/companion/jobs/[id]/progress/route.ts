import { handleProgressRequest } from '../../../../../../lib/companion/jobs'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC says it is still working on a job, which renews its lease. */
export const POST = withDevice(async (request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleProgressRequest(request, scope, (await ctx.params).id)
)
