import { z } from 'zod'
import type { ApiResult } from '../api'
import type { MemberConnections } from '../store-types'
import { ExportError, type GoogleConnection, type OAuthClient } from '../types'
import { redact } from '../vault'
import { newOAuthState, OAUTH_STATE_ERROR, sealOAuthState, verifyOAuthState } from './oauth'

// Google sign-in (OAuth 2.0 web server flow with PKCE) and the Drive calls the export needs. Only `drive.file` is asked
// for: the app sees files it created and folders the member picked. Hosts are fixed: accounts.google.com (the browser
// goes there, never this code), oauth2.googleapis.com (token endpoint) and www.googleapis.com (Drive v3). Every request
// sets `redirect: 'error'`. A token is only ever in an `Authorization` header (the refresh token and client secret go in
// the token endpoint's form body, as Google requires). Every message shown to the member is a fixed sentence, except a
// short piece of Google's own text that has been through `redact`.

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DEFAULT_FOLDER_NAME = 'TolongMeeting Exports'
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DRIVE_ORIGIN = 'https://www.googleapis.com'
export const DRIVE_API = `${DRIVE_ORIGIN}/drive/v3`
export const DRIVE_UPLOAD = `${DRIVE_ORIGIN}/upload/drive/v3`
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DOC_MIME = 'application/vnd.google-apps.document'

export const REVOKED_MESSAGE = 'Google access was removed or expired. Connect Google again on the Connections page.'
export const FOLDER_GONE_MESSAGE =
  'The Drive folder you picked for exports is gone. Pick another on the Connections page.'
const UNAVAILABLE_MESSAGE = 'Google did not answer as expected. Try again later.'
const NO_REFRESH_MESSAGE =
  "Google didn't send a refresh token. Remove TolongMeeting from your Google account's third-party access, then connect again."
const REJECTED_MESSAGE = 'Google rejected the sign-in. Try connecting again.'
const DENIED_MESSAGE = 'Google sign-in was cancelled.'
const NOT_CONNECTED_MESSAGE = 'Connect Google on the Connections page first.'
const PICK_MESSAGE = 'Pick a folder from the Google Drive picker.'
const MAX_BODY_CHARS = 1024
const MAX_PROVIDER_TEXT = 200
const MAX_NAME_CHARS = 200

/** A Drive file or folder id: letters, digits, `_` and `-` only. No path, no URL, no alias such as `root`. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/

export function isDriveId(id: string): boolean {
  return DRIVE_ID.test(id)
}

/** The sign-in page address the member's browser is sent to. */
export function googleAuthUrl(o: { client: OAuthClient; state: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTH_URL)
  const q = url.searchParams
  q.set('client_id', o.client.clientId)
  q.set('redirect_uri', o.client.redirectUri)
  q.set('response_type', 'code')
  q.set('scope', DRIVE_FILE_SCOPE)
  q.set('state', o.state)
  q.set('code_challenge', o.codeChallenge)
  q.set('code_challenge_method', 'S256')
  // Offline access gives a refresh token; `prompt=consent` makes Google send one on a repeat sign-in too.
  q.set('access_type', 'offline')
  q.set('prompt', 'consent')
  return url.toString()
}

/** Begins a sign-in: the address to redirect to, and the sealed state for the cookie (bound to this member). */
export function startGoogleConnect(
  master: Buffer,
  memberId: string,
  client: OAuthClient,
  now: number = Date.now()
): { url: string; sealed: string } {
  const s = newOAuthState()
  const sealed = sealOAuthState(master, memberId, 'google', { state: s.state, verifier: s.verifier }, now)
  return { url: googleAuthUrl({ client, state: s.state, codeChallenge: s.challenge }), sealed }
}

// --- Token endpoint ---------------------------------------------------------------------------------------------

const TokenAnswer = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional()
})
const ErrorAnswer = z.object({ error: z.string().optional(), error_description: z.string().optional() })

async function tokenRequest(http: typeof fetch, form: Record<string, string>): Promise<Response> {
  return http(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    redirect: 'error'
  })
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    if (e instanceof SyntaxError) return undefined
    throw e
  }
}

async function oauthError(res: Response): Promise<{ error: string; text: string }> {
  const parsed = ErrorAnswer.safeParse(await readJson(res))
  const error = parsed.success ? (parsed.data.error ?? '') : ''
  const text = parsed.success ? `${error} ${parsed.data.error_description ?? ''}`.trim() : ''
  return { error, text }
}

// --- Session: an access token that refreshes once on a 401 -------------------------------------------------------

export interface DriveInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Blob
}

export interface GoogleSession {
  /** A Drive call with the bearer token. A 401 refreshes the token once and repeats the call; a second 401 means the grant is gone. */
  fetch(url: string, init?: DriveInit): Promise<Response>
  accessToken(): Promise<string>
  /** Every secret the session holds, for `redact`. */
  secrets(): string[]
}

function assertDriveUrl(raw: string): void {
  const url = new URL(raw)
  const ok =
    url.origin === DRIVE_ORIGIN &&
    (url.pathname.startsWith('/drive/v3/') || url.pathname.startsWith('/upload/drive/v3/'))
  if (!ok || url.username !== '' || url.password !== '')
    throw new Error('Refusing a request outside the Google Drive API')
}

export function googleSession(o: {
  refreshToken: string
  accessToken?: string
  client: OAuthClient
  http: typeof fetch
}): GoogleSession {
  let token = o.accessToken

  async function refresh(): Promise<string> {
    const res = await tokenRequest(o.http, {
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      client_id: o.client.clientId,
      client_secret: o.client.clientSecret
    })
    if (res.ok) {
      const parsed = TokenAnswer.safeParse(await readJson(res))
      if (!parsed.success) throw new ExportError('failed', UNAVAILABLE_MESSAGE)
      token = parsed.data.access_token
      return token
    }
    const said = await oauthError(res)
    if (said.error === 'invalid_grant') throw new ExportError('reconnect_needed', REVOKED_MESSAGE)
    const text = redact(said.text.slice(0, MAX_PROVIDER_TEXT), session.secrets())
    throw new ExportError('failed', `Google sign-in answered ${res.status}: ${text}. Try again.`)
  }

  async function send(url: string, init: DriveInit, bearer: string): Promise<Response> {
    assertDriveUrl(url)
    return o.http(url, {
      method: init.method ?? 'GET',
      headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
      body: init.body,
      redirect: 'error'
    })
  }

  const session: GoogleSession = {
    async fetch(url, init = {}) {
      let fresh = false
      if (token === undefined) {
        token = await refresh()
        fresh = true
      }
      const res = await send(url, init, token)
      if (res.status !== 401) return res
      await res.body?.cancel()
      if (fresh) throw new ExportError('reconnect_needed', REVOKED_MESSAGE)
      const again = await send(url, init, await refresh())
      if (again.status !== 401) return again
      await again.body?.cancel()
      throw new ExportError('reconnect_needed', REVOKED_MESSAGE)
    },
    async accessToken() {
      return token ?? (await refresh())
    },
    secrets() {
      return [o.refreshToken, o.client.clientSecret, ...(token === undefined ? [] : [token])]
    }
  }
  return session
}

// --- Drive ------------------------------------------------------------------------------------------------------

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'])
const DriveErrorBody = z.object({
  error: z
    .object({
      message: z.string().optional(),
      errors: z.array(z.object({ reason: z.string().optional() })).optional()
    })
    .optional()
})

/** What Google said about a failed Drive call: its status, its reason code and a short redacted piece of its message. */
export async function driveFailure(res: Response, session: GoogleSession): Promise<ExportError> {
  const parsed = DriveErrorBody.safeParse(await readJson(res))
  const reason = (parsed.success && parsed.data.error?.errors?.[0]?.reason) || ''
  if (res.status === 429 || (res.status === 403 && RATE_REASONS.has(reason)))
    return new ExportError('rate_limited', 'Google is limiting requests. Try again later.')
  if (res.status === 403 && reason === 'storageQuotaExceeded')
    return new ExportError('failed', "Your Google Drive is full, so the document wasn't created.")
  const message = parsed.success ? (parsed.data.error?.message ?? '') : ''
  const said = redact(message.slice(0, MAX_PROVIDER_TEXT), session.secrets())
  return new ExportError('failed', `Google answered ${res.status}: ${said} Try again.`)
}

async function driveOk(session: GoogleSession, url: string, init?: DriveInit): Promise<Response> {
  const res = await session.fetch(url, init)
  if (res.ok) return res
  throw await driveFailure(res, session)
}

async function driveAnswer<T>(schema: z.ZodType<T>, res: Response): Promise<T> {
  const parsed = schema.safeParse(await readJson(res))
  if (!parsed.success) throw new ExportError('failed', 'Google sent an answer TolongMeeting did not understand.')
  return parsed.data
}

const jsonHeaders = { 'Content-Type': 'application/json; charset=UTF-8' }

/** The Google account's address, for the Connections page. */
export async function driveAccount(session: GoogleSession): Promise<string> {
  const res = await driveOk(session, `${DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress)')}`)
  const body = await driveAnswer(z.object({ user: z.object({ emailAddress: z.string().min(1) }) }), res)
  return body.user.emailAddress.slice(0, 254)
}

/** The "TolongMeeting Exports" folder: the live one this app already made, or a new one. */
export async function ensureDefaultFolder(session: GoogleSession): Promise<{ id: string; name: string }> {
  const q = `name = '${DEFAULT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`
  const query = new URLSearchParams({
    q,
    fields: 'files(id,name)',
    pageSize: '1',
    orderBy: 'createdTime',
    spaces: 'drive'
  })
  const Folder = z.object({ id: z.string().refine(isDriveId), name: z.string() })
  const listed = await driveAnswer(
    z.object({ files: z.array(Folder) }),
    await driveOk(session, `${DRIVE_API}/files?${query}`)
  )
  const found = listed.files[0]
  if (found) return { id: found.id, name: found.name.slice(0, MAX_NAME_CHARS) }
  const made = await driveAnswer(
    Folder,
    await driveOk(session, `${DRIVE_API}/files?fields=${encodeURIComponent('id,name')}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: DEFAULT_FOLDER_NAME, mimeType: FOLDER_MIME })
    })
  )
  return { id: made.id, name: made.name.slice(0, MAX_NAME_CHARS) }
}

export type FolderCheck =
  { ok: true; id: string; name: string } | { ok: false; reason: 'gone' | 'not_folder' | 'trashed' | 'read_only' }

const FolderFile = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  trashed: z.boolean().optional(),
  capabilities: z.object({ canAddChildren: z.boolean().optional() }).optional()
})

/** Asks Drive about a folder id. An id that is not an id is `gone` without a request. */
export async function checkFolder(session: GoogleSession, id: string): Promise<FolderCheck> {
  if (!isDriveId(id)) return { ok: false, reason: 'gone' }
  const fields = 'id,name,mimeType,trashed,capabilities/canAddChildren'
  const res = await session.fetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`)
  if (res.status === 404) {
    await res.body?.cancel()
    return { ok: false, reason: 'gone' }
  }
  if (!res.ok) throw await driveFailure(res, session)
  const file = await driveAnswer(FolderFile, res)
  if (file.id !== id) throw new ExportError('failed', 'Google sent an answer TolongMeeting did not understand.')
  if (file.mimeType !== FOLDER_MIME) return { ok: false, reason: 'not_folder' }
  if (file.trashed === true) return { ok: false, reason: 'trashed' }
  if (file.capabilities?.canAddChildren === false) return { ok: false, reason: 'read_only' }
  return { ok: true, id, name: file.name.slice(0, MAX_NAME_CHARS) }
}

// --- Routes' logic ------------------------------------------------------------------------------------------------

type Stores = Pick<MemberConnections, 'get' | 'save' | 'markReconnect'>

function failure(status: number, error: string, message: string): ApiResult {
  return { status, body: { error, message } }
}

/**
 * Turns a failed Google call into an answer. A revoked grant marks the connection broken (when one is stored) and says so
 * in a fixed sentence; any other `ExportError` becomes a fixed "try again" (its own text may quote Google and is not sent).
 */
async function answerForFailure(
  e: unknown,
  connections: Pick<MemberConnections, 'markReconnect'> | null
): Promise<ApiResult> {
  if (!(e instanceof ExportError)) throw e
  if (e.code === 'reconnect_needed') {
    await connections?.markReconnect('google')
    return failure(409, 'reconnect_needed', REVOKED_MESSAGE)
  }
  return failure(502, 'google_unavailable', UNAVAILABLE_MESSAGE)
}

const STATE_REFUSED: ApiResult = failure(400, 'invalid_state', OAUTH_STATE_ERROR)

/**
 * The callback of `GET /api/connections/google/callback`. `sealedState` is the cookie value. The sealed state must open
 * for this member and provider, be unexpired, and equal the returned `state`; any mismatch is the one fixed answer. The
 * PKCE verifier from the sealed value goes in the token exchange. The refresh token is sealed by the store and is not in
 * the answer.
 */
export async function completeGoogleConnect(
  memberId: string,
  url: URL,
  sealedState: string | null,
  deps: {
    connections: Pick<MemberConnections, 'save'>
    http: typeof fetch
    client: OAuthClient
    master: Buffer
    now?: number
  }
): Promise<ApiResult> {
  const state = url.searchParams.get('state')
  if (sealedState === null || sealedState === '' || state === null) return STATE_REFUSED
  let verifier: string
  try {
    verifier = verifyOAuthState(deps.master, memberId, 'google', sealedState, state, deps.now)
  } catch (e) {
    if (e instanceof Error && e.message === OAUTH_STATE_ERROR) return STATE_REFUSED
    throw e
  }
  const code = url.searchParams.get('code')
  if (url.searchParams.get('error') !== null) return failure(400, 'google_denied', DENIED_MESSAGE)
  if (code === null || code === '') return STATE_REFUSED

  const res = await tokenRequest(deps.http, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: deps.client.clientId,
    client_secret: deps.client.clientSecret,
    redirect_uri: deps.client.redirectUri
  })
  if (!res.ok) {
    const said = await oauthError(res)
    return said.error === 'invalid_grant'
      ? failure(400, 'google_rejected', REJECTED_MESSAGE)
      : failure(502, 'google_unavailable', UNAVAILABLE_MESSAGE)
  }
  const parsed = TokenAnswer.safeParse(await readJson(res))
  if (!parsed.success) return failure(502, 'google_unavailable', UNAVAILABLE_MESSAGE)
  const granted = (parsed.data.scope ?? '').split(' ').filter((s) => s !== '')
  if (granted.length !== 1 || granted[0] !== DRIVE_FILE_SCOPE)
    return failure(400, 'google_scope', 'Allow TolongMeeting to create files in Google Drive, then try again.')
  const refreshToken = parsed.data.refresh_token
  if (refreshToken === undefined) return failure(400, 'google_no_refresh_token', NO_REFRESH_MESSAGE)

  const session = googleSession({
    refreshToken,
    accessToken: parsed.data.access_token,
    client: deps.client,
    http: deps.http
  })
  try {
    const account = await driveAccount(session)
    const folder = await ensureDefaultFolder(session)
    const connection: GoogleConnection = {
      kind: 'google',
      refreshToken,
      account,
      folderId: folder.id,
      folderName: folder.name,
      folderIsDefault: true
    }
    await deps.connections.save(connection)
  } catch (e) {
    return answerForFailure(e, null)
  }
  return { status: 200, body: { connection: { kind: 'google', status: 'ok', ready: true } } }
}

async function storedGoogle(connections: Stores): Promise<{ connection: GoogleConnection } | { refused: ApiResult }> {
  const found = await connections.get('google')
  if (found?.connection.kind !== 'google') return { refused: failure(409, 'not_connected', NOT_CONNECTED_MESSAGE) }
  if (found.status === 'reconnect_needed') return { refused: failure(409, 'reconnect_needed', REVOKED_MESSAGE) }
  return { connection: found.connection }
}

/**
 * `GET /api/connections/google/picker`: a short-lived access token for the browser's Google Picker, with the public
 * API key and the Cloud project number. The refresh token never leaves the server.
 */
export async function pickerToken(deps: {
  connections: Stores
  http: typeof fetch
  client: OAuthClient
  apiKey: string
  appId: string
}): Promise<ApiResult> {
  if (deps.apiKey === '' || deps.appId === '')
    return failure(503, 'picker_not_configured', 'The Google folder picker is not set up on this server.')
  const stored = await storedGoogle(deps.connections)
  if ('refused' in stored) return stored.refused
  const session = googleSession({ refreshToken: stored.connection.refreshToken, client: deps.client, http: deps.http })
  try {
    const accessToken = await session.accessToken()
    return { status: 200, body: { accessToken, apiKey: deps.apiKey, appId: deps.appId } }
  } catch (e) {
    return answerForFailure(e, deps.connections)
  }
}

const FolderBody = z.union([z.strictObject({ folderId: z.string() }), z.strictObject({ useDefault: z.literal(true) })])

const FOLDER_PROBLEM = {
  gone: "TolongMeeting can't open that folder. Pick it again with the picker.",
  not_folder: 'Pick a folder, not a file.',
  trashed: 'That folder is in the bin. Pick another.',
  read_only: "You can't add files to that folder. Pick another."
} as const

/**
 * `PUT /api/connections/google/folder`: `{ folderId }` from the picker, or `{ useDefault: true }`. The id must look like
 * a Drive id, and Drive must say it is a live folder the app can add to, before it is saved.
 */
export async function setGoogleFolder(
  rawBody: string,
  deps: { connections: Stores; http: typeof fetch; client: OAuthClient }
): Promise<ApiResult> {
  let json: unknown
  try {
    json = rawBody.length > MAX_BODY_CHARS ? undefined : JSON.parse(rawBody)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
  }
  const body = FolderBody.safeParse(json)
  if (!body.success) return failure(400, 'invalid_settings', PICK_MESSAGE)
  if ('folderId' in body.data && !isDriveId(body.data.folderId)) return failure(400, 'invalid_settings', PICK_MESSAGE)

  const stored = await storedGoogle(deps.connections)
  if ('refused' in stored) return stored.refused
  const session = googleSession({ refreshToken: stored.connection.refreshToken, client: deps.client, http: deps.http })
  try {
    let folder: { id: string; name: string }
    let isDefault: boolean
    if ('folderId' in body.data) {
      const checked = await checkFolder(session, body.data.folderId)
      if (!checked.ok) return failure(400, 'invalid_settings', FOLDER_PROBLEM[checked.reason])
      folder = checked
      isDefault = false
    } else {
      folder = await ensureDefaultFolder(session)
      isDefault = true
    }
    await deps.connections.save({
      ...stored.connection,
      folderId: folder.id,
      folderName: folder.name,
      folderIsDefault: isDefault
    })
    return { status: 200, body: isDefault ? { useDefault: true } : { folderId: folder.id } }
  } catch (e) {
    return answerForFailure(e, deps.connections)
  }
}
