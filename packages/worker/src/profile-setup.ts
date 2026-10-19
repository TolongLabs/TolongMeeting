import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobConfig } from '@tm/core'
import type { RunDeps } from './run-deps'
import { deriveProfileKey } from './profile/keys'
import { CheckpointAuthError, CheckpointFormatError } from './profile/profile'

const CHECKPOINT_NAME = /^\d{8}T\d{6}Z\.tar\.enc$/

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
  deps: Pick<RunDeps, 'readMasterKey' | 'prepareProfile' | 'restoreProfile'>
): Promise<ProfileSetup> {
  const root = process.env.TM_PROFILE_ROOT
  const keyFile = process.env.TM_MASTER_KEY_FILE
  if (!root) throw new Error('TM_PROFILE_ROOT is not set')
  if (!keyFile) throw new Error('TM_MASTER_KEY_FILE is not set')
  const key = deriveProfileKey(await deps.readMasterKey(keyFile), cfg.identity.id)
  const checkpointsDir = join(root, cfg.identity.id, 'checkpoints')
  let restoredFrom: string | null = null
  if ((await listDir(cfg.profileDir)).length === 0) {
    const names = (await listDir(checkpointsDir))
      .filter((n) => CHECKPOINT_NAME.test(n))
      .sort()
      .reverse()
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
