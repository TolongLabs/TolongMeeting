import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test as base, type Page, type Route } from '@playwright/test'
import type { Rect } from '../../src/adapters/types'

// A stand-in for the Meet web client on https://meet.google.com/** and for Google sign-in on accounts.google.com, by
// route interception (precedent: test/forms/route.ts). The pages are guesses built from config/selectors/meet.json and
// are NOT verified against the real client; see the header of fixtures/meet/app.html.

const FIXTURES = resolve(import.meta.dirname, '../fixtures/meet')
const MEET = 'https://meet.google.com/**'
const ACCOUNTS = 'https://accounts.google.com/**'
const TASK_SCRIPT = /^\/__tm\/([a-z-]+\.js)$/ // app.html loads join.js, state.js, controls.js, chat.js, layout.js from here

export type MeetScene =
  | 'prejoin'
  | 'prejoin-anonymous'
  | 'prejoin-permissions'
  | 'signin'
  | 'blocked'
  | 'invalid'
  | 'lobby'
  | 'lobby-review'
  | 'lobby-denied'
  | 'lobby-expired'
  | 'meeting'
  | 'ended'
  | 'left'
  | 'removed'
  | 'blank'

export interface MeetFixtureMessage {
  id: string
  sender: string
  time: string
  text: string
  href?: string
}

export interface MeetFixtureNotice {
  role: 'dialog' | 'alert'
  text: string
  button: string
}

// Every optional field of every plan 05 task (3 to 9); the defaults live in app.html. Arrays are readonly so that
// `as const` literals are accepted.
export interface MeetFixtureConfig {
  scene: MeetScene
  mic?: 'on' | 'off' | 'denied' // 'denied': the permission-denied button, without data-is-muted (P5-12)
  camera?: 'on' | 'off' | 'denied'
  joinAs?: 'join-now' | 'ask' | 'other-device' // pre-join: which join buttons show
  afterJoin?: MeetScene // where a join button leads; default meeting (Join now, Join here too) or lobby (Ask to join)
  breakout?: boolean // a "join breakout room" prompt in the meeting
  sidePanel?: 'chat' | 'people' | 'closed'
  messages?: readonly MeetFixtureMessage[]
  captions?: string | null // a Captions region with this text; its toolbar toggle is layout.js's
  notices?: readonly MeetFixtureNotice[]
  host?: boolean // Leave opens an "End the call for everyone" dialog (controls.js)
  audioElements?: number // <audio> elements in the meeting scene; default 2
  chatScroll?: 'top' | 'bottom' // where the chat list starts; it stays put when messages arrive
  people?: readonly { name: string; label?: string }[]
  tiles?: readonly string[] // names on participant tiles in the meeting scene
  mutedDecoy?: boolean // a participant's muted-microphone indicator that matches the microphone selectors
  otherDialog?: boolean // a second dialog with its own Close button, ahead of Adjust view (layout.js)
  peopleCount?: number | null // badge inside the People button (layout.js)
  share?: { box: Rect; width: number; height: number } | null // a screen share (layout.js)
  omit?: readonly string[] // selectors whose elements the fixture leaves out
}

// The config each page is currently serving, so a reload shows what setMeetScene last set.
const served = new WeakMap<Page, MeetFixtureConfig>()

const ignoreClosed = (error: unknown): void => {
  if (!/closed|disposed/i.test(String(error))) throw error
}

// Put the config where app.html reads it. Inserted after <head>, so the doctype stays first.
function withConfig(appHtml: string, cfg: MeetFixtureConfig): string {
  const json = JSON.stringify(cfg).replaceAll('<', '\\u003c')
  return appHtml.replace('<head>', () => `<head><script>window.__cfg = ${json}</script>`)
}

/** Serve the fixture on meet.google.com and accounts.google.com; replaces the routes of an earlier call. */
export async function serveMeet(page: Page, cfg: MeetFixtureConfig): Promise<void> {
  const [appHtml, signinHtml] = await Promise.all([
    readFile(join(FIXTURES, 'app.html'), 'utf8'),
    readFile(join(FIXTURES, 'signin.html'), 'utf8')
  ])
  if (!appHtml.includes('<head>')) throw new Error('fixtures/meet/app.html has no <head> to put the config in')
  served.set(page, cfg)
  await page.unroute(MEET)
  await page.unroute(ACCOUNTS)
  await page.route(MEET, async (route: Route) => {
    const request = route.request()
    const script = TASK_SCRIPT.exec(new URL(request.url()).pathname)
    const reply = script
      ? route.fulfill({
          contentType: 'text/javascript',
          body: await readFile(join(FIXTURES, script[1]!), 'utf8')
        })
      : request.resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: withConfig(appHtml, served.get(page)!) })
        : route.fulfill({ status: 204 })
    await reply.catch(ignoreClosed)
  })
  await page.route(ACCOUNTS, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: signinHtml }).catch(ignoreClosed)
  )
}

/** Switch the open page to `scene` without reloading, optionally changing config fields at the same time. */
export async function setMeetScene(
  page: Page,
  scene: MeetScene,
  patch: Partial<MeetFixtureConfig> = {}
): Promise<void> {
  const current = served.get(page)
  if (current === undefined) throw new Error('setMeetScene called before serveMeet')
  served.set(page, { ...current, ...patch, scene })
  await page.evaluate(
    ([next, changes]) => (window as unknown as { __scene(scene: string, patch: object): void }).__scene(next, changes),
    [scene, patch] as const
  )
}

/** Labels of the controls clicked since the page loaded (aria-label, else trimmed text), in order. */
export async function meetClicks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)
}

/** Labels of the clicks the worker must never make (join.js keeps the one list). Empty on a page that is not the fixture. */
export async function meetForbiddenClicks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __forbidden?: string[] }).__forbidden ?? [])
}

/** `test` for every Meet spec: when a test ends, the forbidden-click log must be empty (a page the test closed has none). */
export const test = base.extend<{ noForbiddenClicks: undefined }>({
  noForbiddenClicks: [
    async ({ page }, use) => {
      await use(undefined)
      if (!page.isClosed()) expect(await meetForbiddenClicks(page)).toEqual([])
    },
    { auto: true }
  ]
})
