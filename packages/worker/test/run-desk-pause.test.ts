import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlTokenHash,
  vncSecret,
  type ControlCommand,
  type Heartbeat,
  type JobConfig,
  type MeetingEvent,
  type OccurrenceState
} from '@tm/core'
import { SIGNIN_START_URLS } from '../src/control/vnc'
import { runOccurrence } from '../src/run'
import { fakeDeps, makeCfg, type FakeDeps, type FakeOptions } from './helpers/fake-deps'

let base: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT, site: process.env.TM_PUBLIC_URL }
const servers: { stop(): void }[] = []

beforeEach(async () => {
  base = await makeCfg('lecture')
  profileRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-profiles-'))
  process.env.TM_PROFILE_ROOT = profileRoot
  process.env.TM_PUBLIC_URL = 'https://tolong.example.com'
})

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop()
  for (const [name, value] of [
    ['TM_PROFILE_ROOT', saved.root],
    ['TM_PUBLIC_URL', saved.site]
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(join(base.dataDir, '..'), { recursive: true, force: true })
  await rm(profileRoot, { recursive: true, force: true })
})

// A control server that records every heartbeat. `answer` gets the heartbeat and the events seen so far, and says which
// commands to send.
function control(answer: (body: Heartbeat, events: MeetingEvent[]) => ControlCommand[]) {
  const seen: Heartbeat[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Heartbeat
      seen.push(body)
      const commands = answer(
        body,
        seen.flatMap((b) => b.events)
      )
      return Response.json({ ackedEvents: body.events.length, commands, link: null })
    }
  })
  servers.push({ stop: () => server.stop(true) })
  const events = (): MeetingEvent[] => seen.flatMap((b) => b.events)
  const states = (): OccurrenceState[] =>
    events()
      .filter((e) => e.type === 'state' && 'state' in e.data)
      .map((e) => e.data.state as OccurrenceState)
  const signins = (): unknown[] =>
    events()
      .filter((e) => e.type === 'state' && 'signin' in e.data)
      .map((e) => e.data)
  return { seen, events, states, signins, url: `http://127.0.0.1:${server.port}/api/control` }
}

const withControl = (url: string): JobConfig => ({ ...base, control: { url, token: '1.token' } })

// Real time passes at each wait (`pace` ms), so heartbeats and their replies run while the fake clock does.
function paced(d: FakeDeps, pace = 3): FakeDeps {
  const inner = d.sleep
  d.sleep = async (ms) => {
    await inner(ms)
    await Bun.sleep(pace)
  }
  d.heartbeat = { intervalMs: 15, backoff: { firstMs: 10, maxMs: 40 } }
  return d
}
const fake = (opts: FakeOptions = {}, pace?: number) => paced(fakeDeps(opts), pace)

const sent = (events: MeetingEvent[], signin: 'paused' | 'resumed') =>
  events.some((e) => e.type === 'state' && e.data.signin === signin)

test('a sign-in pause during a meeting exposes only the desk, keeps recording, and checkpoints when it ends', async () => {
  let sentPause = false
  let sentResume = false
  let sentLeave = false
  const c = control((b, events) => {
    if (b.state !== 'in_meeting') return []
    if (!sentPause) return ((sentPause = true), ['pause_for_signin'])
    if (sent(events, 'paused') && !sentResume) return ((sentResume = true), ['resume_after_signin'])
    if (sent(events, 'resumed') && !sentLeave) return ((sentLeave = true), ['leave_now'])
    return []
  })
  const d = fake({ states: 'always_in_meeting' })
  const during: { vnc: number; recording: boolean }[] = []
  const startVnc = d.startVnc
  d.startVnc = async (...args) => {
    const stopper = await startVnc(...args)
    during.push({
      vnc: d.vnc.length,
      recording: d.calls.includes('startRecorder') && !d.calls.includes('recorder.stop')
    })
    return stopper
  }
  let checkpoints = 0
  const checkpoint = d.checkpointProfile
  d.checkpointProfile = async (...args) => {
    checkpoints += 1
    return checkpoint(...args)
  }
  const cfg = withControl(c.url)
  const o = await runOccurrence(cfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'member_left' })

  expect(c.signins()).toEqual([{ signin: 'paused' }, { signin: 'resumed', reason: 'command' }])
  expect(during).toEqual([{ vnc: 1, recording: true }])
  // One checkpoint when the pause ended, one at teardown.
  expect(checkpoints).toBe(2)
  expect(d.vnc).toEqual([]) // stopped again
  expect(d.tabs).toEqual([]) // closed again
  expect(d.calls).toContain('openSigninTabs')
  // The stage never stopped: the recorder ran until the leave.
  expect(d.calls.indexOf('startRecorder')).toBeLessThan(d.calls.indexOf('leave'))
  // The password reaches no heartbeat.
  const secret = vncSecret(controlTokenHash('1.token'))
  expect(JSON.stringify(c.seen)).not.toContain(secret)
})

test('the view is given the desk rectangle, the display and the derived password', async () => {
  let sentPause = false
  const c = control((b) => (b.state === 'in_meeting' && !sentPause ? ((sentPause = true), ['pause_for_signin']) : []))
  const d = fake({ states: [...Array<'in_meeting'>(40).fill('in_meeting'), 'ended'] })
  const calls: unknown[] = []
  const startVnc = d.startVnc
  d.startVnc = async (display, desk, secret, opts) => {
    calls.push({ display, desk, secret, opts })
    return startVnc(display, desk, secret, opts)
  }
  d.openSigninTabs = async (_desk, urls) => {
    calls.push({ urls })
    return async () => undefined
  }
  await runOccurrence(withControl(c.url), d)
  expect(calls).toEqual([
    {
      display: ':99',
      desk: { x: 1920, y: 0, width: 1920, height: 1080 },
      secret: vncSecret(controlTokenHash('1.token')),
      opts: undefined
    },
    { urls: SIGNIN_START_URLS }
  ])
})

test('a pause still open when the meeting ends is closed at teardown, before the browser, without a resume', async () => {
  let sentPause = false
  let sentLeave = false
  const c = control((b, events) => {
    if (b.state !== 'in_meeting') return []
    if (!sentPause) return ((sentPause = true), ['pause_for_signin'])
    if (sent(events, 'paused') && !sentLeave) return ((sentLeave = true), ['leave_now'])
    return []
  })
  const d = fake({ states: 'always_in_meeting' })
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ endedBy: 'member_left' })
  expect(d.vnc).toEqual([])
  expect(c.signins()).toEqual([{ signin: 'paused' }])
})

test('a pause command that fails to start the view is reported and pinged, and the meeting goes on', async () => {
  let sentPause = false
  const c = control((b) => (b.state === 'in_meeting' && !sentPause ? ((sentPause = true), ['pause_for_signin']) : []))
  const d = fake({ states: [...Array<'in_meeting'>(40).fill('in_meeting'), 'ended'] })
  d.startVnc = async () => {
    throw new Error('cannot start x11vnc')
  }
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(c.signins()).toEqual([])
  expect(c.events().some((e) => e.type === 'error' && e.data.where === 'desk pause')).toBe(true)
  expect(d.pings.some((p) => p.message.includes('desk pause'))).toBe(true)
})

test('an expired form sign-in waits in waiting_for_signin until the member is done, then checks again', async () => {
  let signedOut = true
  let sentPause = false
  let sentResume = false
  const c = control((b, events) => {
    if (b.state !== 'waiting_for_signin') return []
    if (!sentPause) return ((sentPause = true), ['pause_for_signin'])
    if (sent(events, 'paused') && !sentResume) return ((sentResume = true), ['resume_after_signin'])
    return []
  })
  // The fake minute passes slowly enough here for the pause round trip.
  const d = fake({ states: ['ended'], signedOut: () => (signedOut ? ['google'] : []) }, 20)
  const checkpoint = d.checkpointProfile
  d.checkpointProfile = async (...args) => {
    // The member signed in during the pause; its checkpoint runs before the check that follows.
    signedOut = false
    return checkpoint(...args)
  }
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed' })
  expect(c.states().slice(0, 4)).toEqual([
    'verifying_accounts',
    'waiting_for_signin',
    'verifying_accounts',
    'watching_for_link'
  ])
  expect(
    c
      .events()
      .filter((e) => e.type === 'state' && 'account' in e.data)
      .map((e) => e.data)
  ).toEqual([
    { account: 'google', signedIn: false },
    { account: 'google', signedIn: true }
  ])
  expect(d.pings.filter((p) => p.actions?.some((a) => a.label === 'Sign in again'))).toHaveLength(1)
  expect(c.signins()).toEqual([{ signin: 'paused' }, { signin: 'resumed', reason: 'command' }])
})

test('a form sign-in nobody completes is waited for only until T-5, then the meeting goes on', async () => {
  const c = control(() => [])
  const d = fake({ states: ['ended'], signedOut: ['google'] })
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed' })
  expect(c.states().slice(0, 4)).toEqual([
    'verifying_accounts',
    'waiting_for_signin',
    'verifying_accounts',
    'watching_for_link'
  ])
  expect(d.joinCount).toBe(1)
})

test('without a control channel nobody can sign in, so an expired form sign-in is not waited for', async () => {
  const d = fake({ states: ['ended'], signedOut: ['google'] })
  await runOccurrence(base, d)
  expect(d.pings.some((p) => p.title.startsWith('Alert'))).toBe(true)
  expect(d.calls).not.toContain('startVnc')
})
