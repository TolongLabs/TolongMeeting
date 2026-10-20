import { handleSecretsRequest, localDeps } from '../../../../../../lib/companion/local'
import { withDevice } from '../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC fetches the AI key and saved details of the local run it holds, close to the meeting. */
export const GET = withDevice(async (_request, scope, ctx: { params: Promise<{ id: string }> }) =>
  handleSecretsRequest(scope, localDeps(), (await ctx.params).id)
)
