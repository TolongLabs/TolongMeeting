import { afterAll, beforeAll, expect, test } from 'bun:test'
import { canonicalFormUrl, type FormCandidate } from '@tm/core'
import {
  extractLinks,
  formProviderOf,
  LinkResolveError,
  normaliseFormUrl,
  resolveFormLink,
  unwrapLink
} from '../src/forms/links'

// A real HTTP server answers every request. Requests to any host (bit.ly, forms.gle, ...) are routed to it,
// so the redirect chains are real HTTP, and each call is recorded with the URL the code asked for.
type Call = { url: string; init: RequestInit | undefined }

let server: ReturnType<typeof Bun.serve>
let base: string
let deadBase: string

const DOCS_FORM = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=send_form'
const SAFE_LINK_FORM = 'https://apc01.safelinks.protection.outlook.com/?url=' + encodeURIComponent(DOCS_FORM)

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/x') return redirect('https://forms.gle/abc', 301)
      if (pathname === '/abc') return redirect(DOCS_FORM)
      if (pathname === '/to-safelink') return redirect(SAFE_LINK_FORM)
      if (pathname === '/long')
        return redirect('https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=pp_url&entry.123=x')
      if (pathname === '/short-form') return redirect('https://docs.google.com/forms/d/e/1FAIpQ/viewform')
      if (pathname === '/not-a-form') return new Response('plain page', { status: 200 })
      if (pathname === '/gle-200') return new Response('no redirect here', { status: 200 })
      if (pathname === '/bad-location') return redirect('http://[bad')
      if (pathname === '/to-javascript') return redirect('javascript://docs.google.com/forms/x')
      if (pathname === '/to-file') return redirect('file://forms.office.com/r/a')
      if (pathname.startsWith('/chain/')) {
        const n = Number(pathname.slice('/chain/'.length))
        const total = Number(new URL(req.url).searchParams.get('total'))
        if (n < total) return redirect(`https://chain.example/chain/${n + 1}?total=${total}`)
        return new Response('end of chain', { status: 200 })
      }
      if (pathname === '/slow') {
        await Bun.sleep(1000)
        return new Response('late', { status: 200 })
      }
      return new Response('unknown', { status: 404 })
    }
  })
  base = `http://127.0.0.1:${server.port}`
  // A port with nothing listening: connecting to it fails at the network level.
  const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  deadBase = `http://127.0.0.1:${dead.port}`
  dead.stop(true)
})

afterAll(() => {
  server.stop(true)
})

// Sends every request for any host to the local server, keeping path and query. Records the URL the code asked for.
function routedFetch(target: string, calls: Call[]): typeof fetch {
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const asked = input instanceof Request ? input.url : String(input)
    calls.push({ url: asked, init })
    const u = new URL(asked)
    return fetch(new URL(u.pathname + u.search, target), init)
  }
  return Object.assign(send, { preconnect: fetch.preconnect })
}

function cand(url: string): FormCandidate {
  return {
    url,
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'participant',
    seenAt: '2026-10-20T10:00:00Z'
  }
}

test('extract and unwrap', () => {
  expect(extractLinks('Attendance: https://forms.gle/abc. Also (https://example.com/x)')).toEqual([
    'https://forms.gle/abc',
    'https://example.com/x'
  ])
  expect(
    unwrapLink('https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fforms.office.com%2Fr%2FAbC123&data=x')
  ).toBe('https://forms.office.com/r/AbC123')
  expect(unwrapLink('https://www.google.com/url?q=https://forms.gle/abc&sa=D')).toBe('https://forms.gle/abc')
  const twice = 'https://google.com/url?url=' + encodeURIComponent(SAFE_LINK_FORM)
  expect(unwrapLink(twice)).toBe(DOCS_FORM)
})

test('follows a shortener without cookies and stops on the provider domain', async () => {
  const calls: Call[] = []
  const r = await resolveFormLink(cand('https://bit.ly/x'), { fetch: routedFetch(base, calls) })
  expect(r).toMatchObject({
    url: 'https://bit.ly/x',
    finalUrl: DOCS_FORM,
    provider: 'google'
  })
  expect(calls.map((c) => c.init)).toEqual([
    {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: expect.anything()
    },
    expect.objectContaining({ redirect: 'manual', credentials: 'omit' })
  ])
  // bit.ly and forms.gle were requested; docs.google.com was never requested.
  expect(calls.map((c) => c.url)).toEqual(['https://bit.ly/x', 'https://forms.gle/abc'])
})

test('a redirect to a Safe Links wrapper is unwrapped before the form check', async () => {
  const calls: Call[] = []
  const r = await resolveFormLink(cand('https://bit.ly/to-safelink'), { fetch: routedFetch(base, calls) })
  expect(r).toMatchObject({ finalUrl: DOCS_FORM, provider: 'google' })
  expect(calls.length).toBe(1)
})

test('a Safe Links wrapper around a form resolves without any request', async () => {
  const calls: Call[] = []
  const r = await resolveFormLink(cand(SAFE_LINK_FORM), { fetch: routedFetch(base, calls) })
  expect(r).toMatchObject({ finalUrl: DOCS_FORM, provider: 'google' })
  expect(calls.length).toBe(0)
})

test('non-forms are null; slow, broken and looping links raise LinkResolveError', async () => {
  const calls: Call[] = []
  expect(await resolveFormLink(cand(`${base}/not-a-form`), { fetch: routedFetch(base, calls) })).toBeNull()
  expect(await resolveFormLink(cand('mailto:someone@example.com'), { fetch: routedFetch(base, calls) })).toBeNull()

  await expect(
    resolveFormLink(cand(`${base}/slow`), { fetch: routedFetch(base, calls), timeoutMs: 50 })
  ).rejects.toMatchObject({ reason: 'timeout' })
  await expect(resolveFormLink(cand(`${base}/x`), { fetch: routedFetch(deadBase, calls) })).rejects.toMatchObject({
    reason: 'network'
  })
  await expect(
    resolveFormLink(cand('https://loop.example/chain/0?total=6'), { fetch: routedFetch(base, calls) })
  ).rejects.toMatchObject({ reason: 'too_many_redirects' })
})

test('five redirects are allowed, six are not', async () => {
  const five = await resolveFormLink(cand('https://chain.example/chain/0?total=5'), { fetch: routedFetch(base, []) })
  expect(five).toBeNull()
  await expect(
    resolveFormLink(cand('https://chain.example/chain/0?total=6'), { fetch: routedFetch(base, []) })
  ).rejects.toBeInstanceOf(LinkResolveError)
})

test('Review Focus: one form in three shapes has one key', async () => {
  const calls: Call[] = []
  const fetchToServer = routedFetch(base, calls)
  const long = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=pp_url&entry.123=x'
  const wrapped = 'https://apc01.safelinks.protection.outlook.com/?url=' + encodeURIComponent(long)
  const short = await resolveFormLink(cand('https://forms.gle/abc'), { fetch: routedFetch(base, []) })
  const fromShort = short?.finalUrl
  const fromShortAfterRedirect = await resolveFormLink(cand(`https://forms.gle/short-form`), {
    fetch: fetchToServer
  })
  expect(short?.finalUrl).toBe(DOCS_FORM)
  expect(fromShortAfterRedirect?.finalUrl).toBe('https://docs.google.com/forms/d/e/1FAIpQ/viewform')

  const keys = new Set([long, unwrapLink(wrapped), fromShort!, fromShortAfterRedirect!.finalUrl].map(normaliseFormUrl))
  expect([...keys]).toEqual(['https://docs.google.com/forms/d/e/1FAIpQ/viewform'])
  expect(normaliseFormUrl('https://forms.office.com/Pages/ResponsePage.aspx?id=AbC&origin=lprLink')).toBe(
    'https://forms.office.com/Pages/ResponsePage.aspx?id=AbC'
  )
  expect(normaliseFormUrl('https://forms.microsoft.com/r/AbC?origin=x')).toBe('https://forms.office.com/r/AbC')
  expect(normaliseFormUrl('https://docs.google.com/forms/d/XyZ/edit?usp=sharing')).toBe(
    'https://docs.google.com/forms/d/XyZ/viewform'
  )
  expect(formProviderOf('https://forms.microsoft.com/r/AbC')).toBe('microsoft')
  expect(formProviderOf('https://docs.google.com/document/d/x')).toBeNull()
  expect(formProviderOf('not a url')).toBeNull()
  expect(() => normaliseFormUrl('https://example.com/forms')).toThrow('not a form URL')
})

test('look-alike hosts are not forms', async () => {
  const calls: Call[] = []
  const lookAlikes = [
    'https://docs.google.com.evil.example/forms/x',
    'https://forms.office.com.attacker.net/r/a',
    'https://docs.google.com@evil.example/forms/x'
  ]
  for (const url of lookAlikes) {
    expect(formProviderOf(url)).toBeNull()
    expect(await resolveFormLink(cand(url), { fetch: routedFetch(base, calls) })).toBeNull()
  }
  expect(formProviderOf('docs.google.com@evil.example/forms/x')).toBeNull()
})

test('a form URL needs https, the default port and no userinfo', async () => {
  const calls: Call[] = []
  const notForms = [
    'http://docs.google.com/forms/d/e/1FAIpQ/viewform',
    'https://docs.google.com:8080/forms/d/e/1FAIpQ/viewform',
    'https://user@docs.google.com/forms/d/e/1FAIpQ/viewform',
    'https://forms.office.com:8443/r/a'
  ]
  for (const url of notForms) {
    expect(formProviderOf(url)).toBeNull()
    expect(await resolveFormLink(cand(url), { fetch: routedFetch(base, calls) })).toBeNull()
  }
  // The explicit default port is the same URL as no port.
  expect(formProviderOf('https://docs.google.com:443/forms/d/e/1FAIpQ/viewform')).toBe('google')
})

test('a form link over a non-http scheme is null and makes no request', async () => {
  const calls: Call[] = []
  for (const url of ['javascript://docs.google.com/forms/x', 'file://forms.office.com/r/a']) {
    expect(formProviderOf(url)).toBeNull()
    expect(await resolveFormLink(cand(url), { fetch: routedFetch(base, calls) })).toBeNull()
  }
  expect(calls.length).toBe(0)
})

test('a redirect to a non-http scheme ends the chain with null', async () => {
  const calls: Call[] = []
  expect(await resolveFormLink(cand(`${base}/to-javascript`), { fetch: routedFetch(base, calls) })).toBeNull()
  expect(await resolveFormLink(cand(`${base}/to-file`), { fetch: routedFetch(base, calls) })).toBeNull()
  expect(calls.length).toBe(2)
})

test('a short link that answers 200 with no redirect is unresolved, not a non-form', async () => {
  const calls: Call[] = []
  const err = await resolveFormLink(cand('https://forms.gle/gle-200'), { fetch: routedFetch(base, calls) }).catch(
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(LinkResolveError)
  expect(err).toMatchObject({ reason: 'network' })
  expect((err as Error).message).toBe('short link forms.gle/gle-200 did not redirect')
  expect(calls.map((c) => c.url)).toEqual(['https://forms.gle/gle-200'])
  await expect(
    resolveFormLink(cand('https://bit.ly/gle-200'), { fetch: routedFetch(base, calls) })
  ).rejects.toMatchObject({
    reason: 'network'
  })
})

test('a body that fails to close raises LinkResolveError with reason network', async () => {
  const broken: typeof fetch = Object.assign(
    async () =>
      new Response(new ReadableStream({ cancel: () => Promise.reject(new Error('socket reset')) }), {
        status: 302,
        headers: { location: DOCS_FORM }
      }),
    { preconnect: fetch.preconnect }
  )
  const err = await resolveFormLink(cand('https://docs.google.com/x'), { fetch: broken }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(LinkResolveError)
  expect(err).toMatchObject({ reason: 'network' })
  expect((err as Error).message).toBe('form link docs.google.com/x could not be closed')
})

test('a malformed Location header raises LinkResolveError with reason network', async () => {
  await expect(resolveFormLink(cand(`${base}/bad-location`), { fetch: routedFetch(base, []) })).rejects.toBeInstanceOf(
    LinkResolveError
  )
  await expect(resolveFormLink(cand(`${base}/bad-location`), { fetch: routedFetch(base, []) })).rejects.toMatchObject({
    reason: 'network'
  })
})

test('the account-index shape has the same key as the plain shape', () => {
  const plain = normaliseFormUrl('https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=sf_link')
  expect(normaliseFormUrl('https://docs.google.com/forms/u/0/d/e/1FAIpQ/viewform')).toBe(plain)
  expect(normaliseFormUrl('https://docs.google.com/forms/u/2/d/e/1FAIpQ/viewform?usp=pp_url')).toBe(plain)
  expect(normaliseFormUrl('https://docs.google.com/forms/u/0/d/XyZ/edit')).toBe(
    'https://docs.google.com/forms/d/XyZ/viewform'
  )
})

test('normaliseFormUrl is the shared canonicalFormUrl; prefilled and direct-submit links open the plain form', () => {
  const plain = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform'
  const links = [
    `${plain}?usp=pp_url&entry.123=Absent`,
    'https://docs.google.com/forms/d/e/1FAIpQ/formResponse?entry.123=Present&submit=Submit',
    'https://docs.google.com/forms/u/1/d/e/1FAIpQ/formResponse?usp=pp_url&entry.123=Absent&submit=Submit#x'
  ]
  for (const link of links) {
    expect(normaliseFormUrl(link)).toBe(plain)
    expect(normaliseFormUrl(link)).toBe(canonicalFormUrl(link))
  }
  expect(normaliseFormUrl('https://forms.office.com/Pages/ResponsePage.aspx?id=AbC&r1a2b=Absent&embed=true')).toBe(
    'https://forms.office.com/Pages/ResponsePage.aspx?id=AbC'
  )
  // The look-alike, https and port guards still refuse before canonicalising.
  expect(() => normaliseFormUrl('https://docs.google.com.evil.example/forms/d/e/1FAIpQ/viewform')).toThrow(
    'not a form URL'
  )
  expect(() => normaliseFormUrl('http://docs.google.com/forms/d/e/1FAIpQ/viewform')).toThrow('not a form URL')
  expect(() => normaliseFormUrl('https://docs.google.com:8443/forms/d/e/1FAIpQ/viewform')).toThrow('not a form URL')
})
