import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where `serve.ts` writes the seeded members' session cookies for the specs. */
export const STATE_FILE = join(tmpdir(), 'tm-web-e2e-state.json')

export interface E2eState {
  /** The session cookies, by member. `admin` is an admin; `member` is not. */
  cookies: Record<'admin' | 'member', { name: string; value: string }>
  /** The admin's meetings: a completed lecture, the running "Live standup", one that is uploading, one stuck on its AI key. */
  meetings: Record<'completed' | 'live' | 'uploading' | 'stuck', string>
}
