import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const HKDF_SALT = 'tolongmeeting/v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** Every sealed secret starts with this. Base64url has no `.`, so `v1.<iv>.<ciphertext>.<tag>` is easy to recognise. */
export const SEALED_PREFIX = 'v1.'

/** Thrown when a secret cannot be sealed or opened. The message is fixed and never carries key, plaintext or input bytes. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretError'
  }
}

/** HKDF-SHA256 of the 32-byte master key: salt `tolongmeeting/v1`, the given `info`, 32 bytes out. */
export function deriveKey(master: Buffer, info: string): Buffer {
  if (master.length !== KEY_BYTES) throw new SecretError('master key must be 32 bytes')
  return Buffer.from(hkdfSync('sha256', master, HKDF_SALT, info, KEY_BYTES))
}

/** The key that encrypts one identity's browser-profile checkpoints (info `profile:<identityId>`). */
export function profileKey(master: Buffer, identityId: string): Buffer {
  return deriveKey(master, `profile:${identityId}`)
}

/** The key that seals one member's secret columns (info `member:<memberId>`). */
export function memberKey(master: Buffer, memberId: string): Buffer {
  return deriveKey(master, `member:${memberId}`)
}

/** AES-256-GCM with a random 12-byte IV. Output: `v1.<iv>.<ciphertext>.<tag>`, each part base64url. */
export function sealSecret(key: Buffer, plaintext: string, aad: string): string {
  if (key.length !== KEY_BYTES) throw new SecretError('key must be 32 bytes')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const parts = [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString('base64url'))
  return `${SEALED_PREFIX}${parts.join('.')}`
}

/** Reverses `sealSecret`. Throws `SecretError` for a wrong key, a wrong `aad` or any changed or malformed byte. */
export function openSecret(key: Buffer, sealed: string, aad: string): string {
  if (key.length !== KEY_BYTES) throw new SecretError('key must be 32 bytes')
  const parts = sealed.startsWith(SEALED_PREFIX) ? sealed.slice(SEALED_PREFIX.length).split('.') : []
  if (parts.length !== 3) throw new SecretError('sealed secret is malformed')
  const [iv, ciphertext, tag] = parts.map((part) => Buffer.from(part, 'base64url'))
  if (iv!.length !== IV_BYTES || tag!.length !== TAG_BYTES) throw new SecretError('sealed secret is malformed')
  const decipher = createDecipheriv('aes-256-gcm', key, iv!, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag!)
  try {
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8')
  } catch {
    // Node's own message can name the failing step; the caller only needs to know the open failed.
    throw new SecretError('sealed secret could not be opened')
  }
}
