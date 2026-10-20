/**
 * A mutating Route Handler is cookie-authenticated, and Next checks `Origin` only for server actions. So a handler that
 * changes something calls this first: the request must come from the site itself (`Origin` equals the origin of
 * `TM_PUBLIC_URL`). A missing or different `Origin` gets a bare 403; nothing else is said. Returns null when it is fine.
 */
export function assertSameOrigin(request: Request): Response | null {
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set')
  if (request.headers.get('origin') === new URL(publicUrl).origin) return null
  return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
}
