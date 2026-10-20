// A student who takes the lecturer's name and posts a form link is not the host (plan 04 and 05: a name listed twice with
// different roles is `unknown`). The genuine host is trusted first, so the run shows the trust going away when the
// duplicate name appears, not that the harness never trusted anyone. Teams, Meet and Zoom each play it.
//   xvfb-run -a bunx playwright test -c packages/worker/playwright.config.ts --project=e2e --workers=2
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { googleUrl, microsoftUrl } from '../forms/route'
import { HOST, finished, startWorker, until, type Running } from './support/harness'
import { MINUTE, eventsOf, formRecords, formSettled, joinMeeting, pause, useWorld } from './support/checks'
import { meetMeeting, teamsMeeting, ORGANISER, type Meeting } from './support/platforms'

const ctx = useWorld()

interface ChatRow {
  sender: string
  senderRole: string
  text: string
}
const chatRows = async (r: Running): Promise<ChatRow[]> =>
  (await readFile(join(r.dataDir, 'chat.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ChatRow)

// What must hold once the spoofer's link was seen: the form is unsent and untrusted, the member heard of it once with the
// plain form page, and the genuine form went through before.
async function expectSpoofRefused(r: Running, ownerRole: string, spooferRole: string): Promise<void> {
  const { world } = ctx
  expect(r.posts.map((p) => p.provider)).toEqual(['google'])
  const records = Object.fromEntries((await formRecords(r.dataDir)).map((x) => [x.provider, x]))
  expect(records.google).toMatchObject({ state: 'submitted', trustReason: 'host' })
  // The identity belongs to an organisation, so the form was opened to see whether it is limited to it: it is not.
  expect(records.microsoft).toMatchObject({ state: 'untrusted', trustReason: null, reason: 'not_org_restricted' })
  expect(records.microsoft!.submittedAt ?? null).toBeNull()
  const about = world.ntfy.pings.filter((p) => !['Joined: Data Mining', 'Attendance submitted'].includes(p.title))
  expect(about).toHaveLength(1)
  expect(about[0]!.actionUrls).toEqual([microsoftUrl('attendance')])
  const rows = await chatRows(r)
  expect(rows.find((x) => x.text.includes(googleUrl('attendance')))!.senderRole).toBe(ownerRole)
  expect(rows.find((x) => x.text.includes(microsoftUrl('attendance')))!.senderRole).toBe(spooferRole)
}

async function spoofOn(m: Meeting): Promise<void> {
  const { world } = ctx
  test.setTimeout(5 * MINUTE)
  const r = ctx.track(startWorker(world, { link: { kind: 'fixed', url: m.link }, onBrowser: m.prepare }))
  const alive = finished(r)
  await joinMeeting(world, r, () => m.admit(r))

  // The genuine organiser is trusted.
  await m.chat(r, ORGANISER, `Attendance: ${googleUrl('attendance')}`)
  await until('the genuine form submitted', 90_000, () => r.posts.length === 1, alive)
  await until('its receipt', 30_000, () => world.ntfy.titled('Attendance submitted').length === 1, alive)

  // A student takes the same name and posts another form.
  await m.person(r, ORGANISER)
  await m.chat(r, ORGANISER, `Please also fill ${microsoftUrl('attendance')}`)
  await until('the spoofed link settled', 60_000, () => formSettled(r, 'microsoft'), alive)
  await pause(10_000)
  expect(await m.forbiddenClicks(r)).toEqual([])
  await m.end(r)
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  await expectSpoofRefused(r, 'host', 'unknown')
  expect(await eventsOf(r, 'error')).toEqual([])
}

test('Teams: a student who takes the organiser name is not the host', async () => {
  await spoofOn(teamsMeeting())
})

test('Meet: a student who takes the host name is not the host', async () => {
  await spoofOn(meetMeeting())
})

// Zoom reads the roster when a link appears: a sender is host or co-host only if verified by the roster.
async function zoomSpoof(spoofer: string, spooferRole: string): Promise<void> {
  const { world } = ctx
  test.setTimeout(5 * MINUTE)
  const r = ctx.track(startWorker(world))
  const alive = finished(r)
  await joinMeeting(world, r, () => world.zoom.admit())
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the genuine form submitted', 90_000, () => r.posts.length === 1, alive)
  await until('its receipt', 30_000, () => world.ntfy.titled('Attendance submitted').length === 1, alive)
  world.zoom.participant(spoofer)
  world.zoom.chat(spoofer, `Please also fill ${microsoftUrl('attendance')}`)
  await until('the second link settled', 60_000, () => formSettled(r, 'microsoft'), alive)
  await pause(15_000)
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  await expectSpoofRefused(r, 'host', spooferRole)
}

test('Zoom: a student with the lecturer name but no host label is a participant', async () => {
  await zoomSpoof('Dr Example', 'participant')
})

// The student's display name is the lecturer's, label and all: duplicate name makes the role unknown.
test('Zoom: a student who takes the exact host display name is not the host', async () => {
  await zoomSpoof(HOST, 'unknown')
})
