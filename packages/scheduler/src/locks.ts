import { and, eq, isNull } from 'drizzle-orm'
import { profiles, type Db } from '@tm/web/db'

/** Takes the identity's browser profile for `holder` (`occ:<occurrenceId>` or `signin:<sessionId>`). False when it is held. */
export async function acquireProfile(db: Db, identityId: string, holder: string): Promise<boolean> {
  const taken = await db
    .update(profiles)
    .set({ heldBy: holder, heldSince: new Date() })
    .where(and(eq(profiles.identityId, identityId), isNull(profiles.heldBy)))
    .returning({ identityId: profiles.identityId })
  return taken.length === 1
}

/** Gives the profile back, but only when `holder` is the one holding it. */
export async function releaseProfile(db: Db, identityId: string, holder: string): Promise<void> {
  await db
    .update(profiles)
    .set({ heldBy: null, heldSince: null })
    .where(and(eq(profiles.identityId, identityId), eq(profiles.heldBy, holder)))
}
