import { pairDeps } from '../../../../lib/companion/deps'
import { handlePairRequest } from '../../../../lib/companion/tokens'

/** A PC trades a pairing code for its device token. No session: the code is the credential (see `handlePairRequest`). */
export async function POST(request: Request): Promise<Response> {
  return handlePairRequest(request, pairDeps())
}
