import { createHash, hkdfSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const HKDF_SALT = 'tolongmeeting/v1'
const KEY_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

// Same derivation as plan 01c's profileKey (core secrets.ts), so 1A checkpoints restore under 1C.
export function deriveProfileKey(masterKey: Buffer, identityId: string): Buffer {
  if (masterKey.length !== KEY_BYTES) throw new Error('master key must be 32 bytes')
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, `profile:${identityId}`, KEY_BYTES))
}

export async function readMasterKey(file: string): Promise<Buffer> {
  const text = (await readFile(file, 'utf8')).trim()
  const key = BASE64.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
  if (key.length !== KEY_BYTES) throw new Error('TM_MASTER_KEY_FILE must hold 32 bytes, base64')
  return key
}

// Matches run-job.sh: sha256 of the identity id, first 32 hex characters.
export function machineIdFor(identityId: string): string {
  return createHash('sha256').update(identityId).digest('hex').slice(0, 32)
}

// Matches run-job.sh: "tm-" plus the first 20 characters of the identity id.
export function hostnameFor(identityId: string): string {
  return `tm-${identityId.slice(0, 20)}`
}
