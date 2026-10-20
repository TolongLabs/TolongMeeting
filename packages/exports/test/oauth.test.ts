import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  newOAuthState,
  oauthRedirectUri,
  OAUTH_STATE_ERROR,
  OAUTH_STATE_TTL_MS,
  pkceChallenge,
  sealOAuthState,
  verifyOAuthState,
  type OAuthProvider
} from '../src/connections/oauth'

const master = randomBytes(32)
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const T0 = 1_800_000_000_000

/** The message a rejected call throws, or fails the test when the call succeeds. */
function rejection(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the call to throw')
}

function sealFor(memberId = 'm1', provider: OAuthProvider = 'google', now = T0) {
  const { state, verifier } = newOAuthState()
  return { state, verifier, sealed: sealOAuthState(master, memberId, provider, { state, verifier }, now) }
}

describe('PKCE', () => {
  test('the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
  })

  test('a verifier outside 43-128 RFC characters is refused without echoing it', () => {
    const short = 'a'.repeat(42)
    const badChar = `${'a'.repeat(42)}+`
    for (const verifier of [short, badChar, 'a'.repeat(129)]) {
      const message = rejection(() => pkceChallenge(verifier))
      expect(message).toBe('PKCE verifier must be 43-128 characters of the RFC 7636 alphabet')
      expect(message).not.toContain(verifier)
    }
  })

  test('new state and verifier are 43 base64url characters and the challenge matches the verifier', () => {
    const a = newOAuthState()
    const b = newOAuthState()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a.state, 'base64url').length).toBe(32)
    expect(a.challenge).toBe(pkceChallenge(a.verifier))
    expect(a.state).not.toBe(b.state)
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe('sealed sign-in state', () => {
  test('opens to its verifier for the same member, provider and state', () => {
    const { state, verifier, sealed } = sealFor()
    expect(sealed).toMatch(/^v1\./)
    expect(verifyOAuthState(master, 'm1', 'google', sealed, state, T0 + 1000)).toBe(verifier)
  })

  test('accepts a callback up to the last millisecond of the 10 minute window', () => {
    const { state, verifier, sealed } = sealFor()
    expect(OAUTH_STATE_TTL_MS).toBe(600_000)
    expect(verifyOAuthState(master, 'm1', 'google', sealed, state, T0 + OAUTH_STATE_TTL_MS - 1)).toBe(verifier)
  })

  test('rejects an expired value', () => {
    const { state, sealed } = sealFor()
    const message = rejection(() => verifyOAuthState(master, 'm1', 'google', sealed, state, T0 + OAUTH_STATE_TTL_MS))
    expect(message).toBe(OAUTH_STATE_ERROR)
  })

  test('rejects a returned state that differs, even in its last character', () => {
    const { state, sealed } = sealFor()
    const flipped = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A')
    for (const wrong of [flipped, '', 'x', state + 'A']) {
      expect(rejection(() => verifyOAuthState(master, 'm1', 'google', sealed, wrong, T0))).toBe(OAUTH_STATE_ERROR)
    }
  })

  test('rejects a value sealed for another member', () => {
    const { state, sealed } = sealFor('m1')
    expect(rejection(() => verifyOAuthState(master, 'm2', 'google', sealed, state, T0))).toBe(OAUTH_STATE_ERROR)
  })

  test('rejects a value sealed for another provider', () => {
    const { state, sealed } = sealFor('m1', 'google')
    expect(rejection(() => verifyOAuthState(master, 'm1', 'notion', sealed, state, T0))).toBe(OAUTH_STATE_ERROR)
  })

  test('rejects a value sealed under another master key', () => {
    const { state, sealed } = sealFor()
    const other = randomBytes(32)
    expect(rejection(() => verifyOAuthState(other, 'm1', 'google', sealed, state, T0))).toBe(OAUTH_STATE_ERROR)
  })

  test('rejects a tampered ciphertext, tag or iv', () => {
    const { state, sealed } = sealFor()
    const [prefix, iv, ciphertext, tag] = sealed.split('.')
    const swap = (part: string) => (part[0] === 'A' ? 'B' : 'A') + part.slice(1)
    for (const tampered of [
      [prefix, iv, swap(ciphertext!), tag],
      [prefix, iv, ciphertext, swap(tag!)],
      [prefix, swap(iv!), ciphertext, tag]
    ]) {
      const value = tampered.join('.')
      expect(value).not.toBe(sealed)
      expect(rejection(() => verifyOAuthState(master, 'm1', 'google', value, state, T0))).toBe(OAUTH_STATE_ERROR)
    }
  })

  test('rejects a value that is not sealed at all, with the same error and without echoing it', () => {
    const { state } = sealFor()
    const junk = 'not-a-sealed-value-but-some-text'
    const message = rejection(() => verifyOAuthState(master, 'm1', 'google', junk, state, T0))
    expect(message).toBe(OAUTH_STATE_ERROR)
    expect(message).not.toContain(junk)
  })

  test('every rejection carries the same fixed message that names no state, verifier or sealed value', () => {
    const { state, verifier, sealed } = sealFor('m1', 'google')
    const messages = [
      rejection(() => verifyOAuthState(master, 'm1', 'google', sealed, 'wrong-state', T0)),
      rejection(() => verifyOAuthState(master, 'm1', 'google', sealed, state, T0 + OAUTH_STATE_TTL_MS)),
      rejection(() => verifyOAuthState(master, 'm2', 'google', sealed, state, T0)),
      rejection(() => verifyOAuthState(master, 'm1', 'notion', sealed, state, T0)),
      rejection(() => verifyOAuthState(master, 'm1', 'google', `${sealed}x`, state, T0)),
      rejection(() => verifyOAuthState(master, 'm1', 'google', 'junk', state, T0))
    ]
    for (const message of messages) {
      expect(message).toBe(OAUTH_STATE_ERROR)
      for (const secret of [state, verifier, sealed]) expect(message).not.toContain(secret)
    }
  })
})

describe('redirect URI', () => {
  test('is built from the configured public origin only', () => {
    expect(oauthRedirectUri('https://tm.example', 'google')).toBe('https://tm.example/api/connections/google/callback')
    expect(oauthRedirectUri('https://tm.example/', 'notion')).toBe('https://tm.example/api/connections/notion/callback')
    expect(oauthRedirectUri('http://localhost:3000', 'google')).toBe(
      'http://localhost:3000/api/connections/google/callback'
    )
  })

  test('refuses anything but a bare https origin (or localhost over http)', () => {
    const refused = [
      'https://tm.example/app',
      'https://tm.example?next=/',
      'https://tm.example/#x',
      'https://user:pw@tm.example',
      'http://tm.example',
      'javascript:alert(1)',
      'not a url'
    ]
    for (const origin of refused) {
      expect(rejection(() => oauthRedirectUri(origin, 'google'))).toBe(
        'TM_PUBLIC_URL must be an https origin with no path, query, fragment or user name'
      )
    }
  })
})
