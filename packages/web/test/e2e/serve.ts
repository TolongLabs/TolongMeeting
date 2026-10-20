// Starts the website for the page specs: a scratch database, two seeded members with real Better Auth sessions, a
// production build and `next start`. Stops the site and drops the database on SIGTERM or SIGINT.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { schema } from '../../db'
import { QUEUES } from '../../db/queues'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember, testDbUrl, TEST_MASTER } from '../../db/testing'
import { createAuth } from '../../lib/auth'
import { giveLiveMeetingALink, seedMeetings } from './seed-meetings'
import { STATE_FILE, type E2eState } from './state'

const webRoot = join(import.meta.dir, '..', '..')
const port = Number(process.argv[2])
const origin = `http://127.0.0.1:${port}`
const DAY = 24 * 3_600_000

const db = await createTestDb()

// Which GitHub user each fake token belongs to; sign-in links the member with the same login.
const users: Record<string, { id: number; login: string }> = {
  gho_admin: { id: 1001, login: 'e2e-admin' },
  gho_member: { id: 1002, login: 'e2e-member' }
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

async function signedIn(login: string, role: 'admin' | 'member', token: string, full: boolean) {
  const seeded = await seedMember(db, { githubLogin: login, role, full })
  const authUserId = await seedAuthUser(db, { githubToken: token })
  const session = await ctx.internalAdapter.createSession(authUserId)
  const signature = createHmac('sha256', ctx.secret).update(session.token).digest('base64')
  return {
    seeded,
    cookie: { name: ctx.authCookies.sessionToken.name, value: encodeURIComponent(`${session.token}.${signature}`) }
  }
}

const admin = await signedIn('e2e-admin', 'admin', 'gho_admin', true)
const member = await signedIn('e2e-member', 'member', 'gho_member', false)

// The admin has a lecture tomorrow, a meeting in progress and an old failed one that is deleted in 2 days.
const now = Date.now()
const { ids, memberId, identityId } = admin.seeded
await db
  .update(schema.occurrences)
  .set({ scheduledStart: new Date(now + DAY), scheduledEnd: new Date(now + DAY + 2 * 3_600_000) })
  .where(eq(schema.occurrences.id, ids.occurrences))
const base = {
  memberId,
  entryId: ids.timetableEntries,
  identityId,
  entryType: 'work',
  transcription: 'live'
} as const
await db.insert(schema.occurrences).values([
  {
    ...base,
    entryName: 'Live standup',
    state: 'in_meeting' as const,
    scheduledStart: new Date(now - 600_000),
    scheduledEnd: new Date(now + 3_000_000),
    deleteAfter: new Date(now + 30 * DAY)
  },
  {
    ...base,
    entryName: 'Old lecture',
    state: 'failed' as const,
    scheduledStart: new Date(now - 28 * DAY),
    scheduledEnd: new Date(now - 28 * DAY + 3_600_000),
    deleteAfter: new Date(now + 2 * DAY)
  }
])

// Saving an entry needs the queues pg-boss sends to (the scheduler makes them in production) and an ntfy server that
// accepts a member's setup and pings. The stand-in answers every request with a token and keeps nothing.
const boss = new PgBoss({ connectionString: testDbUrl(db), supervise: false, schedule: false })
await boss.start()
for (const queue of Object.values(QUEUES)) await boss.createQueue(queue)
await boss.stop({ graceful: false })
const ntfy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ token: 'tk_e2e' }) })

// The meeting pages read files from the data root, so the seeded meetings get a real one.
const dataRoot = mkdtempSync(join(tmpdir(), 'tm-web-e2e-data-'))
const seeded = await seedMeetings({ db, dataRoot, memberId, identityId, entryId: ids.timetableEntries, now })
const live = await giveLiveMeetingALink(db)

const state: E2eState = {
  cookies: { admin: admin.cookie, member: member.cookie },
  meetings: { completed: seeded.completed, live, uploading: seeded.uploading, stuck: seeded.stuck }
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
  TM_DATA_ROOT: dataRoot,
  NTFY_URL: `http://127.0.0.1:${ntfy.port}`,
  NTFY_ADMIN_TOKEN: 'e2e-ntfy-admin'
}

// The whole site, as production builds it. TM_E2E_BUILD_PATHS (comma-separated globs) narrows it to speed up a run.
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
const site = Bun.spawn(['bun', '--bun', 'next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: webRoot,
  env,
  stdout: 'inherit',
  stderr: 'inherit'
})

async function cleanup() {
  await ntfy.stop(true)
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
