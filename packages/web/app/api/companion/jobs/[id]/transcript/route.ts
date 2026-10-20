import { handleTranscriptRequest, nativeDeps } from '../../../../../../lib/companion/native'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC uploads the Whisper output (`txt`, `srt`, `json`) of the job it holds. */
export const POST = withDevice(async (request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleTranscriptRequest(request, scope, await nativeDeps(), (await ctx.params).id)
)
