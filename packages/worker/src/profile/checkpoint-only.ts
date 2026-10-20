import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadProfileKey } from './key'
import { checkpointProfile } from './profile'

const IDENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface CheckpointOnlyDeps {
  /** `TM_PROFILE_ROOT`: the identity's volume is mounted at `<root>/<id>/vol`, its checkpoints at `<root>/<id>/checkpoints`. */
  root: string
  loadProfileKey?: (identityId: string) => Buffer
}

/**
 * The whole `--checkpoint-only <identityId>` mode, run by a container that has the profile volume and nothing else:
 * write one encrypted checkpoint of `<root>/<id>/vol/work`, then return. The volume is mounted one level above `work`
 * (see `restoreProfile`, which renames a staging folder onto its target and cannot rename onto a mount point).
 * A volume with no `work` folder, or an empty one, holds no profile: no checkpoint is written, because a newer empty
 * checkpoint would hide the real one on the next restore. Returns the checkpoint path, or null in that case.
 */
export async function checkpointOnly(identityId: string, deps: CheckpointOnlyDeps): Promise<string | null> {
  if (!IDENTITY_ID.test(identityId)) throw new Error('checkpoint-only needs an identity id')
  const work = join(deps.root, identityId, 'vol', 'work')
  let names: string[]
  try {
    names = await readdir(work)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (names.length === 0) return null
  const key = (deps.loadProfileKey ?? loadProfileKey)(identityId)
  return checkpointProfile(work, join(deps.root, identityId, 'checkpoints'), key)
}
