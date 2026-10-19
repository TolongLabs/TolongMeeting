import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BrowserContext, Route } from '@playwright/test'

// The selector maps the drivers load; set here so a spec that imports this helper needs no environment.
process.env.TM_SELECTORS_DIR ??= resolve(import.meta.dirname, '../../../../config/selectors')

const FIXTURES = resolve(import.meta.dirname, '../fixtures/forms')
const GOOGLE_PATH = /^\/forms\/d\/e\/([^/]+)\/(viewform|formResponse|fixture\.js)$/

export interface FixtureServer {
  requests: string[] // every form-provider URL requested
  submissions: {
    fixture: string
    answers: Record<string, string | string[]>
    sendCopy: boolean
  }[]
  signedOut: Set<string> // fixture names whose form URL redirects to the provider's sign-in page
  // What formResponse serves: the provider's pages, or (to test an unconfirmed submit) the form again or a captcha
  submitResult: Map<string, 'confirmation' | 'already-responded' | 'still-form' | 'captcha'>
  delayMs: Map<string, number> // delay before serving a fixture
  onFormLoad: ((fixture: string, count: number) => void) | null
}

export const googleUrl = (fixture: string): string => `https://docs.google.com/forms/d/e/${fixture}/viewform`
export const microsoftUrl = (fixture: string): string =>
  `https://forms.office.com/Pages/ResponsePage.aspx?id=${fixture}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixtureFile(provider: 'google', name: string): Promise<string> {
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
  await context.route('https://www.google.com/**', (route) => fulfil(route, { status: 200, body: '' }))
  return fx
}
