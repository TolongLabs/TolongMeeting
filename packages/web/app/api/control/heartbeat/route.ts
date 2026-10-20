import { controlDeps, handleHeartbeatRequest } from '../../../../lib/control'

/** The worker's heartbeat. The token is checked in `handleHeartbeat`, not here. */
export async function POST(request: Request): Promise<Response> {
  return handleHeartbeatRequest(request, await controlDeps())
}
