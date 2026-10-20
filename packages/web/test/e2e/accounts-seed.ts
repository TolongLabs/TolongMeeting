// Seeds the running page-test site for accounts.spec.ts. Playwright runs the specs, but the seeding needs the data layer,
// so the spec runs this file with Bun and reads one JSON line from it:
//   bun test/e2e/accounts-seed.ts member <origin>      a signed-in member with identities, a PC and a due meeting
//   bun test/e2e/accounts-seed.ts touch <deviceId>     marks the PC as seen now (a PC is online for 90 seconds)
//   bun test/e2e/accounts-seed.ts home <memberId>      a stored home device for the member
//   bun test/e2e/accounts-seed.ts session <identityId> <state>   an open sign-in session for the identity
// The site's database is the one that holds the shared admin's session (the cookie in the state file), so a stray
// database of another run is never touched.
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { vncSecret } from '@tm/core'
import { schema, type Db } from '../../db'
import { seedAuthUser, seedMember, TEST_MASTER } from '../../db/testing'
import { createAuth } from '../../lib/auth'
import { STATE_FILE, type E2eState } from './state'

const HOUR = 3_600_000

/** `tm_web_<pid>_<base36 time>_<hex>`: the time it was made, to try the newest databases first. */
const madeAt = (name: string) => parseInt(name.split('_')[3] ?? '0', 36)

function urlOf(name: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.pathname = `/${name}`
  return url.toString()
}

/** True when the database is a page-test site's: it holds the admin's session (`token`), or just the admin when no token is known. */
async function isSite(name: string, token: string | null): Promise<boolean> {
  const probe = new Pool({ connectionString: urlOf(name), max: 1 })
  try {
    const hit =
      token === null
        ? await probe.query("select 1 from members where github_login = 'e2e-admin'")
        : await probe.query('select 1 from auth_session where token = $1', [token])
    return (hit.rowCount ?? 0) > 0
  } catch {
    // Not a database of the page tests (no such table), or dropped meanwhile.
    return false
  } finally {
    await probe.end()
  }
}

/**
 * The site's database: `SITE_DB` when the spec already knows it, else the newest one that holds the shared admin's
 * session (the cookie in the state file), or, when another run has removed that file, the newest with the shared admin.
 */
async function siteDb(): Promise<{ db: Db; name: string }> {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set')
  let name = process.env.SITE_DB
  if (!name) {
    const state = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState) : null
    const token = state ? decodeURIComponent(state.cookies.admin.value).split('.')[0]! : null
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
    const names = (await admin.query("select datname from pg_database where datname like 'tm\\_web\\_%'")).rows
      .map((r: { datname: string }) => r.datname)
      .sort((x, y) => madeAt(y) - madeAt(x))
    await admin.end()
    for (let i = 0; i < names.length && !name; i += 16) {
      const batch = names.slice(i, i + 16)
      const hits = await Promise.all(batch.map((n) => isSite(n, token)))
      name = batch[hits.indexOf(true)]
    }
  }
  if (!name) throw new Error('The page-test site database was not found')
  return { db: drizzle(new Pool({ connectionString: urlOf(name), max: 2 }), { schema }), name }
}

async function seedMemberFor(db: Db, origin: string) {
  // A new login every time: the member of a retried run must not clash with the one before.
  const suffix = randomBytes(3).toString('hex')
  const login = `e2e-accounts-${suffix}`
  const token = `gho_accounts_${suffix}`
  const users: Record<string, { id: number; login: string }> = { [token]: { id: 1003 + parseInt(suffix, 16), login } }
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
  const seeded = await seedMember(db, { githubLogin: login, role: 'member', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: token })
  const session = await ctx.internalAdapter.createSession(authUserId)
  const signature = createHmac('sha256', ctx.secret).update(session.token).digest('base64')
  const cookie = { name: ctx.authCookies.sessionToken.name, value: encodeURIComponent(`${session.token}.${signature}`) }

  const { memberId, identityId: main } = seeded
  const now = Date.now()
  const iso = (ms: number) => new Date(now - ms).toISOString()
  // "Main": Zoom signed in, Google signed out, the rest never checked.
  await db
    .update(schema.profiles)
    .set({
      accountStatus: {
        zoom: { verifiedAt: iso(HOUR), signedIn: true },
        google: { verifiedAt: iso(2 * HOUR), signedIn: false }
      }
    })
    .where(eq(schema.profiles.identityId, main))
  // A meeting for "Main" that starts in 30 minutes: it blocks a move.
  const [entry] = await db
    .insert(schema.timetableEntries)
    .values({
      memberId,
      identityId: main,
      name: 'Due soon',
      type: 'work',
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '10:00',
      endTime: '11:00',
      link: { kind: 'paste' },
      transcription: 'live'
    })
    .returning()
  await db.insert(schema.occurrences).values({
    memberId,
    entryId: entry!.id,
    identityId: main,
    entryName: 'Due soon',
    entryType: 'work',
    transcription: 'live',
    scheduledStart: new Date(now + 30 * 60_000),
    scheduledEnd: new Date(now + 90 * 60_000),
    deleteAfter: new Date(now + 30 * 24 * HOUR)
  })
  const [device] = await db
    .insert(schema.deviceTokens)
    .values({ memberId, name: 'Test laptop', tokenHash: randomBytes(16).toString('hex'), lastUsedAt: new Date() })
    .returning()
  const deviceId = device!.id

  const extra = async (
    name: string,
    set: Partial<typeof schema.identities.$inferInsert>,
    location: 'server' | 'local'
  ) => {
    const [row] = await db
      .insert(schema.identities)
      .values({ memberId, name, zoomGuestName: 'Seed Member', ...set })
      .returning()
    await db.insert(schema.profiles).values({ identityId: row!.id, memberId, location })
    return row!.id
  }
  const spare = await extra('Spare', {}, 'server')
  const laptop = await extra('Laptop', { runLocation: 'local', localDeviceId: deviceId }, 'local')
  const remote = await extra('Remote', { runLocation: 'server_via_home' }, 'server')
  const desk = await extra('Desk', {}, 'server')
  const slow = await extra('Slow', {}, 'server')
  return { cookie, memberId, deviceId, identities: { main, spare, laptop, remote, desk, slow } }
}

const [command, a, b] = process.argv.slice(2)
const { db, name } = await siteDb()
if (command === 'member') {
  console.log(JSON.stringify({ ...(await seedMemberFor(db, a!)), siteDb: name }))
} else if (command === 'touch') {
  await db.update(schema.deviceTokens).set({ lastUsedAt: new Date() }).where(eq(schema.deviceTokens.id, a!))
  console.log('{}')
} else if (command === 'home') {
  await db.insert(schema.homeExitNodes).values({
    memberId: a!,
    nodeId: `e2e-node-${a}`,
    hostname: 'tm-home-e2e',
    ipv4: '100.64.0.9',
    checkedAt: new Date()
  })
  console.log('{}')
} else if (command === 'session') {
  const [identity] = await db.select().from(schema.identities).where(eq(schema.identities.id, a!))
  const state = b as 'starting' | 'ready' | 'ended'
  const hash = randomBytes(16).toString('hex')
  const [row] = await db
    .insert(schema.signinSessions)
    .values({
      memberId: identity!.memberId,
      identityId: a!,
      mode: 'container',
      state,
      controlTokenHash: hash,
      upstream: 'tm-signin-e2e:6080'
    })
    .returning()
  // The secret the view's password is made from: the spec checks it appears in no page and no URL.
  console.log(JSON.stringify({ sessionId: row!.id, secret: vncSecret(hash) }))
} else {
  throw new Error(`Unknown command ${command}`)
}
process.exit(0)
