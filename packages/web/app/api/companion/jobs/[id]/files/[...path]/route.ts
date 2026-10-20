import { handleFilesRequest, localRunDeps } from '../../../../../../../lib/companion/local-runs'
import { withDevice } from '../../../../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; path: string[] }> }

const files = withDevice(async (request, scope, ctx: Ctx) => {
  const { id, path } = await ctx.params
  return handleFilesRequest(request, scope, await localRunDeps(), id, path)
})

/** How many bytes of this file the website holds (header `Upload-Offset`). */
export const HEAD = files
/** One chunk of a file of the local run, at the website's offset (`Content-Range`). */
export const PUT = files
