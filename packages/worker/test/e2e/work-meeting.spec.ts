// Plan 06 end to end: the member's name said in a live-transcribed work meeting, and the leave and take-over commands the
// website queues through the control channel (the world's heartbeat stub answers them). The real `runOccurrence` runs
// against the fake Zoom, the realtime ASR stub (which says whatever the test tells it to) and the recording ntfy stub.
//   xvfb-run -a bunx playwright test -c packages/worker/playwright.config.ts --project=e2e --workers=2
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { googleUrl } from '../forms/route'
import { HOST, JOIN_PASSCODE, finished, startWorker, until, type Running } from './support/harness'
import { MINUTE, eventsOf, formRecords, formStates, joinMeeting, pause, useWorld } from './support/checks'

const ctx = useWorld()

const PUBLIC = 'https://tm.example.test'
const MEETING_PAGE = `${PUBLIC}/meetings/occ-e2e`
const MENTIONED = 'Your name was mentioned'

// The events and heartbeats a member-ended run must leave: out of the meeting, the state `left_by_member` with the
// command, and no step towards the summary.
async function expectLeftByMember(r: Running, command: 'leave_now' | 'take_over'): Promise<void> {
  const { world } = ctx
  const outcome = await r.outcome
  expect(outcome).toMatchObject({
    result: 'completed',
    endedBy: 'member_left',
    reason: 'left_by_member',
    command
  })
  expect(JSON.parse(await readFile(join(r.dataDir, 'outcome.json'), 'utf8'))).toEqual(outcome)
  const events = await r.events()
  const left = events.filter((e) => e.type === 'state' && e.data.state === 'left_by_member')
  expect(left.map((e) => e.data.command)).toEqual([command])
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  // The server saw the move, and nothing after it: no leaving, no upload, no transcription (no summary hand-over).
  const states = world.control.states()
  expect(states.at(-1)).toBe('left_by_member')
  for (const state of ['leaving', 'uploading', 'transcribing', 'post_processing', 'completed'])
    expect(states, `state ${state}`).not.toContain(state)
  expect(events.some((e) => e.type === 'state' && ['leaving', 'uploading'].includes(String(e.data.state)))).toBe(false)
  expect(world.ntfy.titled('Summary')).toEqual([])
  // The recording up to that point is kept, and the bot is out: the profile checkpoint was taken.
  expect(await readdir(join(r.dataDir, 'recording'))).toContain('meeting.mkv')
  expect((await readdir(join(r.profileRoot, 'ident-e2e', 'checkpoints'))).length).toBe(1)
  // The link the heartbeat carried holds no passcode.
  const links = world.control.beats.flatMap((b) => (b.linkUsed === undefined ? [] : [b.linkUsed]))
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) expect(link).not.toMatch(/pwd=|SECRETPWD/)
}

test('a work meeting: a mention pings once within seconds, the next inside 2 minutes does not, take-over ends it', async () => {
  const { world } = ctx
  test.setTimeout(6 * MINUTE)
  process.env.TM_PUBLIC_URL = PUBLIC
  try {
    const r = ctx.track(
      startWorker(world, { type: 'work', mentionNames: ['Aisyah Rahman', 'Aisyah'], control: true, heartbeatMs: 1_000 })
    )
    const alive = finished(r)
    await joinMeeting(world, r, () => world.zoom.admit())
    // The joined ping offers the three website pages, and holds no meeting link.
    const joinedPing = world.ntfy.titled('Joined:')[0]!
    expect(joinedPing.actionUrls).toEqual([MEETING_PAGE, `${MEETING_PAGE}/leave`, `${MEETING_PAGE}/take-over`])

    // Speech flows (the stub reports a turn per 3 s of audio) and names nobody: no ping.
    await until('audio at the ASR', 60_000, () => world.asr.audioBytes() > 128_000, alive)
    expect(world.ntfy.titled(MENTIONED)).toEqual([])

    // Someone says the member's name, with the meeting's link and passcode in the same breath.
    const said = Date.now()
    world.asr.say(
      `Aisyah, could you give the budget update? Join at https://e2e.zoom.us/j/81234567890?pwd=${JOIN_PASSCODE} meeting id 81234567890 passcode 482913.`
    )
    await until('the mention ping', 30_000, () => world.ntfy.titled(MENTIONED).length === 1, alive)
    const ping = world.ntfy.titled(MENTIONED)[0]!
    const latency = ping.at - said
    test.info().annotations.push({ type: 'mention latency', description: `${latency} ms` })
    expect(latency).toBeLessThan(8_000)
    expect(ping.priority).toBe(4)
    expect(ping.message).toContain('budget update')
    for (const secret of [JOIN_PASSCODE, '482913', '81234567890', 'zoom.us', 'pwd='])
      expect(ping.raw, `mention ping holds ${secret}`).not.toContain(secret)
    expect(ping.actionUrls).toEqual([MEETING_PAGE, `${MEETING_PAGE}/take-over`])

    // The name again, 10 s of stream later: an event, no second ping.
    await pause(10_000)
    world.asr.say('Aisyah Rahman, are you still there?')
    await until('the second mention seen', 30_000, async () => (await eventsOf(r, 'mention')).length === 2, alive)
    await pause(6_000)
    expect(world.ntfy.titled(MENTIONED)).toHaveLength(1)
    const mentions = await eventsOf(r, 'mention')
    for (const e of mentions) expect(Object.keys(e.data)).toEqual(['atMs'])
    expect(Number(mentions[1]!.data.atMs) - Number(mentions[0]!.data.atMs)).toBeLessThan(120_000)
    // A work meeting has no forms to fill.
    expect(await eventsOf(r, 'form')).toEqual([])
    expect(r.posts).toEqual([])

    // The member takes over from the ping: the bot leaves, and no summary is started.
    const sent = Date.now()
    world.control.command('take_over')
    await expectLeftByMember(r, 'take_over')
    expect(r.endedAt()! - sent).toBeLessThan(50_000)
    // The spoken passcode is in the transcript file and nowhere derived from it.
    for (const p of world.ntfy.pings) expect(p.raw).not.toContain(JOIN_PASSCODE)
    expect(JSON.stringify(await r.events())).not.toContain(JOIN_PASSCODE)
    expect(r.logs.join('\n')).not.toContain(JOIN_PASSCODE)
  } finally {
    delete process.env.TM_PUBLIC_URL
  }
})

for (const command of ['leave_now', 'take_over'] as const) {
  test(`${command} while a form is being submitted: the submit settles, then the bot leaves, no summary hand-over`, async () => {
    const { world } = ctx
    test.setTimeout(5 * MINUTE)
    const r = ctx.track(
      startWorker(world, {
        control: true,
        heartbeatMs: 1_000,
        onBrowser: async (x) => {
          // The provider takes 7 s to answer the submission.
          await x.context.route(/\/forms\/d\/e\/[^/]+\/formResponse$/, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 7_000))
            await route.fallback()
          })
        }
      })
    )
    const alive = finished(r)
    await joinMeeting(world, r, () => world.zoom.admit())
    world.zoom.chat(HOST, `Attendance: ${googleUrl('attendance')}`)
    await until('the form being submitted', 60_000, async () => (await formStates(r)).includes('submitting'), alive)
    expect(r.posts).toHaveLength(0)

    const sent = Date.now()
    world.control.command(command)
    await expectLeftByMember(r, command)
    expect(r.endedAt()! - sent).toBeLessThan(50_000)

    // The submit was let finish: sent once, receipted once, and before the bot left.
    expect(r.posts).toHaveLength(1)
    const [record] = await formRecords(r.dataDir)
    expect(record).toMatchObject({ state: 'submitted', trustReason: 'host' })
    const left = (await r.events()).find((e) => e.type === 'state' && e.data.state === 'left_by_member')!
    expect(Date.parse(record!.submittedAt!)).toBeLessThanOrEqual(Date.parse(left.at))
    expect(world.ntfy.pings.map((p) => p.title).sort()).toEqual(['Attendance submitted', 'Joined: Data Mining'])
    // It left through the page's own Leave button.
    expect(r.logs.some((l) => l.includes('zoom: click leaveButton'))).toBe(true)
  })
}
