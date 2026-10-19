import { memberFile, notFound, serveFile } from '../../../../../../lib/files'
import { requireMember } from '../../../../../../lib/session'

/**
 * A file of one of the signed-in member's meetings. The path is resolved only through `memberFile`: the artefact must
 * belong to the member, and the real file must sit inside the occurrence directory. Every refusal is the same 404.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; path: string[] }> }
): Promise<Response> {
  const scope = await requireMember()
  const { id, path } = await ctx.params
  const file = await memberFile(scope, id, path.join('/'))
  if (file === null) return notFound()
  return serveFile(file, request.headers.get('range'))
}
