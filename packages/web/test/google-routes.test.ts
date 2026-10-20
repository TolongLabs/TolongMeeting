import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { GET as callbackGET } from '../app/api/connections/google/callback/route'
import { PUT as folderPUT } from '../app/api/connections/google/folder/route'
import { GET as pickerGET } from '../app/api/connections/google/picker/route'
import { GET as startGET } from '../app/api/connections/google/start/route'
import { connections, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { exportStores } from '../lib/exports'
import { googleCallbackResponse, googleFolderResponse, googlePickerResponse, googleStartResponse } from '../lib/google'
import { clearOAuthCookie, readOAuthCookie, setOAuthCookie } from '../lib/oauth-cookie'
import { createScope } from '../lib/scope'

const REFRESH = '1//web-refresh-secret'
const ACCESS = 'ya29.web-access-secret'
const FOLDER = 'webFolderIdAAAA1'
const ENV = [
  'TM_PUBLIC_URL',
  'TM_MASTER_KEY_FILE',
  'TM_DATA_ROOT',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_API_KEY',
  'GOOGLE_APP_ID'
]

let db: Db
let dir: string
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  db = await createTestDb()
  dir = mkdtempSync(join(tmpdir(), 'tm-google-routes-'))
  writeFileSync(join(dir, 'master.key'), randomBytes(32).toString('base64'))
  for (const name of ENV) saved[name] = process.env[name]
  Object.assign(process.env, {
    TM_PUBLIC_URL: 'https://tm.example',
    TM_MASTER_KEY_FILE: join(dir, 'master.key'),
    TM_DATA_ROOT: dir,
    GOOGLE_CLIENT_ID: 'web-client-id',
    GOOGLE_CLIENT_SECRET: 'web-client-secret',
    GOOGLE_API_KEY: 'AIzaWebPickerKey',
    GOOGLE_APP_ID: '123456789'
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

/** A fake Google that records each call. */
function fakeGoogle() {
  const calls: { url: string; method: string; redirect: string; authorization: string | null; body: string }[] = []
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const body = await req.clone().text()
    calls.push({
      url: req.url,
      method: req.method,
      redirect: req.redirect,
      authorization: req.headers.get('authorization'),
      body
    })
    const url = new URL(req.url)
    if (url.pathname === '/token') {
      return Response.json({
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: 'https://www.googleapis.com/auth/drive.file'
      })
    }
    if (url.pathname === '/drive/v3/about') return Response.json({ user: { emailAddress: 'web@example.edu' } })
    if (url.pathname === '/drive/v3/files')
      return Response.json({ files: [{ id: FOLDER, name: 'TolongMeeting Exports' }] })
    throw new Error(`unexpected ${req.method} ${req.url}`)
  }) as typeof fetch
  return { fetch: fetchFake, calls }
}

const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!
const callbackRequest = (state: string, cookie: string | null) =>
  new Request(`https://tm.example/api/connections/google/callback?state=${state}&code=abc`, {
    headers: cookie === null ? {} : { cookie }
  })

test('the sign-in cookie is HttpOnly, Secure, Lax, scoped to the Google routes and lasts ten minutes', () => {
  const set = setOAuthCookie('google', 'v1.abc.def.ghi')
  for (const part of [
    'tm_oauth_google=v1.abc.def.ghi',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/api/connections/google',
    'Max-Age=600'
  ])
    expect(set).toContain(part)
  expect(clearOAuthCookie('google')).toContain('Max-Age=0')
  const req = new Request('https://tm.example', {
    headers: { cookie: 'a=b; tm_oauth_google=v1.abc.def.ghi; tm_oauth_notion=zzz' }
  })
  expect(readOAuthCookie(req, 'google')).toBe('v1.abc.def.ghi')
  expect(readOAuthCookie(req, 'notion')).toBe('zzz')
  expect(readOAuthCookie(new Request('https://tm.example'), 'google')).toBeNull()
})

test('routes refuse a cross-site caller before anything else', async () => {
  const get = (url: string, headers: Record<string, string>) =>
    new Request(`https://tm.example/api/connections/google/${url}`, { headers })
  for (const handler of [startGET, pickerGET]) {
    const path = handler === startGET ? 'start' : 'picker'
    for (const headers of <Record<string, string>[]>[
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      {}
    ]) {
      expect((await handler(get(path, headers))).status).toBe(403)
    }
  }
  for (const origin of ['https://evil.example', null]) {
    const res = await folderPUT(
      new Request('https://tm.example/api/connections/google/folder', {
        method: 'PUT',
        body: JSON.stringify({ useDefault: true }),
        headers: origin === null ? {} : { origin }
      })
    )
    expect(res.status).toBe(403)
  }
  expect(typeof callbackGET).toBe('function')
})

test('start, callback, picker and folder work for the signed-in member only', async () => {
  const a = await seedMember(db)
  const b = await seedMember(db)
  for (const m of [a.memberId, b.memberId]) await db.delete(connections).where(eq(connections.memberId, m))
  const scopeA = createScope(db, a.memberId)
  const scopeB = createScope(db, b.memberId)

  const start = googleStartResponse(scopeA)
  expect(start.status).toBe(302)
  expect(start.headers.get('cache-control')).toBe('no-store')
  const to = new URL(start.headers.get('location')!)
  expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(to.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
  expect(to.searchParams.get('client_id')).toBe('web-client-id')
  expect(start.headers.get('set-cookie')).toContain('HttpOnly')
  const state = to.searchParams.get('state')!
  const cookie = cookieOf(start)

  // Another member presenting the first member's cookie and state gets the fixed refusal and no connection.
  const stolen = fakeGoogle()
  const refused = await googleCallbackResponse(scopeB, callbackRequest(state, cookie), stolen.fetch)
  expect(refused.headers.get('location')).toBe('https://tm.example/connections?google=invalid_state')
  expect(refused.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(stolen.calls).toEqual([])
  expect(await exportStores(scopeB).connections.get('google')).toBeNull()

  const g = fakeGoogle()
  const done = await googleCallbackResponse(scopeA, callbackRequest(state, cookie), g.fetch)
  expect(done.status).toBe(302)
  expect(done.headers.get('location')).toBe('https://tm.example/connections?google=connected')
  expect(done.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(g.calls.every((c) => c.redirect === 'error')).toBe(true)
  expect(g.calls.map((c) => new URL(c.url).origin)).toEqual([
    'https://oauth2.googleapis.com',
    'https://www.googleapis.com',
    'https://www.googleapis.com'
  ])
  const [row] = await db.select().from(connections).where(eq(connections.memberId, a.memberId))
  expect(row?.tokenEnc).not.toContain(REFRESH)
  expect(JSON.stringify(row?.settings)).not.toContain(REFRESH)
  expect(row?.settings).toEqual({
    account: 'web@example.edu',
    folderId: FOLDER,
    folderName: 'TolongMeeting Exports',
    folderIsDefault: true
  })
  expect(await exportStores(scopeB).connections.get('google')).toBeNull()
  expect(JSON.stringify(await exportStores(scopeA).connections.summaries())).not.toContain(REFRESH)

  // The picker hands the browser a fresh access token, never the refresh token.
  const refresh = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const form = new URLSearchParams(await new Request(input, init).text())
    expect(form.get('refresh_token')).toBe(REFRESH)
    return Response.json({ access_token: ACCESS })
  }) as typeof fetch
  const picker = await googlePickerResponse(scopeA, refresh)
  expect(picker.headers.get('cache-control')).toBe('no-store')
  const text = await picker.text()
  expect(JSON.parse(text)).toEqual({ accessToken: ACCESS, apiKey: 'AIzaWebPickerKey', appId: '123456789' })
  expect(text).not.toContain(REFRESH)
  expect((await googlePickerResponse(scopeB, refresh)).status).toBe(409)

  // A folder id that is a URL or path is refused without calling Google.
  const none = fakeGoogle()
  const bad = await googleFolderResponse(
    scopeA,
    new Request('https://tm.example/x', {
      method: 'PUT',
      body: JSON.stringify({ folderId: 'https://drive.google.com/drive/folders/abc' })
    }),
    none.fetch
  )
  expect(bad.status).toBe(400)
  expect(none.calls).toEqual([])
})

test('without a Google client the routes say so instead of failing', async () => {
  const id = process.env.GOOGLE_CLIENT_ID
  process.env.GOOGLE_CLIENT_ID = ''
  try {
    const m = await seedMember(db)
    expect(googleStartResponse(createScope(db, m.memberId)).status).toBe(503)
  } finally {
    process.env.GOOGLE_CLIENT_ID = id
  }
})
