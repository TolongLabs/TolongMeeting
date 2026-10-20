import { z } from 'zod'
import type { ApiResult } from '../api'
import type { MemberConnections } from '../store-types'
import {
  ExportError,
  type ConnectionSummary,
  type ExportErrorCode,
  type NotionConnection,
  type NotionParent,
  type OAuthClient
} from '../types'
import { redact } from '../vault'
import { newOAuthState, OAUTH_STATE_ERROR, oauthRedirectUri, sealOAuthState, verifyOAuthState } from './oauth'
import { guarded, isTransportError } from './transport'

// Notion's public-integration OAuth flow and REST client (https://developers.notion.com/guides/get-started/authorization,
// /reference/request-limits, /reference/patch-block-children, /guides/data-apis/uploading-small-files).
//
// - Only `https://api.notion.com` is called, always with `Notion-Version` and `redirect: 'error'`. The access token is only
//   ever in the `Authorization` header: never in a URL, a body, a log line or a stored message.
// - Notion's authorization flow has no PKCE (the PKCE guide is for MCP clients), so the sealed `state` alone binds a
//   callback to the member who started it. The verifier that `newOAuthState` makes is sealed with it and not used.
// - Every message a route sends is a fixed sentence. Text from Notion goes into a stored error only after `redact`.

export const NOTION_API = 'https://api.notion.com'
/** The API version sent with every request. `2026-03-11` has data sources, `in_trash` and file uploads. */
export const NOTION_VERSION = '2026-03-11'
const AUTHORIZE_URL = `${NOTION_API}/v1/oauth/authorize`

/** About 3 requests a second is the average limit of a plan other than Business or Enterprise. */
const SPACING_MS = 340
const MAX_RETRIES = 5
/** The most one request waits in total for 429 and 529 answers. Notion's `Retry-After` is at most 60 s. */
export const MAX_TOTAL_WAIT_MS = 120_000
const MAX_BACKOFF_SECONDS = 30
const MAX_PROVIDER_TEXT = 200
const MAX_NAME_CHARS = 100
const SEARCH_PAGE_SIZE = 100
const MAX_CODE_CHARS = 2048
const MAX_BODY_CHARS = 1024

export const MESSAGES = {
  busy: 'Notion is busy. Try again in a few minutes.',
  removed: 'Notion access was removed. Connect Notion again on the Connections page.',
  odd: 'Notion answered in a way TolongMeeting does not understand. Try again later.',
  signIn: 'Notion did not accept the sign-in. Start again.',
  denied: 'Notion access was not granted. Start again and choose the pages to share.',
  notConnected: 'Connect Notion on the Connections page first.',
  badParent: 'Choose a page or database from the list.',
  unreachable: `TolongMeeting can't reach that Notion page or database. Share it with the TolongLabs integration, then try again.`,
  unavailable: 'Notion did not answer as expected. Try again later.'
} as const

const NOTION_ID_PLAIN = /^[0-9a-f]{32}$/i
const NOTION_ID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROLS = /\p{Cc}/gu

/** A Notion id as the lower-case dashed UUID, or null when `raw` is not one (32 hex digits, with or without dashes). */
export function notionId(raw: string): string | null {
  const s = raw.trim()
  if (!NOTION_ID_PLAIN.test(s) && !NOTION_ID_DASHED.test(s)) return null
  const h = s.replaceAll('-', '').toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The id of a page from its address (`https://www.notion.so/<Title>-<32 hex>`), or null for anything else. */
export function notionPageIdFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'www.notion.so' && url.hostname !== 'notion.so')) return null
  const last = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
  const match = /(?:^|-)([0-9a-f]{32})$/i.exec(last)
  return match ? notionId(match[1]!) : null
}

/** An answer of Notion with a status the client did not treat as success. */
export class NotionApiError extends ExportError {
  constructor(
    readonly status: number,
    code: ExportErrorCode,
    message: string
  ) {
    super(code, message)
    this.name = 'NotionApiError'
  }
}

export interface NotionClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>
  upload(filename: string, bytes: Uint8Array, contentType: string): Promise<string> // file upload id
  /** The connection with the tokens as they are now (after a refresh). Save this, never the one you started with. */
  readonly connection: NotionConnection
}

export interface NotionClientDeps {
  http: typeof fetch
  sleep(ms: number): Promise<void>
  saveConnection(c: NotionConnection): Promise<void>
  client: OAuthClient
}

type Payload = { json?: unknown } | { form: () => FormData }

const RefreshAnswer = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).nullish() })
const FileUploadCreated = z.object({ id: z.string() })
const FileUploadSent = z.object({ status: z.string().optional() })

function basicAuth(client: OAuthClient): string {
  return `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`, 'utf8').toString('base64')}`
}

/** Checks `value` against `schema`; a mismatch is one fixed sentence (the zod message can quote the answer). */
export function parseNotion<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const error = new ExportError('failed', MESSAGES.odd)
  error.cause = parsed.error
  throw error
}

/** Seconds from `Retry-After`, or exponential backoff (1, 2, 4 ... capped at 30 s) when it is missing or not a number. */
function waitMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after')
  if (header !== null && /^\d{1,6}$/.test(header.trim())) return Number(header.trim()) * 1000
  return Math.min(2 ** attempt, MAX_BACKOFF_SECONDS) * 1000
}

/**
 * A Notion client for one connection. Requests are spaced `SPACING_MS` apart (the first goes at once). A 429 or 529
 * waits `Retry-After` (not the spacing) and resends, up to `MAX_RETRIES` times and `MAX_TOTAL_WAIT_MS` in all, then
 * fails with `rate_limited`. A 401 refreshes the tokens once (Notion rotates both), saves them and resends; without a
 * refresh token, or when the refresh is refused, it fails with `reconnect_needed`.
 */
export function createNotionClient(conn: NotionConnection, deps: NotionClientDeps): NotionClient {
  // No answer from Notion (network, timeout, abort) is a fixed "did not answer" error, never a bare TypeError.
  const http = guarded(deps.http, MESSAGES.unavailable)
  let current = conn
  const everSeen = new Set<string>([conn.accessToken, ...(conn.refreshToken ? [conn.refreshToken] : [])])
  let refreshed = false
  let started = false

  const secrets = () => [...everSeen, deps.client.clientSecret]
  const remember = (c: NotionConnection) => {
    everSeen.add(c.accessToken)
    if (c.refreshToken) everSeen.add(c.refreshToken)
  }

  async function fail(res: Response): Promise<never> {
    let said = ''
    try {
      const parsed: unknown = await res.json()
      const message = (parsed as { message?: unknown } | null)?.message
      if (typeof message === 'string') said = redact(message.slice(0, MAX_PROVIDER_TEXT), secrets())
    } catch {
      // No JSON body: the status is all there is to say.
    }
    const code: ExportErrorCode = res.status === 403 || res.status === 404 ? 'not_found' : 'failed'
    throw new NotionApiError(res.status, code, `Notion answered ${res.status}${said ? `: ${said}` : ''}. Try again.`)
  }

  async function refresh(): Promise<void> {
    if (refreshed || current.refreshToken === null) throw new ExportError('reconnect_needed', MESSAGES.removed)
    refreshed = true
    const res = await http(`${NOTION_API}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(deps.client),
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
      redirect: 'error'
    })
    if (res.status === 400 || res.status === 401) {
      await res.body?.cancel()
      throw new ExportError('reconnect_needed', MESSAGES.removed)
    }
    if (!res.ok) return fail(res)
    const answer = parseNotion(RefreshAnswer, await res.json())
    current = {
      ...current,
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token ?? current.refreshToken
    }
    remember(current)
    await deps.saveConnection(current)
  }

  async function perform(method: string, path: string, payload: Payload): Promise<Response> {
    // Only API paths, so no caller can send the token anywhere else.
    if (!/^\/v1\/[A-Za-z0-9_\-/]+(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(path)) throw new Error('Not a Notion API path')
    if (started) await deps.sleep(SPACING_MS)
    started = true
    let waited = 0
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${current.accessToken}`,
        'Notion-Version': NOTION_VERSION,
        Accept: 'application/json'
      }
      const init: RequestInit = { method, headers, redirect: 'error' }
      if ('form' in payload) init.body = payload.form()
      else if (payload.json !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(payload.json)
      }
      const res = await http(`${NOTION_API}${path}`, init)
      if (res.ok) return res
      if (res.status === 429 || res.status === 529) {
        const wait = waitMs(res, attempt)
        await res.body?.cancel()
        if (attempt >= MAX_RETRIES || waited + wait > MAX_TOTAL_WAIT_MS)
          throw new ExportError('rate_limited', MESSAGES.busy)
        waited += wait
        await deps.sleep(wait)
        continue
      }
      if (res.status === 401) {
        await res.body?.cancel()
        await refresh()
        continue
      }
      return fail(res)
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch (e) {
      const error = new ExportError('failed', MESSAGES.odd)
      error.cause = e
      throw error
    }
  }

  return {
    get connection() {
      return current
    },
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      return (await readJson(await perform(method, path, { json: body }))) as T
    },
    async upload(filename, bytes, contentType) {
      const created = parseNotion(
        FileUploadCreated,
        await readJson(await perform('POST', '/v1/file_uploads', { json: { filename, content_type: contentType } }))
      )
      const id = notionId(created.id)
      if (id === null) throw new ExportError('failed', MESSAGES.odd)
      const form = () => {
        const f = new FormData()
        f.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), filename)
        return f
      }
      const sent = parseNotion(
        FileUploadSent,
        await readJson(await perform('POST', `/v1/file_uploads/${id}/send`, { form }))
      )
      if (sent.status !== undefined && sent.status !== 'uploaded') throw new ExportError('failed', MESSAGES.odd)
      return id
    }
  }
}

/** The Notion OAuth client from `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` and `TM_PUBLIC_URL`; null when either is unset or empty. */
export function notionClientFromEnv(env: Record<string, string | undefined> = process.env): OAuthClient | null {
  const clientId = env.NOTION_CLIENT_ID
  const clientSecret = env.NOTION_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  if (!env.TM_PUBLIC_URL) throw new Error('TM_PUBLIC_URL is not set')
  return { clientId, clientSecret, redirectUri: oauthRedirectUri(env.TM_PUBLIC_URL, 'notion') }
}

export function notionAuthUrl(o: { client: OAuthClient; state: string }): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', o.client.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('owner', 'user')
  url.searchParams.set('redirect_uri', o.client.redirectUri)
  url.searchParams.set('state', o.state)
  return url.toString()
}

/**
 * Starts the sign-in: a fresh state, sealed for this member and provider, and the address to send the browser to. The
 * caller keeps `sealed` in the state cookie and redirects to `location`.
 */
export function beginNotionConnect(
  memberId: string,
  o: { master: Buffer; client: OAuthClient; now?: number }
): { location: string; sealed: string } {
  const { state, verifier } = newOAuthState()
  const sealed = sealOAuthState(o.master, memberId, 'notion', { state, verifier }, o.now)
  return { location: notionAuthUrl({ client: o.client, state }), sealed }
}

const TokenAnswer = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  workspace_name: z.string().nullish()
})

function summary(c: NotionConnection): ConnectionSummary {
  return {
    kind: 'notion',
    status: 'ok',
    ready: c.parent !== null,
    label: c.workspace,
    detail: c.parent?.name ?? 'No page chosen yet'
  }
}

const SIGN_IN_FAILED: ApiResult = { status: 400, body: { error: 'invalid_state', message: OAUTH_STATE_ERROR } }

/** Text from Notion that is shown: no control characters, a bounded length. */
function cleanName(raw: string, fallback: string): string {
  const name = raw.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
  return name === '' ? fallback : name
}

/**
 * The callback of the sign-in. The sealed state cookie must open for this member and `notion`, be unexpired and equal the
 * returned `state`; any failure of that is the one `OAUTH_STATE_ERROR` answer. Then the code is exchanged (Basic
 * authentication with the client, the redirect address from the configuration, never from the request) and the
 * connection saved with no parent chosen yet. Every answer is a fixed sentence; Notion's text is not passed on.
 */
export async function completeNotionConnect(
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
  const returned = url.searchParams.get('state')
  if (sealedState === null || returned === null) return SIGN_IN_FAILED
  try {
    verifyOAuthState(deps.master, memberId, 'notion', sealedState, returned, deps.now)
  } catch (e) {
    if (e instanceof Error && e.message === OAUTH_STATE_ERROR) return SIGN_IN_FAILED
    throw e
  }
  const code = url.searchParams.get('code')
  if (url.searchParams.has('error') || code === null || code === '' || code.length > MAX_CODE_CHARS)
    return { status: 400, body: { error: 'not_granted', message: MESSAGES.denied } }

  let res: Response
  try {
    res = await deps.http(`${NOTION_API}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(deps.client),
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: deps.client.redirectUri }),
      redirect: 'error'
    })
  } catch (e) {
    if (isTransportError(e))
      return { status: 502, body: { error: 'notion_unavailable', message: MESSAGES.unavailable } }
    throw e
  }
  if (!res.ok) {
    await res.body?.cancel()
    return { status: 502, body: { error: 'notion_rejected', message: MESSAGES.signIn } }
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { status: 502, body: { error: 'notion_rejected', message: MESSAGES.signIn } }
  }
  const answer = TokenAnswer.safeParse(json)
  if (!answer.success) return { status: 502, body: { error: 'notion_rejected', message: MESSAGES.signIn } }
  const connection: NotionConnection = {
    kind: 'notion',
    accessToken: answer.data.access_token,
    refreshToken: answer.data.refresh_token ?? null,
    workspace: cleanName(answer.data.workspace_name ?? '', 'Notion'),
    parent: null
  }
  await deps.connections.save(connection)
  return { status: 200, body: { connection: summary(connection) } }
}

export const NotionPageSchema = z.object({
  id: z.string(),
  in_trash: z.boolean().optional(),
  archived: z.boolean().optional(),
  url: z.string().optional(),
  parent: z.record(z.string(), z.unknown()).optional(),
  properties: z
    .record(
      z.string(),
      z.object({ type: z.string(), title: z.array(z.object({ plain_text: z.string() })).optional() }).loose()
    )
    .optional()
})
const DataSourceObject = z.object({
  id: z.string(),
  in_trash: z.boolean().optional(),
  archived: z.boolean().optional(),
  title: z.array(z.object({ plain_text: z.string() })).optional(),
  properties: z.record(z.string(), z.object({ type: z.string() }).loose()).optional()
})
const SearchAnswer = z.object({ results: z.array(z.object({ object: z.string() }).loose()) })

export type NotionPageObject = z.infer<typeof NotionPageSchema>

function pageTitle(page: NotionPageObject): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type === 'title') return (property.title ?? []).map((t) => t.plain_text).join('')
  }
  return ''
}

/** Pages and databases (data sources) shared with the integration, named by their titles. At most 100 of each. */
export async function listNotionParents(
  client: NotionClient
): Promise<{ type: NotionParent['type']; id: string; name: string }[]> {
  const out: { type: NotionParent['type']; id: string; name: string }[] = []
  for (const value of ['page', 'data_source'] as const) {
    const answer = parseNotion(
      SearchAnswer,
      await client.request('POST', '/v1/search', {
        filter: { property: 'object', value },
        page_size: SEARCH_PAGE_SIZE
      })
    )
    for (const raw of answer.results) {
      if (raw.object !== value) continue
      if (value === 'page') {
        const page = parseNotion(NotionPageSchema, raw)
        const id = notionId(page.id)
        if (id === null || page.in_trash || page.archived) continue
        out.push({ type: 'page_id', id, name: cleanName(pageTitle(page), 'Untitled') })
      } else {
        const source = parseNotion(DataSourceObject, raw)
        const id = notionId(source.id)
        if (id === null || source.in_trash || source.archived) continue
        out.push({
          type: 'data_source_id',
          id,
          name: cleanName((source.title ?? []).map((t) => t.plain_text).join(''), 'Untitled')
        })
      }
    }
  }
  return out
}

/**
 * Reads the member's chosen parent from Notion, so only an id the integration can see is kept. A page's title property
 * is `title`; a data source's is the property of type `title`. `id` must be a Notion id (32 hex digits).
 */
export async function resolveNotionParent(
  client: NotionClient,
  type: NotionParent['type'],
  rawId: string
): Promise<NotionParent> {
  const id = notionId(rawId)
  if (id === null) throw new ExportError('invalid_settings', MESSAGES.badParent)
  try {
    if (type === 'page_id') {
      const page = parseNotion(NotionPageSchema, await client.request('GET', `/v1/pages/${id}`))
      if (notionId(page.id) !== id || page.in_trash || page.archived)
        throw new ExportError('not_found', MESSAGES.unreachable)
      return { type, id, name: cleanName(pageTitle(page), 'Untitled'), titleProperty: 'title' }
    }
    const source = parseNotion(DataSourceObject, await client.request('GET', `/v1/data_sources/${id}`))
    if (notionId(source.id) !== id || source.in_trash || source.archived)
      throw new ExportError('not_found', MESSAGES.unreachable)
    const titleProperty = Object.entries(source.properties ?? {}).find(([, p]) => p.type === 'title')?.[0]
    if (titleProperty === undefined) throw new ExportError('invalid_settings', MESSAGES.badParent)
    return {
      type,
      id,
      name: cleanName((source.title ?? []).map((t) => t.plain_text).join(''), 'Untitled'),
      titleProperty
    }
  } catch (e) {
    if (e instanceof NotionApiError && (e.status === 403 || e.status === 404)) {
      throw new ExportError('not_found', MESSAGES.unreachable)
    }
    throw e
  }
}

type RouteDeps = {
  connections: Pick<MemberConnections, 'get' | 'save' | 'markReconnect'>
  http: typeof fetch
  sleep(ms: number): Promise<void>
  client: OAuthClient
}

/** What a route sends for a failed Notion call: fixed sentences only (a stored message may quote Notion). */
async function routeFailure(e: unknown, deps: RouteDeps): Promise<ApiResult> {
  if (!(e instanceof ExportError)) throw e
  if (e.code === 'reconnect_needed') {
    await deps.connections.markReconnect('notion')
    return { status: 409, body: { error: 'reconnect_needed', message: MESSAGES.removed } }
  }
  if (e.code === 'rate_limited') return { status: 503, body: { error: 'rate_limited', message: MESSAGES.busy } }
  if (e.code === 'not_found') return { status: 422, body: { error: 'not_found', message: MESSAGES.unreachable } }
  if (e.code === 'invalid_settings')
    return { status: 422, body: { error: 'invalid_settings', message: MESSAGES.badParent } }
  return { status: 502, body: { error: 'notion_unavailable', message: MESSAGES.unavailable } }
}

async function openClient(deps: RouteDeps): Promise<{ client: NotionClient } | { refused: ApiResult }> {
  const stored = await deps.connections.get('notion')
  if (stored?.connection.kind !== 'notion')
    return { refused: { status: 409, body: { error: 'not_connected', message: MESSAGES.notConnected } } }
  if (stored.status === 'reconnect_needed')
    return { refused: { status: 409, body: { error: 'reconnect_needed', message: MESSAGES.removed } } }
  return {
    client: createNotionClient(stored.connection, {
      http: deps.http,
      sleep: deps.sleep,
      saveConnection: (c) => deps.connections.save(c),
      client: deps.client
    })
  }
}

/** `GET /api/connections/notion/parents`: `{ parents }`, the pages and databases shared with the integration. */
export async function notionParentsRequest(deps: RouteDeps): Promise<ApiResult> {
  const opened = await openClient(deps)
  if ('refused' in opened) return opened.refused
  try {
    return { status: 200, body: { parents: await listNotionParents(opened.client) } }
  } catch (e) {
    return routeFailure(e, deps)
  }
}

const ParentBody = z.strictObject({ type: z.enum(['page_id', 'data_source_id']), id: z.string().max(64) })

/** `PUT /api/connections/notion/parent`: `{ type, id }`, read back from Notion, then saved as the export parent. */
export async function selectNotionParentRequest(rawBody: string, deps: RouteDeps): Promise<ApiResult> {
  let json: unknown
  try {
    json = rawBody.length > MAX_BODY_CHARS ? undefined : JSON.parse(rawBody)
  } catch {
    json = undefined
  }
  const body = ParentBody.safeParse(json)
  if (!body.success) return { status: 422, body: { error: 'invalid_settings', message: MESSAGES.badParent } }
  const opened = await openClient(deps)
  if ('refused' in opened) return opened.refused
  try {
    const parent = await resolveNotionParent(opened.client, body.data.type, body.data.id)
    // The client's connection holds the tokens as they are now; saving the stored one could undo a refresh.
    const connection: NotionConnection = { ...opened.client.connection, parent }
    await deps.connections.save(connection)
    return { status: 200, body: { connection: summary(connection) } }
  } catch (e) {
    return routeFailure(e, deps)
  }
}
