import { memberKey, openSecret, sealSecret, SecretError } from '@tm/core'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { OAuthClient } from '../types'

export type OAuthProvider = 'google' | 'notion'

/** A sign-in must reach its callback within this long of starting. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/** The one error every rejected sign-in state raises. It never names the state, the verifier or the sealed value. */
export const OAUTH_STATE_ERROR = 'The sign-in link is invalid or has expired. Start again.'

const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/

interface StoredState {
  state: string
  verifier: string
  exp: number
}

/** RFC 7636 S256: base64url(SHA-256(verifier)), no padding. Throws for a verifier outside 43-128 characters of the RFC alphabet. */
export function pkceChallenge(verifier: string): string {
  if (!VERIFIER_SHAPE.test(verifier))
    throw new Error('PKCE verifier must be 43-128 characters of the RFC 7636 alphabet')
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** A fresh state and PKCE verifier: 32 random bytes each, base64url (43 characters). */
export function newOAuthState(): { state: string; verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { state: randomBytes(32).toString('base64url'), verifier, challenge: pkceChallenge(verifier) }
}

/**
 * Seals a state and its verifier for a cookie. The sealed value opens only for this member and this provider, and it
 * expires `OAUTH_STATE_TTL_MS` after `now`. Uses the member's sealing key (`memberKey`, the key behind `sealColumn`)
 * with an AAD of `oauth_state:<provider>:<member>`.
 */
export function sealOAuthState(
  master: Buffer,
  memberId: string,
  provider: OAuthProvider,
  value: { state: string; verifier: string },
  now: number = Date.now()
): string {
  const payload: StoredState = { state: value.state, verifier: value.verifier, exp: now + OAUTH_STATE_TTL_MS }
  return sealSecret(memberKey(master, memberId), JSON.stringify(payload), oauthAad(provider, memberId))
}

/**
 * Checks a callback against the sealed cookie and returns the verifier for the token exchange. Rejects, with
 * `OAUTH_STATE_ERROR` only: an expired value, a state that differs from `returnedState` (compared in constant time),
 * a value sealed for another member or provider, and any changed byte.
 */
export function verifyOAuthState(
  master: Buffer,
  memberId: string,
  provider: OAuthProvider,
  sealed: string,
  returnedState: string,
  now: number = Date.now()
): string {
  const stored = openStoredState(master, memberId, provider, sealed)
  if (!stored || now >= stored.exp || !sameText(stored.state, returnedState)) throw new Error(OAUTH_STATE_ERROR)
  return stored.verifier
}

/**
 * The callback URL for a provider, built only from the configured public origin (`TM_PUBLIC_URL`), never from a request.
 * The origin must be `https`, or `http` on localhost for development, with no path, query, fragment or user name.
 */
export function oauthRedirectUri(publicOrigin: string, provider: OAuthProvider): string {
  const url = parsePublicOrigin(publicOrigin)
  return `${url.origin}/api/connections/${provider}/callback`
}

/**
 * The OAuth client of a provider from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` or `NOTION_CLIENT_ID` /
 * `NOTION_CLIENT_SECRET`, or null when either is unset or empty (Compose passes an unset variable as ''). The redirect
 * address is `<TM_PUBLIC_URL origin>/api/connections/<kind>/callback`, built by `oauthRedirectUri` (a trailing slash is
 * dropped; a path, query or user name in `TM_PUBLIC_URL` is refused).
 */
export function oauthClientFromEnv(
  kind: 'google' | 'notion',
  env: Record<string, string | undefined> = process.env
): OAuthClient | null {
  const prefix = kind.toUpperCase()
  const clientId = env[`${prefix}_CLIENT_ID`]
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]
  if (!clientId || !clientSecret) return null
  const base = env.TM_PUBLIC_URL
  if (!base) throw new Error('TM_PUBLIC_URL is not set')
  return { clientId, clientSecret, redirectUri: oauthRedirectUri(base, kind) }
}

function oauthAad(provider: OAuthProvider, memberId: string): string {
  return `oauth_state:${provider}:${memberId}`
}

/** Opens and parses a sealed state. Returns null for any value that does not open as ours; a missing key still throws. */
function openStoredState(
  master: Buffer,
  memberId: string,
  provider: OAuthProvider,
  sealed: string
): StoredState | null {
  const key = memberKey(master, memberId)
  try {
    const parsed: unknown = JSON.parse(openSecret(key, sealed, oauthAad(provider, memberId)))
    return isStoredState(parsed) ? parsed : null
  } catch (error) {
    if (error instanceof SecretError || error instanceof SyntaxError) return null
    throw error
  }
}

function isStoredState(value: unknown): value is StoredState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.state === 'string' && typeof v.verifier === 'string' && typeof v.exp === 'number'
}

/** Constant-time text compare. A length difference is refused at once; state lengths are fixed, so that leaks nothing. */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

function parsePublicOrigin(raw: string): URL {
  const url = parseAbsolute(raw)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local)
  const bare =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  if (!schemeOk || !bare) {
    throw new Error('TM_PUBLIC_URL must be an https origin with no path, query, fragment or user name')
  }
  return url
}

function parseAbsolute(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new Error('TM_PUBLIC_URL must be an https origin with no path, query, fragment or user name')
  }
}
