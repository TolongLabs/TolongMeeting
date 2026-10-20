import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { PUT } from '../app/api/connections/github/route'
import { connections, type Db } from '../db'
import { memberExportStores } from '../db/exports'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { connectionsResponse, saveGitHubResponse } from '../lib/exports'
import { createScope } from '../lib/scope'

let db: Db
let master: Buffer
let previousUrl: string | undefined
const TOKEN = 'github_pat_route_secret_1234'

beforeAll(async () => {
  db = await createTestDb()
  master = randomBytes(32)
  previousUrl = process.env.TM_PUBLIC_URL
  process.env.TM_PUBLIC_URL = 'https://tm.example/'
}, 30_000)

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.TM_PUBLIC_URL
  else process.env.TM_PUBLIC_URL = previousUrl
  await dropAllTestDbs()
}, 30_000)

/** A fetch that answers GitHub's two checks and records what it was asked. */
function fakeGitHub(status = 200) {
  const calls: { url: string; redirect: string; authorization: string | null }[] = []
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({ url: req.url, redirect: req.redirect, authorization: req.headers.get('authorization') })
    return Response.json({}, { status })
  }) as typeof fetch
  return { fetch: fetchFake, calls }
}

const put = (body: unknown, origin: string | null = 'https://tm.example') =>
  new Request('https://tm.example/api/connections/github', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: origin === null ? {} : { origin }
  })
const settings = { owner: 'acme', repo: 'notes', branch: 'main', folder: 'meetings' }

test('a cross-origin or origin-less PUT is refused before anything else', async () => {
  for (const origin of ['https://evil.example', null]) {
    const res = await PUT(put({ ...settings, token: TOKEN }, origin))
    expect(res.status).toBe(403)
  }
})

test('the token is checked at GitHub, sealed for this member only, and never returned', async () => {
  const a = await seedMember(db)
  const b = await seedMember(db)
  for (const m of [a.memberId, b.memberId]) await db.delete(connections).where(eq(connections.memberId, m))
  const forMember = (id: string) => memberExportStores(createScope(db, id), master, '/unused')
  const mine = forMember(a.memberId)
  const gh = fakeGitHub()

  const res = await saveGitHubResponse(mine, put({ ...settings, token: TOKEN }), gh.fetch)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.text()).not.toContain(TOKEN)
  expect(gh.calls.map((c) => new URL(c.url).origin)).toEqual(['https://api.github.com', 'https://api.github.com'])
  expect(gh.calls.every((c) => c.redirect === 'error' && c.authorization === `Bearer ${TOKEN}`)).toBe(true)

  const [row] = await db.select().from(connections).where(eq(connections.memberId, a.memberId))
  expect(row?.tokenEnc).not.toContain(TOKEN)
  expect(JSON.stringify(row?.settings)).not.toContain(TOKEN)
  expect(row?.settings).toEqual(settings)
  expect((await mine.connections.get('github'))?.connection).toMatchObject({ token: TOKEN, ...settings })
  expect(await forMember(b.memberId).connections.get('github')).toBeNull()
  const status = await (await connectionsResponse(mine)).text()
  expect(status).toContain('acme/notes')
  expect(status).not.toContain(TOKEN)
})

test('a token GitHub rejects is not saved', async () => {
  const a = await seedMember(db)
  await db.delete(connections).where(eq(connections.memberId, a.memberId))
  const mine = memberExportStores(createScope(db, a.memberId), master, '/unused')
  const res = await saveGitHubResponse(mine, put({ ...settings, token: TOKEN }), fakeGitHub(401).fetch)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'invalid_settings', message: 'GitHub rejected this token.' })
  expect(await mine.connections.get('github')).toBeNull()
})
