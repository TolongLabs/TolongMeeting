import { expect, test } from 'bun:test'
import { removeConnection, type RemoveDeps } from '../src'
import type { Connection, OAuthClient } from '../src/types'
import { memoryStores } from './memory-stores'
import { routeFetch } from './route-fetch'

const REFRESH = '1//refresh-secret-1'
const ACCESS = 'ntn_access_secret_1'
const GITHUB = 'github_pat_secret_1'
const NOTION_CLIENT: OAuthClient = { clientId: 'nid', clientSecret: 'nsecret', redirectUri: 'https://tm.example/cb' }

const google: Connection = {
  kind: 'google',
  refreshToken: REFRESH,
  account: 'a@example.edu',
  folderId: 'F1',
  folderName: 'TolongMeeting Exports',
  folderIsDefault: true
}
const github: Connection = { kind: 'github', token: GITHUB, owner: 'o', repo: 'r', branch: 'main', folder: '' }
const notion: Connection = { kind: 'notion', accessToken: ACCESS, refreshToken: null, workspace: 'W', parent: null }

/** Deps for one member, over in-memory stores that hold m1's three connections and m2's GitHub one. */
function setup(over: { fetch?: typeof fetch; notionClient?: OAuthClient | null } = {}) {
  const stores = memoryStores({
    connections: [
      { memberId: 'm1', connection: google },
      { memberId: 'm1', connection: github },
      { memberId: 'm1', connection: notion },
      { memberId: 'm2', connection: { ...github, token: 'github_pat_other_member' } }
    ]
  })
  const lines: string[] = []
  const forMember = (memberId: string): RemoveDeps => ({
    connections: {
      get: (kind) => stores.connections.get(memberId, kind),
      remove: (kind) => stores.connections.remove(memberId, kind)
    },
    http:
      over.fetch ??
      ((async () => {
        throw new Error('no network in tests')
      }) as unknown as typeof fetch),
    notionClient: over.notionClient === undefined ? NOTION_CLIENT : over.notionClient,
    log: (l) => lines.push(l)
  })
  return { stores, lines, forMember }
}

test('Google removal revokes the refresh token in a form body, even if revoking fails', async () => {
  for (const status of [200, 400]) {
    const f = routeFetch([['POST', 'https://oauth2.googleapis.com/revoke', () => new Response('', { status })]])
    const { stores, lines, forMember } = setup({ fetch: f.fetch })
    const res = await removeConnection('google', forMember('m1'))
    expect(res).toEqual({
      status: 200,
      body: {
        message:
          status === 200
            ? 'Removed, and Google access revoked.'
            : 'Removed. To end access fully, remove TolongMeeting in your Google Account under Security, Third-party access.'
      }
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/revoke',
      body: 'token=1%2F%2Frefresh-secret-1',
      redirect: 'error'
    })
    expect(f.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(await stores.connections.get('m1', 'google')).toBeNull()
    expect(lines).toEqual(status === 200 ? [] : ['connection google revoke failed (status 400)'])
  }
})

test('the row is deleted before the provider is asked, and a network error still removes it', async () => {
  const seen: (string | null)[] = []
  const { stores, lines, forMember } = setup()
  const deps = forMember('m1')
  deps.http = (async () => {
    seen.push((await stores.connections.get('m1', 'google'))?.connection.kind ?? null)
    throw Object.assign(new TypeError(`connect failed for ${REFRESH}`), { code: 'ECONNRESET' })
  }) as unknown as typeof fetch
  const res = await removeConnection('google', deps)
  expect(res.status).toBe(200)
  expect(seen).toEqual([null])
  expect(await stores.connections.get('m1', 'google')).toBeNull()
  expect(lines).toEqual(['connection google revoke failed (TypeError)'])
})

test('Notion removal revokes the access token with the integration client when one is configured', async () => {
  const f = routeFetch([['POST', 'https://api.notion.com/v1/oauth/revoke', () => Response.json({ request_id: 'r' })]])
  const { stores, forMember } = setup({ fetch: f.fetch })
  expect((await removeConnection('notion', forMember('m1'))).body).toEqual({
    message: 'Removed, and Notion access revoked.'
  })
  expect(f.calls[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ token: ACCESS }), redirect: 'error' })
  expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('nid:nsecret').toString('base64')}`)
  expect(f.calls[0]!.headers['notion-version']).toBe('2026-03-11')
  expect(await stores.connections.get('m1', 'notion')).toBeNull()
})

test('a failed Notion revoke, or no Notion client, still removes and explains the last step', async () => {
  const manual = 'Removed. To end access fully, disconnect TolongLabs in Notion under Settings, Connections.'
  const f = routeFetch([['POST', 'https://api.notion.com/v1/oauth/revoke', () => new Response('', { status: 401 })]])
  const failing = setup({ fetch: f.fetch })
  expect((await removeConnection('notion', failing.forMember('m1'))).body).toEqual({ message: manual })
  expect(failing.lines).toEqual(['connection notion revoke failed (status 401)'])
  expect(await failing.stores.connections.get('m1', 'notion')).toBeNull()

  const none = setup({ notionClient: null })
  expect((await removeConnection('notion', none.forMember('m1'))).body).toEqual({ message: manual })
  expect(await none.stores.connections.get('m1', 'notion')).toBeNull()
})

test('GitHub removal makes no call and tells the member to delete the token on GitHub', async () => {
  const { stores, forMember } = setup()
  const res = await removeConnection('github', forMember('m1'))
  expect(res).toEqual({
    status: 200,
    body: {
      message:
        'Removed. Also delete the token on GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens.'
    }
  })
  expect(await stores.connections.get('m1', 'github')).toBeNull()
})

test("another member's connection, or none at all, is a 404 and nothing is touched", async () => {
  const { stores, lines, forMember } = setup()
  expect(await removeConnection('google', forMember('m2'))).toEqual({ status: 404, body: { error: 'not_found' } })
  expect((await removeConnection('github', forMember('m3'))).status).toBe(404)
  expect(await stores.connections.get('m1', 'google')).not.toBeNull()
  expect(await stores.connections.get('m2', 'github')).not.toBeNull()
  expect(lines).toEqual([])
})

test('no answer and no log line holds a token', async () => {
  const f = routeFetch([['POST', /revoke$/, () => new Response(`bad ${REFRESH} ${ACCESS}`, { status: 500 })]])
  const { lines, forMember } = setup({ fetch: f.fetch })
  const out: unknown[] = []
  for (const kind of ['google', 'notion', 'github'] as const) out.push(await removeConnection(kind, forMember('m1')))
  const text = JSON.stringify(out) + lines.join('\n')
  for (const secret of [REFRESH, ACCESS, GITHUB, 'nsecret']) expect(text).not.toContain(secret)
  expect(lines).toHaveLength(2)
})
