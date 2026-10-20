// Loaded into the site's server process (`bun --preload`, through BUN_OPTIONS: `bun --bun next start` runs the server in a child Bun), for the
// spec only. The site calls GitHub, Google and Notion on their real addresses; this sends those calls to the fake
// providers in `TM_FAKE_PROVIDERS` and refuses any other address outside the machine, so a spec can never reach a real
// provider.
const base = process.env.TM_FAKE_PROVIDERS
if (!base) throw new Error('TM_FAKE_PROVIDERS is not set')

const PROVIDERS = {
  'https://api.github.com': '/github',
  'https://oauth2.googleapis.com': '/google-oauth',
  'https://www.googleapis.com': '/google-api',
  'https://api.notion.com': '/notion'
}

const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const prefix = PROVIDERS[url.origin]
  if (prefix === undefined) {
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(request)
    return Promise.reject(new Error(`The spec's site made a call to ${url.origin}`))
  }
  return realFetch(new Request(`${base}${prefix}${url.pathname}${url.search}`, request))
}
