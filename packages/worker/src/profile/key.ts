import { profileKey } from '@tm/core'
import { readFileSync } from 'node:fs'
import { parseKeyText } from './keys'

/**
 * The key that encrypts this identity's profile checkpoints. When `TM_PROFILE_KEY_FILE` is set (the launcher sets it
 * for a container) the file holds the ready 32-byte base64 key. Otherwise the key is derived from the master key in
 * `TM_MASTER_KEY_FILE`, as plan 01a runs.
 */
export function loadProfileKey(identityId: string): Buffer {
  const profileFile = process.env.TM_PROFILE_KEY_FILE
  if (profileFile) return parseKeyText(readFileSync(profileFile, 'utf8'), 'TM_PROFILE_KEY_FILE')
  const masterFile = process.env.TM_MASTER_KEY_FILE
  if (!masterFile) throw new Error('Set TM_PROFILE_KEY_FILE or TM_MASTER_KEY_FILE')
  return profileKey(parseKeyText(readFileSync(masterFile, 'utf8'), 'TM_MASTER_KEY_FILE'), identityId)
}
