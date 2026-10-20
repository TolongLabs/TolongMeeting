'use server'

import { formatWhen, MAX_DEVICES_PER_MEMBER } from '@tm/core'
import { redirect } from 'next/navigation'
import {
  createPairingCode,
  DeviceLimitError,
  NtfyNotSetUpError,
  revokeDevice,
  TooManyCodesError
} from '../../lib/companion/tokens'
import { getQueue } from '../../lib/queue'
import { requireMember } from '../../lib/session'
import type { PairState } from './pair-state'

// Server actions: public endpoints, so each gets the member from the session and never from client input. The pairing
// code is returned to the form that asked and nowhere else. Every refusal is a fixed sentence.

/** Makes a new pairing code (the earlier unused ones stop working) and returns it with the time it stops working. */
export async function pairCodeAction(): Promise<PairState> {
  const scope = await requireMember()
  try {
    const { code, expiresAt } = await createPairingCode(scope)
    return { status: 'created', code, validUntil: formatWhen(expiresAt, (await scope.me()).timeZone) }
  } catch (e) {
    if (e instanceof NtfyNotSetUpError)
      return { status: 'error', message: 'Set up notifications first. A paired PC needs your notification topic.' }
    if (e instanceof DeviceLimitError)
      return {
        status: 'error',
        message: `You already have ${MAX_DEVICES_PER_MEMBER} PCs paired. Remove one first.`
      }
    if (e instanceof TooManyCodesError)
      return { status: 'error', message: 'You asked for too many codes. Wait 10 minutes and try again.' }
    throw e
  }
}

/** Removes the PC named by the form (`id`) and goes back to the page. Another member's PC is the same "not found". */
export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const scope = await requireMember()
  const id = formData.get('id')
  const revoked = typeof id === 'string' && (await revokeDevice(scope, id, new Date(), await getQueue()))
  redirect(`/devices?notice=${revoked ? 'revoked' : 'not-found'}`)
}
