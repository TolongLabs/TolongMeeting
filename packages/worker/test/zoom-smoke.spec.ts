import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test as base, type Page, type Route } from '@playwright/test'
import { runSmokeEntry } from '../src/smoke/run'
import { zoomSmoke } from '../src/smoke/zoom'

// Runs against test/fixtures/zoom-meeting-top.html, an imitation of the Zoom web client that has NOT been checked
// against the real one. The route serves it for the standing test meeting's link, so the smoke entry sees a meeting
// page at a zoom.us address.
const MEETING_URL = 'https://zoom.us/j/1234567890'
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8')
const MEETING = fixture('zoom-meeting-top.html')
const SCRIPT = fixture('fixture.js')

async function serveZoom(page: Page, edit: (html: string) => string = (html) => html): Promise<void> {
  await page.route('https://zoom.us/**', async (route: Route) => {
    if (route.request().url().endsWith('/fixture.js')) {
      return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: SCRIPT })
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: edit(MEETING) })
  })
}

const forbiddenClicks = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __fixture?: { forbiddenClicks: string[] } }).__fixture?.forbiddenClicks ?? []
  )
const clicks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fixture?: { clicks: string[] } }).__fixture?.clicks ?? [])

// Every test ends with an empty forbidden-click log: the smoke run never clicks the microphone, camera, share or chat.
const test = base.extend<{ noForbiddenClicks: undefined }>({
  noForbiddenClicks: [
    async ({ page }, use) => {
      await use(undefined)
      if (!page.isClosed()) expect(await forbiddenClicks(page)).toEqual([])
    },
    { auto: true }
  ]
})

test.use({ viewport: { width: 1920, height: 1080 } })

test('passes on the meeting imitation', async ({ page }) => {
  await serveZoom(page)
  expect(await runSmokeEntry(page, zoomSmoke, MEETING_URL)).toEqual({ missing: [] })
})

// The join keeps polling for an in-meeting control until its 60 s deadline, so this case takes about a minute.
test('fails loudly, naming the key, when the leave button is gone', async ({ page }) => {
  test.setTimeout(120_000)
  await serveZoom(page, (html) => html.replace('aria-label="Leave"', 'aria-label="Exit"'))
  expect((await runSmokeEntry(page, zoomSmoke, MEETING_URL)).missing).toContain('leaveButton')
})

test('leaves at once when a device is on, and reads nothing else', async ({ page }) => {
  test.setTimeout(120_000)
  // The microphone button reads "Mute my microphone": the microphone is live.
  await serveZoom(page, (html) => html.replace('aria-label="audio"', 'aria-label="Mute my microphone"'))
  expect((await runSmokeEntry(page, zoomSmoke, MEETING_URL)).missing).toEqual(['step:assertDevicesOff'])
  const done = await clicks(page)
  expect(done.at(-1)).toBe('leave meeting')
  // Joining the audio, the layout and the chat sweep come after the device check: none of them ran.
  expect(done).not.toContain('join audio by computer')
})

test('refuses a link that is not a zoom link', async ({ page }) => {
  await expect(runSmokeEntry(page, zoomSmoke, 'https://teams.microsoft.com/l/meetup-join/x/0')).rejects.toThrow(
    'the smoke link is not a zoom link'
  )
})
