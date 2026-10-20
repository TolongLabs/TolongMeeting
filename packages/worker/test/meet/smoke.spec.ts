import { expect } from '@playwright/test'
import { runSmokeEntry } from '../../src/smoke/run'
import { meetSmoke } from '../../src/smoke/meet'
import { serveMeet, test } from './serve'

// Runs against test/fixtures/meet/app.html, an imitation of the Meet web client that has NOT been checked against the
// real one. The `test` from serve.ts fails any case that clicked a control the worker must never touch.
const URL = 'https://meet.google.com/abc-defg-hij'
const cfg = {
  scene: 'prejoin',
  mic: 'off',
  camera: 'off',
  joinAs: 'join-now',
  sidePanel: 'closed',
  people: [{ name: 'Member' }]
} as const

test('passes on the full imitation', async ({ page }) => {
  await serveMeet(page, cfg)
  expect(await runSmokeEntry(page, meetSmoke, URL)).toEqual({ missing: [] })
})

// With the chat button gone, the steps after the chat checkpoint each wait out their own timeout, about 35 s in all.
test('fails loudly, naming the key, when the chat button is gone', async ({ page }) => {
  test.setTimeout(120_000)
  await serveMeet(page, { ...cfg, omit: ["[aria-label='Chat with everyone']"] })
  expect((await runSmokeEntry(page, meetSmoke, URL)).missing).toContain('chatButton')
})
