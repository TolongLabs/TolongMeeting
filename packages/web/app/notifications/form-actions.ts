'use server'

import { redirect } from 'next/navigation'
import { NtfyAdminError } from '../../lib/ntfy-admin'
import { requireMember } from '../../lib/session'
import { ensureNtfyAction, sendTestPingAction } from './actions'

// The notification page's buttons. They take no input and get the member from the session. Neither puts the ntfy token
// or the topic in a redirect.

/** Creates the member's ntfy topic, then goes back to the page. A refusal from ntfy is told in one fixed sentence. */
export async function setUpNotificationsFormAction(): Promise<void> {
  await requireMember()
  try {
    await ensureNtfyAction()
  } catch (e) {
    if (!(e instanceof NtfyAdminError)) throw e
    redirect('/notifications?notice=setup-failed')
  }
  redirect('/notifications?notice=ready')
}

/** Sends the test ping, then goes back to the page, which says whether it went out. */
export async function sendTestPingFormAction(): Promise<void> {
  await requireMember()
  const { ok } = await sendTestPingAction()
  redirect(`/notifications?notice=${ok ? 'ping-sent' : 'ping-failed'}`)
}
