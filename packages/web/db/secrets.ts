import { memberKey, openSecret, sealSecret } from '@tm/core'
import { readFileSync } from 'node:fs'

const KEY_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Thrown for a missing or malformed master key. The message is fixed and never carries the file's bytes. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MasterKeyError'
  }
}

/** The member-owned columns that hold sealed secrets (`*_enc` in the schema). Each one seals under its own AAD. */
export type SecretColumn =
  'members.ntfy_token' | 'ai_keys.dashscope_key' | 'ai_keys.modelscope_key' | 'connections.token'

/** Reads the 32-byte base64 master key from `TM_MASTER_KEY_FILE`. */
export function loadMasterKey(file: string | undefined = process.env.TM_MASTER_KEY_FILE): Buffer {
  if (!file) throw new MasterKeyError('TM_MASTER_KEY_FILE is not set')
  const text = readFileSync(file, 'utf8').trim()
  const key = BASE64.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
  if (key.length !== KEY_BYTES) throw new MasterKeyError('TM_MASTER_KEY_FILE must hold 32 bytes, base64')
  return key
}

function aadFor(column: SecretColumn, memberId: string): string {
  return `${column}:${memberId}`
}

/** Seals `plaintext` for storage in an `*_enc` column: `v1.<iv>.<ciphertext>.<tag>`, bound to this member and column. */
export function sealColumn(master: Buffer, memberId: string, column: SecretColumn, plaintext: string): string {
  return sealSecret(memberKey(master, memberId), plaintext, aadFor(column, memberId))
}

/** Opens what `sealColumn` wrote. Throws `SecretError` for another member, another column or any changed byte. */
export function openColumn(master: Buffer, memberId: string, column: SecretColumn, sealed: string): string {
  return openSecret(memberKey(master, memberId), sealed, aadFor(column, memberId))
}
