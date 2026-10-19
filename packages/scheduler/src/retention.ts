import { lstat, readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIVE_STATES, formatDay, formatWhen } from '@tm/core'
import { pings } from '@tm/notify'
import { and, eq, inArray, isNull, gt, lte, notInArray, sql } from 'drizzle-orm'
import { artefacts, events, forms, identities, members, occurrences, profiles } from '@tm/web/db'
import { applyTrigger } from '@tm/web/db/transitions'
import { resolveEnv } from './container-spec'
import type { LaunchDeps } from './launch'

/** How many `*.tar.enc` checkpoints stay in each identity's `checkpoints/` directory. */
export const KEEP_CHECKPOINTS = 3

const WARN_BEFORE_MS = 3 * 24 * 3_600_000
/** A temp file this young may belong to a checkpoint still being written. Same limit as the worker's own cleanup. */
const FRESH_TMP_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Mirrors CHECKPOINT_NAME and the `.tmp-<hex>` suffix in packages/worker/src/profile/profile.ts (not exported there).
const CHECKPOINT_NAME = /^\d{8}T\d{6}Z\.tar\.enc$/
const CHECKPOINT_TMP = /\.tar\.enc\.tmp-/

export type RetentionResult = {
  warned: number
  deleted: number
  orphansRemoved: number
  checkpointsPruned: number
  /** Occurrences left alone because they became active (or hold a profile) after they were picked. */
  skipped: number
}

/** The occurrence is running (or holds a browser profile), so its data may not be deleted. */
export class OccurrenceActiveError extends Error {
  constructor(occurrenceId: string) {
    super(`occurrence ${occurrenceId} is active; its data was not deleted`)
    this.name = 'OccurrenceActiveError'
  }
}

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

/** Names in `dir`, or none when it doesn't exist yet. */
async function readdirOrEmpty(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (errCode(e) === 'ENOENT') return []
    throw e
  }
}

/**
 * Removes `<root>/<name>` and everything in it. Only a real directory directly under `root` is emptied and removed;
 * a symlink at that spot is unlinked, never followed, and `rm` unlinks links inside the tree without following them.
 * Returns false when nothing was there.
 */
async function removeUnder(root: string, name: string): Promise<boolean> {
  const path = join(root, name)
  const st = await lstatOrNull(path)
  if (st === null) return false
  if (st.isSymbolicLink()) await unlink(path)
  else if (st.isDirectory()) await rm(path, { recursive: true })
  else throw new Error(`${path} is not a directory`)
  return true
}

/**
 * Deletes a meeting's data: the database rows first (one transaction), then `<dataRoot>/occurrences/<id>/`. The row
 * stays as a `deleted` tombstone. A failed `rm` leaves the tombstone, whose directory the orphan pass removes. Running
 * it again on a tombstone only retries the directory. The reason is `member` after "delete now" (`requestDeleteNow`
 * sets `state_reason` to `deleting`) and `expired` otherwise. Throws `OccurrenceActiveError` for an active occurrence.
 */
export async function deleteOccurrenceData(deps: LaunchDeps, occurrenceId: string, _now: Date): Promise<void> {
  const { db, env } = deps
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(occurrences).where(eq(occurrences.id, occurrenceId)).for('update')
    if (!row) throw new Error(`No occurrence ${occurrenceId}`)
    if (row.state === 'deleted') return
    if (ACTIVE_STATES.has(row.state)) throw new OccurrenceActiveError(occurrenceId)
    const held = await tx
      .select({ identityId: profiles.identityId })
      .from(profiles)
      .where(eq(profiles.heldBy, `occ:${occurrenceId}`))
    if (held.length > 0) throw new OccurrenceActiveError(occurrenceId)

    await tx.delete(forms).where(eq(forms.occurrenceId, occurrenceId))
    await tx.delete(artefacts).where(eq(artefacts.occurrenceId, occurrenceId))
    await tx.delete(events).where(eq(events.occurrenceId, occurrenceId))
    await applyTrigger(tx, occurrenceId, 'delete', { reason: row.stateReason === 'deleting' ? 'member' : 'expired' })
    await tx
      .update(occurrences)
      .set({ linkUsed: null, pastedLink: null, entrySnapshot: null, containerName: null, controlTokenHash: null })
      .where(eq(occurrences.id, occurrenceId))
  })
  await removeUnder(join(env.dataRoot, 'occurrences'), occurrenceId)
}

/** Pings each meeting that is within 3 days of deletion, once. The stamp is written first; a failed ping stays stamped. */
async function warnSoon(deps: LaunchDeps, now: Date): Promise<number> {
  const { db, notifier, env } = deps
  const { publicUrl } = resolveEnv(env)
  const due = await db
    .select({
      id: occurrences.id,
      memberId: occurrences.memberId,
      entry: occurrences.entryName,
      start: occurrences.scheduledStart,
      deleteAfter: occurrences.deleteAfter,
      timeZone: members.timeZone
    })
    .from(occurrences)
    .innerJoin(members, eq(members.id, occurrences.memberId))
    .where(
      and(
        notInArray(occurrences.state, [...ACTIVE_STATES, 'deleted']),
        isNull(occurrences.deletionWarnedAt),
        lte(sql`${occurrences.deleteAfter} - interval '3 days'`, now),
        gt(occurrences.deleteAfter, now)
      )
    )
  let warned = 0
  for (const o of due) {
    const stamped = await db
      .update(occurrences)
      .set({ deletionWarnedAt: now })
      .where(
        and(
          eq(occurrences.id, o.id),
          isNull(occurrences.deletionWarnedAt),
          notInArray(occurrences.state, [...ACTIVE_STATES, 'deleted'])
        )
      )
      .returning({ id: occurrences.id })
    if (stamped.length === 0) continue
    warned++
    await notifier.notify(
      o.memberId,
      pings.deletionSoon({
        entry: o.entry,
        when: formatWhen(o.start, o.timeZone),
        deleteOn: formatDay(o.deleteAfter, o.timeZone),
        meetingUrl: `${publicUrl}/meetings/${o.id}`
      })
    )
  }
  return warned
}

/** UUID-named directories directly under `root`, with their entry type; every other name is left alone. */
export async function uuidEntries(root: string) {
  return (await readdirOrEmpty(root)).filter((d) => UUID.test(d.name))
}

/** Removes directories under `occurrences/` without a live row and under `profileRoot` without an identity row. */
async function removeOrphans(deps: LaunchDeps): Promise<number> {
  const { db, env } = deps
  let removed = 0

  const occRoot = join(env.dataRoot, 'occurrences')
  const occEntries = await uuidEntries(occRoot)
  if (occEntries.length > 0) {
    // Listed before queried: a launch inserts the row before it makes the directory.
    const rows = await db
      .select({ id: occurrences.id, state: occurrences.state })
      .from(occurrences)
      .where(
        inArray(
          occurrences.id,
          occEntries.map((d) => d.name.toLowerCase())
        )
      )
    const live = new Set(rows.filter((r) => r.state !== 'deleted').map((r) => r.id))
    for (const d of occEntries) if (!live.has(d.name.toLowerCase()) && (await removeUnder(occRoot, d.name))) removed++
  }

  const profEntries = await uuidEntries(env.profileRoot)
  if (profEntries.length > 0) {
    const rows = await db
      .select({ id: identities.id })
      .from(identities)
      .where(
        inArray(
          identities.id,
          profEntries.map((d) => d.name.toLowerCase())
        )
      )
    const known = new Set(rows.map((r) => r.id))
    for (const d of profEntries)
      if (!known.has(d.name.toLowerCase()) && (await removeUnder(env.profileRoot, d.name))) removed++
  }
  return removed
}

/** The complete checkpoint files in `<profileRoot>/<identityId>/checkpoints/`, oldest first. Never follows a symlink. */
export async function checkpointFiles(profileRoot: string, identityId: string): Promise<string[]> {
  const dir = await checkpointDir(profileRoot, identityId)
  if (dir === null) return []
  return (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isFile() && CHECKPOINT_NAME.test(d.name))
    .map((d) => d.name)
    .sort()
}

/** The identity's checkpoint directory when both it and the identity directory are real directories, else null. */
async function checkpointDir(profileRoot: string, identityId: string): Promise<string | null> {
  const idDir = join(profileRoot, identityId)
  const dir = join(idDir, 'checkpoints')
  for (const p of [idDir, dir]) {
    const st = await lstatOrNull(p)
    if (st === null) return null
    // A worker can write inside its own profile directory, so a link here is never followed.
    if (!st.isDirectory()) {
      console.error(`retention: ${p} is not a real directory; skipped`)
      return null
    }
  }
  return dir
}

/** Keeps the newest `KEEP_CHECKPOINTS` checkpoints per identity and removes temp files older than 60 s. */
async function pruneCheckpoints(deps: LaunchDeps, now: Date): Promise<number> {
  const { profileRoot } = deps.env
  let pruned = 0
  for (const d of await uuidEntries(profileRoot)) {
    const dir = await checkpointDir(profileRoot, d.name)
    if (dir === null) continue
    const names = await checkpointFiles(profileRoot, d.name)
    for (const old of names.slice(0, -KEEP_CHECKPOINTS)) {
      await rm(join(dir, old))
      pruned++
    }
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (!f.isFile() || !CHECKPOINT_TMP.test(f.name)) continue
      const st = await lstatOrNull(join(dir, f.name))
      if (st !== null && now.getTime() - st.mtimeMs >= FRESH_TMP_MS) await rm(join(dir, f.name))
    }
  }
  return pruned
}

/**
 * The hourly retention pass: warns about meetings 3 days from deletion, deletes expired ones, removes orphaned
 * directories and prunes old checkpoints. A step that fails does not stop the others; the failures are thrown together
 * at the end, so nothing is hidden and one stuck directory doesn't block the rest.
 */
export async function retentionTick(deps: LaunchDeps, now: Date): Promise<RetentionResult> {
  const result: RetentionResult = { warned: 0, deleted: 0, orphansRemoved: 0, checkpointsPruned: 0, skipped: 0 }
  const failures: unknown[] = []
  const step = async (run: () => Promise<void>) => {
    try {
      await run()
    } catch (e) {
      failures.push(e)
    }
  }

  await step(async () => void (result.warned = await warnSoon(deps, now)))
  const expired = await deps.db
    .select({ id: occurrences.id })
    .from(occurrences)
    .where(and(notInArray(occurrences.state, [...ACTIVE_STATES, 'deleted']), lte(occurrences.deleteAfter, now)))
  for (const { id } of expired) {
    await step(async () => {
      try {
        await deleteOccurrenceData(deps, id, now)
        result.deleted++
      } catch (e) {
        if (!(e instanceof OccurrenceActiveError)) throw e
        result.skipped++
      }
    })
  }
  await step(async () => void (result.orphansRemoved = await removeOrphans(deps)))
  await step(async () => void (result.checkpointsPruned = await pruneCheckpoints(deps, now)))

  if (failures.length > 0) throw new AggregateError(failures, `retention: ${failures.length} step(s) failed`)
  return result
}
