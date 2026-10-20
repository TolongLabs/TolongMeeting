import { handleCheckRequest, homeRouteDeps } from '../../../../lib/home-route'
import { requireMember } from '../../../../lib/session'

/** Whether the signed-in member's home device is online and sharing its connection. */
export async function POST(request: Request): Promise<Response> {
  return handleCheckRequest(request, await requireMember(), homeRouteDeps())
}
