import { handleEventsRequest } from '../../../../lib/companion/sse'
import { withDevice } from '../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The PC's command stream (server-sent events). */
export const GET = withDevice(async (request, scope) => handleEventsRequest(request, scope))
