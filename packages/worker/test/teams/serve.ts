import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'

declare global {
  interface Window {
    __cfg: TeamsFixtureConfig
    __clicks: string[]
    __forbidden: string[]
    __scene: (scene: TeamsScene, patch?: Partial<TeamsFixtureConfig>) => void
    __addMessage: (message: FixtureMessage) => void
    __addRoster: (participant: { name: string; role?: string }) => void
  }
}

export type TeamsScene =
  | 'launcher'
  | 'prejoin'
  | 'prejoin-anonymous'
  | 'prejoin-permissions'
  | 'signin'
  | 'device-blocked'
  | 'invalid'
  | 'lobby'
  | 'lobby-denied'
  | 'lobby-expired'
  | 'meeting'
  | 'ended'
  | 'left'
  | 'removed'
  | 'blank'

export interface FixtureMessage {
  id: string
  sender: string
  time: string
  datetime: string
  text: string
  href?: string
}

export interface FixtureRect {
  x: number
  y: number
  width: number
  height: number
}

// What the imitation page does. Only `scene` is required; app.html fills the rest in (devices off, computer audio, no
// chat, no notices, nothing shared). The page is an UNVERIFIED imitation of the Teams web client.
export interface TeamsFixtureConfig {
  scene: TeamsScene
  mic?: 'on' | 'off'
  camera?: 'on' | 'off'
  audio?: 'computer' | 'none'
  // The scene "Continue on this browser" and "Join now" lead to.
  afterLauncher?: TeamsScene
  afterJoin?: TeamsScene
  // A pre-join toggle that ignores clicks.
  stuck?: 'none' | 'camera' | 'mic'
  breakout?: 'none' | 'prompt' | 'moved'
  chatOpen?: boolean
  messages?: FixtureMessage[]
  chatScroll?: 'top' | 'bottom'
  roster?: { name: string; role?: string }[]
  notices?: { role: 'dialog' | 'alert' | 'status'; text: string; button: string }[]
  incomingAudioOff?: boolean
  organiser?: boolean
  peopleCount?: number | null
  share?: { box: FixtureRect; width: number; height: number } | null
  // Selectors whose elements the fixture leaves out.
  omit?: string[]
}

const APP = readFileSync(fileURLToPath(new URL('../fixtures/teams/app.html', import.meta.url)), 'utf8')
const SIGNIN = readFileSync(fileURLToPath(new URL('../fixtures/teams/signin.html', import.meta.url)), 'utf8')
const ROUTES = {
  app: ['https://teams.microsoft.com/**', 'https://teams.live.com/**'],
  signin: ['https://login.microsoftonline.com/**']
} as const

const served = new WeakMap<Page, { cfg: TeamsFixtureConfig; handlers: [string, (route: Route) => Promise<void>][] }>()

// Serves the Teams imitation on the real host names (teams.microsoft.com, teams.live.com) and the Microsoft sign-in
// imitation on login.microsoftonline.com. Replaces the routes an earlier call set up on this page.
export async function serveTeams(page: Page, cfg: TeamsFixtureConfig): Promise<void> {
  const earlier = served.get(page)
  for (const [url, handler] of earlier?.handlers ?? []) await page.unroute(url, handler)
  const state: { cfg: TeamsFixtureConfig; handlers: [string, (route: Route) => Promise<void>][] } = {
    cfg: { ...cfg },
    handlers: []
  }
  // Escaped so the JSON cannot close the script element.
  const app = async (route: Route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: APP.replace(
        '<head>',
        `<head><script>window.__cfg = ${JSON.stringify(state.cfg).replaceAll('<', '\\u003c')}</script>`
      )
    })
  const signin = async (route: Route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: SIGNIN })
  for (const url of ROUTES.app) state.handlers.push([url, app])
  for (const url of ROUTES.signin) state.handlers.push([url, signin])
  for (const [url, handler] of state.handlers) await page.route(url, handler)
  served.set(page, state)
}

// Switches the open page to another scene, applying `patch`; a later page.goto gets the new configuration too.
export async function setTeamsScene(
  page: Page,
  scene: TeamsScene,
  patch: Partial<TeamsFixtureConfig> = {}
): Promise<void> {
  const state = served.get(page)
  if (!state) throw new Error('serveTeams has not been called for this page')
  Object.assign(state.cfg, patch, { scene })
  await page.evaluate(([next, changes]) => window.__scene(next, changes), [scene, patch] as const)
}

// The controls clicked on the page, in order, by aria-label else text.
export function teamsClicks(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__clicks)
}

// The clicks the worker must never make (the Teams app launcher, in-meeting microphone and camera, share, react, send,
// End meeting, recording, breakout join, admit). A correct run leaves this empty.
export function teamsForbiddenClicks(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__forbidden)
}
