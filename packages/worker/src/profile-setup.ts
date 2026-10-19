import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { JobConfig } from '@tm/core'
import type { RunDeps } from './run-deps'
import { CheckpointAuthError, CheckpointFormatError, listCheckpoints } from './profile/profile'

export interface ProfileSetup {
  key: Buffer
  checkpointsDir: string
  /** The checkpoint the profile was restored from, or null when the profile was already there or is new. */
  restoredFrom: string | null
}

// The names in a directory; a missing directory holds nothing.
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

// The identity's key and checkpoint directory. An empty working profile is restored from the newest checkpoint; one
// that fails authentication or is not a checkpoint is skipped for the next-newest, and the run fails only when none
// restores. Then the profile is prepared (host check, stale locks).
export async function setupProfile(
  cfg: JobConfig,
  deps: Pick<RunDeps, 'loadProfileKey' | 'prepareProfile' | 'restoreProfile'>
): Promise<ProfileSetup> {
  const root = process.env.TM_PROFILE_ROOT
  if (!root) throw new Error('TM_PROFILE_ROOT is not set')
  const key = deps.loadProfileKey(cfg.identity.id)
  const checkpointsDir = join(root, cfg.identity.id, 'checkpoints')
  let restoredFrom: string | null = null
  if ((await listDir(cfg.profileDir)).length === 0) {
    const names = (await listCheckpoints(checkpointsDir)).map((path) => basename(path))
    let last: unknown = null
    for (const name of names) {
      try {
        await deps.restoreProfile(join(checkpointsDir, name), cfg.profileDir, key)
        restoredFrom = name
        break
      } catch (error) {
        if (!(error instanceof CheckpointAuthError || error instanceof CheckpointFormatError)) throw error
        console.error(`profile checkpoint ${name} skipped: ${error.name}`)
        last = error
      }
    }
    if (names.length > 0 && restoredFrom === null) {
      throw new Error(`no profile checkpoint could be restored (${names.length} tried)`, { cause: last })
    }
  }
  await deps.prepareProfile(cfg.profileDir, cfg.identity.id)
  return { key, checkpointsDir, restoredFrom }
}
