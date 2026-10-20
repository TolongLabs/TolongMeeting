import { createExportResponse, exportStores, listExportsResponse } from '../../../../../lib/exports'
import { assertSameOrigin } from '../../../../../lib/same-origin'
import { requireMember } from '../../../../../lib/session'

type Ctx = { params: Promise<{ id: string }> }

/** The exports of one of the signed-in member's meetings. Another member's meeting and a deleted one are the same 404. */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const stores = exportStores(await requireMember())
  return listExportsResponse(stores, (await ctx.params).id)
}

/** Queues an export, `{ target }`. Cookie-authenticated, so the request must be same-origin. */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const stores = exportStores(await requireMember())
  return createExportResponse(stores, (await ctx.params).id, request)
}
