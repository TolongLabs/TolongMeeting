import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where `serve.ts` writes the seeded members' session cookies for the specs. */
export const STATE_FILE = join(tmpdir(), 'tm-web-e2e-state.json')

export interface E2eState {
  /** The session cookies, by member. `admin` is an admin; `member` is not. */
  cookies: Record<'admin' | 'member', { name: string; value: string }>
}
