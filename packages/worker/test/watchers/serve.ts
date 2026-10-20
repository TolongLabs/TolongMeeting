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

/** One message of the WhatsApp fixture. `at` is an ISO time; the page shows it in its own locale. */
export interface WhatsAppMessage {
  id: string
  sender: string
  at: string
  text: string
  href?: string
}

export interface WhatsAppChat {
  name: string
  messages: WhatsAppMessage[]
}

export interface WhatsAppFixture {
  /** `qr` shows only the link-device code, as a profile with no linked phone does. */
  mode: 'chats' | 'qr'
  chats: WhatsAppChat[]
}

// Plan 04 adds `teams?`.
export interface WatcherFixtures {
  discord?: DiscordFixture
  whatsapp?: WhatsAppFixture
}

/** What the fixture pages put on `window`. Cast to it in `page.evaluate`: other specs declare their own `__fixture`. */
export interface DiscordWindow {
  __fixture: DiscordFixture
  __addMessage: (m: DiscordMessage) => void
  __touched?: boolean
}

/** What the WhatsApp fixture page puts on `window`. `__switchChat` is the member opening another chat. */
export interface WhatsAppWindow {
  __fixture: WhatsAppFixture
  __addMessage: (chatName: string, m: WhatsAppMessage) => void
  __switchChat: (name: string) => void
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
  const { discord, whatsapp } = f
  if (discord === undefined && whatsapp === undefined) return
  // Each host's page reads only its own fixture.
  const byHost: Record<string, DiscordFixture | WhatsAppFixture | undefined> = {
    'discord.com': discord,
    'web.whatsapp.com': whatsapp
  }
  await context.addInitScript((fixtures) => {
    const fixture = fixtures[location.hostname]
    if (fixture !== undefined) (window as unknown as { __fixture: unknown }).__fixture = fixture
  }, byHost)
  if (discord !== undefined)
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
  if (whatsapp !== undefined)
    await context.route('https://web.whatsapp.com/**', async (route) =>
      new URL(route.request().url()).pathname === '/'
        ? page(route, 'whatsapp/web.html')
        : route.fulfill({ status: 404, body: '' })
    )
}
