import { authoriseVncRequest, vncDeps } from '../../../../lib/control'

/** Caddy's `forward_auth` target for `/vnc/<sessionId>/...`. The member and the session are checked in `authoriseVnc`. */
export async function GET(request: Request): Promise<Response> {
  return authoriseVncRequest(request, vncDeps())
}
