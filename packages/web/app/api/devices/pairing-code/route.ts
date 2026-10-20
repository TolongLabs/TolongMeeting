import { handlePairingCodeRequest } from '../../../../lib/companion/tokens'
import { requireMember } from '../../../../lib/session'

/** A new pairing code for the signed-in member. */
export async function POST(request: Request): Promise<Response> {
  return handlePairingCodeRequest(request, await requireMember())
}
