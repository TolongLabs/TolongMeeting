import { expect } from 'bun:test'
import { DOC_MIME, DRIVE_FILE_SCOPE, FOLDER_MIME } from '../src/connections/google'
import type { GoogleConnection, OAuthClient } from '../src/types'
import { json, routeFetch, type Route } from './route-fetch'

export const client: OAuthClient = {
  clientId: 'client-id-123',
  clientSecret: 'client-secret-xyz',
  redirectUri: 'https://tm.example/api/connections/google/callback'
}
export const REFRESH = '1//refresh-token-secret'
export const ACCESS = 'ya29.access-token-one'
export const ACCESS2 = 'ya29.access-token-two'
export const FOLDER = 'folderIdAAAAAA1'
export const NEW_FOLDER = 'folderIdBBBBBB2'
export const DOC = 'docIdCCCCCCCCC3'
export const LOCATION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=U1'

export function googleConn(over: Partial<GoogleConnection> = {}): GoogleConnection {
  return {
    kind: 'google',
    refreshToken: REFRESH,
    account: 'member@example.edu',
    folderId: FOLDER,
    folderName: 'TolongMeeting Exports',
    folderIsDefault: true,
    ...over
  }
}

export interface GoogleOptions {
  /** `refresh_token` in the code exchange (default sent; null leaves it out). */
  refreshToken?: string | null
  scope?: string
  /** What the code exchange answers instead of success. */
  exchange?: { status: number; body: unknown }
  /** The refresh grant answers `invalid_grant`. */
  revoked?: boolean
  /** The first n Drive/upload calls answer 401 whatever the token. */
  unauthorized?: number
  /** Every Drive call answers 401. */
  always401?: boolean
  /** An existing default folder the list finds (default none). */
  existingFolder?: string | null
  /** The answer for `GET files/{id}` by id; default: the connection's folder is a live folder. */
  files?: Record<string, { status?: number; body?: object }>
  /** Docs the app-property search finds. */
  docs?: object[]
  /** The answer of the upload's first request, or of its byte PUT. */
  init?: { status: number; body?: object; location?: string | null }
  put?: { status: number; body?: object }
}

const liveFolder = (id: string, name = 'Lectures') => ({
  body: { id, name, mimeType: FOLDER_MIME, trashed: false, capabilities: { canAddChildren: true } }
})

/** A fake Google: token endpoint, Drive v3 and its resumable upload. */
export function google(o: GoogleOptions = {}) {
  let driveCalls = 0
  const refreshes: string[] = []
  const guard = (req: Request): Response | null => {
    driveCalls++
    if (o.always401 || driveCalls <= (o.unauthorized ?? 0)) return json({ error: { code: 401 } }, 401)
    return null
  }
  const routes: Route[] = [
    [
      'POST',
      'https://oauth2.googleapis.com/token',
      async (req) => {
        const form = new URLSearchParams(await req.text())
        if (form.get('grant_type') === 'refresh_token') {
          if (o.revoked)
            return json(
              { error: 'invalid_grant', error_description: `Token has been expired or revoked ${REFRESH}` },
              400
            )
          refreshes.push(form.get('refresh_token') ?? '')
          return json({ access_token: ACCESS2, expires_in: 3599, token_type: 'Bearer' })
        }
        if (o.exchange) return json(o.exchange.body, o.exchange.status)
        return json({
          access_token: ACCESS,
          expires_in: 3599,
          token_type: 'Bearer',
          scope: o.scope ?? DRIVE_FILE_SCOPE,
          ...(o.refreshToken === null ? {} : { refresh_token: o.refreshToken ?? REFRESH })
        })
      }
    ],
    [
      'GET',
      'https://www.googleapis.com/drive/v3/about',
      (req) => guard(req) ?? json({ user: { emailAddress: 'member@example.edu' } })
    ],
    [
      'GET',
      'https://www.googleapis.com/drive/v3/files',
      (req) => {
        const denied = guard(req)
        if (denied) return denied
        const q = new URL(req.url).searchParams.get('q') ?? ''
        if (q.includes('appProperties')) return json({ files: o.docs ?? [] })
        return json({ files: o.existingFolder ? [{ id: o.existingFolder, name: 'TolongMeeting Exports' }] : [] })
      }
    ],
    [
      'POST',
      'https://www.googleapis.com/drive/v3/files',
      (req) => guard(req) ?? json({ id: NEW_FOLDER, name: 'TolongMeeting Exports' })
    ],
    [
      'GET',
      /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^/?]+\?/,
      (req) => {
        const denied = guard(req)
        if (denied) return denied
        const id = decodeURIComponent(new URL(req.url).pathname.split('/').pop() ?? '')
        const set = o.files?.[id]
        if (set) return json(set.body ?? {}, set.status ?? 200)
        return json(liveFolder(id).body)
      }
    ],
    ['POST', 'https://www.googleapis.com/upload/drive/v3/files', (req) => start(req)],
    ['PATCH', /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/[^/?]+\?/, (req) => start(req)],
    [
      'PUT',
      'https://www.googleapis.com/upload/drive/v3/files',
      (req) => {
        const denied = guard(req)
        if (denied) return denied
        if (o.put) return json(o.put.body ?? {}, o.put.status)
        return json({ id: DOC, mimeType: DOC_MIME })
      }
    ]
  ]
  function start(req: Request): Response {
    const denied = guard(req)
    if (denied) return denied
    const init = o.init
    if (init && init.status !== 200) return json(init.body ?? {}, init.status)
    const location = init && 'location' in init ? init.location : LOCATION
    return new Response(null, { status: 200, headers: location ? { location } : {} })
  }
  return { ...routeFetch(routes), refreshes }
}

/** Every call went to a documented Google host with `redirect: 'error'`, with no token or secret in its address. */
export function expectSafeCalls(
  f: ReturnType<typeof google>,
  secrets: string[] = [REFRESH, ACCESS, ACCESS2, client.clientSecret]
) {
  expect(f.calls.length).toBeGreaterThan(0)
  for (const call of f.calls) {
    const url = new URL(call.url)
    expect(['https://oauth2.googleapis.com', 'https://www.googleapis.com']).toContain(url.origin)
    expect(call.redirect).toBe('error')
    for (const s of secrets) expect(call.url).not.toContain(s)
    if (url.origin === 'https://www.googleapis.com') {
      expect(call.headers.authorization).toMatch(/^Bearer ya29\./)
      expect(call.body).not.toContain(REFRESH)
      expect(call.body).not.toContain(client.clientSecret)
    } else {
      expect(call.headers.authorization).toBeUndefined()
    }
  }
}

export { liveFolder }

/** A member-bound connection store in memory. */
export function memberStore(seed?: GoogleConnection, status: 'ok' | 'reconnect_needed' = 'ok') {
  let current = seed === undefined ? null : { connection: seed, status }
  const marked: string[] = []
  return {
    get: async () => current,
    save: async (c: GoogleConnection) => {
      current = { connection: c, status: 'ok' }
    },
    markReconnect: async (kind: string) => {
      marked.push(kind)
      if (current) current.status = 'reconnect_needed'
    },
    marked,
    saved: () => current
  } satisfies Record<string, unknown> as {
    get(): Promise<{ connection: GoogleConnection; status: 'ok' | 'reconnect_needed' } | null>
    save(c: GoogleConnection): Promise<void>
    markReconnect(kind: 'google'): Promise<void>
    marked: string[]
    saved(): { connection: GoogleConnection; status: 'ok' | 'reconnect_needed' } | null
  }
}
