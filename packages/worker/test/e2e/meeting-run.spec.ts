// A whole meeting run, end to end, on this host: the real `runOccurrence` with the real screen, Chrome, recorder, frame
// loop, chat capture, QR decoder and form handler, against local fakes for Zoom, the form providers, the AI service
// (chat, vision and realtime ASR) and ntfy. Then the real pipeline CLI on the output. See support/harness.ts for the few
// places where a component is swapped for its test option.
//   xvfb-run -a bunx playwright test -c packages/worker/playwright.config.ts --project=e2e
import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { FormRecord } from '@tm/core'
import { googleUrl, microsoftUrl } from '../forms/route'
import {
  CHAT_PASSCODE,
  HOST,
  JOIN_PASSCODE,
  chatJoinLink,
  finished,
  keepOrRemove,
  readEvents,
  runPipelineCli,
  startShared,
  startWorker,
  startWorld,
  textFiles,
  until,
  type Running,
  type Shared,
  type World
} from './support/harness'
import { killFfmpeg } from '../helpers/media'
import { slidePng } from './support/media'
import { TRANSCRIPT_LINES } from './support/stubs'
import { decodeQr } from '../../src/qr/qr'

let shared: Shared
let world: World
let run: Running | null = null

test.beforeAll(() => {
  shared = startShared()
})

test.beforeEach(async () => {
  world = await startWorld(shared)
  run = null
})

test.afterEach(async ({}, testInfo) => {
  if (run !== null) {
    run.abort()
    await Promise.race([run.outcome.catch(() => undefined), new Promise((r) => setTimeout(r, 70_000))])
  }
  await world.stop()
  await keepOrRemove(world, testInfo.status !== testInfo.expectedStatus)
})

const stateReached = (r: Running, state: string) => async () =>
  (await readEvents(r.dataDir)).some((e) => e.type === 'state' && e.data.state === state)
const probeFile = async (file: string) => {
  const info = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString()
  ) as { streams: Record<string, string | number>[]; format: { duration: string } }
  const v = info.streams.find((x) => x.codec_type === 'video')!
  const a = info.streams.find((x) => x.codec_type === 'audio')!
  return {
    video: String(v.codec_name),
    audio: String(a.codec_name),
    width: Number(v.width),
    height: Number(v.height),
    duration: Number(info.format.duration)
  }
}
const formRecords = async (dataDir: string): Promise<FormRecord[]> => {
  const dir = join(dataDir, 'forms')
  const records: FormRecord[] = []
  for (const name of await readdir(dir))
    records.push(JSON.parse(await readFile(join(dir, name, 'record.json'), 'utf8')) as FormRecord)
  return records
}
const eventCount = async (r: Running, type: string) => (await readEvents(r.dataDir)).filter((e) => e.type === type)

test('a whole lecture: join, record, submit both forms once, ping, summarise', async () => {
  test.setTimeout(8 * 60_000)
  const r = (run = startWorker(world))
  const alive = finished(r)

  // Lobby, then the host lets the bot in.
  await until('the bot in the waiting room', 90_000, stateReached(r, 'in_lobby'), alive)
  world.zoom.admit()
  await until('the joined ping', 60_000, () => world.ntfy.titled('Joined:').length === 1, alive)
  await until(
    'the chat capture and the frame loop',
    30_000,
    async () => (await eventCount(r, 'joined')).length === 1,
    alive
  )

  // In the meeting: the stage plays video and sound.
  const playing = await r.stage
    .frameLocator('iframe#webclient')
    .locator('#e2e-stage-video')
    .evaluate(async (v: HTMLVideoElement) => {
      const t0 = v.currentTime
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return { advanced: v.currentTime > t0, muted: v.muted, volume: v.volume, paused: v.paused }
    })
  expect(playing).toEqual({ advanced: true, muted: false, volume: 1, paused: false })

  // The host posts a Google Form and (a minute later in a real lecture) a link to the Zoom meeting with its passcode.
  world.zoom.chat(HOST, `Attendance please: ${googleUrl('attendance')}`)
  await until('the Google form submitted', 90_000, () => r.posts.some((p) => p.provider === 'google'), alive)

  // A slide with a QR code to a Microsoft form.
  world.zoom.share(
    await slidePng('Week 5', ['Quiz 2 is due on 2 November 2026', 'Scan to register'], microsoftUrl('attendance'))
  )
  await until('the Microsoft form submitted', 90_000, () => r.posts.some((p) => p.provider === 'microsoft'), alive)
  world.zoom.chat(HOST, `Join again: ${chatJoinLink}`)
  await until('both attendance pings', 60_000, () => world.ntfy.titled('Attendance submitted').length === 2, alive)
  // The same forms again, in other dress (a tracking query, the QR's own address): still one submission each.
  world.zoom.chat(HOST, `Reminder: ${microsoftUrl('attendance')}`)
  world.zoom.chat(HOST, `Reminder: ${googleUrl('attendance')}?usp=sf_link`)
  world.redirects.set('https://forms.gle/short1', googleUrl('attendance'))
  world.zoom.chat(HOST, 'Short link: https://forms.gle/short1')
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  expect(r.posts).toHaveLength(2)
  await new Promise((resolve) => setTimeout(resolve, 12_000))
  world.zoom.stopShare()
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  // Joining and leaving are the only visible acts: the page counted no click on a control the bot must not use
  // (microphone, camera, share, reactions, the chat box).
  const clicks = await r.stage
    .frame({ url: /zoom-meeting-top/ })!
    .evaluate(() => (window as unknown as { __fixture: { forbiddenClicks: string[] } }).__fixture.forbiddenClicks)
  expect(clicks).toEqual([])
  world.zoom.end()

  const endRequestedAt = Date.now()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page', reason: null })
  expect(JSON.parse(await readFile(join(r.dataDir, 'outcome.json'), 'utf8'))).toEqual(outcome)

  // Teardown: from the first teardown state to the end of the run, inside the 50 s budget.
  const events = await r.events()
  const leaving = events.find((e) => e.type === 'state' && e.data.state === 'leaving')!
  expect(r.endedAt()! - Date.parse(leaving.at)).toBeLessThan(50_000)
  expect(r.endedAt()! - endRequestedAt).toBeLessThan(60_000)

  // Recording: segments, the joined file, and the stage (not the desk) in it.
  const recording = join(r.dataDir, 'recording')
  const segments = (await readdir(recording)).filter((f) => /^attempt_1_seg_\d+\.mkv$/.test(f)).sort()
  expect(segments.length).toBeGreaterThanOrEqual(2)
  const joined = await probeFile(join(recording, 'meeting.mkv'))
  expect(joined).toMatchObject({ video: 'h264', audio: 'aac', width: 1920, height: 1080 })
  let segmentSeconds = 0
  for (const f of segments) segmentSeconds += (await probeFile(join(recording, f))).duration
  expect(joined.duration).toBeGreaterThan(30)
  expect(Math.abs(joined.duration - segmentSeconds)).toBeLessThan(2)
  const attempts = JSON.parse(await readFile(join(recording, 'attempts.json'), 'utf8')) as {
    startedAt: string
    stoppedAt: string
  }[]
  expect(attempts).toHaveLength(1)
  expect(
    Math.abs(Date.parse(attempts[0]!.stoppedAt) - Date.parse(attempts[0]!.startedAt) - joined.duration * 1000)
  ).toBeLessThan(3000)
  // A frame of the joined recording, taken while the slide was up, shows the slide and decodes to the form's address.
  const qrForm = events.find((e) => e.type === 'form' && e.data.source === 'qr')!
  const slideAt = (Date.parse(String(qrForm.data.seenAt)) - Date.parse(attempts[0]!.startedAt) + 3000) / 1000
  const png = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(slideAt),
      '-i',
      join(recording, 'meeting.mkv'),
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1'
    ],
    { maxBuffer: 20_000_000 }
  )
  expect(await decodeQr(png, null)).toContain(microsoftUrl('attendance'))

  // Chat: every line with the host marked, as the worker stored it.
  const chat = (await readFile(join(r.dataDir, 'chat.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { sender: string; senderRole: string; text: string })
  // Known: with one message in the list, Zoom-like markup lets the list wrapper's id stand for the row's id, so that
  // message is stored twice (see .superpowers/sdd/e2e-findings.md, F3).
  const distinct = new Set(chat.map((m) => `${m.sender}|${m.text}`)).size
  if (chat.length !== distinct)
    test
      .info()
      .annotations.push({ type: 'finding F3', description: `${chat.length} chat rows for ${distinct} messages` })
  expect(chat.every((m) => m.sender === 'Dr Example' && m.senderRole === 'host')).toBe(true)
  expect(chat.some((m) => m.text.includes(googleUrl('attendance')))).toBe(true)
  expect(chat.some((m) => m.text.includes(chatJoinLink))).toBe(true)

  // Live transcript from the ASR stub, with recording-relative times.
  const live = (await readFile(join(r.dataDir, 'transcript/live.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { startMs: number; endMs: number; text: string })
  expect(live.length).toBeGreaterThanOrEqual(5)
  expect(live.map((l) => l.text).slice(0, 4)).toEqual(TRANSCRIPT_LINES)
  expect(world.asr.sockets()).toBe(1)

  // Forms: each attendance form submitted exactly once, to the provider, in time, with the saved details.
  expect(r.posts.map((p) => p.provider).sort()).toEqual(['google', 'microsoft'])
  expect(r.fx.submissions).toHaveLength(2)
  for (const s of r.fx.submissions) {
    expect(s.sendCopy).toBe(false)
    expect(s.answers).toMatchObject({
      'Full name': 'Test Student',
      'Matric No.': 'A00000000',
      'Course code': 'ABC1234',
      Section: '02',
      'Programme of study': 'MSc Example',
      Attendance: 'Present'
    })
  }
  const records = await formRecords(r.dataDir)
  expect(records.map((x) => [x.provider, x.state, x.trustReason]).sort()).toEqual([
    ['google', 'submitted', 'host'],
    ['microsoft', 'submitted', 'qr_on_screen']
  ])
  for (const x of records) expect(Date.parse(x.submittedAt!) - Date.parse(x.seenAt)).toBeLessThan(120_000)
  // The passcode link the host posted is no form: it is looked at once, by its host name, and let go.
  expect(world.ntfy.pings.every((p) => !p.attachment)).toBe(true)
  const ignored = events.filter((e) => e.type === 'form' && e.data.outcome === 'ignored')
  expect(ignored.map((e) => [e.data.reason, e.data.host])).toEqual([['not_a_form', 'e2e.zoom.us']])

  // Pings before the pipeline: joined once, two attendance receipts, nothing else.
  const titles = () => world.ntfy.pings.map((p) => p.title)
  expect(titles().sort()).toEqual(['Attendance submitted', 'Attendance submitted', 'Joined: Data Mining'])
  expect(world.ntfy.titled('Joined:')[0]!.message).toContain('12 participants')
  expect(world.ntfy.titled('Attendance submitted').map((p) => p.priority)).toEqual([4, 4])

  // The checkpoint of the profile, written at teardown.
  const checkpoints = await readdir(join(r.profileRoot, 'ident-e2e', 'checkpoints'))
  expect(checkpoints.filter((f) => f.endsWith('.tar.enc'))).toHaveLength(1)

  // The pipeline on the output directory, with the same stubs.
  const piped = await runPipelineCli(world, r.cfg)
  expect(piped, piped.stderr).toMatchObject({ code: 0 })
  const out = join(r.dataDir, 'out')
  const outFiles = await readdir(out)
  const summaryFile = outFiles.find((f) => /^\d{4}-\d{2}-\d{2} \d{4} Data Mining\.md$/.test(f))
  expect(summaryFile, outFiles.join(', ')).toBeDefined()
  for (const f of ['chat.md', 'transcript.md', 'slides.md']) expect(outFiles).toContain(f)
  const summary = await readFile(join(out, summaryFile!), 'utf8')
  const transcript = await readFile(join(out, 'transcript.md'), 'utf8')
  for (const line of TRANSCRIPT_LINES.slice(0, 3)) expect(transcript).toContain(line)
  const attendance = /^.*Attendance.*$/m.exec(summary)?.[0] ?? ''
  expect(attendance).toMatch(/submitted at \d\d:\d\d \(Google Forms\) ✓/)
  expect(attendance).toMatch(/submitted at \d\d:\d\d \(Microsoft Forms\) ✓/)
  expect(summary).toContain('due Mon 2 Nov 2026')
  // Every link in the summary is a plain form page.
  for (const link of summary.match(/https?:\/\/\S+/g) ?? []) {
    expect(link.replace(/[).,;]+$/, '')).toMatch(
      /^https:\/\/(docs\.google\.com\/forms\/d\/e\/[^/?#]+\/viewform|forms\.office\.com\/Pages\/ResponsePage\.aspx\?id=[\w-]+)$/
    )
  }
  expect(world.ntfy.titled('Summary ready:')).toHaveLength(1)
  const outcomeJson = await readFile(join(r.dataDir, 'outcome.json'), 'utf8')
  expect(JSON.parse(outcomeJson)).toMatchObject({ result: 'completed' })
  // A second pipeline run builds the same files and does not ping again.
  const again = await runPipelineCli(world, r.cfg)
  expect(again.code).toBe(0)
  expect(world.ntfy.titled('Summary ready:')).toHaveLength(1)

  // No meeting link or passcode in any ping, any worker file or event, or anything sent to the AI service.
  const secrets = [JOIN_PASSCODE, CHAT_PASSCODE, 'pwd=']
  for (const ping of world.ntfy.pings)
    for (const secret of secrets) expect(ping.raw, `ping ${ping.title}`).not.toContain(secret)
  for (const request of world.ai.requests) {
    for (const secret of [...secrets, 'e2e.zoom.us', 'A00000000', 'student@example.edu.my'])
      expect(request.body, `AI request to ${request.model}`).not.toContain(secret)
  }
  const files = await textFiles(r.dataDir)
  const holdingSecrets = [...files].filter(([, text]) => secrets.some((s) => text.includes(s))).map(([name]) => name)
  // Nor the AI key or the ntfy token anywhere, and no secret in what the worker printed.
  for (const [name, text] of files)
    for (const key of ['sk-e2e-key', 'tk-e2e-token']) expect(text, name).not.toContain(key)
  for (const secret of [...secrets, 'sk-e2e-key', 'tk-e2e-token']) expect(r.logs.join('\n')).not.toContain(secret)
  expect(holdingSecrets).toEqual(['chat.jsonl']) // the chat is kept as it arrived; nothing derived from it holds a secret
})

// --- the edge cases: each is a run of its own, and each must leave no form submitted twice and no form or ping lost ---

const MINUTE = 60_000

// Lobby, admission, and the first loops running.
async function joinMeeting(r: Running): Promise<void> {
  const alive = finished(r)
  await until('the bot in the waiting room', 90_000, stateReached(r, 'in_lobby'), alive)
  world.zoom.admit()
  await until('the bot in the meeting', 60_000, async () => (await eventCount(r, 'joined')).length === 1, alive)
  await until('the joined ping', 30_000, () => world.ntfy.titled('Joined:').length === 1, alive)
}

const formStates = async (r: Running): Promise<string[]> =>
  (await r.events())
    .filter((e) => e.type === 'form' && typeof e.data.state === 'string')
    .map((e) => String(e.data.state))

const pingTitles = () => world.ntfy.pings.map((p) => p.title)
const lastStateOf = async (r: Running) => (await formRecords(r.dataDir)).map((x) => x.state)

test('SIGTERM mid-meeting: leaves, checkpoints, ends terminated inside 50 s, the form already sent stays sent once', async () => {
  test.setTimeout(5 * MINUTE)
  const r = (run = startWorker(world))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the form submitted', 60_000, () => r.posts.length === 1, alive)
  await until('its receipt', 30_000, () => world.ntfy.titled('Attendance submitted').length === 1, alive)
  await new Promise((resolve) => setTimeout(resolve, 6_000))

  r.abort()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'terminated', reason: 'terminated' })
  expect(r.endedAt()! - r.abortedAt()!).toBeLessThan(50_000)
  expect(JSON.parse(await readFile(join(r.dataDir, 'outcome.json'), 'utf8'))).toEqual(outcome)
  const checkpoints = await readdir(join(r.profileRoot, 'ident-e2e', 'checkpoints'))
  expect(checkpoints.filter((f) => f.endsWith('.tar.enc'))).toHaveLength(1)
  // The recording stops cleanly: the segments are there and the stop is written down.
  const attempts = JSON.parse(await readFile(join(r.dataDir, 'recording/attempts.json'), 'utf8')) as {
    stoppedAt: string | null
  }[]
  expect(attempts[0]!.stoppedAt).not.toBeNull()
  expect(
    (await readdir(join(r.dataDir, 'recording'))).filter((f) => /^attempt_1_seg_\d+\.mkv$/.test(f)).length
  ).toBeGreaterThan(0)
  // The member left the meeting rather than being cut off: no error from the leave step.
  const events = await r.events()
  expect(events.filter((e) => e.type === 'error').map((e) => e.data.where)).toEqual([])
  expect(events.some((e) => e.type === 'state' && e.data.state === 'uploading')).toBe(false)
  // Nothing was submitted twice and nothing else was sent.
  expect(r.posts).toHaveLength(1)
  expect(await lastStateOf(r)).toEqual(['submitted'])
  expect(pingTitles().sort()).toEqual(['Attendance submitted', 'Joined: Data Mining'])
})

test('lobby that never admits: the lobby_expired path ends as not admitted with one alert', async () => {
  test.setTimeout(4 * MINUTE)
  // The hard stop (end + 30 minutes) falls 30 s from now, and the lobby wait ends there.
  const r = (run = startWorker(world, { startInMs: -45 * MINUTE, endInMs: -30 * MINUTE + 30_000 }))
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'not_admitted', endedBy: null, reason: null, joinedAt: null })
  const alerts = world.ntfy.titled('Alert:')
  expect(alerts).toHaveLength(1)
  expect(alerts[0]!.priority).toBe(4)
  expect(world.ntfy.pings).toHaveLength(1) // no "joined", no form pings
  expect(world.zoom.joinPageLoads()).toBe(1) // past the hard stop it does not try again
  const events = await r.events()
  expect(events.some((e) => e.type === 'joined')).toBe(false)
  expect(events.filter((e) => e.type === 'state').map((e) => e.data.state)).toContain('in_lobby')
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  expect(r.posts).toHaveLength(0)
  expect(JSON.parse(await readFile(join(r.dataDir, 'outcome.json'), 'utf8'))).toEqual(outcome)
  expect((await readdir(join(r.profileRoot, 'ident-e2e', 'checkpoints'))).length).toBe(1)
})

test('a form behind a sign-in wall: one "Sign in again" ping, nothing typed, nothing sent, then submitted once after sign-in', async () => {
  test.setTimeout(5 * MINUTE)
  const r = (run = startWorker(world, { onBrowser: (x) => void x.fx.signedOut.add('attendance') }))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the sign-in ping', 60_000, () => world.ntfy.titled('Sign in again').length === 1, alive)
  const ping = world.ntfy.titled('Sign in again')[0]!
  expect(ping.priority).toBe(4)
  expect(ping.actionUrls).toEqual([googleUrl('attendance')])
  expect(r.posts).toHaveLength(0)
  expect(await formStates(r)).toContain('awaiting_signin')
  // The sign-in page is left alone: nothing in its field.
  const tab = r.context.pages().find((p) => p.url().startsWith('https://accounts.google.com/'))!
  expect(await tab.locator('input[type=email]').inputValue()).toBe('')

  // The member signs in on the desk and the form opens again: one submission.
  r.fx.signedOut.delete('attendance')
  await tab.locator('#continue').click()
  await until('the form submitted after sign-in', 90_000, () => r.posts.length === 1, alive)
  await until('its receipt', 30_000, () => world.ntfy.titled('Attendance submitted').length === 1, alive)
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(r.posts).toHaveLength(1)
  const [record] = await formRecords(r.dataDir)
  expect(record).toMatchObject({ state: 'submitted', signinRetried: true, trustReason: 'host' })
  expect(world.ntfy.titled('Sign in again')).toHaveLength(1)
  expect(world.ntfy.titled('Attendance submitted')).toHaveLength(1)
})

test('a form behind a sign-in wall when the meeting ends: the member still has the ping, and nothing was sent', async () => {
  test.setTimeout(5 * MINUTE)
  const r = (run = startWorker(world, { onBrowser: (x) => void x.fx.signedOut.add('attendance') }))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the sign-in ping', 60_000, () => world.ntfy.titled('Sign in again').length === 1, alive)
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(r.posts).toHaveLength(0)
  const [record] = await formRecords(r.dataDir)
  expect(record!.state).not.toBe('submitted')
  expect(['awaiting_signin', 'failed']).toContain(record!.state)
  // The form tab is closed, and every ping about the form carries the plain form page.
  expect(r.context.pages().filter((p) => !p.isClosed())).toHaveLength(0)
  for (const ping of world.ntfy.pings.filter((p) => p.title !== 'Joined: Data Mining')) {
    expect(ping.actionUrls.every((u) => u === googleUrl('attendance'))).toBe(true)
  }
  // The summary points the member at the form.
  const piped = await runPipelineCli(world, r.cfg)
  expect(piped, piped.stderr).toMatchObject({ code: 0 })
  const out = join(r.dataDir, 'out')
  const summary = await readFile(
    join(
      out,
      (await readdir(out)).find((f) => /Data Mining\.md$/.test(f))!
    ),
    'utf8'
  )
  expect(/^Attendance: .*$/m.exec(summary)?.[0]).toContain(`needs you: ${googleUrl('attendance')}`)
})

test('the meeting ends while a form is being submitted: sent once, and the member hears of it', async () => {
  test.setTimeout(5 * MINUTE)
  const r = (run = startWorker(world, {
    onBrowser: async (x) => {
      // The provider takes 7 s to answer the submission.
      await x.context.route(/\/forms\/d\/e\/[^/]+\/formResponse$/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 7_000))
        await route.fallback()
      })
    }
  }))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the form being submitted', 60_000, async () => (await formStates(r)).includes('submitting'), alive)
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(
    r.endedAt()! - Date.parse((await r.events()).find((e) => e.type === 'state' && e.data.state === 'leaving')!.at)
  ).toBeLessThan(50_000)
  expect(r.posts.length).toBeLessThanOrEqual(1)
  const [record] = await formRecords(r.dataDir)
  const receipts = world.ntfy.pings.filter((p) => p.title !== 'Joined: Data Mining')
  // Whatever became of it, the record is settled and the member has exactly one message about it.
  expect(['submitted', 'failed']).toContain(record!.state)
  expect(receipts).toHaveLength(1)
  if (record!.state === 'submitted') {
    expect(r.posts).toHaveLength(1)
    expect(receipts[0]!.title).toBe('Attendance submitted')
  } else {
    expect(receipts[0]!.actionUrls).toEqual([googleUrl('attendance')])
  }
})

test('the bot is removed: one removed alert, the run ends cleanly with the recording kept', async () => {
  test.setTimeout(5 * MINUTE)
  const r = (run = startWorker(world))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the form submitted', 60_000, () => r.posts.length === 1, alive)
  world.zoom.remove()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'removed' })
  expect(world.ntfy.titled('Alert:')).toHaveLength(1)
  expect(world.ntfy.titled('Alert:')[0]!.message.toLowerCase()).toContain('removed')
  expect(r.posts).toHaveLength(1)
  expect(await lastStateOf(r)).toEqual(['submitted'])
  expect(world.ntfy.titled('Attendance submitted')).toHaveLength(1)
  expect((await probeFile(join(r.dataDir, 'recording/meeting.mkv'))).duration).toBeGreaterThan(5)
  expect((await readdir(join(r.profileRoot, 'ident-e2e', 'checkpoints'))).length).toBe(1)
})

test('links in the chat that are not forms, or only look like forms, are never opened or submitted', async () => {
  test.setTimeout(5 * MINUTE)
  const r = (run = startWorker(world))
  const alive = finished(r)
  await joinMeeting(r)
  // A short link that leads to a look-alike is no form either.
  world.redirects.set('https://forms.gle/phish', 'https://docs.google.com.evil.test/forms/d/e/attendance/viewform')
  const links = [
    'https://example.org/lecture-notes.pdf',
    'https://forms.gle/phish',
    'https://docs.google.com.evil.test/forms/d/e/attendance/viewform',
    'https://forms.office.com.evil.test/Pages/ResponsePage.aspx?id=attendance',
    'https://docs.google.com@evil.test/forms/d/e/attendance/viewform',
    'http://forms.office.com/Pages/ResponsePage.aspx?id=attendance',
    'https://docs.google.com:8443/forms/d/e/attendance/viewform'
  ]
  // One message at a time, as a class types them: the chat panel shows a few rows, and a burst scrolls past before it is read.
  for (const link of links) {
    world.zoom.chat(HOST, `Please see ${link}`)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
  }
  await until('every link looked at', 60_000, async () => (await eventCount(r, 'form')).length >= links.length, alive)
  await new Promise((resolve) => setTimeout(resolve, 6_000))
  expect(r.posts).toHaveLength(0)
  expect(r.decoyRequests).toEqual([])
  // The only provider request is the sign-in check at the start.
  expect(r.fx.requests.filter((u) => u !== 'https://forms.office.com/')).toEqual([])
  expect(r.context.pages().filter((p) => !p.isClosed())).toHaveLength(2) // the stage and the desk, nothing else
  // Control: the spy does see a request to a look-alike host when something makes one.
  await r.desk.goto('https://docs.google.com.evil.test/control').catch(() => undefined)
  expect(r.decoyRequests).toEqual(['https://docs.google.com.evil.test/control'])
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  const forms = await eventCount(r, 'form')
  expect(forms.every((e) => e.data.outcome === 'ignored' && e.data.reason === 'not_a_form')).toBe(true)
  expect(forms).toHaveLength(links.length)
  await expect(readdir(join(r.dataDir, 'forms'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(pingTitles()).toEqual(['Joined: Data Mining'])
  const piped = await runPipelineCli(world, r.cfg)
  expect(piped, piped.stderr).toMatchObject({ code: 0 })
  const out = join(r.dataDir, 'out')
  const summary = await readFile(
    join(
      out,
      (await readdir(out)).find((f) => /Data Mining\.md$/.test(f))!
    ),
    'utf8'
  )
  expect(/^Attendance: .*$/m.exec(summary)?.[0]).toBe('Attendance: not seen')
})

test('the hard stop (end + 30 minutes) ends a meeting that never ends: hard_stop, one teardown, recording joined', async () => {
  test.setTimeout(4 * MINUTE)
  // The scheduled end was 30 minutes ago less 40 s: the hard stop is 40 s away.
  const r = (run = startWorker(world, { startInMs: -45 * MINUTE, endInMs: -30 * MINUTE + 40_000 }))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the form submitted', 30_000, () => r.posts.length === 1, alive)
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'hard_stop', reason: null })
  // Within one 5 s tick of the hard stop, and the teardown inside its budget.
  const hardStop = Date.parse(r.cfg.entry.end) + 30 * MINUTE
  expect(r.endedAt()! - hardStop).toBeLessThan(5_000 + 50_000)
  const leaving = (await r.events()).find((e) => e.type === 'state' && e.data.state === 'leaving')!
  expect(Date.parse(leaving.at) - hardStop).toBeLessThan(7_000)
  expect(r.endedAt()! - Date.parse(leaving.at)).toBeLessThan(50_000)
  expect(r.posts).toHaveLength(1)
  expect(pingTitles().sort()).toEqual(['Attendance submitted', 'Joined: Data Mining'])
  expect((await probeFile(join(r.dataDir, 'recording/meeting.mkv'))).duration).toBeGreaterThan(20)
})

test('the recorder killed mid-meeting restarts: a gap of at most 3 s, one ping, one joined recording', async () => {
  test.setTimeout(4 * MINUTE)
  const r = (run = startWorker(world))
  const alive = finished(r)
  await joinMeeting(r)
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  // Only the ffmpeg that records into this run's directory.
  killFfmpeg(join(r.dataDir, 'recording'))
  await until('the gap event', 30_000, async () => (await eventCount(r, 'recording_gap')).length === 1, alive)
  await until('the recorder-restarted ping', 30_000, () => world.ntfy.titled('Alert:').length === 1, alive)
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  const [gap] = await eventCount(r, 'recording_gap')
  expect(Number(gap!.data.seconds)).toBeLessThanOrEqual(3)
  expect(world.ntfy.titled('Alert:')).toHaveLength(1)
  expect(world.ntfy.titled('Alert:')[0]!.message).toContain('recorder restarted')
  const segments = (await readdir(join(r.dataDir, 'recording'))).filter((f) => /^attempt_1_seg_\d+\.mkv$/.test(f))
  expect(segments.length).toBeGreaterThanOrEqual(2)
  expect((await probeFile(join(r.dataDir, 'recording/meeting.mkv'))).duration).toBeGreaterThan(15)
  const attempts = JSON.parse(await readFile(join(r.dataDir, 'recording/attempts.json'), 'utf8')) as {
    gaps?: unknown[]
  }[]
  expect(attempts[0]!.gaps).toHaveLength(1)
})

test('an expired Microsoft forms sign-in is pinged before the join, and the meeting is still attended', async () => {
  test.setTimeout(4 * MINUTE)
  const r = (run = startWorker(world, {
    onBrowser: async (x) => {
      // The forms home page sends the desk to Microsoft's sign-in page, as it does once the session has expired.
      await x.context.route('https://forms.office.com/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<script>location.replace("https://login.microsoftonline.com/common/oauth2/authorize")</script>'
        })
      )
    }
  }))
  const alive = finished(r)
  await joinMeeting(r)
  const alerts = world.ntfy.titled('Alert:')
  expect(alerts).toHaveLength(1)
  expect(alerts[0]!.message).toContain('Microsoft')
  expect(alerts[0]!.priority).toBe(4)
  // The alert came before the joined ping.
  expect(world.ntfy.pings.findIndex((p) => p.title.startsWith('Alert:'))).toBeLessThan(
    world.ntfy.pings.findIndex((p) => p.title.startsWith('Joined:'))
  )
  const accounts = (await r.events()).filter((e) => e.type === 'state' && e.data.account !== undefined)
  expect(accounts.map((e) => [e.data.account, e.data.signedIn])).toEqual([
    ['google', true],
    ['microsoft', false]
  ])
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(alive()).toBe(false)
})

test('SIGTERM while a form is being submitted: out inside 50 s, the form is not lost and not sent twice', async () => {
  test.setTimeout(4 * MINUTE)
  const r = (run = startWorker(world, {
    onBrowser: async (x) => {
      // The provider takes 25 s to answer the submission.
      await x.context.route(/\/forms\/d\/e\/[^/]+\/formResponse$/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 25_000))
        await route.fallback().catch(() => undefined)
      })
    }
  }))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the form being submitted', 60_000, async () => (await formStates(r)).includes('submitting'), alive)
  r.abort()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'terminated' })
  expect(r.endedAt()! - r.abortedAt()!).toBeLessThan(50_000)
  expect(r.posts.length).toBeLessThanOrEqual(1)
  // The record is settled as "may have been submitted", and the member has one ping with the plain form page.
  const [record] = await formRecords(r.dataDir)
  expect(record).toMatchObject({ state: 'failed', reason: 'submit_unconfirmed' })
  const about = world.ntfy.pings.filter((p) => p.title !== 'Joined: Data Mining')
  expect(about).toHaveLength(1)
  expect(about[0]!.priority).toBe(4)
  expect(about[0]!.actionUrls).toEqual([googleUrl('attendance')])
  expect((await readdir(join(r.profileRoot, 'ident-e2e', 'checkpoints'))).length).toBe(1)
})

test('the meeting ends while a form is still opening: the form is not lost', async () => {
  test.setTimeout(4 * MINUTE)
  const r = (run = startWorker(world, { onBrowser: (x) => void x.fx.delayMs.set('attendance', 9_000) }))
  const alive = finished(r)
  await joinMeeting(r)
  world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
  await until('the form opening', 60_000, async () => (await formStates(r)).includes('opening'), alive)
  world.zoom.end()
  const outcome = await r.outcome
  expect(outcome).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(r.posts).toHaveLength(0)
  const [record] = await formRecords(r.dataDir)
  expect(record).toMatchObject({ state: 'failed', reason: 'meeting_ended' })
  const about = world.ntfy.pings.filter((p) => p.title !== 'Joined: Data Mining')
  expect(about).toHaveLength(1)
  expect(about[0]!.actionUrls).toEqual([googleUrl('attendance')])
  expect(r.context.pages().filter((p) => !p.isClosed())).toHaveLength(0)
})
