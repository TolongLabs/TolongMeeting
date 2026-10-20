import type { AccountCheckData, FormProvider } from '@tm/core'
import type { Page } from 'playwright'
import { teamsSelectors } from '../adapters/teams/selectors'
import { textPattern, zoomSelectors } from '../adapters/zoom/selectors'
import { checkFormProviders } from '../forms/provider-check'
import { discordSelectors, whatsappSelectors } from '../watchers/selectors'

// The form providers are checked by the same navigation the meeting run uses at T-60. The other kinds are read from
// the tabs the sign-in session opened, which the member has just used: nothing is navigated, so a page the member
// closed is unknown rather than a fresh load that could sign the tab out.
const FORM_PROVIDERS: FormProvider[] = ['google', 'microsoft']
const CHECKED_KINDS = ['zoom', 'teams', 'whatsapp', 'discord'] as const
type CheckedKind = (typeof CHECKED_KINDS)[number]

const READ_TIMEOUT_MS = 3_000
const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.live.com']

/** True signed in, false signed out, null when the page cannot tell (unknown: it is left out of the report). */
type Verdict = boolean | null

const hostOf = (page: Page): string => {
  try {
    return new URL(page.url()).hostname
  } catch {
    return ''
  }
}

const isZoomHost = (host: string): boolean => host === 'zoom.us' || host === 'accounts.zoom.us'

// Zoom has only a negative signal (the `signInRequired` text) and the sign-in page's own URL. A loaded page on
// zoom.us that is not the sign-in page and shows no such text counts as signed in; anything else is unknown.
async function checkZoom(page: Page): Promise<Verdict> {
  const url = new URL(page.url())
  if (!isZoomHost(url.hostname)) return null
  if (url.hostname === 'accounts.zoom.us' || url.pathname.startsWith('/signin')) return false
  const { texts } = await zoomSelectors()
  const text = await page.locator('body').innerText({ timeout: READ_TIMEOUT_MS })
  if (textPattern(texts.signInRequired).test(text)) return false
  return true
}

// The Teams watcher's own rule: a page on a sign-in host is signed out, a page on a Teams host is signed in, and any
// other page is unknown. The tab the session opened starts on teams.microsoft.com and redirects when signed out.
async function checkTeams(page: Page): Promise<Verdict> {
  const { signInHosts } = await teamsSelectors()
  const host = hostOf(page)
  if (signInHosts.includes(host)) return false
  return TEAMS_HOSTS.includes(host) ? true : null
}

// The WhatsApp watcher's own rule: the link-device code means signed out. A page still loading shows neither the code
// nor the chat list, and stays unknown.
async function checkWhatsApp(page: Page): Promise<Verdict> {
  if (hostOf(page) !== 'web.whatsapp.com') return null
  const sel = await whatsappSelectors()
  if ((await page.locator(sel.linkQr).filter({ visible: true }).count()) > 0) return false
  return (await page.locator(sel.chatList).count()) > 0 ? true : null
}

// The Discord watcher's own rule: the login path or the visible login form means signed out. The message list is the
// positive signal; a page still loading has neither and stays unknown.
async function checkDiscord(page: Page): Promise<Verdict> {
  if (hostOf(page) !== 'discord.com') return null
  const sel = await discordSelectors()
  if (new URL(page.url()).pathname.replace(/\/+$/, '') === '/login') return false
  if ((await page.locator(sel.loginForm).filter({ visible: true }).count()) > 0) return false
  return (await page.locator(sel.scroller).count()) > 0 ? true : null
}

async function findPage(account: CheckedKind, pages: readonly Page[]): Promise<Page | null> {
  if (account === 'teams') {
    const { signInHosts } = await teamsSelectors()
    const teams = pages.find((p) => TEAMS_HOSTS.includes(hostOf(p)))
    return teams ?? pages.find((p) => signInHosts.includes(hostOf(p))) ?? null
  }
  const wanted: Record<Exclude<CheckedKind, 'teams'>, string[]> = {
    zoom: ['zoom.us', 'accounts.zoom.us'],
    whatsapp: ['web.whatsapp.com'],
    discord: ['discord.com']
  }
  return pages.find((p) => wanted[account].includes(hostOf(p))) ?? null
}

// One read per kind. A page that has gone, navigated away or cannot be read is unknown: it is never signed in.
async function readKind(account: CheckedKind, page: Page): Promise<Verdict> {
  try {
    switch (account) {
      case 'zoom':
        return await checkZoom(page)
      case 'teams':
        return await checkTeams(page)
      case 'whatsapp':
        return await checkWhatsApp(page)
      case 'discord':
        return await checkDiscord(page)
    }
  } catch (error) {
    console.error(`signin: could not check ${account} (${error instanceof Error ? error.name : 'error'})`)
    return null
  }
}

/**
 * Checks the accounts a sign-in session touched, from the pages it left open. The Google and Microsoft form sign-ins
 * use the meeting run's `checkFormProviders` on the desk anchor. Zoom, Teams, WhatsApp Web and Discord use their own
 * adapter's signed-in rule on the page the session opened for them. A kind whose page is missing or unreadable is left
 * out of the report, which the website reads as not checked (unknown), never as signed in.
 */
export async function checkSigninAccounts(desk: Page, pages: readonly Page[]): Promise<AccountCheckData[]> {
  const open = pages.filter((p) => !p.isClosed())
  const checks: AccountCheckData[] = []
  for (const account of CHECKED_KINDS) {
    const page = await findPage(account, open)
    if (page === null) continue
    const verdict = await readKind(account, page)
    if (verdict !== null) checks.push({ account, signedIn: verdict })
  }
  const signedOut = await checkFormProviders(desk, FORM_PROVIDERS)
  for (const account of FORM_PROVIDERS) checks.push({ account, signedIn: !signedOut.includes(account) })
  return checks
}
