import { deriveKey } from '@tm/core'

/**
 * The secret Better Auth signs cookies with and encrypts stored OAuth tokens with, derived from the master key. Sign-in
 * (`createAuth`) and everything that reads a stored GitHub token (`authScope`) must use the same one.
 */
export function authSecret(master: Buffer): string {
  return deriveKey(master, 'better-auth').toString('base64')
}
