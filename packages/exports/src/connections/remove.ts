import type { ApiResult } from '../api'
import type { MemberConnections } from '../store-types'
import type { ConnectionKind, OAuthClient } from '../types'
import { NOTION_API, NOTION_VERSION } from './notion'

// Removing a connection. The sealed token row goes first, so no export can open the token again; only then is the
// provider asked to revoke, where it has an API:
//   Google  POST https://oauth2.googleapis.com/revoke, form body `token=<refresh token>` (revokes the whole grant).
//   Notion  POST https://api.notion.com/v1/oauth/revoke, Basic auth with the integration's client, JSON `{ token }`.
//   GitHub  none: an app cannot revoke a member's fine-grained token (`POST /credentials/revoke` is for leaked
//           credentials, takes no authentication and tells the owner it leaked), so the member deletes it on GitHub.
// A failed revoke is logged by provider and status (or error name) only and never blocks the removal. Nothing here
// returns or logs a token, and every message is a fixed sentence.

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const NOTION_REVOKE_URL = `${NOTION_API}/v1/oauth/revoke`
const REVOKE_TIMEOUT_MS = 10_000

export const REMOVE_MESSAGES = {
  github:
    'Removed. Also delete the token on GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens.',
  googleRevoked: 'Removed, and Google access revoked.',
  googleManual:
    'Removed. To end access fully, remove TolongMeeting in your Google Account under Security, Third-party access.',
  notionRevoked: 'Removed, and Notion access revoked.',
  notionManual: 'Removed. To end access fully, disconnect TolongLabs in Notion under Settings, Connections.'
} as const

export interface RemoveDeps {
  /** Bound to the signed-in member, so another member's connection is simply not there. */
  connections: Pick<MemberConnections, 'get' | 'remove'>
  http: typeof fetch
  /** The Notion client the revoke call signs with; null when Notion is not set up on this server. */
  notionClient: OAuthClient | null
  /** One line, never a token. */
  log(line: string): void
}

const NOT_FOUND: ApiResult = { status: 404, body: { error: 'not_found' } }

/** True when the provider answered 2xx. A thrown error is logged by name; a bad status by number. */
async function revoke(
  provider: 'google' | 'notion',
  deps: RemoveDeps,
  url: string,
  init: RequestInit
): Promise<boolean> {
  try {
    const res = await deps.http(url, {
      ...init,
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS)
    })
    await res.body?.cancel()
    if (!res.ok) deps.log(`connection ${provider} revoke failed (status ${res.status})`)
    return res.ok
  } catch (e) {
    deps.log(`connection ${provider} revoke failed (${e instanceof Error ? e.name : 'unknown'})`)
    return false
  }
}

/**
 * Removes the member's connection of `kind`: 404 when there is none, else the row is deleted and the provider asked to
 * revoke (Google, and Notion when its client is configured). The answer is always 200 with a `message` once the row is gone.
 */
export async function removeConnection(kind: ConnectionKind, deps: RemoveDeps): Promise<ApiResult> {
  const found = await deps.connections.get(kind)
  if (found === null) return NOT_FOUND
  const { connection } = found
  await deps.connections.remove(kind)

  if (connection.kind === 'google') {
    const revoked = await revoke('google', deps, GOOGLE_REVOKE_URL, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: connection.refreshToken }).toString()
    })
    return { status: 200, body: { message: revoked ? REMOVE_MESSAGES.googleRevoked : REMOVE_MESSAGES.googleManual } }
  }
  if (connection.kind === 'notion') {
    const client = deps.notionClient
    const revoked =
      client !== null &&
      (await revoke('notion', deps, NOTION_REVOKE_URL, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`, 'utf8').toString('base64')}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token: connection.accessToken })
      }))
    return { status: 200, body: { message: revoked ? REMOVE_MESSAGES.notionRevoked : REMOVE_MESSAGES.notionManual } }
  }
  return { status: 200, body: { message: REMOVE_MESSAGES.github } }
}
