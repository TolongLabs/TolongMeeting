import { handleSigninRequest, signinDeps } from '../../../../lib/control'

/** The sign-in container's report. The token is checked in `handleSigninHeartbeat`, not here. */
export async function POST(request: Request): Promise<Response> {
  return handleSigninRequest(request, signinDeps())
}
