import { failDeps, handleFailRequest } from '../../../../../../lib/companion/native'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC could not finish the job it holds (native transcription or a local run). */
export const POST = withDevice(async (request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleFailRequest(request, scope, failDeps(), (await ctx.params).id)
)
