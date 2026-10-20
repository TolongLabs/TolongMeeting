import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The port of the site under test; the other page specs use 4791 to 4800. */
export const OPS_PORT = 4817

/** Where `serve.ts` writes the seeded members' session cookies for the spec. */
export const STATE_FILE = join(tmpdir(), 'tm-web-ops-e2e-state.json')

/** What the fake GitHub accepts: the token of the one repository it knows. */
export const GITHUB_TOKEN = 'github_pat_E2ESECRETTOKEN0123456789'
export const GITHUB_REPO = { owner: 'acme', repo: 'notes', branch: 'main' }
/** What the fake Google hands out as the Picker's access token, and the folder it knows. */
export const GOOGLE_ACCESS_TOKEN = 'ya29.E2EPICKERACCESSTOKEN'
export const GOOGLE_FOLDER = { id: 'FOLDER_E2E_0123456789', name: 'Lecture exports' }
export const NOTION_PARENT = { id: '3f2b8a9e-6c1d-4e7a-9b0f-2d5c8e1a4f60', name: 'Lecture notes' }

export type Who = 'admin' | 'member' | 'linked'

export interface OpsState {
  /**
   * The session cookies, by member. `admin` is an admin without a notification topic; `member` is a member with one and
   * no connections; `linked` is a member with Google and Notion connections.
   */
  cookies: Record<Who, { name: string; value: string }>
}
