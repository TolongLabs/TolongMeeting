import {
  beginNotionConnect,
  completeNotionConnect,
  ExportError,
  notionClientFromEnv,
  notionParentsRequest,
  selectNotionParentRequest,
  type ApiResult
} from '@tm/exports/api'
import { cachedMasterKey } from '../db/secrets'
import { exportStores } from './exports'
import { callbackCrashed, clearOAuthCookie, readOAuthCookie, setOAuthCookie } from './oauth-cookie'
import { providerFetch } from './provider-fetch'
import type { MemberScope } from './scope'

// The Notion connection as the site serves it. Each function takes the member's own scope, so it can only reach that
// member's connection. Nothing here logs: a log line could carry a token.

const NO_STORE = { 'Cache-Control': 'no-store' }
/** A request waits at most this long for a rate limit; a longer wait fails with `rate_limited` instead. */
const MAX_ROUTE_WAIT_MS = 10_000

function send(result: ApiResult): Response {
  return Response.json(result.body, { status: result.status, headers: NO_STORE })
}

function notConfigured(): Response {
  return Response.json(
    { error: 'not_configured', message: 'Notion export is not set up on this server.' },
    { status: 503, headers: NO_STORE }
  )
}

function publicOrigin(): string {
  const url = process.env.TM_PUBLIC_URL
  if (!url) throw new Error('TM_PUBLIC_URL is not set')
  return new URL(url).origin
}

/** Waiting inside a web request is bounded: a long `Retry-After` becomes the "Notion is busy" answer. */
async function routeSleep(ms: number): Promise<void> {
  if (ms > MAX_ROUTE_WAIT_MS) throw new ExportError('rate_limited', 'Notion is busy. Try again in a few minutes.')
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** `GET .../start`: sends the member to Notion and keeps the sealed state in a cookie. */
export function notionStartResponse(scope: MemberScope): Response {
  const client = notionClientFromEnv()
  if (client === null) return notConfigured()
  const master = cachedMasterKey()
  const { location, sealed } = beginNotionConnect(scope.memberId, { master, client })
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, Location: location, 'Set-Cookie': setOAuthCookie('notion', sealed) }
  })
}

/**
 * `GET .../callback`: Notion sends the browser back here, cross-site, so there is no origin to check; the sealed state
 * (member, provider, expiry) is the check (Notion has no PKCE). The cookie is cleared whatever the outcome (also when
 * something unexpected throws), and the
 * member lands on the Connections page with a fixed result code in the query.
 */
export async function notionCallbackResponse(
  scope: MemberScope,
  request: Request,
  http: typeof fetch = providerFetch
): Promise<Response> {
  const client = notionClientFromEnv()
  if (client === null) return notConfigured()
  try {
    const master = cachedMasterKey()
    const result = await completeNotionConnect(
      scope.memberId,
      new URL(request.url),
      readOAuthCookie(request, 'notion'),
      {
        connections: exportStores(scope).connections,
        http,
        client,
        master
      }
    )
    const outcome = result.status === 200 ? 'connected' : (result.body as { error: string }).error
    const headers = new Headers(NO_STORE)
    headers.set('Location', `${publicOrigin()}/connections?notion=${encodeURIComponent(outcome)}`)
    headers.append('Set-Cookie', clearOAuthCookie('notion'))
    return new Response(null, { status: 302, headers })
  } catch (e) {
    return callbackCrashed('notion', e)
  }
}

/** `GET .../parents`: the pages and databases shared with the integration. */
export async function notionParentsResponse(scope: MemberScope, http: typeof fetch = providerFetch): Promise<Response> {
  const client = notionClientFromEnv()
  if (client === null) return notConfigured()
  return send(
    await notionParentsRequest({ connections: exportStores(scope).connections, http, sleep: routeSleep, client })
  )
}

/** `PUT .../parent`: `{ type, id }`, read back from Notion and saved as the export parent. */
export async function notionParentResponse(
  scope: MemberScope,
  request: Request,
  http: typeof fetch = providerFetch
): Promise<Response> {
  const client = notionClientFromEnv()
  if (client === null) return notConfigured()
  return send(
    await selectNotionParentRequest(await request.text(), {
      connections: exportStores(scope).connections,
      http,
      sleep: routeSleep,
      client
    })
  )
}
