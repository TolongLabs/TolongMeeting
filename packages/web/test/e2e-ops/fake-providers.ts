// Stand-ins for GitHub, Google and Notion, for the spec. One local server answers all three under a path each
// (`/github`, `/google-oauth`, `/google-api`, `/notion`); `preload.ts` points the site's calls at it.
import { GITHUB_REPO, GITHUB_TOKEN, GOOGLE_ACCESS_TOKEN, GOOGLE_FOLDER, NOTION_PARENT } from './state'

const json = (body: unknown, status = 200) => Response.json(body, { status })

function github(request: Request, path: string): Response {
  if (request.headers.get('authorization') !== `Bearer ${GITHUB_TOKEN}`) return json({}, 401)
  const repo = `/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}`
  if (path === repo) return json({})
  if (path === `${repo}/branches/${GITHUB_REPO.branch}`) return json({})
  return json({}, 404)
}

function googleOAuth(path: string): Response {
  if (path === '/token') return json({ access_token: GOOGLE_ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' })
  return new Response('', { status: 200 })
}

function googleApi(path: string): Response {
  // The search for the default folder finds it.
  if (path === '/drive/v3/files')
    return json({ files: [{ id: 'DEFAULT_FOLDER_0123456789', name: 'TolongMeeting Exports' }] })
  if (path === `/drive/v3/files/${GOOGLE_FOLDER.id}`)
    return json({
      id: GOOGLE_FOLDER.id,
      name: GOOGLE_FOLDER.name,
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canAddChildren: true }
    })
  return json({}, 404)
}

const notionPage = {
  object: 'page',
  id: NOTION_PARENT.id,
  properties: { title: { type: 'title', title: [{ plain_text: NOTION_PARENT.name }] } }
}

async function notion(request: Request, path: string): Promise<Response> {
  if (path === '/v1/search') {
    const body = (await request.json()) as { filter: { value: string } }
    return json({ object: 'list', results: body.filter.value === 'page' ? [notionPage] : [], has_more: false })
  }
  if (path === `/v1/pages/${NOTION_PARENT.id}`) return json(notionPage)
  return json({}, 404)
}

/** The fake providers on a free local port. Stop it with `server.stop(true)`. */
export function startFakeProviders() {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const [, service = '', ...rest] = url.pathname.split('/')
      const path = `/${rest.join('/')}`
      if (service === 'github') return github(request, path)
      if (service === 'google-oauth') return googleOAuth(path)
      if (service === 'google-api') return googleApi(path)
      if (service === 'notion') return notion(request, path)
      return json({}, 404)
    }
  })
}
