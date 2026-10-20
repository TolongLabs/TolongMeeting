import { readFile, rm } from 'node:fs/promises'
import { DEVICE_TOKEN_PREFIX } from '@tm/core'
import { z } from 'zod'
import { isMissing, Queue, writeFileAtomic } from './atomic'

/** The part of Electron's `safeStorage` the store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export const SECRET_NAMES = ['deviceToken', 'ntfyToken', 'profileKey'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

/** There is no secure storage on this machine. The store refuses to hold a secret rather than write it as text. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Secure storage is not available on this PC, so TolongMeeting will not store the secret')
    this.name = 'EncryptionUnavailableError'
  }
}

const FileSchema = z.strictObject({
  deviceToken: z.base64().optional(),
  ntfyToken: z.base64().optional(),
  profileKey: z.base64().optional()
}) satisfies z.ZodType<Partial<Record<SecretName, string>>>

/** Secrets live in one file as base64 of `safeStorage` ciphertext (DPAPI on Windows). Never plaintext. */
export class SecretStore {
  private readonly writes = new Queue()

  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike
  ) {}

  async get(n: SecretName): Promise<string | null> {
    const stored = (await this.read())[n]
    if (stored === undefined) return null
    this.requireEncryption()
    return this.safe.decryptString(Buffer.from(stored, 'base64'))
  }

  async set(n: SecretName, v: string): Promise<void> {
    if (n === 'deviceToken' && !v.startsWith(DEVICE_TOKEN_PREFIX)) throw new Error('not a device token')
    if (v === '') throw new Error('a secret cannot be empty')
    this.requireEncryption()
    await this.writes.run(async () => {
      const all = await this.read()
      all[n] = this.safe.encryptString(v).toString('base64')
      await writeFileAtomic(this.file, JSON.stringify(all), 0o600)
    })
  }

  /**
   * Forgets the tokens of this pairing (`deviceToken`, `ntfyToken`), for example when the server revokes this PC. The
   * `profileKey` stays: it encrypts the saved browser profiles and does not come from the server, so a server's 401
   * must not make every saved login unreadable. Needs no encryption.
   */
  clear(): Promise<void> {
    return this.writes.run(async () => {
      const { deviceToken: _device, ntfyToken: _ntfy, ...kept } = await this.read()
      if (Object.keys(kept).length === 0) await rm(this.file, { force: true })
      else await writeFileAtomic(this.file, JSON.stringify(kept), 0o600)
    })
  }

  private requireEncryption(): void {
    if (!this.safe.isEncryptionAvailable()) throw new EncryptionUnavailableError()
  }

  private async read(): Promise<z.infer<typeof FileSchema>> {
    try {
      return FileSchema.parse(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (e) {
      if (isMissing(e)) return {}
      throw e
    }
  }
}
