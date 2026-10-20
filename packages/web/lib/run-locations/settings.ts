import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { DeviceAuth } from '@tm/core'
import { emitDeviceCommand, listLocalIdentities, type Db } from '../../db/local-runs'
import { scopeHomeNodeStore } from '../../db/home-route'
import { safeDbError } from '../../db/errors'
import { QUEUES, type Queue } from '../../db/queues'
import { deviceTokens, identities, profiles } from '../../db/schema'
import { assertIdentityMovable, InUseError } from '../identities'
import type { MemberScope } from '../scope'

// Where an identity runs (plan 08 task 1): `server`, `server_via_home` or `local` on one of the member's paired PCs.
// Only `setRunLocation` changes `identities.run_location` (the settings form does not), so the launcher can trust it
// for every occurrence it picks up: a change is refused while the identity has a meeting under way or about to launch.

export type RunLocationChoice =
  { location: 'server' } | { location: 'server_via_home' } | { location: 'local'; deviceId: string }

export const RunLocationChoiceSchema = z.discriminatedUnion('location', [
  z.strictObject({ location: z.literal('server') }),
  z.strictObject({ location: z.literal('server_via_home') }),
  z.strictObject({ location: z.literal('local'), deviceId: z.uuid() })
])

export type SetRunLocationResult =
  { ok: true } | { ok: false; error: 'identity_not_found' | 'device_not_found' | 'home_route_not_set_up' }

/**
 * Moves one of the member's identities to a run location.
 *
 * - Refused with `InUseError` while a meeting of the identity is past `scheduled` and unfinished, one starts within 75
 *   minutes of `now`, or a meeting or sign-in holds its profile (`assertIdentityMovable`, which also closes the race
 *   with the scheduler's launch). `scheduled` meetings further out don't block and launch at the new location. The
 *   hold is re-checked by the same statement that writes `profiles.location`, so a sign-in that starts at this moment
 *   either wins (and this refuses) or finds the new location.
 * - `local` needs one of the member's own unrevoked devices (`device_not_found` otherwise), locked `for update` so a
 *   concurrent `revokeDevice` is serialised with the move; `server_via_home` needs a
 *   stored home exit node (`home_route_not_set_up`).
 * - Writes `run_location`, `local_device_id` (null unless `local`) and `profiles.location` (`local` for My PC, else
 *   `server`) in one transaction, and tells the PC that gained the identity, and the one that lost it, with a
 *   `local_identities_changed` event in that transaction.
 * - Moving to `local` queues `profile-delete` for the server's copy in that same transaction (through its connection),
 *   so the job exists exactly when the move committed. Asking again for the same `local` choice queues it again; the
 *   handler deletes nothing for an identity that is no longer on My PC.
 */
export async function setRunLocation(
  scope: MemberScope,
  queue: Queue,
  identityId: string,
  choice: RunLocationChoice,
  now: Date = new Date()
): Promise<SetRunLocationResult> {
  const parsed = RunLocationChoiceSchema.parse(choice)
  if (!z.uuid().safeParse(identityId).success) return { ok: false, error: 'identity_not_found' }
  try {
    return await scope.transaction<SetRunLocationResult>(async (s) => {
      const [identity] = await s.select(identities, eq(identities.id, identityId))
      const [profile] = await s.select(profiles, eq(profiles.identityId, identityId))
      if (!identity || !profile) return { ok: false, error: 'identity_not_found' }

      const deviceId = parsed.location === 'local' ? parsed.deviceId : null
      const unchanged = identity.runLocation === parsed.location && identity.localDeviceId === deviceId
      const queueDelete = async () => {
        if (parsed.location === 'local') await s.sendInTransaction(queue, QUEUES.profileDelete, { identityId })
      }
      if (unchanged) {
        await queueDelete()
        return { ok: true }
      }

      await assertIdentityMovable(s, identityId, profile, now)
      if (deviceId !== null) {
        // The row lock makes a revoke of this PC wait for this move (or this move wait for the revoke, and then see
        // the revoked row and refuse), so the identity never ends up bound to a revoked device.
        const [device] = await s.selectForUpdate(
          deviceTokens,
          and(eq(deviceTokens.id, deviceId), isNull(deviceTokens.revokedAt))!
        )
        if (!device) return { ok: false, error: 'device_not_found' }
      }
      if (parsed.location === 'server_via_home' && !(await scopeHomeNodeStore(s).get()))
        return { ok: false, error: 'home_route_not_set_up' }

      await s.update(
        identities,
        { runLocation: parsed.location, localDeviceId: deviceId },
        eq(identities.id, identityId)
      )
      const free = and(eq(profiles.identityId, identityId), isNull(profiles.heldBy))!
      const location = parsed.location === 'local' ? 'local' : 'server'
      if ((await s.update(profiles, { location }, free)) === 0)
        throw new InUseError('This identity is in use by a meeting or a sign-in.')

      if (deviceId !== null) await emitDeviceCommand(s, deviceId, { type: 'local_identities_changed' })
      const before = identity.localDeviceId
      if (before !== null && before !== deviceId)
        await emitDeviceCommand(s, before, { type: 'local_identities_changed' })
      await queueDelete()
      return { ok: true }
    })
  } catch (e) {
    throw safeDbError(e)
  }
}

const NO_STORE = { 'cache-control': 'no-store' }
const fail = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE })
const MAX_BODY_BYTES = 1024

/** Browsers say where a request came from; a member route accepts only the site's own pages (and non-browser clients). */
const crossSite = (request: Request): boolean => {
  const site = request.headers.get('sec-fetch-site')
  return site !== null && site !== 'same-origin'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    if (e instanceof SyntaxError) return null
    throw e
  }
}

/**
 * `PUT /api/identities/<id>/run-location` for the signed-in member, body `RunLocationChoice`. 400 for a bad body, 404
 * for an identity or device that is not theirs, 409 while the identity is in use or its home route is not set up.
 */
export async function handleRunLocationRequest(
  request: Request,
  scope: MemberScope,
  queue: Queue,
  identityId: string
): Promise<Response> {
  if (crossSite(request)) return fail('forbidden', 403)
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail('invalid_body', 400)
  const text = await request.text()
  const body = RunLocationChoiceSchema.safeParse(text.length > MAX_BODY_BYTES ? null : parseJson(text))
  if (!body.success) return fail('invalid_body', 400)
  try {
    const result = await setRunLocation(scope, queue, identityId, body.data)
    if (result.ok) return Response.json({ ok: true }, { headers: NO_STORE })
    return fail(result.error, result.error === 'home_route_not_set_up' ? 409 : 404)
  } catch (e) {
    if (e instanceof InUseError) return fail('identity_in_use', 409)
    throw e
  }
}

/**
 * `GET /api/companion/identities` for a PC: the identities bound to it and the worker image it pulls. `image` is
 * `TM_WORKER_IMAGE_REF`; unset is an error, not a default (a PC must never run an image nobody named).
 */
export async function handleCompanionIdentities(
  db: Db,
  device: DeviceAuth,
  env: Record<string, string | undefined> = process.env
): Promise<Response> {
  const image = env.TM_WORKER_IMAGE_REF
  if (!image) throw new Error('TM_WORKER_IMAGE_REF is not set')
  return Response.json({ identities: await listLocalIdentities(db, device), image }, { headers: NO_STORE })
}
