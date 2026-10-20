// The Content-Security-Policy of the remote sign-in page. The page runs noVNC in the member's browser to sign in to
// bot accounts. Next's inline bootstrap script receives a per-request nonce, and script-src allows no unsafe-inline.
// Styles keep 'unsafe-inline' because noVNC dynamically sets inline styles on its display and cursor elements.

const SIGNIN_ROUTE = /^\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/signin$/i

/** True for the remote sign-in page of an identity only. */
export const isSigninPage = (pathname: string): boolean => SIGNIN_ROUTE.test(pathname)

export function signinCsp(nonce: string): string {
  const dev = process.env.NODE_ENV !== 'production'
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
}
