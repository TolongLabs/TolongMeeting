import { randomBytes } from 'node:crypto'
import { expect, test } from 'bun:test'
import {
  checkFolder,
  completeGoogleConnect,
  DRIVE_FILE_SCOPE,
  googleAuthUrl,
  googleSession,
  pickerToken,
  REVOKED_MESSAGE,
  setGoogleFolder,
  startGoogleConnect
} from '../src/connections/google'
import { OAUTH_STATE_ERROR, pkceChallenge, sealOAuthState } from '../src/connections/oauth'
import {
  ACCESS,
  ACCESS2,
  client,
  expectSafeCalls,
  FOLDER,
  google,
  googleConn,
  liveFolder,
  memberStore,
  NEW_FOLDER,
  REFRESH
} from './google-fake'

const master = randomBytes(32)
const callbackUrl = (state: string, extra = 'code=auth-code-1') =>
  new URL(`https://tm.example/api/connections/google/callback?state=${encodeURIComponent(state)}&${extra}`)

/** A started sign-in: the redirect address, the sealed cookie, and the state Google would send back. */
function started(memberId = 'm1', now?: number) {
  const s = startGoogleConnect(master, memberId, client, now)
  const url = new URL(s.url)
  return { ...s, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! }
}

test('the sign-in address asks for drive.file only, offline, with a PKCE challenge', () => {
  const u = new URL(googleAuthUrl({ client, state: 's1', codeChallenge: 'c1' }))
  expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(u.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE)
  expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
  expect(u.searchParams.get('access_type')).toBe('offline')
  expect(u.searchParams.get('prompt')).toBe('consent')
  expect(u.searchParams.get('response_type')).toBe('code')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  expect(u.searchParams.get('redirect_uri')).toBe(client.redirectUri)
  expect(u.searchParams.get('include_granted_scopes')).toBeNull()
  expect(u.toString()).not.toContain(client.clientSecret)
})

test('connecting sends the PKCE verifier, saves a sealed-for-the-store connection and returns no token', async () => {
  const s = started()
  const f = google({ existingFolder: FOLDER })
  const connections = memberStore()
  const res = await completeGoogleConnect('m1', callbackUrl(s.state), s.sealed, {
    connections,
    http: f.fetch,
    client,
    master
  })
  expect(res.status).toBe(200)
  expect(JSON.stringify(res)).not.toContain(REFRESH)
  expect(JSON.stringify(res)).not.toContain(ACCESS)

  const exchange = new URLSearchParams(f.call('POST', 'https://oauth2.googleapis.com/token').body)
  expect(exchange.get('grant_type')).toBe('authorization_code')
  expect(exchange.get('code')).toBe('auth-code-1')
  expect(exchange.get('redirect_uri')).toBe(client.redirectUri)
  expect(pkceChallenge(exchange.get('code_verifier')!)).toBe(s.challenge)

  expect(connections.saved()?.connection).toEqual(googleConn({ folderId: FOLDER }))
  // The default folder this app already made is reused, not created again.
  expect(
    f.calls.some((c) => c.method === 'POST' && c.url.startsWith('https://www.googleapis.com/drive/v3/files'))
  ).toBe(false)
  expectSafeCalls(f)
})

test('without an existing folder the default folder is created', async () => {
  const s = started()
  const f = google()
  const connections = memberStore()
  await completeGoogleConnect('m1', callbackUrl(s.state), s.sealed, { connections, http: f.fetch, client, master })
  expect(JSON.parse(f.call('POST', 'https://www.googleapis.com/drive/v3/files').body)).toEqual({
    name: 'TolongMeeting Exports',
    mimeType: 'application/vnd.google-apps.folder'
  })
  expect(connections.saved()?.connection).toMatchObject({ folderId: NEW_FOLDER, folderIsDefault: true })
})

test('every state mismatch is the one fixed answer, before any request to Google', async () => {
  const T0 = 1_800_000_000_000
  const s = started('m1', T0)
  const other = startGoogleConnect(master, 'm1', client, T0)
  const sealedForNotion = sealOAuthState(master, 'm1', 'notion', { state: s.state, verifier: 'v'.repeat(43) }, T0)
  const attempts: [string, URL, string | null, number?][] = [
    ['wrong state', callbackUrl('WRONG'), s.sealed],
    ['no state', new URL('https://tm.example/cb?code=c'), s.sealed],
    ['no cookie', callbackUrl(s.state), null],
    ['empty cookie', callbackUrl(s.state), ''],
    ['another member', callbackUrl(s.state), s.sealed],
    ['another provider', callbackUrl(s.state), sealedForNotion],
    ['another sign-in', callbackUrl(s.state), other.sealed],
    ['tampered', callbackUrl(s.state), s.sealed.slice(0, -2) + 'AA'],
    ['expired', callbackUrl(s.state), s.sealed, T0 + 10 * 60 * 1000 + 1],
    ['no code', callbackUrl(s.state, 'x=1'), s.sealed]
  ]
  const expected = { status: 400, body: { error: 'invalid_state', message: OAUTH_STATE_ERROR } }
  for (const [name, url, cookie, now] of attempts) {
    const f = google()
    const member = name === 'another member' ? 'm2' : 'm1'
    const res = await completeGoogleConnect(member, url, cookie, {
      connections: memberStore(),
      http: f.fetch,
      client,
      master,
      now: now ?? T0 + 1000
    })
    expect({ name, res }).toEqual({ name, res: expected })
    expect(f.calls).toEqual([])
  }
})

test('a sign-in without a refresh token, with another scope, or that Google refuses saves nothing', async () => {
  const run = async (o: Parameters<typeof google>[0]) => {
    const s = started()
    const connections = memberStore()
    const res = await completeGoogleConnect('m1', callbackUrl(s.state), s.sealed, {
      connections,
      http: google(o).fetch,
      client,
      master
    })
    expect(connections.saved()).toBeNull()
    return res
  }
  expect((await run({ refreshToken: null })).body).toMatchObject({
    message:
      "Google didn't send a refresh token. Remove TolongMeeting from your Google account's third-party access, then connect again."
  })
  expect((await run({ scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` })).body).toMatchObject({
    error: 'google_scope'
  })
  expect((await run({ exchange: { status: 400, body: { error: 'invalid_grant' } } })).body).toMatchObject({
    error: 'google_rejected'
  })
  expect((await run({ exchange: { status: 500, body: {} } })).status).toBe(502)
  const denied = started()
  const res = await completeGoogleConnect('m1', callbackUrl(denied.state, 'error=access_denied'), denied.sealed, {
    connections: memberStore(),
    http: google().fetch,
    client,
    master
  })
  expect(res.body).toMatchObject({ error: 'google_denied' })
})

test('a 401 refreshes the token once and repeats the call; a second 401 means the grant is gone', async () => {
  const f = google({ unauthorized: 1 })
  const session = googleSession({ refreshToken: REFRESH, accessToken: ACCESS, client, http: f.fetch })
  const res = await session.fetch('https://www.googleapis.com/drive/v3/about?fields=user')
  expect(res.status).toBe(200)
  expect(f.refreshes).toEqual([REFRESH])
  expect(f.calls.filter((c) => c.url.includes('/about')).map((c) => c.headers.authorization)).toEqual([
    `Bearer ${ACCESS}`,
    `Bearer ${ACCESS2}`
  ])

  const g = google({ always401: true })
  const stuck = googleSession({ refreshToken: REFRESH, accessToken: ACCESS, client, http: g.fetch })
  await expect(stuck.fetch('https://www.googleapis.com/drive/v3/about?fields=user')).rejects.toMatchObject({
    code: 'reconnect_needed',
    message: REVOKED_MESSAGE
  })
  expect(g.refreshes).toHaveLength(1)
})

test('the session refuses any address outside the Drive API, before sending a token', async () => {
  const f = google()
  const session = googleSession({ refreshToken: REFRESH, accessToken: ACCESS, client, http: f.fetch })
  for (const url of [
    'https://evil.example/drive/v3/about',
    'http://www.googleapis.com/drive/v3/about',
    'https://www.googleapis.com.evil.example/drive/v3/about',
    'https://www.googleapis.com/oauth2/v1/userinfo',
    'https://user:pw@www.googleapis.com/drive/v3/about'
  ])
    await expect(session.fetch(url)).rejects.toThrow('Refusing a request outside the Google Drive API')
  expect(f.calls).toEqual([])
})

test('a picked folder must be an id, and a live folder, before it is saved', async () => {
  const connections = memberStore(googleConn())
  const folder = (id: string, over: object, status = 200) => ({
    [id]: { status, body: { id, name: 'Lectures', ...over } }
  })
  const pick = (body: unknown, files: Record<string, { status?: number; body?: object }> = {}) => {
    const f = google({ files })
    return setGoogleFolder(JSON.stringify(body), { connections, http: f.fetch, client }).then((res) => ({ res, f }))
  }

  for (const bad of [
    'https://drive.google.com/drive/folders/abcdefghijk',
    '../etc/passwd',
    'a/b/cdefghijkl',
    'root',
    'short',
    'id with space1',
    ''
  ]) {
    const { res, f } = await pick({ folderId: bad })
    expect(res).toEqual({
      status: 400,
      body: { error: 'invalid_settings', message: 'Pick a folder from the Google Drive picker.' }
    })
    expect(f.calls).toEqual([])
  }
  for (const body of [{}, { folderId: 1 }, { folderId: 'abcdefghijk', extra: 1 }, { useDefault: false }, 'x']) {
    expect((await pick(body)).res.status).toBe(400)
  }
  expect((await setGoogleFolder('{not json', { connections, http: google().fetch, client })).status).toBe(400)

  const DOC_ID = 'docIdDOCDOCDOC1'
  expect(
    (
      await pick(
        { folderId: DOC_ID },
        folder(DOC_ID, { mimeType: 'application/vnd.google-apps.document', trashed: false })
      )
    ).res
  ).toEqual({ status: 400, body: { error: 'invalid_settings', message: 'Pick a folder, not a file.' } })
  const BIN = 'folderInBin0001'
  expect(
    (await pick({ folderId: BIN }, folder(BIN, { mimeType: 'application/vnd.google-apps.folder', trashed: true }))).res
      .body
  ).toMatchObject({ message: 'That folder is in the bin. Pick another.' })
  const GONE = 'folderGone0001'
  expect((await pick({ folderId: GONE }, { [GONE]: { status: 404, body: {} } })).res.status).toBe(400)
  const RO = 'folderReadOnly1'
  expect(
    (
      await pick(
        { folderId: RO },
        folder(RO, {
          mimeType: 'application/vnd.google-apps.folder',
          trashed: false,
          capabilities: { canAddChildren: false }
        })
      )
    ).res.status
  ).toBe(400)
  expect(connections.saved()?.connection).toMatchObject({ folderId: FOLDER })

  const NEW = 'folderLectures01'
  const ok = await pick(
    { folderId: NEW },
    folder(NEW, { mimeType: 'application/vnd.google-apps.folder', trashed: false })
  )
  expect(ok.res).toEqual({ status: 200, body: { folderId: NEW } })
  expect(connections.saved()?.connection).toMatchObject({
    folderId: NEW,
    folderName: 'Lectures',
    folderIsDefault: false,
    refreshToken: REFRESH
  })
  expectSafeCalls(ok.f)

  const back = await pick({ useDefault: true })
  expect(back.res).toEqual({ status: 200, body: { useDefault: true } })
  expect(connections.saved()?.connection).toMatchObject({ folderId: NEW_FOLDER, folderIsDefault: true })
})

test('a response about another id than the one asked is refused', async () => {
  const f = google({ files: { [FOLDER]: liveFolder('someOtherFolder1') } })
  const session = googleSession({ refreshToken: REFRESH, accessToken: ACCESS, client, http: f.fetch })
  await expect(checkFolder(session, FOLDER)).rejects.toMatchObject({ code: 'failed' })
})

test('the picker gets an access token, the key and the app id, never the refresh token', async () => {
  const connections = memberStore(googleConn())
  const f = google()
  const res = await pickerToken({ connections, http: f.fetch, client, apiKey: 'AIzaKey', appId: '123456' })
  expect(res).toEqual({ status: 200, body: { accessToken: ACCESS2, apiKey: 'AIzaKey', appId: '123456' } })
  expect(JSON.stringify(res)).not.toContain(REFRESH)
  expect(new URLSearchParams(f.call('POST', 'https://oauth2.googleapis.com/token').body).get('refresh_token')).toBe(
    REFRESH
  )
  expectSafeCalls(f, [ACCESS2, client.clientSecret])
  expect((await pickerToken({ connections, http: f.fetch, client, apiKey: '', appId: '1' })).status).toBe(503)
  expect(
    (await pickerToken({ connections: memberStore(), http: f.fetch, client, apiKey: 'k', appId: '1' })).status
  ).toBe(409)
  const broken = memberStore(googleConn(), 'reconnect_needed')
  const g = google()
  expect(
    (await pickerToken({ connections: broken, http: g.fetch, client, apiKey: 'k', appId: '1' })).body
  ).toMatchObject({
    error: 'reconnect_needed'
  })
  expect(g.calls).toEqual([])
})

test('a revoked grant marks the connection broken with a fixed message and reveals nothing', async () => {
  for (const run of [
    (connections: ReturnType<typeof memberStore>) =>
      pickerToken({ connections, http: google({ revoked: true }).fetch, client, apiKey: 'k', appId: '1' }),
    (connections: ReturnType<typeof memberStore>) =>
      setGoogleFolder(JSON.stringify({ useDefault: true }), {
        connections,
        http: google({ revoked: true }).fetch,
        client
      })
  ]) {
    const connections = memberStore(googleConn())
    const res = await run(connections)
    expect(res).toEqual({ status: 409, body: { error: 'reconnect_needed', message: REVOKED_MESSAGE } })
    expect(connections.marked).toEqual(['google'])
    expect(JSON.stringify(res)).not.toContain(REFRESH)
  }
})
