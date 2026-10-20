// The Content-Security-Policy of the Connections page. It is the one page that loads a script from another site (the
// Google Picker). A script is allowed only with this request's nonce, and `strict-dynamic` lets the page's own scripts
// load the Picker script. Google's folder picker is framed from `docs.google.com` (and `drive.google.com`, as Google's own
// example policy for the Picker allows), and its script may call `*.googleapis.com`. Nothing else beyond the site itself.

/** True for the Connections page only. */
export const isConnectionsPage = (pathname: string): boolean => pathname === '/connections'

/** A new random nonce for one request. */
export const newNonce = (): string => Buffer.from(crypto.randomUUID()).toString('base64')

export function connectionsCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://apis.google.com`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self' https://*.googleapis.com",
    'frame-src https://docs.google.com https://drive.google.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
}
