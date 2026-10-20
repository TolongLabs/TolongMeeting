import { CompanionCommandSchema, DEVICE_ONLINE_WINDOW_MS, type CompanionCommand, type DeviceAuth } from '@tm/core'
import { and, asc, eq, gte, isNull } from 'drizzle-orm'
import type { MemberScope } from '../lib/scope'
import { safeDbError } from './errors'
import { companionEvents, deviceTokens, identities, type Db } from './index'

export type { Db }

/**
 * Queries for run locations (plan 08). Device-facing functions take a `Db` and act for the device they are given; the
 * one member-facing function takes the member's scope, so it joins the caller's transaction.
 */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw safeDbError(e)
  }
}

/** True when the device is not revoked and was seen within `DEVICE_ONLINE_WINDOW_MS` before `now`. */
export async function isDeviceOnline(db: Db, deviceId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await guarded(() =>
    db
      .select({ id: deviceTokens.id })
      .from(deviceTokens)
      .where(
        and(
          eq(deviceTokens.id, deviceId),
          isNull(deviceTokens.revokedAt),
          gte(deviceTokens.lastUsedAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))
        )
      )
  )
  return rows.length === 1
}

/** The device's name, or `null` for a device that does not exist. */
export async function deviceName(db: Db, deviceId: string): Promise<string | null> {
  const [row] = await guarded(() =>
    db.select({ name: deviceTokens.name }).from(deviceTokens).where(eq(deviceTokens.id, deviceId))
  )
  return row?.name ?? null
}

/** The identities bound to this device (`run_location = 'local'`), oldest first. Only the device's own member's rows. */
export async function listLocalIdentities(db: Db, device: DeviceAuth): Promise<{ id: string; name: string }[]> {
  return guarded(() =>
    db
      .select({ id: identities.id, name: identities.name })
      .from(identities)
      .where(
        and(
          eq(identities.memberId, device.memberId),
          eq(identities.runLocation, 'local'),
          eq(identities.localDeviceId, device.deviceId)
        )
      )
      .orderBy(asc(identities.createdAt), asc(identities.id))
  )
}

/** Appends a command to one of the member's devices' event streams, in the scope's transaction. */
export async function emitDeviceCommand(
  scope: MemberScope,
  deviceId: string,
  command: CompanionCommand
): Promise<void> {
  const checked = CompanionCommandSchema.parse(command)
  await guarded(() => scope.insert(companionEvents, { deviceId, command: checked }))
}
