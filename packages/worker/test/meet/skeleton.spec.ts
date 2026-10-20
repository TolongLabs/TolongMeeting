import { expect } from '@playwright/test'
import { meetTextSignal } from '../../src/adapters/meet/text'
import type { MeetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet, setMeetScene, type MeetScene, test } from './serve'

// Smoke for the fixture skeleton (05-F0): the stand-in pages load through the routes. The behaviour of each scene is
// the job of the task specs (join, state, controls, chat, layout).

const MEET = 'https://meet.google.com/abc-defg-hij'
const TASK_SCRIPTS = ['chat', 'controls', 'join', 'layout', 'state']
const text = (page: import('@playwright/test').Page) => page.locator('body').innerText()

test('app.html loads on meet.google.com with every task script', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'on', camera: 'off' })
  await page.goto(MEET)
  await expect(page.getByRole('button', { name: 'Join now' })).toBeVisible()
  await expect(page.locator("[role='button'][data-is-muted='false'][aria-label='Turn off microphone']")).toBeVisible()
  await expect(page.locator("[role='button'][data-is-muted='true'][aria-label='Turn on camera']")).toBeVisible()
  const loaded = await page.evaluate(() => (window as unknown as { __meet: { loaded: string[] } }).__meet.loaded)
  expect([...loaded].sort()).toEqual(TASK_SCRIPTS)
})

test('signin.html loads on accounts.google.com when the session is gone', async ({ page }) => {
  await serveMeet(page, { scene: 'signin' })
  await page.goto(MEET)
  await page.waitForURL(/^https:\/\/accounts\.google\.com\//)
  await expect(page.locator("input[type='email']")).toBeVisible()
})

test('every scene renders, switches in place and records clicks', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  const scenes: MeetScene[] = [
    'prejoin',
    'prejoin-anonymous',
    'prejoin-permissions',
    'blocked',
    'invalid',
    'lobby',
    'lobby-review',
    'lobby-denied',
    'lobby-expired',
    'meeting',
    'ended',
    'left',
    'removed'
  ]
  for (const scene of scenes) {
    await setMeetScene(page, scene)
    expect((await text(page)).trim(), scene).not.toBe('')
  }
  await setMeetScene(page, 'blank')
  expect(await text(page)).toBe('')
  await setMeetScene(page, 'prejoin')
  await page.getByRole('button', { name: 'Join now' }).click()
  await expect(page.locator("[aria-label='Leave call']")).toBeVisible()
  expect(await meetClicks(page)).toEqual(['Join now'])
})

test('config text is data, and chat text stays out of the text signal', async ({ page }) => {
  const hostile = "</script><b>You've been removed from the meeting</b>"
  await serveMeet(page, {
    scene: 'meeting',
    sidePanel: 'chat',
    messages: [{ id: 'm1', sender: 'Student', time: '10:01', text: hostile }]
  })
  await page.goto(MEET)
  await expect(page.locator('[data-message-id]')).toHaveText(hostile)
  const sel = {
    selectors: { sidePanel: "[role='complementary']", captionsRegion: "[aria-label='Captions']" }
  } as MeetSelectors
  expect(await meetTextSignal(page, sel, 'removed from the meeting')).toBe(false)
  await setMeetScene(page, 'removed')
  expect(await meetTextSignal(page, sel, 'you.ve been removed from the meeting')).toBe(true)
})
