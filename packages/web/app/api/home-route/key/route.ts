import { handleKeyRequest, homeRouteDeps } from '../../../../lib/home-route'
import { requireMember } from '../../../../lib/session'

/** A single-use setup key for the signed-in member's home device. */
export async function POST(request: Request): Promise<Response> {
  return handleKeyRequest(request, await requireMember(), homeRouteDeps())
}
