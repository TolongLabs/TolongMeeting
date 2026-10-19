import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { members } from '../db'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember } from '../db/testing'
import { createAuth } from '../lib/auth'
import { NOT_A_MEMBER } from '../lib/authorise'
import type { GitHubApi } from '../lib/github'

afterAll(dropAllTestDbs)

const github: GitHubApi = {
  user: async () => ({ id: 42, login: 'Octo-Member' }),
  orgMembership: async () => 'active'
}

async function setup() {
  const db = await createTestDb()
  const auth = createAuth({
    db,
    master: Buffer.alloc(32, 7),
    publicUrl: 'https://meetings.example.test',
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
    org: 'tolonglabs',
    github
  })
  return { db, auth }
}

test('the real Better Auth only stores a session for an added member, and links that member', async () => {
  const { db, auth } = await setup()
  const ctx = await auth.$context
  const stranger = await seedAuthUser(db, { githubToken: 'gho_stranger' })
  await expect(ctx.internalAdapter.createSession(stranger)).rejects.toThrow(NOT_A_MEMBER)
  expect(await ctx.internalAdapter.listSessions(stranger)).toEqual([])

  const { memberId } = await seedMember(db, { githubLogin: 'octo-member', full: false })
  const added = await seedAuthUser(db, { githubToken: 'gho_added' })
  const session = await ctx.internalAdapter.createSession(added)
  expect(session.userId).toBe(added)
  const [row] = await db.select().from(members).where(eq(members.id, memberId))
  expect(row).toMatchObject({ githubId: 42, authUserId: added })
})

test('sign-in goes to GitHub with read:org, and secrets stay out of the URL', async () => {
  const { auth } = await setup()
  const res = await auth.handler(
    new Request('https://meetings.example.test/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://meetings.example.test' },
      body: JSON.stringify({ provider: 'github', callbackURL: '/', disableRedirect: true })
    })
  )
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  const target = new URL(url)
  expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize')
  expect(target.searchParams.get('scope')).toContain('read:org')
  expect(url).not.toContain('client-secret-value')
  const cookies = res.headers.getSetCookie().join('\n')
  expect(cookies).toMatch(/HttpOnly/i)
  expect(cookies).toMatch(/Secure/i)
  expect(cookies).toMatch(/SameSite=Lax/i)
})

test('there is no email and password sign-up', async () => {
  const { auth } = await setup()
  const res = await auth.handler(
    new Request('https://meetings.example.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://meetings.example.test' },
      body: JSON.stringify({ email: 'a@b.test', password: 'password-1234', name: 'A' })
    })
  )
  expect(res.status).toBeGreaterThanOrEqual(400)
})
