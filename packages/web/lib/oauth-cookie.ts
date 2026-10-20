import { OAUTH_STATE_TTL_MS } from '@tm/exports'

// The sealed sign-in state travels in a cookie: HttpOnly, Secure, SameSite=Lax (the provider's redirect back is a
// top-level GET, which Lax allows) and only sent to that provider's own routes. The value is sealed for the member and
// provider (`sealOAuthState`), so the cookie alone proves nothing to another member.

export type CookieProvider = 'google' | 'notion'

export const oauthCookieName = (provider: CookieProvider): string => `tm_oauth_${provider}`

const attributes = (provider: CookieProvider, maxAge: number): string =>
  `Path=/api/connections/${provider}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`

/** The `Set-Cookie` value that stores the sealed state for the lifetime of a sign-in. */
export function setOAuthCookie(provider: CookieProvider, sealed: string): string {
  return `${oauthCookieName(provider)}=${sealed}; ${attributes(provider, OAUTH_STATE_TTL_MS / 1000)}`
}

/** The `Set-Cookie` value that removes it. */
export function clearOAuthCookie(provider: CookieProvider): string {
  return `${oauthCookieName(provider)}=; ${attributes(provider, 0)}`
}

/**
 * The answer when a sign-in callback threw something it did not expect (a database error, a bug): still a 500, so the
 * failure stays loud, but the cookie is cleared and only the error's name is logged (a message could carry a token).
 */
export function callbackCrashed(provider: CookieProvider, e: unknown): Response {
  console.error(`${provider} callback failed (${e instanceof Error ? e.name : 'unknown'})`)
  return Response.json(
    { error: 'internal_error' },
    { status: 500, headers: { 'Cache-Control': 'no-store', 'Set-Cookie': clearOAuthCookie(provider) } }
  )
}

/** The sealed state from the request's `Cookie` header, or null. */
export function readOAuthCookie(request: Request, provider: CookieProvider): string | null {
  const name = `${oauthCookieName(provider)}=`
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(name)) return trimmed.slice(name.length)
  }
  return null
}
