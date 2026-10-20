import { exportFileResponse } from '../../../../../lib/export-files'
import { exportStores } from '../../../../../lib/exports'
import { requireMember } from '../../../../../lib/session'

/**
 * The file of a finished download export (zip or PDF) of the signed-in member. Every refusal is the same 404: another
 * member's export, a deleted meeting, an export that is not done, a missing or refused file.
 */
export async function GET(request: Request, ctx: { params: Promise<{ exportId: string }> }): Promise<Response> {
  const stores = exportStores(await requireMember())
  return exportFileResponse(stores, (await ctx.params).exportId, request)
}
