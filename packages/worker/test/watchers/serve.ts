import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Route } from 'playwright'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')

/** One message of the Discord fixture. `href` is a link inside the message. */
export interface DiscordMessage {
  id: string
  sender: string
  datetime: string
  text: string
  href?: string
}

export interface DiscordFixture {
  /** The channel's path, `/channels/<server>/<channel>`. Any other channel path redirects to `/channels/@me`. */
  channelPath: string
  messages: DiscordMessage[]
  /** Redirect the channel to `/login`, as a signed-out profile is. */
  loginRequired?: boolean
}

// Task 5 adds `whatsapp?: WhatsAppFixture`; plan 04 adds `teams?`.
export interface WatcherFixtures {
  discord?: DiscordFixture
}

/** What the fixture pages put on `window`. Cast to it in `page.evaluate`: other specs declare their own `__fixture`. */
export interface DiscordWindow {
  __fixture: DiscordFixture
  __addMessage: (m: DiscordMessage) => void
  __touched?: boolean
}

const page = async (route: Route, file: string) =>
  route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: await readFile(join(fixtures, file), 'utf8')
  })

const redirect = (route: Route, path: string) =>
  route.fulfill({ status: 302, headers: { location: `https://discord.com${path}` } })

/**
 * Serves the chat-app fixture pages on their real host names (`context.route`), so a watcher's own URL rules run
 * unchanged. Each page gets its fixture as `window.__fixture` from an init script.
 */
export async function serveWatcherFixtures(context: BrowserContext, f: WatcherFixtures): Promise<void> {
  const { discord } = f
  if (discord === undefined) return
  await context.addInitScript((fixture) => {
    ;(window as unknown as DiscordWindow).__fixture = fixture
  }, discord)
  await context.route('https://discord.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/login') return page(route, 'discord/login.html')
    if (path === discord.channelPath)
      return discord.loginRequired ? redirect(route, '/login') : page(route, 'discord/channel.html')
    if (path === '/channels/@me')
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Discord</title>' })
    if (path.startsWith('/channels/')) return redirect(route, '/channels/@me')
    return route.fulfill({ status: 404, body: '' })
  })
}
