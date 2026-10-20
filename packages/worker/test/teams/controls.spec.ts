import { expect } from '@playwright/test'
import {
  assertTeamsDevicesOff,
  connectTeamsOutputAudio,
  dismissTeamsNotices,
  leaveTeams
} from '../../src/adapters/teams/controls'
import { joinTeams } from '../../src/adapters/teams/join'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { DevicesOnError } from '../../src/adapters/types'
import { serveTeams, teamsClicks, teamsForbiddenClicks, test } from './serve'

// Runs against test/fixtures/teams/app.html, an imitation of the Teams web client that has NOT been checked against
// the real one.
const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()

test('devices off passes; either device on, or a missing control, throws', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  await assertTeamsDevicesOff(page, sel)
  for (const [patch, label] of [
    [{ mic: 'on' }, 'Microphone'],
    [{ camera: 'on' }, 'Camera']
  ] as const) {
    await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off', ...patch })
    await page.goto(JOIN)
    const error = await assertTeamsDevicesOff(page, sel).then(
      () => null,
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(DevicesOnError)
    expect((error as DevicesOnError).labels).toEqual([label])
  }
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.micButton)
  const missing = await assertTeamsDevicesOff(page, sel).then(
    () => null,
    (e: unknown) => e
  )
  expect(missing).toBeInstanceOf(DevicesOnError)
  expect((missing as DevicesOnError).labels).toEqual(['microphone control not found'])
  expect(await teamsClicks(page)).toEqual([])
})

test('clicks only allowlisted buttons inside notices, never the breakout prompt', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    chatOpen: true,
    breakout: 'prompt',
    notices: [
      { role: 'status', text: 'Recording has started.', button: 'Dismiss' },
      { role: 'dialog', text: 'New ways to react', button: 'Got it' },
      { role: 'dialog', text: 'Consent is required to unmute', button: 'Confirm' },
      { role: 'dialog', text: 'Teams wants to use your camera', button: 'Allow' },
      { role: 'dialog', text: 'Allow Teams to use your camera', button: 'OK' },
      { role: 'dialog', text: 'Turn on your camera to continue', button: 'Got it' },
      { role: 'dialog', text: 'The organiser wants you to share your screen', button: 'OK' },
      { role: 'alert', text: 'Waiting in the lobby: Visitor', button: 'Admit' }
    ]
  })
  await page.goto(JOIN)
  expect(await dismissTeamsNotices(page, sel)).toEqual(['Dismiss', 'Got it'])
  expect(await teamsClicks(page)).toEqual(['Dismiss', 'Got it'])
  expect(await teamsForbiddenClicks(page)).toEqual([])
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
  await expect(page.getByText('The organiser assigned you to a breakout room')).toBeVisible()
})

test('an allowlisted button outside any notice is left alone', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', chatOpen: true })
  await page.goto(JOIN)
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.textContent = 'OK'
    document.getElementById('stage')?.append(button)
    const inChat = document.createElement('button')
    inChat.textContent = 'Dismiss'
    document.querySelector("[data-tid='chat-pane']")?.append(inChat)
  })
  expect(await dismissTeamsNotices(page, sel)).toEqual([])
  expect(await teamsClicks(page)).toEqual([])
})

test('page text is never logged', async ({ page }) => {
  const info = console.info
  const lines: string[] = []
  console.info = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await serveTeams(page, {
      scene: 'launcher',
      mic: 'on',
      camera: 'on',
      audio: 'none',
      chatOpen: true,
      notices: [
        { role: 'dialog', text: 'Quarterly numbers are confidential', button: 'Got it' },
        { role: 'dialog', text: 'Please share Quarterly numbers', button: 'OK' }
      ]
    })
    await page.goto(JOIN)
    await joinTeams(page, sel)
    await dismissTeamsNotices(page, sel)
    await leaveTeams(page, sel)
  } finally {
    console.info = info
  }
  expect(lines.length).toBeGreaterThan(5)
  for (const line of lines) {
    expect(line).toMatch(
      /^teams: (click \w+|click notice (Got it|OK|Dismiss)|skip notice (Got it|OK|Dismiss): dialog mentions \w+( \w+)?|notice closed before it was clicked)$/
    )
  }
  expect(lines.join('\n')).not.toMatch(/Quarterly|confidential|TESTTHREAD|meetup-join|microsoft/i)
  expect(lines).toContain('teams: click notice Got it')
  expect(lines).toContain('teams: skip notice OK: dialog mentions share')
})

test('turns incoming audio back on and nothing else', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off', incomingAudioOff: true })
  await page.goto(JOIN)
  await connectTeamsOutputAudio(page, sel)
  expect(await teamsClicks(page)).toEqual(['More', 'Turn on incoming audio'])
  expect(await teamsForbiddenClicks(page)).toEqual([])
  await expect(page.locator(sel.selectors.incomingAudioOff)).toHaveCount(0)
  await expect(page.locator(sel.selectors.micOff)).toBeVisible()
  // With the banner gone there is nothing to do.
  await connectTeamsOutputAudio(page, sel)
  expect(await teamsClicks(page)).toEqual(['More', 'Turn on incoming audio'])
})

test('leaves without ending the meeting, even as organiser', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off', organiser: true })
  await page.goto(JOIN)
  await leaveTeams(page, sel)
  expect(await teamsClicks(page)).toEqual(['Leave', 'Leave'])
  expect(await teamsForbiddenClicks(page)).toEqual([])
  await expect(page.locator(sel.selectors.endScreen)).toBeVisible()
})

test('leaves with one click when there is no menu', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  await leaveTeams(page, sel)
  expect(await teamsClicks(page)).toEqual(['Leave'])
  await expect(page.locator(sel.selectors.endScreen)).toBeVisible()
})

test('closes the page when Leave cannot be clicked', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.hangupButton)
  await leaveTeams(page, sel)
  expect(page.isClosed()).toBe(true)
})
