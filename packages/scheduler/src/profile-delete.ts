import { lstat, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { profiles } from '@tm/web/db'
import type { LaunchDeps } from './launch'
import { acquireProfile, releaseProfile } from './locks'

const ProfileDeleteData = z.object({ identityId: z.uuid() })
// A single path segment that can't be `.`, `..` or a hidden directory such as `.machine-ids`.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code

/** `lstat` that answers `null` for a missing path and throws for anything else. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null
    throw e
  }
}

/**
 * Removes `<root>/<identityId>` (work directory, checkpoints, job files) and `<root>/.machine-ids/<identityId>`. A
 * symlink at either spot is unlinked and never followed. Another identity's directory is never touched, and a missing
 * path is fine, so running it twice is safe. The database row is not changed here (see `handleProfileDelete`).
 */
export async function deleteServerProfile(
  identityId: string,
  profileRoot: string | undefined = process.env.TM_PROFILE_ROOT
): Promise<void> {
  if (!profileRoot) throw new Error('TM_PROFILE_ROOT is not set')
  if (!SEGMENT.test(identityId)) throw new Error('deleteServerProfile: not an identity id')
  const dir = join(profileRoot, identityId)
  const st = await lstatOrNull(dir)
  if (st?.isSymbolicLink()) await unlink(dir)
  else if (st?.isDirectory()) await rm(dir, { recursive: true })
  else if (st) throw new Error(`${dir} is not a directory`)
  const machineId = join(profileRoot, '.machine-ids', identityId)
  if (await lstatOrNull(machineId)) await unlink(machineId)
}

/**
 * The `profile-delete` job: the member moved an identity to My PC, so the server's copy of its profile goes. It takes
 * the profile first, so a meeting or sign-in container that holds it makes this throw and the job retry. Nothing is
 * deleted for an identity that is gone (its directory is an orphan for retention) or that is not on My PC any more
 * (the member moved it back, and may have signed in on the server since). Afterwards the row keeps no checkpoint or
 * account status for the deleted files.
 */
export async function handleProfileDelete(deps: LaunchDeps, data: unknown, _now: Date): Promise<string> {
  const { identityId } = ProfileDeleteData.parse(data)
  const { db, env } = deps
  const holder = `delete:${identityId}`
  if (!(await acquireProfile(db, identityId, holder))) {
    const [exists] = await db
      .select({ id: profiles.identityId })
      .from(profiles)
      .where(eq(profiles.identityId, identityId))
    if (!exists) return `${identityId}: no such profile`
    throw new Error(`profile ${identityId} is in use; the server copy was not deleted`)
  }
  try {
    // Read under the hold: `setRunLocation` can't move the identity while it is held.
    const [row] = await db
      .select({ location: profiles.location })
      .from(profiles)
      .where(eq(profiles.identityId, identityId))
    if (row!.location !== 'local') return `${identityId}: not on My PC, nothing deleted`
    await deleteServerProfile(identityId, env.profileRoot)
    await db
      .update(profiles)
      .set({ latestCheckpoint: null, checkpointAt: null, accountStatus: {} })
      .where(eq(profiles.identityId, identityId))
  } finally {
    await releaseProfile(db, identityId, holder)
  }
  return `${identityId}: server copy deleted`
}
