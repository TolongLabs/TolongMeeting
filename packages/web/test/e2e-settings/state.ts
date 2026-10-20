import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where `serve.ts` writes the seeded member's session cookie and the fakes' address for the spec. */
export const STATE_FILE = join(tmpdir(), 'tm-web-e2e-settings-state.json')

export interface SettingsE2eState {
  cookie: { name: string; value: string }
  /** The fake ntfy server, which the spec asks which pings arrived. */
  ntfyOrigin: string
}
