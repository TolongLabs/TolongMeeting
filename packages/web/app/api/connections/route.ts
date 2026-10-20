import { connectionsResponse, exportStores } from '../../../lib/exports'
import { requireMember } from '../../../lib/session'

/** The signed-in member's export connections as a masked status. A token never leaves the server. */
export async function GET(): Promise<Response> {
  return connectionsResponse(exportStores(await requireMember()))
}
