import { withDevice } from '../../../../../lib/companion/scope'
import { handleSummaryRequest } from '../../../../../lib/companion/summaries'

export const dynamic = 'force-dynamic'

/** One summary as Markdown. */
export const GET = withDevice(async (_request, scope, ctx: { params: Promise<{ occurrenceId: string }> }) =>
  handleSummaryRequest(scope, (await ctx.params).occurrenceId)
)
