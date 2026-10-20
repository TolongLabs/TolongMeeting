import { DEVICE_ONLINE_WINDOW_MS } from '@tm/core'
import { and, eq, gte, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { emitDeviceCommand } from '../../db/local-runs'
import { safeDbError } from '../../db/errors'
import { deviceTokens, identities } from '../../db/schema'
import type { MemberScope } from '../scope'

// "Sign in" for an identity that runs on the member's own PC (plan 08 Task 10). The website cannot reach the PC, so it
// queues an `open_signin` command on that PC's event stream; the companion opens the sign-in view when it reads it.

export type OpenSigninResult = { opened: true; pcName: string } | { opened: false; reason: 'pc_offline' | 'not_local' }

/**
 * Queues `open_signin` for the PC an identity is bound to. `null` when the identity is not the member's (the scope only
 * sees their rows, so another member's identity is the same answer as a missing one). `not_local` for an identity that
 * runs elsewhere, `pc_offline` when its PC is revoked or has not been seen within `DEVICE_ONLINE_WINDOW_MS`. The PC row
 * is locked while the event is added, so a revoke and this command never cross.
 */
export async function openSignin(
  scope: MemberScope,
  identityId: string,
  now: Date = new Date()
): Promise<OpenSigninResult | null> {
  if (!z.uuid().safeParse(identityId).success) return null
  try {
    return await scope.transaction<OpenSigninResult | null>(async (s) => {
      const [identity] = await s.select(identities, eq(identities.id, identityId))
      if (!identity) return null
      if (identity.runLocation !== 'local' || identity.localDeviceId === null)
        return { opened: false, reason: 'not_local' }
      const seenSince = new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS)
      const [device] = await s.selectForUpdate(
        deviceTokens,
        and(
          eq(deviceTokens.id, identity.localDeviceId),
          isNull(deviceTokens.revokedAt),
          gte(deviceTokens.lastUsedAt, seenSince)
        )!
      )
      if (!device) return { opened: false, reason: 'pc_offline' }
      await emitDeviceCommand(s, device.id, { type: 'open_signin', identityId })
      return { opened: true, pcName: device.name }
    })
  } catch (e) {
    throw safeDbError(e)
  }
}

const NO_STORE = { 'cache-control': 'no-store' }

/**
 * `POST /api/identities/<id>/open-signin` for the signed-in member (the route checks the request is same-origin first).
 * Answers `{ opened: true, pcName }` or `{ opened: false, reason }`, and 404 for an identity that is not theirs.
 */
export async function handleOpenSigninRequest(scope: MemberScope, identityId: string, now?: Date): Promise<Response> {
  const result = await openSignin(scope, identityId, now)
  if (result === null) return Response.json({ error: 'identity_not_found' }, { status: 404, headers: NO_STORE })
  return Response.json(result, { headers: NO_STORE })
}
