'use server'

import { getQueue } from '../../../../lib/queue'
import { requireMember } from '../../../../lib/session'
import {
  finishSignin,
  signinStatus,
  startSignin,
  vncPassword,
  type SigninMode,
  type SigninState
} from '../../../../lib/signin'

// Server actions: public endpoints, so each gets the member from the session and never from client input. A session
// that is not the member's is indistinguishable from a missing one (a `SigninError` with a fixed message).

/** Starts a sign-in for one of the member's identities, or returns the one already open. */
export async function startSigninAction(identityId: string): Promise<{ sessionId: string; mode: SigninMode }> {
  const scope = await requireMember()
  return startSignin(scope, identityId, { queue: await getQueue() })
}

/** The "Done" button. */
export async function finishSigninAction(sessionId: string): Promise<void> {
  const scope = await requireMember()
  await finishSignin(scope, sessionId)
}

/** What the viewer polls every 2 seconds. */
export async function signinStatusAction(sessionId: string): Promise<SigninState> {
  const scope = await requireMember()
  return signinStatus(scope, sessionId)
}

/** The password for noVNC, once the member's session is ready. It never goes in a URL. */
export async function vncPasswordAction(sessionId: string): Promise<string> {
  const scope = await requireMember()
  return vncPassword(scope, sessionId)
}
