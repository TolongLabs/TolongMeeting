import { controlState } from '../../../../../lib/meeting'
import { requireMember } from '../../../../../lib/session'

/**
 * `{ state }` of one of the signed-in member's meetings, for the page that waits for the bot to leave. A meeting that
 * is not theirs, and an id that is no meeting, get the same 404.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const scope = await requireMember()
  const { id } = await ctx.params
  const found = await controlState(scope, id)
  if (found === null)
    return Response.json({ error: 'not found' }, { status: 404, headers: { 'cache-control': 'no-store' } })
  return Response.json(found, { headers: { 'cache-control': 'no-store' } })
}
