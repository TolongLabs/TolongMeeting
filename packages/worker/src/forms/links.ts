import { canonicalFormUrl, type FormCandidate, type FormProvider, type ResolvedForm } from '@tm/core'

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
// A shortener that does not redirect is unresolved, never "not a form": a real form behind it would be missed.
const SHORT_LINK_HOSTS = new Set(['forms.gle', 'bit.ly', 't.co', 'tinyurl.com'])

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

// A form URL is https, on the default port, with no userinfo. Anything else is not a form, whatever its host.
function isSecureFormUrl(u: URL): boolean {
  return u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === ''
}

export function formProviderOf(url: string): FormProvider | null {
  const u = parseUrl(url)
  if (!u || !isSecureFormUrl(u)) return null
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

// A shortener or an unopened Safe Links / Google redirect wrapper: its non-redirect answer cannot be read as "not a form".
function isShortOrWrapperLink(url: string): boolean {
  const u = parseUrl(url)
  if (!u) return false
  if (SHORT_LINK_HOSTS.has(u.hostname)) return true
  if (u.hostname.endsWith('.safelinks.protection.outlook.com')) return true
  return (u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname === '/url'
}

// The per-meeting duplicate key: the canonical form URL, the same one that gives the form id. It never carries
// pre-filled answers or the direct-submit path. A URL that is not on a form provider is refused.
export function normaliseFormUrl(url: string): string {
  if (formProviderOf(url) === null) throw new Error('not a form URL')
  return canonicalFormUrl(url)
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

async function cancelBody(res: Response, url: string): Promise<void> {
  try {
    await res.body?.cancel()
  } catch (err) {
    throw new LinkResolveError('network', `form link ${where(url)} could not be closed`, { cause: err })
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
    await cancelBody(res, current)
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null
    if (location === null) {
      if (isShortOrWrapperLink(current)) {
        throw new LinkResolveError('network', `short link ${where(current)} did not redirect`)
      }
      break
    }
    if (redirects === maxRedirects) {
      throw new LinkResolveError(
        'too_many_redirects',
        `form link ${where(current)} redirected more than ${maxRedirects} times`
      )
    }
    redirects += 1
    if (!URL.canParse(location, current)) {
      throw new LinkResolveError('network', `form link ${where(current)} sent a malformed Location header`)
    }
    current = unwrapLink(new URL(location, current).href)
  }

  // Only a final form page counts. A short link that stopped redirecting (forms.gle answering 200) is not a form.
  const provider = isFinalFormUrl(current) ? formProviderOf(current) : null
  if (provider === null) return null
  return { ...c, finalUrl: current, provider }
}
