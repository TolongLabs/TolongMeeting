import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BrowserContext, Route } from '@playwright/test'

// The selector maps the drivers load; set here so a spec that imports this helper needs no environment.
process.env.TM_SELECTORS_DIR ??= resolve(import.meta.dirname, '../../../../config/selectors')

const FIXTURES = resolve(import.meta.dirname, '../fixtures/forms')
const GOOGLE_PATH = /^\/forms\/d\/e\/([^/]+)\/(viewform|formResponse|fixture\.js)$/
const MICROSOFT_FORM_PATH = '/Pages/ResponsePage.aspx' // the id is case-sensitive, as a Microsoft short code is
const MICROSOFT_SUBMIT_PATH = '/formapi/api/fixture/responses'
const MICROSOFT_SCRIPT_PATH = '/Pages/fixture.js'
const FORM_ID = /^[A-Za-z0-9-]+$/ // a Microsoft form id: letters, digits and hyphens, case kept

export interface FixtureServer {
  requests: string[] // every form-provider URL requested
  submissions: {
    fixture: string
    answers: Record<string, string | string[]>
    sendCopy: boolean
  }[]
  signedOut: Set<string> // fixture names whose form URL redirects to the provider's sign-in page
  // What the submit endpoint serves (Google: formResponse, Microsoft: formapi): the provider's response, or (to test an
  // unconfirmed submit) the form again or a captcha
  submitResult: Map<string, 'confirmation' | 'already-responded' | 'still-form' | 'captcha'>
  delayMs: Map<string, number> // delay before serving a fixture
  onFormLoad: ((fixture: string, count: number) => void) | null
}

export const googleUrl = (fixture: string): string => `https://docs.google.com/forms/d/e/${fixture}/viewform`
export const microsoftUrl = (fixture: string): string =>
  `https://forms.office.com/Pages/ResponsePage.aspx?id=${fixture}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixtureFile(provider: 'google' | 'microsoft', name: string): Promise<string> {
  return readFile(join(FIXTURES, provider, name), 'utf8')
}

// A page that closed while a delayed fixture was pending cannot be answered; anything else is a real failure.
async function fulfil(route: Route, options: Parameters<Route['fulfill']>[0]): Promise<void> {
  await route.fulfill(options).catch((error: unknown) => {
    if (!/closed|disposed/i.test(String(error))) throw error
  })
}

const html = (body: string, status = 200) => ({ status, contentType: 'text/html; charset=utf-8', body })

export async function routeFormFixtures(context: BrowserContext): Promise<FixtureServer> {
  const fx: FixtureServer = {
    requests: [],
    submissions: [],
    signedOut: new Set(),
    submitResult: new Map(),
    delayMs: new Map(),
    onFormLoad: null
  }
  const loads = new Map<string, number>()

  await context.route('https://docs.google.com/**', async (route) => {
    const request = route.request()
    const match = GOOGLE_PATH.exec(new URL(request.url()).pathname)
    if (match === null) return fulfil(route, { status: 200, body: '' })
    const [, name, kind] = match as unknown as [string, string, string]
    if (kind === 'fixture.js') {
      return fulfil(route, {
        status: 200,
        contentType: 'text/javascript',
        body: await fixtureFile('google', 'fixture.js')
      })
    }
    fx.requests.push(request.url())
    if (kind === 'formResponse') {
      if (request.method() !== 'POST') return fulfil(route, html('method not allowed', 405))
      const posted = new URLSearchParams(request.postData() ?? '').get('answers')
      if (posted === null) throw new Error(`POST to formResponse for ${name} carries no "answers" field`)
      const { answers, sendCopy } = JSON.parse(posted) as Pick<
        FixtureServer['submissions'][number],
        'answers' | 'sendCopy'
      >
      fx.submissions.push({ fixture: name, answers, sendCopy })
      const result = fx.submitResult.get(name) ?? 'confirmation'
      const served = {
        confirmation: 'confirmation.html',
        'already-responded': 'already-responded.html',
        'still-form': 'widgets.html',
        captcha: 'captcha.html'
      }[result]
      return fulfil(route, html(await fixtureFile('google', served)))
    }
    if (fx.signedOut.has(name)) {
      const location = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(googleUrl(name))}`
      // A fulfilled 302 is followed, but Playwright does not route the request it leads to, so the stand-in for the
      // redirect is a page that replaces itself with the sign-in URL.
      return fulfil(route, html(`<!doctype html><script>location.replace(${JSON.stringify(location)})</script>`))
    }
    const delay = fx.delayMs.get(name)
    if (delay !== undefined) await sleep(delay)
    let page: string
    try {
      page = await fixtureFile('google', `${name}.html`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return fulfil(route, html(`no fixture ${name}`, 404))
    }
    await fulfil(route, html(page))
    const count = (loads.get(name) ?? 0) + 1
    loads.set(name, count)
    fx.onFormLoad?.(name, count)
  })
  await context.route('https://accounts.google.com/**', async (route) =>
    fulfil(route, html(await fixtureFile('google', 'signin.html')))
  )
  // Both Microsoft hosts from the map. Every request to them is recorded; only a form page is served from a fixture.
  const microsoftHost = (url: URL) =>
    url.protocol === 'https:' && (url.hostname === 'forms.office.com' || url.hostname === 'forms.microsoft.com')
  await context.route(microsoftHost, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    fx.requests.push(request.url())
    if (url.pathname === MICROSOFT_SCRIPT_PATH) {
      return fulfil(route, {
        status: 200,
        contentType: 'text/javascript',
        body: await fixtureFile('microsoft', 'fixture.js')
      })
    }
    if (url.pathname === MICROSOFT_SUBMIT_PATH) {
      const name = url.searchParams.get('id')
      if (request.method() !== 'POST' || name === null || !FORM_ID.test(name)) {
        return fulfil(route, html('method not allowed, or no valid form id', 405))
      }
      const { answers, sendCopy } = JSON.parse(request.postData() ?? 'null') as Pick<
        FixtureServer['submissions'][number],
        'answers' | 'sendCopy'
      >
      fx.submissions.push({ fixture: name, answers, sendCopy })
      const reply = {
        confirmation: {},
        'already-responded': { alreadyResponded: true },
        'still-form': { stillForm: true },
        captcha: { captcha: true }
      }[fx.submitResult.get(name) ?? 'confirmation']
      return fulfil(route, { status: 200, contentType: 'application/json', body: JSON.stringify(reply) })
    }
    if (url.pathname !== MICROSOFT_FORM_PATH) return fulfil(route, { status: 200, body: '' }) // the captcha frame, assets
    const name = url.searchParams.get('id')
    // The id names a fixture file, so it is checked before it is joined into a path.
    if (name === null || !FORM_ID.test(name)) return fulfil(route, html('no such form', 400))
    if (fx.signedOut.has(name)) {
      const location = `https://login.microsoftonline.com/common/oauth2/authorize?redirect_uri=${encodeURIComponent(microsoftUrl(name))}`
      return fulfil(route, html(`<!doctype html><script>location.replace(${JSON.stringify(location)})</script>`))
    }
    const delay = fx.delayMs.get(name)
    if (delay !== undefined) await sleep(delay)
    let page: string
    try {
      page = await fixtureFile('microsoft', `${name}.html`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return fulfil(route, html(`no fixture ${name}`, 404))
    }
    await fulfil(route, html(page))
    const count = (loads.get(name) ?? 0) + 1
    loads.set(name, count)
    fx.onFormLoad?.(name, count)
  })
  // Look-alikes: a page that looks like the attendance form on a host that is not a form host, or on plain http. The
  // driver must treat each one as not a form. They are not provider requests, so they are not recorded.
  const decoy = async (route: Route) => {
    const page = new URL(route.request().url()).pathname === MICROSOFT_FORM_PATH
    return fulfil(route, page ? html(await fixtureFile('microsoft', 'attendance.html')) : { status: 200, body: '' })
  }
  await context.route('https://forms.office.com.evil.test/**', decoy)
  await context.route('http://forms.office.com/**', decoy)
  await context.route('https://login.microsoftonline.com/**', async (route) =>
    fulfil(route, html(await fixtureFile('microsoft', 'signin.html')))
  )
  await context.route('https://www.google.com/**', (route) => fulfil(route, { status: 200, body: '' }))
  return fx
}
