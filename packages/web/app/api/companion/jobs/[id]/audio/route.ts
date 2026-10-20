import { handleAudioRequest } from '../../../../../../lib/companion/native'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC downloads the cut audio of a recording it holds the job for. Supports `Range`. */
export const GET = withDevice(async (request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleAudioRequest(request, scope, (await ctx.params).id)
)
