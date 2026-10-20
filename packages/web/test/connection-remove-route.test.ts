import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ExportError, type Connection } from '@tm/exports/api'
import { DELETE as githubDELETE } from '../app/api/connections/github/route'
import { DELETE as googleDELETE } from '../app/api/connections/google/route'
import { DELETE as notionDELETE } from '../app/api/connections/notion/route'
import { connections, type Db } from '../db'
import { memberExportStores } from '../db/exports'
import { createTestDb, dropAllTestDbs, seedAuthUser, seedMember, testDbUrl } from '../db/testing'
import { members } from '../db'
import { removeConnectionResponse } from '../lib/exports'
import { createScope } from '../lib/scope'
import { expectNotLogged } from './no-log'

let db: Db
let master: Buffer
const saved: Record<string, string | undefined> = {}
const ENV = ['TM_PUBLIC_URL', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET']
const REFRESH = '1//route-refresh-secret'
const ACCESS = 'ntn_route_access_secret'
const TOKEN = 'github_pat_route_remove_secret'

beforeAll(async () => {
  db = await createTestDb()
  master = randomBytes(32)
  for (const name of ENV) saved[name] = process.env[name]
  Object.assign(process.env, {
    TM_PUBLIC_URL: 'https://tm.example',
    NOTION_CLIENT_ID: 'route-client',
    NOTION_CLIENT_SECRET: 'route-client-secret'
  })
}, 30_000)

afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  await dropAllTestDbs()
}, 30_000)

const google: Connection = {
  kind: 'google',
  refreshToken: REFRESH,
  account: 'a@example.edu',
  folderId: 'F1',
  folderName: 'TolongMeeting Exports',
  folderIsDefault: true
}
const notion: Connection = { kind: 'notion', accessToken: ACCESS, refreshToken: null, workspace: 'W', parent: null }
const github: Connection = { kind: 'github', token: TOKEN, owner: 'o', repo: 'r', branch: 'main', folder: '' }

const forMember = (id: string) => memberExportStores(createScope(db, id), master, '/unused')

function fakeProviders(status = 200) {
  const calls: { url: string; body: string; redirect: string }[] = []
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({ url: req.url, body: await req.clone().text(), redirect: req.redirect })
    return new Response(`echo ${REFRESH} ${ACCESS}`, { status })
  }) as typeof fetch
  return { fetch: fetchFake, calls }
}

test('a cross-origin or origin-less DELETE is refused before anything else', async () => {
  for (const handler of [githubDELETE, googleDELETE, notionDELETE]) {
    for (const headers of [{ origin: 'https://evil.example' }, {}] as Record<string, string>[]) {
      const res = await handler(new Request('https://tm.example/api/connections/x', { method: 'DELETE', headers }))
      expect(res.status).toBe(403)
    }
  }
})

test("removal deletes only the caller's sealed row, revokes at the provider and returns no token", async () => {
  const a = await seedMember(db)
  const b = await seedMember(db)
  for (const m of [a.memberId, b.memberId]) await db.delete(connections).where(eq(connections.memberId, m))
  const mine = forMember(a.memberId)
  const theirs = forMember(b.memberId)
  for (const c of [google, notion, github]) await mine.connections.save(c)
  await theirs.connections.save({ ...google, refreshToken: '1//other-member-refresh' })
  const providers = fakeProviders()
  const lines: string[] = []

  for (const kind of ['google', 'notion', 'github'] as const) {
    await expectNotLogged(kind === 'google' ? REFRESH : kind === 'notion' ? ACCESS : TOKEN, async () => {
      const res = await removeConnectionResponse(mine, kind, providers.fetch, (l) => lines.push(l))
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const text = await res.text()
      for (const secret of [REFRESH, ACCESS, TOKEN]) expect(text).not.toContain(secret)
    })
  }
  expect(providers.calls.map((c) => c.url)).toEqual([
    'https://oauth2.googleapis.com/revoke',
    'https://api.notion.com/v1/oauth/revoke'
  ])
  expect(providers.calls[0]).toMatchObject({ body: 'token=1%2F%2Froute-refresh-secret', redirect: 'error' })
  expect(providers.calls[1]!.body).toBe(JSON.stringify({ token: ACCESS }))
  expect(await db.select().from(connections).where(eq(connections.memberId, a.memberId))).toEqual([])
  expect((await theirs.connections.get('google'))?.connection).toMatchObject({
    refreshToken: '1//other-member-refresh'
  })
  expect(lines).toEqual([])
})

test("another member's connection and a missing one are both 404, and a failed revoke is logged by status only", async () => {
  const a = await seedMember(db)
  const b = await seedMember(db)
  for (const m of [a.memberId, b.memberId]) await db.delete(connections).where(eq(connections.memberId, m))
  await forMember(a.memberId).connections.save(google)
  const providers = fakeProviders(500)
  const lines: string[] = []

  const res = await removeConnectionResponse(forMember(b.memberId), 'google', providers.fetch, (l) => lines.push(l))
  expect(res.status).toBe(404)
  expect(providers.calls).toEqual([])
  expect(await forMember(a.memberId).connections.get('google')).not.toBeNull()

  await expectNotLogged(REFRESH, async () => {
    const ok = await removeConnectionResponse(forMember(a.memberId), 'google', providers.fetch, (l) => lines.push(l))
    expect(ok.status).toBe(200)
    expect(await ok.text()).not.toContain(REFRESH)
  })
  expect(lines).toEqual(['connection google revoke failed (status 500)'])
  expect(await forMember(a.memberId).connections.get('google')).toBeNull()
  expect((await removeConnectionResponse(forMember(a.memberId), 'google', providers.fetch)).status).toBe(404)
})

test('removeConnectionAction catches provider errors and redirects with fixed problem sentence', async () => {
  process.env.DATABASE_URL = testDbUrl(db)
  const a = await seedMember(db, { full: false })
  const authUserId = await seedAuthUser(db)
  await db.update(members).set({ authUserId }).where(eq(members.id, a.memberId))

  let removalRunner: () => Promise<Response> = async () =>
    new Response(JSON.stringify({ error: 'failed' }), { status: 500 })
  mock.module('next/headers', () => ({ headers: async () => new Headers() }))
  mock.module('../lib/auth', () => ({
    getAuth: () => ({ api: { getSession: async () => ({ user: { id: authUserId } }) } })
  }))
  mock.module('../lib/exports', () => ({
    exportStores: () => ({}),
    removeConnectionResponse: async () => removalRunner()
  }))

  const { removeConnectionAction } = await import('../app/connections/actions')

  const googleForm = new FormData()
  googleForm.set('kind', 'google')

  // When removal answers non-200 / provider failure:
  const res1 = await removeConnectionAction(googleForm).catch((e: unknown) => e)
  expect((res1 as { digest?: string })?.digest).toBe(
    'NEXT_REDIRECT;replace;/connections?google=google_unavailable;307;'
  )

  // When removal throws an ExportError:
  removalRunner = async () => {
    throw new ExportError('failed', 'provider error')
  }
  const res2 = await removeConnectionAction(googleForm).catch((e: unknown) => e)
  expect((res2 as { digest?: string })?.digest).toBe(
    'NEXT_REDIRECT;replace;/connections?google=google_unavailable;307;'
  )

  // When removal throws an unexpected error, it rethrows:
  removalRunner = async () => {
    throw new Error('unexpected crash')
  }
  await expect(removeConnectionAction(googleForm)).rejects.toThrow('unexpected crash')
})
