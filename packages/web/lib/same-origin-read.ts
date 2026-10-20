/**
 * The check for a handler that answers a GET with something a page must not hand to another site. A same-origin `fetch`
 * or link click sends no `Origin` on a GET, so `assertSameOrigin` would refuse the page itself. Here: an `Origin` must
 * equal the origin of `TM_PUBLIC_URL`; without one, the browser's `Sec-Fetch-Site` must say `same-origin` (or `none`, a
 * typed address). Anything else gets a bare 403. Returns null when it is fine.
 */
export function assertSameOriginRead(request: Request): Response | null {
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set')
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  const ok = origin !== null ? origin === new URL(publicUrl).origin : site === 'same-origin' || site === 'none'
  return ok ? null : new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
}
