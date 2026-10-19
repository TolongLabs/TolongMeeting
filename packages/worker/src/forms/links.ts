import type { FormCandidate, FormProvider, ResolvedForm } from '@tm/core'

export interface ResolveOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxRedirects?: number
}

export class LinkResolveError extends Error {
  readonly reason: 'timeout' | 'network' | 'too_many_redirects'

  constructor(reason: LinkResolveError['reason'], message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LinkResolveError'
    this.reason = reason
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]{}]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_UNWRAP_DEPTH = 3

export function extractLinks(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((m) => m[0].replace(TRAILING_PUNCTUATION, ''))
}

function parseUrl(url: string): URL | null {
  return URL.canParse(url) ? new URL(url) : null
}

// Only the host and path appear in errors, never the query (it can carry tokens or pre-filled answers).
function where(url: string): string {
  const u = new URL(url)
  return `${u.host}${u.pathname}`
}

function unwrapOnce(url: string): string {
  const u = parseUrl(url)
  if (!u) return url
  if (u.hostname.endsWith('.safelinks.protection.outlook.com')) return u.searchParams.get('url') ?? url
  if (u.hostname === 'www.google.com' || u.hostname === 'google.com') {
    if (u.pathname !== '/url') return url
    return u.searchParams.get('q') ?? u.searchParams.get('url') ?? url
  }
  return url
}

// Peels Safe Links and Google redirect wrappers, up to three layers.
export function unwrapLink(url: string): string {
  let current = url
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const next = unwrapOnce(current)
    if (next === current) break
    current = next
  }
  return current
}

export function formProviderOf(url: string): FormProvider | null {
  const u = parseUrl(url)
  if (!u) return null
  if (u.hostname === 'docs.google.com') return u.pathname.startsWith('/forms/') ? 'google' : null
  if (u.hostname === 'forms.gle') return 'google'
  if (u.hostname === 'forms.office.com' || u.hostname === 'forms.microsoft.com') return 'microsoft'
  return null
}

// A form page that needs no further request: the chain stops here without fetching it.
// forms.gle is always a short link, so it is requested.
function isFinalFormUrl(url: string): boolean {
  const u = parseUrl(url)
  return u !== null && u.hostname !== 'forms.gle' && formProviderOf(url) !== null
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

// The per-meeting duplicate key: one key per form, whatever shape the link was posted in.
export function normaliseFormUrl(url: string): string {
  const u = parseUrl(url)
  const provider = u ? formProviderOf(url) : null
  if (!u || provider === null) throw new Error('not a form URL')
  if (provider === 'microsoft') {
    const id = u.searchParams.get('id')
    if (u.pathname.toLowerCase() === '/pages/responsepage.aspx' && id) return `https://forms.office.com/id/${id}`
    return `https://forms.office.com${trimTrailingSlash(u.pathname)}`
  }
  const google = /^\/forms\/d\/(?:e\/)?[^/]+/.exec(u.pathname)
  if (u.hostname === 'docs.google.com' && google) return `https://docs.google.com${google[0]}`
  return `https://${u.hostname}${trimTrailingSlash(u.pathname)}`
}

async function requestOnce(fetchFn: typeof fetch, url: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetchFn(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal })
  } catch (err) {
    if (signal.aborted) {
      throw new LinkResolveError('timeout', `form link ${where(url)} timed out`, { cause: err })
    }
    throw new LinkResolveError('network', `form link ${where(url)} could not be reached`, { cause: err })
  }
}

// Returns the resolved form, or null when the final URL is not on a form provider.
export async function resolveFormLink(c: FormCandidate, opts: ResolveOptions = {}): Promise<ResolvedForm | null> {
  const fetchFn = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? 5000
  const maxRedirects = opts.maxRedirects ?? 5
  const signal = AbortSignal.timeout(timeoutMs)

  let current = unwrapLink(c.url)
  let redirects = 0
  while (!isFinalFormUrl(current)) {
    const u = parseUrl(current)
    if (u === null || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null
    const res = await requestOnce(fetchFn, current, signal)
    await res.body?.cancel()
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null
    if (location === null) break
    if (redirects === maxRedirects) {
      throw new LinkResolveError(
        'too_many_redirects',
        `form link ${where(c.url)} redirected more than ${maxRedirects} times`
      )
    }
    redirects += 1
    current = unwrapLink(new URL(location, current).href)
  }

  const provider = formProviderOf(current)
  if (provider === null) return null
  return { ...c, finalUrl: current, provider }
}
