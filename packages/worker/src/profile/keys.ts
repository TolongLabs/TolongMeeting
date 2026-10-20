import { profileKey } from '@tm/core'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const KEY_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

// Core's profileKey, so 1A checkpoints restore under 1C (one derivation, one salt).
export function deriveProfileKey(masterKey: Buffer, identityId: string): Buffer {
  return profileKey(masterKey, identityId)
}

/** Decodes the text of a key file: 32 bytes, base64. Throws `<variable> must hold 32 bytes, base64` (never the text). */
export function parseKeyText(text: string, variable: string): Buffer {
  const trimmed = text.trim()
  const key = BASE64.test(trimmed) ? Buffer.from(trimmed, 'base64') : Buffer.alloc(0)
  if (key.length !== KEY_BYTES) throw new Error(`${variable} must hold 32 bytes, base64`)
  return key
}

export async function readMasterKey(file: string): Promise<Buffer> {
  return parseKeyText(await readFile(file, 'utf8'), 'TM_MASTER_KEY_FILE')
}

// Matches run-job.sh: sha256 of the identity id, first 32 hex characters.
export function machineIdFor(identityId: string): string {
  return createHash('sha256').update(identityId).digest('hex').slice(0, 32)
}

// Matches run-job.sh: "tm-" plus the first 20 characters of the identity id.
export function hostnameFor(identityId: string): string {
  return `tm-${identityId.slice(0, 20)}`
}
