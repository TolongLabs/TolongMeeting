import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { GET as parentsGET } from '../app/api/connections/notion/parents/route'
import { PUT as parentPUT } from '../app/api/connections/notion/parent/route'
import { GET as startGET } from '../app/api/connections/notion/start/route'
import { connections, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { exportStores } from '../lib/exports'
import { notionCallbackResponse, notionParentResponse, notionParentsResponse, notionStartResponse } from '../lib/notion'
import { createScope } from '../lib/scope'

const ACCESS = 'ntn_web_access_secret'
const REFRESH = 'ntn_web_refresh_secret'
const PAGE = '3c90c3cc-0d44-4b50-8888-8dd25736052a'
const ENV = ['TM_PUBLIC_URL', 'TM_MASTER_KEY_FILE', 'TM_DATA_ROOT', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET']

let db: Db
let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  db = await createTestDb()
  dir = mkdtempSync(join(tmpdir(), 'tm-notion-routes-'))
  writeFileSync(join(dir, 'master.key'), randomBytes(32).toString('base64'))
  for (const name of ENV) saved[name] = process.env[name]
  Object.assign(process.env, {
    TM_PUBLIC_URL: 'https://tm.example',
    TM_MASTER_KEY_FILE: join(dir, 'master.key'),
    TM_DATA_ROOT: dir,
    NOTION_CLIENT_ID: 'web-notion-id',
    NOTION_CLIENT_SECRET: 'web-notion-secret'
  })
}, 30_000)

afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(dir, { recursive: true, force: true })
  await dropAllTestDbs()
}, 30_000)

/** A fake Notion that records each call. */
function fakeNotion() {
  const calls: {
    url: string
    method: string
    redirect: string
    authorization: string | null
    version: string | null
  }[] = []
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({
      url: req.url,
      method: req.method,
      redirect: req.redirect,
      authorization: req.headers.get('authorization'),
      version: req.headers.get('notion-version')
    })
    const path = new URL(req.url).pathname
    if (path === '/v1/oauth/token')
      return Response.json({ access_token: ACCESS, refresh_token: REFRESH, workspace_name: 'Kelas' })
    if (path === '/v1/search') return Response.json({ results: [] })
    if (path === `/v1/pages/${PAGE}`)
      return Response.json({
        id: PAGE,
        url: `https://www.notion.so/${PAGE.replaceAll('-', '')}`,
        properties: { title: { type: 'title', title: [{ plain_text: 'Lecture notes' }] } }
      })
    throw new Error(`unexpected ${req.method} ${req.url}`)
  }) as typeof fetch
  return { fetch: fetchFake, calls }
}

const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!
const callbackRequest = (state: string, cookie: string | null) =>
  new Request(`https://tm.example/api/connections/notion/callback?state=${state}&code=abc`, {
    headers: cookie === null ? {} : { cookie }
  })
const put = (body: unknown) =>
  new Request('https://tm.example/api/connections/notion/parent', { method: 'PUT', body: JSON.stringify(body) })

test('routes refuse a cross-site caller before anything else', async () => {
  const get = (path: string, headers: Record<string, string>) =>
    new Request(`https://tm.example/api/connections/notion/${path}`, { headers })
  for (const [handler, path] of [
    [startGET, 'start'],
    [parentsGET, 'parents']
  ] as const) {
    for (const headers of <Record<string, string>[]>[
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      {}
    ])
      expect((await handler(get(path, headers))).status).toBe(403)
  }
  for (const origin of ['https://evil.example', null]) {
    const res = await parentPUT(
      new Request('https://tm.example/api/connections/notion/parent', {
        method: 'PUT',
        body: JSON.stringify({ type: 'page_id', id: PAGE }),
        headers: origin === null ? {} : { origin }
      })
    )
    expect(res.status).toBe(403)
  }
})

test('sign-in, parent choice and isolation between members', async () => {
  const a = await seedMember(db)
  const b = await seedMember(db)
  for (const m of [a.memberId, b.memberId]) await db.delete(connections).where(eq(connections.memberId, m))
  const scopeA = createScope(db, a.memberId)
  const scopeB = createScope(db, b.memberId)

  const start = notionStartResponse(scopeA)
  expect(start.status).toBe(302)
  const to = new URL(start.headers.get('location')!)
  expect(to.origin + to.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
  expect(to.searchParams.get('client_id')).toBe('web-notion-id')
  expect(to.searchParams.get('redirect_uri')).toBe('https://tm.example/api/connections/notion/callback')
  expect(start.headers.get('set-cookie')).toContain('HttpOnly')
  expect(start.headers.get('set-cookie')).toContain('Path=/api/connections/notion')
  const state = to.searchParams.get('state')!
  const cookie = cookieOf(start)

  // Another member presenting the first member's cookie and state gets the fixed refusal and no connection.
  const stolen = fakeNotion()
  const refused = await notionCallbackResponse(scopeB, callbackRequest(state, cookie), stolen.fetch)
  expect(refused.headers.get('location')).toBe('https://tm.example/connections?notion=invalid_state')
  expect(refused.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(stolen.calls).toEqual([])
  expect(await exportStores(scopeB).connections.get('notion')).toBeNull()
  const missing = await notionCallbackResponse(scopeA, callbackRequest(state, null), stolen.fetch)
  expect(missing.headers.get('location')).toBe('https://tm.example/connections?notion=invalid_state')

  const n = fakeNotion()
  const done = await notionCallbackResponse(scopeA, callbackRequest(state, cookie), n.fetch)
  expect(done.headers.get('location')).toBe('https://tm.example/connections?notion=connected')
  expect(done.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(n.calls.map((c) => [c.url, c.redirect, c.version])).toEqual([
    ['https://api.notion.com/v1/oauth/token', 'error', '2026-03-11']
  ])
  const [row] = await db.select().from(connections).where(eq(connections.memberId, a.memberId))
  expect(row?.tokenEnc).not.toContain(ACCESS)
  expect(JSON.stringify(row?.settings)).not.toContain('ntn_')
  expect(row?.settings).toEqual({ workspace: 'Kelas', parent: null })
  expect(await exportStores(scopeB).connections.get('notion')).toBeNull()

  // The parent comes from the member's choice, read back from Notion.
  const choose = fakeNotion()
  const chosen = await notionParentResponse(scopeA, put({ type: 'page_id', id: PAGE }), choose.fetch)
  expect(chosen.status).toBe(200)
  expect(await chosen.text()).not.toContain('ntn_')
  expect(choose.calls.map((c) => [c.method, new URL(c.url).origin, c.authorization])).toEqual([
    ['GET', 'https://api.notion.com', `Bearer ${ACCESS}`]
  ])
  const [after] = await db.select().from(connections).where(eq(connections.memberId, a.memberId))
  expect(after?.settings).toEqual({
    workspace: 'Kelas',
    parent: { type: 'page_id', id: PAGE, name: 'Lecture notes', titleProperty: 'title' }
  })
  expect(JSON.stringify(await exportStores(scopeA).connections.summaries())).not.toContain('ntn_')

  // A bad id is refused without a call to Notion; the other member has nothing to choose from.
  const none = fakeNotion()
  expect((await notionParentResponse(scopeA, put({ type: 'page_id', id: 'PARENT' }), none.fetch)).status).toBe(422)
  expect((await notionParentResponse(scopeB, put({ type: 'page_id', id: PAGE }), none.fetch)).status).toBe(409)
  expect((await notionParentsResponse(scopeB, none.fetch)).status).toBe(409)
  expect(none.calls).toEqual([])
  expect((await notionParentsResponse(scopeA, none.fetch)).status).toBe(200)
})

test('without a Notion client in the environment the routes answer 503', async () => {
  const id = process.env.NOTION_CLIENT_ID
  process.env.NOTION_CLIENT_ID = ''
  try {
    const m = await seedMember(db)
    const scope = createScope(db, m.memberId)
    expect(notionStartResponse(scope).status).toBe(503)
    expect((await notionParentsResponse(scope)).status).toBe(503)
  } finally {
    process.env.NOTION_CLIENT_ID = id
  }
})
