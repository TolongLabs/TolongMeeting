import { afterAll, afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { schema } from '../db'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember, TEST_MASTER } from '../db/testing'
import { createAuth } from '../lib/auth'
import { NOT_A_MEMBER } from '../lib/authorise'
import type { GitHubApi } from '../lib/github'
import { authScope } from '../lib/scope'

const { auth_account, auth_user, members } = schema

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
afterAll(dropAllTestDbs)

const github: GitHubApi = {
  user: async () => ({ id: 42, login: 'Octo-Member' }),
  orgMembership: async () => 'active'
}

const PUBLIC_URL = 'https://meetings.example.test'

async function setup(publicUrl = PUBLIC_URL) {
  const db = await createTestDb()
  const auth = createAuth({
    db,
    master: TEST_MASTER,
    publicUrl,
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

const GITHUB_TOKEN = 'gho_callback_token'

/** Answers GitHub's token and user endpoints for the Better Auth callback; every other request goes nowhere. */
function fakeGitHub(profile: { id: number; login: string; email: string }): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.href === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: GITHUB_TOKEN, token_type: 'bearer', scope: 'read:org' })
    }
    if (url.href === 'https://api.github.com/user') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${GITHUB_TOKEN}`)
      return Response.json({ ...profile, name: profile.login, avatar_url: null })
    }
    if (url.href === 'https://api.github.com/user/emails') {
      return Response.json([{ email: profile.email, primary: true, verified: true }])
    }
    throw new Error(`Unexpected request to ${url.href}`)
  }) as typeof fetch
}

/** Starts a GitHub sign-in and finishes it at the callback. Returns the callback response and the cookies it set. */
async function signIn(auth: ReturnType<typeof createAuth>, publicUrl = PUBLIC_URL) {
  const start = await auth.handler(
    new Request(`${publicUrl}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: publicUrl },
      body: JSON.stringify({ provider: 'github', callbackURL: '/', disableRedirect: true })
    })
  )
  const { url } = (await start.json()) as { url: string }
  const state = new URL(url).searchParams.get('state')!
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const res = await auth.handler(
    new Request(`${publicUrl}/api/auth/callback/github?code=fake-code&state=${state}`, { headers: { cookie } })
  )
  const session = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => c!.includes('session_token'))
    .join('; ')
  return { res, session }
}

test('a GitHub user who is not a member is sent back to /sign-in with NOT_A_MEMBER, and nothing of theirs is kept', async () => {
  const { db, auth } = await setup()
  fakeGitHub({ id: 99, login: 'stranger', email: 'stranger@users.noreply.test' })
  const { res } = await signIn(auth)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!, PUBLIC_URL)
  expect(location.pathname).toBe('/sign-in')
  expect(location.searchParams.get('error')).toBe('NOT_A_MEMBER')
  expect(location.searchParams.get('error_description')).toBe(NOT_A_MEMBER)
  expect(res.headers.getSetCookie().some((c) => c.includes('session_token'))).toBe(false)
  // The auth user and its GitHub token are deleted, not left behind.
  expect(await db.$count(auth_user)).toBe(0)
  expect(await db.$count(auth_account)).toBe(0)
})

test('an added member signs in with the token sealed at rest, and endSessions ends the real session', async () => {
  const { db, auth } = await setup()
  const { memberId } = await seedMember(db, { githubLogin: 'octo-member', full: false })
  fakeGitHub({ id: 42, login: 'Octo-Member', email: 'octo@users.noreply.test' })
  const { res, session } = await signIn(auth)
  expect(res.status).toBe(302)
  expect(new URL(res.headers.get('location')!, PUBLIC_URL).pathname).toBe('/')

  const [account] = await db.select().from(auth_account)
  expect(account!.accessToken).toBeTruthy()
  expect(account!.accessToken).not.toContain(GITHUB_TOKEN)
  const [member] = await db.select().from(members).where(eq(members.id, memberId))
  expect(member).toMatchObject({ githubId: 42, authUserId: account!.userId })
  expect(await authScope(TEST_MASTER, db).githubToken(account!.userId)).toBe(GITHUB_TOKEN)

  const headers = new Headers({ cookie: session })
  expect((await auth.api.getSession({ headers }))?.user.id).toBe(account!.userId)
  await authScope(TEST_MASTER, db).endSessions(account!.userId)
  expect(await auth.api.getSession({ headers })).toBeNull()
})

test('a GitHub account does not link to an existing user with the same email', async () => {
  const { db, auth } = await setup()
  await seedMember(db, { githubLogin: 'octo-member', full: false })
  const existing = await seedAuthUser(db)
  const [user] = await db.select().from(auth_user).where(eq(auth_user.id, existing))
  fakeGitHub({ id: 42, login: 'Octo-Member', email: user!.email })
  const { res } = await signIn(auth)
  expect(res.status).toBe(302)
  expect(new URL(res.headers.get('location')!, PUBLIC_URL).searchParams.get('error')).toBe('account_not_linked')
  expect(await db.$count(auth_account)).toBe(0)
})

test('cookies are Secure only when the public URL is https', async () => {
  const insecure = 'http://localhost:3000'
  const { auth } = await setup(insecure)
  const res = await auth.handler(
    new Request(`${insecure}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: insecure },
      body: JSON.stringify({ provider: 'github', callbackURL: '/', disableRedirect: true })
    })
  )
  const cookies = res.headers.getSetCookie().join('\n')
  expect(cookies).toMatch(/HttpOnly/i)
  expect(cookies).not.toMatch(/Secure/i)
})
