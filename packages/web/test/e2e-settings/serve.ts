// Starts the website for the settings specs: a scratch database, one seeded member with a real Better Auth session and no
// AI key, no ntfy topic and no details, a fake ntfy and fake AI providers, a production build and `next start`. Stops the
// site and drops the database on SIGTERM or SIGINT. The page specs in `test/e2e` use `serve.ts` there.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { schema } from '../../db'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember, testDbUrl, TEST_MASTER } from '../../db/testing'
import { createAuth } from '../../lib/auth'
import { startFakes } from './fakes'
import { STATE_FILE, type SettingsE2eState } from './state'

const webRoot = join(import.meta.dir, '..', '..')
const port = Number(process.argv[2])
const origin = `http://127.0.0.1:${port}`

const db = await createTestDb()
const fakes = startFakes()

const auth = createAuth({
  db,
  master: TEST_MASTER,
  publicUrl: origin,
  clientId: 'e2e-client-id',
  clientSecret: 'e2e-client-secret',
  org: 'tolonglabs',
  github: { user: async () => ({ id: 2001, login: 'e2e-settings' }), orgMembership: async () => 'active' }
})
const ctx = await auth.$context

const seeded = await seedMember(db, { githubLogin: 'e2e-settings', role: 'member', full: false })
await db.delete(schema.aiKeys).where(eq(schema.aiKeys.memberId, seeded.memberId))
const authUserId = await seedAuthUser(db, { githubToken: 'gho_settings' })
const session = await ctx.internalAdapter.createSession(authUserId)
const signature = createHmac('sha256', ctx.secret).update(session.token).digest('base64')

const state: SettingsE2eState = {
  cookie: { name: ctx.authCookies.sessionToken.name, value: encodeURIComponent(`${session.token}.${signature}`) },
  ntfyOrigin: fakes.ntfyOrigin
}
mkdirSync(tmpdir(), { recursive: true })
writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 })

const keyFile = join(tmpdir(), `tm-web-e2e-key-${randomBytes(4).toString('hex')}`)
writeFileSync(keyFile, TEST_MASTER.toString('base64'), { mode: 0o600 })
const env = {
  ...process.env,
  DATABASE_URL: testDbUrl(db),
  TM_PUBLIC_URL: origin,
  GITHUB_CLIENT_ID: 'e2e-client-id',
  GITHUB_CLIENT_SECRET: 'e2e-client-secret',
  GITHUB_ORG: 'tolonglabs',
  TM_MASTER_KEY_FILE: keyFile,
  NTFY_URL: fakes.ntfyOrigin,
  NTFY_ADMIN_TOKEN: 'tk_e2e_admin',
  TM_E2E_FAKE_PROVIDERS: fakes.providersOrigin
}

// Narrow with TM_E2E_BUILD_PATHS (comma-separated globs) to speed up a run.
const buildPaths = process.env.TM_E2E_BUILD_PATHS
const build = Bun.spawn(['bun', '--bun', 'next', 'build', ...(buildPaths ? ['--debug-build-paths', buildPaths] : [])], {
  cwd: webRoot,
  env,
  stdout: 'inherit',
  stderr: 'inherit'
})
if ((await build.exited) !== 0) {
  await cleanup()
  throw new Error('next build failed')
}
// `bun --preload ... --bun next` would not pass the preload on, so Next's own entry file is run directly.
const site = Bun.spawn(
  [
    'bun',
    '--preload',
    join(import.meta.dir, 'fake-providers.ts'),
    Bun.resolveSync('next/dist/bin/next', webRoot),
    'start',
    '-H',
    '127.0.0.1',
    '-p',
    String(port)
  ],
  { cwd: webRoot, env, stdout: 'inherit', stderr: 'inherit' }
)

async function cleanup() {
  fakes.stop()
  rmSync(keyFile, { force: true })
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
