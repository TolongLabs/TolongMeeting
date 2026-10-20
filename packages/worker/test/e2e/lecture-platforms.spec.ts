// A whole lecture on Teams and on Meet, end to end: the real `runOccurrence` against the repository's imitation pages for
// the two platforms (Playwright routes on the real host names), the form fixtures, the AI stub with realtime ASR and the
// recording ntfy stub; then the real pipeline CLI. It asserts the goals the Zoom scenario in meeting-run.spec.ts
// asserts: each form submitted once, no link or passcode in a summary, ping, event or AI request, teardown inside 50 s,
// and no click on a control the bot must not use. The pages are UNVERIFIED imitations (see their headers).
//   xvfb-run -a bunx playwright test -c packages/worker/playwright.config.ts --project=e2e --workers=2
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { googleUrl, microsoftUrl } from '../forms/route'
import { finished, runPipelineCli, startWorker, until } from './support/harness'
import { MINUTE, expectNoSecrets, formRecords, joinMeeting, pause, useWorld } from './support/checks'
import { meetMeeting, teamsMeeting, PARTICIPANTS, type Meeting } from './support/platforms'
import { slidePng } from './support/media'
import { TRANSCRIPT_LINES } from './support/stubs'

const ctx = useWorld()

async function wholeLecture(m: Meeting): Promise<void> {
  const { world } = ctx
  test.setTimeout(8 * MINUTE)
  const r = ctx.track(startWorker(world, { link: { kind: 'fixed', url: m.link }, onBrowser: m.prepare }))
  const alive = finished(r)

  // Lobby, then the organiser lets the bot in.
  await joinMeeting(world, r, () => m.admit(r))
  const joining = (await r.events()).find((e) => e.type === 'state' && e.data.state === 'joining')!
  expect(joining.data.link).toEqual({ source: 'fixed', host: m.linkHost })

  // The organiser posts a Google Form; the bot submits it once.
  await m.chat(r, m.host, `Attendance please: ${googleUrl('attendance')}`)
  await until('the Google form submitted', 90_000, () => r.posts.some((p) => p.provider === 'google'), alive)

  // A slide with a QR code to a Microsoft form.
  await m.share(
    r,
    await slidePng('Week 5', ['Quiz 2 is due on 2 November 2026', 'Scan to register'], microsoftUrl('attendance'))
  )
  await until('the Microsoft form submitted', 90_000, () => r.posts.some((p) => p.provider === 'microsoft'), alive)
  await m.chat(r, m.host, `Join again: ${m.chatLink}`)
  await until('both attendance pings', 60_000, () => world.ntfy.titled('Attendance submitted').length === 2, alive)

  // The same forms again, in other dress: still one submission each.
  await m.chat(r, m.host, `Reminder: ${microsoftUrl('attendance')}`)
  await m.chat(r, m.host, `Reminder: ${googleUrl('attendance')}?usp=sf_link`)
  world.redirects.set('https://forms.gle/short1', googleUrl('attendance'))
  await m.chat(r, m.host, 'Short link: https://forms.gle/short1')
  await pause(8_000)
  expect(r.posts).toHaveLength(2)
  await pause(12_000)
  await m.stopShare(r)
  await pause(5_000)
  // Joining and leaving are the only visible acts: the page counted no click on a control the bot must not use.
  expect(await m.forbiddenClicks(r)).toEqual([])
  await m.end(r)

  const endRequestedAt = Date.now()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page', reason: null })
  expect(JSON.parse(await readFile(join(r.dataDir, 'outcome.json'), 'utf8'))).toEqual(outcome)

  // Teardown inside the 50 s budget.
  const events = await r.events()
  const leaving = events.find((e) => e.type === 'state' && e.data.state === 'leaving')!
  expect(r.endedAt()! - Date.parse(leaving.at)).toBeLessThan(50_000)
  expect(r.endedAt()! - endRequestedAt).toBeLessThan(60_000)
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  expect(await readdir(join(r.dataDir, 'recording'))).toContain('meeting.mkv')

  // Chat as stored: every line from the organiser, marked as host (the roster says so, never the text).
  const chat = (await readFile(join(r.dataDir, 'chat.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { sender: string; senderRole: string; text: string })
  expect(chat.every((x) => x.sender === m.host && x.senderRole === 'host')).toBe(true)
  expect(chat.some((x) => x.text.includes(googleUrl('attendance')))).toBe(true)
  expect(chat.some((x) => x.text.includes(m.chatLink))).toBe(true)

  // The live transcript from the ASR stub.
  const live = (await readFile(join(r.dataDir, 'transcript/live.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { text: string })
  expect(live.map((l) => l.text).slice(0, 4)).toEqual(TRANSCRIPT_LINES)

  // Forms: each submitted exactly once, to its provider, with the saved details.
  expect(r.posts.map((p) => p.provider).sort()).toEqual(['google', 'microsoft'])
  expect(r.fx.submissions).toHaveLength(2)
  for (const s of r.fx.submissions) {
    expect(s.sendCopy).toBe(false)
    expect(s.answers).toMatchObject({
      'Full name': 'Test Student',
      'Matric No.': 'A00000000',
      'Course code': 'ABC1234',
      Section: '02',
      Attendance: 'Present'
    })
  }
  const records = await formRecords(r.dataDir)
  expect(records.map((x) => [x.provider, x.state, x.trustReason]).sort()).toEqual([
    ['google', 'submitted', 'host'],
    ['microsoft', 'submitted', 'qr_on_screen']
  ])
  for (const x of records) expect(Date.parse(x.submittedAt!) - Date.parse(x.seenAt)).toBeLessThan(120_000)
  // The meeting link the organiser posted is looked at once, by its host name, and let go.
  const ignored = events.filter((e) => e.type === 'form' && e.data.outcome === 'ignored')
  expect(ignored.map((e) => [e.data.reason, e.data.host])).toEqual([['not_a_form', m.linkHost]])

  // Pings before the pipeline: joined once (with the roster's count), two attendance receipts, nothing else.
  expect(world.ntfy.pings.map((p) => p.title).sort()).toEqual([
    'Attendance submitted',
    'Attendance submitted',
    'Joined: Data Mining'
  ])
  expect(world.ntfy.titled('Joined:')[0]!.message).toContain(`${PARTICIPANTS} participants`)

  // The pipeline: a summary that lists both submissions and holds no link but the plain form pages.
  const piped = await runPipelineCli(world, r.cfg)
  expect(piped, piped.stderr).toMatchObject({ code: 0 })
  const out = join(r.dataDir, 'out')
  const summaryFile = (await readdir(out)).find((f) => /^\d{4}-\d{2}-\d{2} \d{4} Data Mining\.md$/.test(f))
  expect(summaryFile).toBeDefined()
  const summary = await readFile(join(out, summaryFile!), 'utf8')
  const attendance = /^.*Attendance.*$/m.exec(summary)?.[0] ?? ''
  expect(attendance).toMatch(/submitted at \d\d:\d\d \(Google Forms\) ✓/)
  expect(attendance).toMatch(/submitted at \d\d:\d\d \(Microsoft Forms\) ✓/)
  expect(summary).toContain('due Mon 2 Nov 2026')
  for (const link of summary.match(/https?:\/\/\S+/g) ?? []) {
    expect(link.replace(/[).,;]+$/, '')).toMatch(
      /^https:\/\/(docs\.google\.com\/forms\/d\/e\/[^/?#]+\/viewform|forms\.office\.com\/Pages\/ResponsePage\.aspx\?id=[\w-]+)$/
    )
  }
  expect(world.ntfy.titled('Summary ready:')).toHaveLength(1)

  await expectNoSecrets(world, r, m.secrets, [m.linkHost])
}

test('a whole lecture on Teams: lobby, forms from chat and from a slide, end, summary', async () => {
  await wholeLecture(teamsMeeting())
})

test('a whole lecture on Meet: lobby, forms from chat and from a slide, end, summary', async () => {
  await wholeLecture(meetMeeting())
})
