import { expect, type Page } from '@playwright/test'
import { ensureMeetLayout, meetParticipantCount, meetSharedScreenRegion } from '../../src/adapters/meet/layout'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { readMeetRoles } from '../../src/adapters/meet/roles'
import { meetClicks, meetForbiddenClicks, serveMeet, setMeetScene, test } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one (plan 05 task 10 checks it live).
const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const base = { scene: 'meeting', mic: 'off', camera: 'off' } as const
const share = {
  box: { x: 0, y: 0, width: 1440, height: 900 },
  width: 1440,
  height: 1080
}

// The fixture's video gets its size from the canvas stream a moment after the page loads.
const shareReady = (page: Page) =>
  page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-is-presentation='true'] video")
    return video !== null && video.videoWidth > 0
  })

test.use({ viewport: { width: 1920, height: 1080 } })

test('reads the participant count from the badge with chat left open', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'chat', peopleCount: 57 })
  await page.goto(MEET)
  expect(await meetParticipantCount(page, sel)).toBe(57)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
  expect(await meetClicks(page)).toEqual([])
  expect(await meetForbiddenClicks(page)).toEqual([])
  await setMeetScene(page, 'meeting', { peopleCount: null })
  expect(await meetParticipantCount(page, sel)).toBeNull()
})

test('reopens chat when the people list took the panel', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'people', share: null })
  await page.goto(MEET)
  await ensureMeetLayout(page, sel)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
  expect(await meetClicks(page)).toEqual(['Chat with everyone'])
  expect(await meetForbiddenClicks(page)).toEqual([])
})

test('turns captions off and spotlights a share once', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    sidePanel: 'chat',
    captions: 'the QR code is at the bottom',
    share
  })
  await page.goto(MEET)
  await ensureMeetLayout(page, sel)
  await ensureMeetLayout(page, sel)
  expect(await meetClicks(page)).toEqual(['Turn off captions', 'More options', 'Adjust view', 'Spotlight', 'Close'])
  expect(await meetForbiddenClicks(page)).toEqual([])
  await expect(page.locator(sel.selectors.captionsRegion)).toHaveCount(0)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test("Close is the Adjust view dialog's own, not another dialog's", async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'chat', share, otherDialog: true })
  await page.goto(MEET)
  await shareReady(page)
  await ensureMeetLayout(page, sel)
  expect(await meetClicks(page)).toEqual(['More options', 'Adjust view', 'Spotlight', 'Close'])
  expect(await meetForbiddenClicks(page)).toEqual([])
  await expect(page.getByText('Meeting details')).toBeVisible()
  await expect(page.getByText('Spotlight')).toHaveCount(0)
})

test('a layout change queued behind a role read leaves both intact', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    sidePanel: 'chat',
    people: [{ name: 'Ms Tan', label: 'Host' }, { name: 'Ali' }],
    captions: 'the QR code is at the bottom',
    share
  })
  await page.goto(MEET)
  await shareReady(page)
  const [roles] = await Promise.all([readMeetRoles(page, sel), ensureMeetLayout(page, sel)])
  expect([...roles.entries()]).toEqual([
    ['ms tan', 'host'],
    ['ali', 'participant']
  ])
  expect(await meetClicks(page)).toEqual([
    'People',
    'Chat with everyone',
    'Turn off captions',
    'More options',
    'Adjust view',
    'Spotlight',
    'Close'
  ])
  expect(await meetForbiddenClicks(page)).toEqual([])
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test('the shared-screen region is the picture inside the letterbox', async ({ page }) => {
  await serveMeet(page, { ...base, share })
  await page.goto(MEET)
  await shareReady(page)
  expect(await meetSharedScreenRegion(page, sel)).toEqual({
    x: 120,
    y: 0,
    width: 1200,
    height: 900
  })
  await setMeetScene(page, 'meeting', { share: null })
  expect(await meetSharedScreenRegion(page, sel)).toBeNull()
})
