'use server'

import { appNotifier } from '../../db/notifier'
import { loadMasterKey } from '../../db/secrets'
import { ensureNtfy, ntfyAdminFromEnv, revealNtfyToken, sendTestPing } from '../../lib/ntfy-admin'
import { requireMember } from '../../lib/session'

// Server actions: public endpoints, so each gets the member from the session and never from client input. The ntfy
// token leaves the server only in the reply to showNtfyTokenAction, for the member who asked; the topic is the other
// ntfy detail the client receives.

/** Creates the member's ntfy user, topic and token on first use, and returns the topic. */
export async function ensureNtfyAction(): Promise<{ topic: string }> {
  const scope = await requireMember()
  return ensureNtfy(scope, ntfyAdminFromEnv(), loadMasterKey())
}

/** Sends the member's test ping to their topic. `ok` is false when the ping did not go out (the reason is logged). */
export async function sendTestPingAction(): Promise<{ ok: boolean }> {
  const scope = await requireMember()
  return { ok: await sendTestPing(scope, appNotifier()) }
}

/** The member's own ntfy access token, for the "Show token" button. Throws when notifications are not set up yet. */
export async function showNtfyTokenAction(): Promise<string> {
  const scope = await requireMember()
  const token = await revealNtfyToken(scope, loadMasterKey())
  if (token === null) throw new Error('Notifications are not set up')
  return token
}
