import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  beginNotionConnect,
  completeNotionConnect,
  createNotionClient,
  listNotionParents,
  MAX_TOTAL_WAIT_MS,
  NOTION_VERSION,
  notionAuthUrl,
  notionId,
  notionPageIdFromUrl,
  notionParentsRequest,
  resolveNotionParent,
  selectNotionParentRequest
} from '../src/connections/notion'
import { OAUTH_STATE_ERROR, newOAuthState, sealOAuthState } from '../src/connections/oauth'
import type { Connection, NotionConnection } from '../src/types'
import { ACCESS, DS_ID, notionConn, oauth, PARENT_ID, REFRESH, uuid, pageObject, pageParent } from './notion-fake'
import { json, routeFetch, type Route } from './route-fetch'

const master = randomBytes(32)

/** A client over `routes`; `sleeps` and `saved` record what it waited for and what it saved. */
function clientOver(routes: Route[], conn: NotionConnection = notionConn()) {
  const f = routeFetch(routes)
  const sleeps: number[] = []
  const saved: NotionConnection[] = []
  const client = createNotionClient(conn, {
    http: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    saveConnection: async (c) => {
      saved.push(c)
    },
    client: oauth
  })
  return { f, client, sleeps, saved }
}

test('authorize URL', () => {
  const u = new URL(notionAuthUrl({ client: oauth, state: 's1' }))
  expect(u.origin + u.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
  expect(Object.fromEntries(u.searchParams)).toEqual({
    client_id: 'nid',
    response_type: 'code',
    owner: 'user',
    redirect_uri: 'https://tm.example/api/connections/notion/callback',
    state: 's1'
  })
})

test('notion ids: 32 hex digits, with or without dashes', () => {
  expect(notionId('ABCDEF0123456789abcdef0123456789')).toBe('abcdef01-2345-6789-abcd-ef0123456789')
  expect(notionId(PARENT_ID)).toBe(PARENT_ID)
  for (const bad of ['PARENT', '', '../v1/users', `${PARENT_ID}/children`, PARENT_ID.slice(1), `${PARENT_ID}x`])
    expect(notionId(bad)).toBeNull()
  expect(notionPageIdFromUrl(`https://www.notion.so/Meeting-Notes-${PARENT_ID.replaceAll('-', '')}`)).toBe(PARENT_ID)
  expect(notionPageIdFromUrl(`http://www.notion.so/${PARENT_ID.replaceAll('-', '')}`)).toBeNull()
  expect(notionPageIdFromUrl(`https://evil.example/${PARENT_ID.replaceAll('-', '')}`)).toBeNull()
  expect(notionPageIdFromUrl('https://www.notion.so/no-id-here')).toBeNull()
})

test('client headers, redirect mode, token placement, spacing and rate limits', async () => {
  const { f, client, sleeps } = clientOver([
    ['POST', '/v1/search', (_req, n) => (n === 0 ? json({}, 429, { 'retry-after': '2' }) : json({ results: [] }))]
  ])
  await client.request('POST', '/v1/search', { query: 'x' })
  await client.request('POST', '/v1/search', {})
  expect(sleeps).toEqual([2000, 340])
  for (const call of f.calls) {
    expect(new URL(call.url).origin).toBe('https://api.notion.com')
    expect(call.headers['notion-version']).toBe(NOTION_VERSION)
    expect(call.headers.authorization).toBe(`Bearer ${ACCESS}`)
    expect(call.redirect).toBe('error')
    expect(call.url).not.toContain(ACCESS)
    expect(call.body).not.toContain(ACCESS)
  }
  expect(NOTION_VERSION).toBe('2026-03-11')
})

test('the client sends only API paths', async () => {
  const { f, client } = clientOver([])
  for (const path of ['https://evil.example/v1/x', '//evil.example/v1/x', '/v2/search', '/v1/../x', 'v1/search'])
    await expect(client.request('GET', path)).rejects.toThrow('Not a Notion API path')
  expect(f.calls).toHaveLength(0)
})

test('rate limits wait Retry-After, but only for a bounded time', async () => {
  const always = (retryAfter?: string, status = 429): Route => [
    'POST',
    '/v1/search',
    () => json({}, status, retryAfter === undefined ? {} : { 'retry-after': retryAfter })
  ]
  const slow = clientOver([always('60')])
  await expect(slow.client.request('POST', '/v1/search', {})).rejects.toMatchObject({
    code: 'rate_limited',
    message: 'Notion is busy. Try again in a few minutes.'
  })
  expect(slow.sleeps).toEqual([60_000, 60_000])
  expect(slow.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS)

  const huge = clientOver([always('900')])
  await expect(huge.client.request('POST', '/v1/search', {})).rejects.toMatchObject({ code: 'rate_limited' })
  expect(huge.sleeps).toEqual([])

  // No header: 1, 2, 4 ... seconds, at most five resends; 529 is treated like 429.
  const bare = clientOver([always(undefined, 529)])
  await expect(bare.client.request('POST', '/v1/search', {})).rejects.toMatchObject({ code: 'rate_limited' })
  expect(bare.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000])
  expect(bare.f.calls).toHaveLength(6)
})

test('a 401 refreshes once, saves the rotated tokens and resends; a second 401 means reconnect', async () => {
  const refresh: Route = [
    'POST',
    '/v1/oauth/token',
    () => json({ access_token: 'ntn_new_access', refresh_token: 'ntn_new_refresh' })
  ]
  const ok = clientOver([['POST', '/v1/search', (_r, n) => (n === 0 ? json({}, 401) : json({ results: [] }))], refresh])
  await ok.client.request('POST', '/v1/search', {})
  const token = ok.f.call('POST', '/v1/oauth/token')
  expect(token.headers.authorization).toBe(`Basic ${btoa('nid:ns-client-secret')}`)
  expect(token.headers['notion-version']).toBe(NOTION_VERSION)
  expect(JSON.parse(token.body)).toEqual({ grant_type: 'refresh_token', refresh_token: REFRESH })
  expect(ok.saved).toEqual([{ ...notionConn(), accessToken: 'ntn_new_access', refreshToken: 'ntn_new_refresh' }])
  expect(ok.f.calls.at(-1)!.headers.authorization).toBe('Bearer ntn_new_access')
  expect(ok.client.connection.accessToken).toBe('ntn_new_access')

  const twice = clientOver([['POST', '/v1/search', () => json({}, 401)], refresh])
  await expect(twice.client.request('POST', '/v1/search', {})).rejects.toMatchObject({ code: 'reconnect_needed' })
  expect(twice.f.count('POST', '/v1/oauth/token')).toBe(1)

  const none = clientOver([['POST', '/v1/search', () => json({}, 401)]], notionConn({ refreshToken: null }))
  await expect(none.client.request('POST', '/v1/search', {})).rejects.toMatchObject({
    code: 'reconnect_needed',
    message: 'Notion access was removed. Connect Notion again on the Connections page.'
  })

  const refused = clientOver([
    ['POST', '/v1/search', () => json({}, 401)],
    ['POST', '/v1/oauth/token', () => json({}, 400)]
  ])
  await expect(refused.client.request('POST', '/v1/search', {})).rejects.toMatchObject({ code: 'reconnect_needed' })
  expect(refused.saved).toEqual([])
})

test('error text from Notion is redacted before it is kept', async () => {
  const said = `Bad request for Bearer ${ACCESS} refresh ${REFRESH} secret ${oauth.clientSecret}`
  const { client } = clientOver([['POST', '/v1/pages', () => json({ message: said }, 400)]])
  const error = await client.request('POST', '/v1/pages', {}).catch((e: Error) => e)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toStartWith('Notion answered 400: ')
  for (const secret of [ACCESS, REFRESH, oauth.clientSecret]) expect(message).not.toContain(secret)
  expect(message).toContain('[redacted]')
})

test('uploads create the file upload, then send the bytes as multipart', async () => {
  const id = uuid(0x77)
  const { f, client } = clientOver([
    ['POST', '/v1/file_uploads', () => json({ id, status: 'pending' })],
    ['POST', `/v1/file_uploads/${id}/send`, () => json({ id, status: 'uploaded' })]
  ])
  expect(await client.upload('slide-01.jpg', new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), 'image/jpeg')).toBe(id)
  expect(JSON.parse(f.call('POST', '/v1/file_uploads').body)).toEqual({
    filename: 'slide-01.jpg',
    content_type: 'image/jpeg'
  })
  const send = f.call('POST', `/v1/file_uploads/${id}/send`)
  expect(send.headers['content-type']).toStartWith('multipart/form-data; boundary=')
  expect(send.body).toContain('name="file"; filename="slide-01.jpg"')
  expect(send.body).toContain('Content-Type: image/jpeg')

  // An upload id that is not a Notion id never reaches a URL path.
  const bad = clientOver([['POST', '/v1/file_uploads', () => json({ id: '../../users', status: 'pending' })]])
  await expect(bad.client.upload('a.jpg', new Uint8Array(1), 'image/jpeg')).rejects.toMatchObject({ code: 'failed' })
  expect(bad.f.calls).toHaveLength(1)
})

// ---- the sign-in -----------------------------------------------------------------------------------------------

function sealedFor(memberId: string, over: { now?: number } = {}) {
  const { state, verifier } = newOAuthState()
  return { state, sealed: sealOAuthState(master, memberId, 'notion', { state, verifier }, over.now) }
}

function connect(f: ReturnType<typeof routeFetch>) {
  const saved: Connection[] = []
  return {
    saved,
    deps: {
      connections: {
        async save(c: Connection) {
          saved.push(c)
        }
      },
      http: f.fetch,
      client: oauth,
      master
    }
  }
}

const tokenRoute = (status = 200, body: unknown = {}): Route => [
  'POST',
  '/v1/oauth/token',
  () =>
    json(
      status === 200
        ? {
            access_token: 'ntn_granted_access',
            refresh_token: 'ntn_granted_refresh',
            workspace_name: 'Kelas\u0007 Notes',
            ...(body as object)
          }
        : body,
      status
    )
]

test('no answer from Notion on the code exchange is notion_unavailable and saves nothing', async () => {
  for (const fail of [
    () => new TypeError('fetch failed'),
    () => new DOMException('The operation timed out.', 'TimeoutError')
  ]) {
    const f = routeFetch([])
    const { saved, deps } = connect(f)
    const { state, sealed } = sealedFor('m1')
    const result = await completeNotionConnect(
      'm1',
      new URL(`https://tm.example/cb?code=c0de&state=${state}`),
      sealed,
      {
        ...deps,
        http: (async () => {
          throw fail()
        }) as unknown as typeof fetch
      }
    )
    expect([result.status, (result.body as { error: string }).error]).toEqual([502, 'notion_unavailable'])
    expect(saved).toEqual([])
  }
})

test('no answer from Notion on a request is a fixed ExportError', async () => {
  const { client } = clientOver([
    [
      'GET',
      '/v1/users/me',
      () => {
        throw new TypeError('fetch failed')
      }
    ]
  ])
  await expect(client.request('GET', '/v1/users/me')).rejects.toMatchObject({
    code: 'failed',
    message: 'Notion did not answer as expected. Try again later.'
  })
})

test('the callback exchanges the code and saves the connection with no parent', async () => {
  const f = routeFetch([tokenRoute()])
  const { saved, deps } = connect(f)
  const { state, sealed } = sealedFor('m1')
  const result = await completeNotionConnect(
    'm1',
    new URL(`https://tm.example/cb?code=c0de&state=${state}`),
    sealed,
    deps
  )
  expect(saved).toEqual([
    {
      kind: 'notion',
      accessToken: 'ntn_granted_access',
      refreshToken: 'ntn_granted_refresh',
      workspace: 'Kelas Notes',
      parent: null
    }
  ])
  expect(result.status).toBe(200)
  expect(JSON.stringify(result)).not.toContain('ntn_granted')
  const call = f.call('POST', '/v1/oauth/token')
  expect(call.url).toBe('https://api.notion.com/v1/oauth/token')
  expect(call.redirect).toBe('error')
  expect(call.headers.authorization).toBe(`Basic ${btoa('nid:ns-client-secret')}`)
  expect(call.headers['notion-version']).toBe(NOTION_VERSION)
  // The redirect address comes from the configuration, not from the request.
  expect(JSON.parse(call.body)).toEqual({
    grant_type: 'authorization_code',
    code: 'c0de',
    redirect_uri: 'https://tm.example/api/connections/notion/callback'
  })
})

test('every state mismatch gets the one fixed error and calls nobody', async () => {
  const f = routeFetch([tokenRoute()])
  const { saved, deps } = connect(f)
  const mine = sealedFor('m1')
  const stale = sealedFor('m1', { now: Date.now() - 11 * 60_000 })
  const google = newOAuthState()
  const cases: [string, URL, string | null, string][] = [
    ['no cookie', new URL(`https://tm.example/cb?code=c&state=${mine.state}`), null, 'm1'],
    ['no state', new URL('https://tm.example/cb?code=c'), mine.sealed, 'm1'],
    ['wrong state', new URL('https://tm.example/cb?code=c&state=other'), mine.sealed, 'm1'],
    ['other member', new URL(`https://tm.example/cb?code=c&state=${mine.state}`), mine.sealed, 'm2'],
    ['expired', new URL(`https://tm.example/cb?code=c&state=${stale.state}`), stale.sealed, 'm1'],
    ['garbage cookie', new URL(`https://tm.example/cb?code=c&state=${mine.state}`), 'v1.x.y.z', 'm1'],
    [
      'sealed for Google',
      new URL(`https://tm.example/cb?code=c&state=${google.state}`),
      sealOAuthState(master, 'm1', 'google', google),
      'm1'
    ]
  ]
  for (const [name, url, cookie, member] of cases) {
    const result = await completeNotionConnect(member, url, cookie, deps)
    expect([name, result]).toEqual([
      name,
      { status: 400, body: { error: 'invalid_state', message: OAUTH_STATE_ERROR } }
    ])
  }
  expect(f.calls).toHaveLength(0)
  expect(saved).toHaveLength(0)
})

test('a refused grant or a failed exchange says one fixed sentence and keeps nothing', async () => {
  const { state, sealed } = sealedFor('m1')
  const url = (extra: string) => new URL(`https://tm.example/cb?state=${state}${extra}`)

  const denied = routeFetch([tokenRoute()])
  const a = connect(denied)
  expect(await completeNotionConnect('m1', url('&error=access_denied'), sealed, a.deps)).toMatchObject({
    status: 400,
    body: { error: 'not_granted' }
  })
  expect(await completeNotionConnect('m1', url(''), sealed, a.deps)).toMatchObject({ status: 400 })
  expect(denied.calls).toHaveLength(0)

  const rejected = routeFetch([tokenRoute(400, { message: 'invalid_grant: ntn_secret_echo', code: 'invalid_request' })])
  const b = connect(rejected)
  const result = await completeNotionConnect('m1', url('&code=c0de'), sealed, b.deps)
  expect(result).toEqual({
    status: 502,
    body: { error: 'notion_rejected', message: 'Notion did not accept the sign-in. Start again.' }
  })
  expect(b.saved).toHaveLength(0)
})

test('start and callback make a round trip through the sealed state', async () => {
  const { location, sealed } = beginNotionConnect('m1', { master, client: oauth })
  const state = new URL(location).searchParams.get('state')!
  expect(location).not.toContain('code_challenge')
  const f = routeFetch([tokenRoute()])
  const { saved, deps } = connect(f)
  const ok = await completeNotionConnect('m1', new URL(`https://tm.example/cb?code=c&state=${state}`), sealed, deps)
  expect(ok.status).toBe(200)
  expect(saved).toHaveLength(1)
  // The same callback for another member is refused.
  expect(
    (await completeNotionConnect('m2', new URL(`https://tm.example/cb?code=c&state=${state}`), sealed, deps)).status
  ).toBe(400)
})

// ---- choosing the parent ---------------------------------------------------------------------------------------

const searchRoute = (): Route => [
  'POST',
  '/v1/search',
  async (req) => {
    const { filter } = (await req.clone().json()) as { filter: { value: string } }
    return filter.value === 'page'
      ? json({
          results: [
            { ...pageObject(PARENT_ID, pageParent), object: 'page' },
            { ...pageObject(uuid(3), pageParent, { in_trash: true }), object: 'page' },
            { object: 'page', id: 'not-an-id', properties: {} }
          ]
        })
      : json({
          results: [{ object: 'data_source', id: DS_ID.replaceAll('-', ''), title: [{ plain_text: 'Courses' }] }]
        })
  }
]

test('listing shares: pages and data sources, named by title, trashed and odd ids left out', async () => {
  const { f, client } = clientOver([searchRoute()])
  expect(await listNotionParents(client)).toEqual([
    { type: 'page_id', id: PARENT_ID, name: 'Meeting' },
    { type: 'data_source_id', id: DS_ID, name: 'Courses' }
  ])
  const bodies = f.calls.map((c) => JSON.parse(c.body))
  expect(bodies).toEqual([
    { filter: { property: 'object', value: 'page' }, page_size: 100 },
    { filter: { property: 'object', value: 'data_source' }, page_size: 100 }
  ])
})

test('a data source parent resolves its title property; a page uses "title"', async () => {
  const { client } = clientOver([
    [
      'GET',
      `/v1/data_sources/${DS_ID}`,
      () =>
        json({
          object: 'data_source',
          id: DS_ID,
          title: [{ plain_text: 'Lecture notes' }],
          properties: { Name: { type: 'title' }, Date: { type: 'date' } }
        })
    ],
    ['GET', `/v1/pages/${PARENT_ID}`, () => json(pageObject(PARENT_ID, pageParent))]
  ])
  expect(await resolveNotionParent(client, 'data_source_id', DS_ID)).toEqual({
    type: 'data_source_id',
    id: DS_ID,
    name: 'Lecture notes',
    titleProperty: 'Name'
  })
  expect(await resolveNotionParent(client, 'page_id', PARENT_ID.replaceAll('-', ''))).toMatchObject({
    id: PARENT_ID,
    titleProperty: 'title'
  })
})

test('a parent id that is not a Notion id never reaches Notion; a lost one says how to fix it', async () => {
  const { f, client } = clientOver([['GET', `/v1/pages/${PARENT_ID}`, () => json({ message: 'nope' }, 404)]])
  for (const bad of ['PARENT', '../users/me', `${PARENT_ID}/children`])
    await expect(resolveNotionParent(client, 'page_id', bad)).rejects.toMatchObject({ code: 'invalid_settings' })
  expect(f.calls).toHaveLength(0)
  await expect(resolveNotionParent(client, 'page_id', PARENT_ID)).rejects.toMatchObject({ code: 'not_found' })
  // An answer about some other page is not accepted as the one asked for.
  const other = clientOver([['GET', `/v1/pages/${PARENT_ID}`, () => json(pageObject(uuid(9), pageParent))]])
  await expect(resolveNotionParent(other.client, 'page_id', PARENT_ID)).rejects.toMatchObject({ code: 'not_found' })
})

function routeDeps(routes: Route[], stored: { connection: Connection; status?: 'ok' | 'reconnect_needed' } | null) {
  const f = routeFetch(routes)
  const saved: Connection[] = []
  const marked: string[] = []
  return {
    f,
    saved,
    marked,
    deps: {
      connections: {
        async get() {
          return stored ? { connection: stored.connection, status: stored.status ?? ('ok' as const) } : null
        },
        async save(c: Connection) {
          saved.push(c)
        },
        async markReconnect(kind: string) {
          marked.push(kind)
        }
      },
      http: f.fetch,
      sleep: async () => {},
      client: oauth
    }
  }
}

test('the parent route saves what Notion confirms, with the tokens as they are now', async () => {
  const t = routeDeps(
    [
      ['GET', `/v1/pages/${PARENT_ID}`, (_r, n) => (n === 0 ? json({}, 401) : json(pageObject(PARENT_ID, pageParent)))],
      ['POST', '/v1/oauth/token', () => json({ access_token: 'ntn_rotated', refresh_token: 'ntn_rotated_r' })]
    ],
    { connection: notionConn() }
  )
  const result = await selectNotionParentRequest(JSON.stringify({ type: 'page_id', id: PARENT_ID }), t.deps)
  expect(result).toEqual({
    status: 200,
    body: { connection: { kind: 'notion', status: 'ok', ready: true, label: 'Notes', detail: 'Meeting' } }
  })
  expect(t.saved.at(-1)).toMatchObject({
    accessToken: 'ntn_rotated',
    refreshToken: 'ntn_rotated_r',
    parent: { id: PARENT_ID }
  })
  expect(JSON.stringify(result)).not.toContain('ntn_')
})

test('the parent route refuses bad bodies, a missing connection and a revoked one', async () => {
  const t = routeDeps([], { connection: notionConn() })
  for (const body of [
    '',
    '{',
    '[]',
    JSON.stringify({ type: 'page_id' }),
    JSON.stringify({ type: 'page_id', id: 'PARENT' }),
    JSON.stringify({ type: 'database_id', id: PARENT_ID }),
    JSON.stringify({ type: 'page_id', id: PARENT_ID, extra: 1 })
  ]) {
    const r = await selectNotionParentRequest(body, t.deps)
    expect(r.status).toBe(422)
  }
  // 'PARENT' is a well-formed body whose id is not a Notion id: rejected without a call.
  expect(t.f.calls).toHaveLength(0)

  const none = routeDeps([], null)
  expect((await selectNotionParentRequest(JSON.stringify({ type: 'page_id', id: PARENT_ID }), none.deps)).status).toBe(
    409
  )
  expect((await notionParentsRequest(none.deps)).status).toBe(409)

  const revoked = routeDeps([['GET', `/v1/pages/${PARENT_ID}`, () => json({}, 401)]], {
    connection: notionConn({ refreshToken: null })
  })
  expect(await selectNotionParentRequest(JSON.stringify({ type: 'page_id', id: PARENT_ID }), revoked.deps)).toEqual({
    status: 409,
    body: {
      error: 'reconnect_needed',
      message: 'Notion access was removed. Connect Notion again on the Connections page.'
    }
  })
  expect(revoked.marked).toEqual(['notion'])
})

test('the parents route lists shares and never sends Notion text or a token', async () => {
  const t = routeDeps([searchRoute()], { connection: notionConn() })
  const result = await notionParentsRequest(t.deps)
  expect(result.status).toBe(200)
  expect((result.body as { parents: unknown[] }).parents).toHaveLength(2)

  const broken = routeDeps([['POST', '/v1/search', () => json({ message: `oops ${ACCESS}` }, 500)]], {
    connection: notionConn()
  })
  const failed = await notionParentsRequest(broken.deps)
  expect(failed).toEqual({
    status: 502,
    body: { error: 'notion_unavailable', message: 'Notion did not answer as expected. Try again later.' }
  })
})
