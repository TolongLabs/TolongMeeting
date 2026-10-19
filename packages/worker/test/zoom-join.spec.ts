import { expect, test } from '@playwright/test'
import { zoomAdapter } from '../src/adapters/zoom'
import { zoomJoin } from '../src/adapters/zoom/join'

declare global {
  interface Window {
    __fixture: { clicks: string[]; typedName: string }
  }
}

const inMs = (ms: number) => new Date(Date.now() + ms)

for (const root of ['top', 'iframe'])
  test(`guest join through two device prompts (${root})`, async ({ page }) => {
    await page.goto(`/zoom-prejoin.html?then=meeting-${root}`)
    expect(await zoomAdapter.join(page, { guestName: 'Member Guest' })).toEqual({ kind: 'in_meeting' })
    expect(await page.evaluate(() => [window.__fixture.clicks, window.__fixture.typedName])).toEqual([
      ['continue', 'continue', 'join'],
      'Member Guest'
    ])
    await zoomAdapter.assertDevicesOff(page)
  })

test('signed-in join keeps the prefilled name', async ({ page }) => {
  await page.goto('/zoom-prejoin.html?then=meeting-top&signedin=1')
  expect(await zoomAdapter.join(page, { guestName: 'Member Guest' })).toEqual({ kind: 'in_meeting' })
  expect(await page.evaluate(() => window.__fixture.typedName)).toBe('')
})

test('lobby, sign-in, busy account and missing name are distinct results', async ({ page }) => {
  await page.goto('/zoom-prejoin.html?then=lobby')
  expect(await zoomAdapter.join(page, { guestName: 'G' })).toEqual({ kind: 'lobby' })
  await page.goto('/zoom-signin.html')
  expect(await zoomAdapter.join(page, { guestName: 'G' })).toEqual({ kind: 'signin_required', host: 'localhost' })
  await page.goto('/zoom-busy.html')
  expect(await zoomAdapter.join(page, { guestName: 'G' })).toEqual({ kind: 'account_busy' })
  await page.goto('/zoom-prejoin.html?then=meeting-top')
  expect(await zoomAdapter.join(page, { guestName: null })).toEqual({ kind: 'failed', reason: 'name_required' })
})

test('a name the page wipes is name_not_set and Join is never clicked', async ({ page }) => {
  await page.goto('/zoom-prejoin.html?then=meeting-top&refuse=1')
  expect(await zoomAdapter.join(page, { guestName: 'Member Guest' })).toEqual({
    kind: 'failed',
    reason: 'name_not_set'
  })
  expect(await page.evaluate(() => window.__fixture.clicks)).toEqual(['continue', 'continue'])
})

test('a device prompt that never goes away is clicked 3 times, then prejoin_timeout', async ({ page }) => {
  await page.goto('/zoom-prejoin.html?then=meeting-top&loop=1')
  const started = Date.now()
  expect(await zoomJoin(page, { guestName: 'Member Guest', timeoutMs: 4_000 })).toEqual({
    kind: 'failed',
    reason: 'prejoin_timeout'
  })
  expect(await page.evaluate(() => window.__fixture.clicks)).toEqual(['continue', 'continue', 'continue'])
  // The poll steps are cut to the deadline: no step runs a 10 s timeout past it.
  expect(Date.now() - started).toBeLessThan(6_000)
})

test('a page with nothing to do ends as prejoin_timeout on time', async ({ page }) => {
  await page.goto('/forms-home.html')
  const started = Date.now()
  expect(await zoomJoin(page, { guestName: 'G', timeoutMs: 2_000 })).toEqual({
    kind: 'failed',
    reason: 'prejoin_timeout'
  })
  expect(Date.now() - started).toBeLessThan(4_000)
})

test('admission outcomes', async ({ page }) => {
  await page.goto('/zoom-lobby.html?admit=2000')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(10_000))).toBe('admitted')
  await page.goto('/zoom-lobby.html?deny=1000')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(10_000))).toBe('lobby_denied')
  await page.goto('/zoom-lobby.html?end=1000')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(10_000))).toBe('lobby_denied')
  await page.goto('/zoom-lobby.html')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(3_000))).toBe('lobby_expired')
})

test('devices on fail loudly; leave confirms', async ({ page }) => {
  await page.goto('/zoom-devices-on.html')
  await expect(zoomAdapter.assertDevicesOff(page)).rejects.toMatchObject({
    name: 'DevicesOnError',
    labels: ['mute my microphone', 'stop my video']
  })
  await page.goto('/zoom-meeting-top.html')
  await zoomAdapter.leave(page)
  expect(await page.evaluate(() => window.__fixture.clicks)).toEqual(['leave', 'leave meeting'])
})
