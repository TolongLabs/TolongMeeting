import { notFound, openMemberFile, serveFile } from '../../../../../../lib/files'
import { requireMember } from '../../../../../../lib/session'

/**
 * A file of one of the signed-in member's meetings. The file is opened only through `openMemberFile`: the artefact must
 * belong to the member, and the open descriptor must be a regular file inside the occurrence directory. Every refusal is
 * the same 404. The handle is closed when the response ends or the request is aborted.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; path: string[] }> }
): Promise<Response> {
  const scope = await requireMember()
  const { id, path } = await ctx.params
  const file = await openMemberFile(scope, id, path.join('/'))
  if (file === null) return notFound()
  return serveFile(file, request.headers.get('range'), request.signal)
}
