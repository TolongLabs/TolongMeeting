'use server'

import { getDb } from '../../db/index'
import { appNotifier } from '../../db/notifier'
import { loadMasterKey } from '../../db/secrets'
import { ensureNtfy, ntfyAdminFromEnv, sendTestPing } from '../../lib/ntfy-admin'
import { requireMember } from '../../lib/session'

// Server actions: public endpoints, so each gets the member from the session and never from client input. The ntfy
// token is never returned; the topic is the only ntfy detail the client receives.

/** Creates the member's ntfy user, topic and token on first use, and returns the topic. */
export async function ensureNtfyAction(): Promise<{ topic: string }> {
  const scope = await requireMember()
  return ensureNtfy(getDb(), scope, ntfyAdminFromEnv(), loadMasterKey())
}

/** Sends the member's test ping to their topic. `ok` is false when the ping did not go out (the reason is logged). */
export async function sendTestPingAction(): Promise<{ ok: boolean }> {
  const scope = await requireMember()
  return { ok: await sendTestPing(scope, appNotifier()) }
}
