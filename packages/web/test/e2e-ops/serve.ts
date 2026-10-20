// Starts the website for the devices, connections and admin spec: a scratch database with three seeded members (real
// Better Auth sessions), the fake providers, a production build and `next start` with `preload.mjs`. Stops the site and
// drops the database on SIGTERM or SIGINT.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { schema } from '../../db'
import { memberExportStores } from '../../db/exports'
import { QUEUES } from '../../db/queues'
import { sealColumn } from '../../db/secrets'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember, testDbUrl, TEST_MASTER } from '../../db/testing'
import { createAuth } from '../../lib/auth'
import { createScope } from '../../lib/scope'
import { startFakeProviders } from './fake-providers'
import { STATE_FILE, type OpsState } from './state'

const webRoot = join(import.meta.dir, '..', '..')
const port = Number(process.argv[2])
const origin = `http://127.0.0.1:${port}`

const db = await createTestDb()

// Which GitHub user each fake token belongs to; sign-in links the member with the same login.
const users: Record<string, { id: number; login: string }> = {
  gho_admin: { id: 2001, login: 'ops-admin' },
  gho_member: { id: 2002, login: 'ops-member' },
  gho_linked: { id: 2003, login: 'ops-linked' }
}
const auth = createAuth({
  db,
  master: TEST_MASTER,
  publicUrl: origin,
  clientId: 'e2e-client-id',
  clientSecret: 'e2e-client-secret',
  org: 'tolonglabs',
  github: { user: async (token) => users[token]!, orgMembership: async () => 'active' }
})
const ctx = await auth.$context

async function signedIn(login: string, role: 'admin' | 'member', token: string) {
  const seeded = await seedMember(db, { githubLogin: login, role, full: false })
  const authUserId = await seedAuthUser(db, { githubToken: token })
  const session = await ctx.internalAdapter.createSession(authUserId)
  const signature = createHmac('sha256', ctx.secret).update(session.token).digest('base64')
  return {
    seeded,
    cookie: { name: ctx.authCookies.sessionToken.name, value: encodeURIComponent(`${session.token}.${signature}`) }
  }
}

const admin = await signedIn('ops-admin', 'admin', 'gho_admin')
const member = await signedIn('ops-member', 'member', 'gho_member')
const linked = await signedIn('ops-linked', 'member', 'gho_linked')

// The member has a notification topic (a PC needs one to pair); the admin has none.
await db
  .update(schema.members)
  .set({
    ntfyTopic: 'tm-e2eopstopic',
    ntfyTokenEnc: sealColumn(TEST_MASTER, member.seeded.memberId, 'members.ntfy_token', 'tk_e2e')
  })
  .where(eq(schema.members.id, member.seeded.memberId))

// The linked member already has Google (with a folder) and Notion (no page chosen yet).
const dataRoot = mkdtempSync(join(tmpdir(), 'tm-web-ops-data-'))
const linkedStores = memberExportStores(createScope(db, linked.seeded.memberId), TEST_MASTER, dataRoot)
await linkedStores.connections.save({
  kind: 'google',
  refreshToken: '1//e2e-refresh-token',
  account: 'linked@example.edu',
  folderId: 'DEFAULT_FOLDER_0123456789',
  folderName: 'TolongMeeting Exports',
  folderIsDefault: true
})
await linkedStores.connections.save({
  kind: 'notion',
  accessToken: 'ntn_e2e_access_token',
  refreshToken: null,
  workspace: 'Lecture workspace',
  parent: null
})

// Revoking a PC sends to pg-boss queues (the scheduler makes them in production), and removing a member calls an ntfy
// server. The stand-in answers every request with a token and keeps nothing.
const boss = new PgBoss({ connectionString: testDbUrl(db), supervise: false, schedule: false })
await boss.start()
for (const queue of Object.values(QUEUES)) await boss.createQueue(queue)
await boss.stop({ graceful: false })
const ntfy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ token: 'tk_e2e' }) })
const providers = startFakeProviders()

const state: OpsState = { cookies: { admin: admin.cookie, member: member.cookie, linked: linked.cookie } }
mkdirSync(tmpdir(), { recursive: true })
writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 })

const keyFile = join(tmpdir(), `tm-web-ops-key-${randomBytes(4).toString('hex')}`)
writeFileSync(keyFile, TEST_MASTER.toString('base64'), { mode: 0o600 })
const env = {
  ...process.env,
  DATABASE_URL: testDbUrl(db),
  TM_PUBLIC_URL: origin,
  TM_DATA_ROOT: dataRoot,
  GITHUB_CLIENT_ID: 'e2e-client-id',
  GITHUB_CLIENT_SECRET: 'e2e-client-secret',
  GITHUB_ORG: 'tolonglabs',
  GOOGLE_CLIENT_ID: 'e2e-google-id',
  GOOGLE_CLIENT_SECRET: 'e2e-google-secret',
  GOOGLE_API_KEY: 'e2e-google-api-key',
  GOOGLE_APP_ID: '123456789012',
  NOTION_CLIENT_ID: 'e2e-notion-id',
  NOTION_CLIENT_SECRET: 'e2e-notion-secret',
  TM_MASTER_KEY_FILE: keyFile,
  NTFY_URL: `http://127.0.0.1:${ntfy.port}`,
  NTFY_ADMIN_TOKEN: 'e2e-ntfy-admin',
  TM_FAKE_PROVIDERS: `http://127.0.0.1:${providers.port}`,
  // Its own build folder, so a build by another spec in this folder can't replace the pages under test.
  TM_NEXT_DIST_DIR: 'node_modules/.cache/tm-ops-next'
}

// The pages of this spec and the API, as production builds them. TM_E2E_BUILD_PATHS (comma-separated globs) replaces the list.
const buildPaths =
  process.env.TM_E2E_BUILD_PATHS ??
  'app/devices/**,app/connections/**,app/admin/**,app/sign-in/**,app/page.tsx,app/api/**'
const build = Bun.spawn(['bun', '--bun', 'next', 'build', '--debug-build-paths', buildPaths], {
  cwd: webRoot,
  env,
  stdout: 'inherit',
  stderr: 'inherit'
})
if ((await build.exited) !== 0) {
  await cleanup()
  throw new Error('next build failed')
}
// The server runs in a child Bun, which a `--preload` on the command line does not reach; BUN_OPTIONS does.
const site = Bun.spawn(['bun', '--bun', 'next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: webRoot,
  env: {
    ...env,
    BUN_OPTIONS: `--preload=${join(import.meta.dir, 'preload.mjs')}`
  },
  stdout: 'inherit',
  stderr: 'inherit'
})

async function cleanup() {
  await ntfy.stop(true)
  await providers.stop(true)
  rmSync(keyFile, { force: true })
  rmSync(dataRoot, { recursive: true, force: true })
  rmSync(STATE_FILE, { force: true })
  await dropAllTestDbs()
}

async function stop() {
  site.kill()
  await site.exited
  await cleanup()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
await site.exited
await cleanup()
