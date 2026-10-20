import {
  completeGoogleConnect,
  oauthClientFromEnv,
  pickerToken,
  setGoogleFolder,
  startGoogleConnect,
  type ApiResult
} from '@tm/exports/api'
import { loadMasterKey } from '../db/secrets'
import { exportStores } from './exports'
import { callbackCrashed, clearOAuthCookie, readOAuthCookie, setOAuthCookie } from './oauth-cookie'
import { providerFetch } from './provider-fetch'
import type { MemberScope } from './scope'

// The Google Docs connection as the site serves it. Each function takes the member's own scope, so it can only reach
// that member's connection. Nothing here logs: a log line could carry a token.

let master: Buffer | undefined

const NO_STORE = { 'Cache-Control': 'no-store' }

function send(result: ApiResult): Response {
  return Response.json(result.body, { status: result.status, headers: NO_STORE })
}

function notConfigured(): Response {
  return Response.json(
    { error: 'not_configured', message: 'Google Docs export is not set up on this server.' },
    { status: 503, headers: NO_STORE }
  )
}

function publicOrigin(): string {
  const url = process.env.TM_PUBLIC_URL
  if (!url) throw new Error('TM_PUBLIC_URL is not set')
  return new URL(url).origin
}

/** `GET .../start`: sends the member to Google and keeps the sealed state in a cookie. */
export function googleStartResponse(scope: MemberScope): Response {
  const client = oauthClientFromEnv('google')
  if (client === null) return notConfigured()
  master ??= loadMasterKey()
  const { url, sealed } = startGoogleConnect(master, scope.memberId, client)
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, Location: url, 'Set-Cookie': setOAuthCookie('google', sealed) }
  })
}

/**
 * `GET .../callback`: Google sends the browser back here, cross-site, so there is no origin to check; the sealed state
 * (member, provider, expiry) and the PKCE verifier are the check. The cookie is cleared whatever the outcome (also when
 * something unexpected throws), and the
 * member lands on the Connections page with a fixed result code in the query.
 */
export async function googleCallbackResponse(
  scope: MemberScope,
  request: Request,
  http: typeof fetch = providerFetch
): Promise<Response> {
  const client = oauthClientFromEnv('google')
  if (client === null) return notConfigured()
  try {
    master ??= loadMasterKey()
    const result = await completeGoogleConnect(
      scope.memberId,
      new URL(request.url),
      readOAuthCookie(request, 'google'),
      {
        connections: exportStores(scope).connections,
        http,
        client,
        master
      }
    )
    const outcome = result.status === 200 ? 'connected' : (result.body as { error: string }).error
    const headers = new Headers(NO_STORE)
    headers.set('Location', `${publicOrigin()}/connections?google=${encodeURIComponent(outcome)}`)
    headers.append('Set-Cookie', clearOAuthCookie('google'))
    return new Response(null, { status: 302, headers })
  } catch (e) {
    return callbackCrashed('google', e)
  }
}

/** `GET .../picker`: a short-lived access token, the public API key and the Cloud project number for the Picker. */
export async function googlePickerResponse(scope: MemberScope, http: typeof fetch = providerFetch): Promise<Response> {
  const client = oauthClientFromEnv('google')
  if (client === null) return notConfigured()
  return send(
    await pickerToken({
      connections: exportStores(scope).connections,
      http,
      client,
      apiKey: process.env.GOOGLE_API_KEY ?? '',
      appId: process.env.GOOGLE_APP_ID ?? ''
    })
  )
}

/** `PUT .../folder`: `{ folderId }` from the Picker, or `{ useDefault: true }`. */
export async function googleFolderResponse(
  scope: MemberScope,
  request: Request,
  http: typeof fetch = providerFetch
): Promise<Response> {
  const client = oauthClientFromEnv('google')
  if (client === null) return notConfigured()
  return send(
    await setGoogleFolder(await request.text(), { connections: exportStores(scope).connections, http, client })
  )
}
