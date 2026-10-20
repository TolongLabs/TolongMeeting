import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ControlCommand, Heartbeat, JobConfig, MeetingEvent } from '@tm/core'
import { runOccurrence } from '../src/run'
import { resetWatcherEnv, configureWatchers, WatcherChatError, WatcherSigninError } from '../src/watchers/loop'
import type { ChatSourceReader } from '../src/watchers/loop'
import { fakeDeps, makeCfg, type FakeDeps, type FakeOptions } from './helpers/fake-deps'

const LINK = 'https://example.zoom.us/j/00000000001?pwd=PASSCODE'
const NEWER = 'https://example.zoom.us/j/00000000002?pwd=PASSCODE'
const PASTED = 'https://example.zoom.us/j/00000000009?pwd=PASSCODE'
const FORM = 'https://forms.gle/TESTFORM1'

let base: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT, site: process.env.TM_PUBLIC_URL }
const servers: { stop(): void }[] = []

beforeEach(async () => {
  base = await makeCfg('lecture')
  base = {
    ...base,
    entry: {
      ...base.entry,
      link: { kind: 'chat', app: 'whatsapp', chat: 'Data Mining Class' },
      trustedSenders: ['Lecturer']
    }
  }
  profileRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-profiles-'))
  process.env.TM_PROFILE_ROOT = profileRoot
  process.env.TM_PUBLIC_URL = 'https://tolong.example.com'
})

afterEach(async () => {
  resetWatcherEnv()
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

const message = (key: string, sender: string, links: string[]): ChatMessage => ({
  key,
  sender,
  senderRole: 'unknown',
  time: '',
  seenAt: '',
  text: '',
  links,
  replyTo: null
})

// A chat source with a fixed history and a script for each later read.
function reader(history: ChatMessage[], latest: (call: number) => ChatMessage[] = () => []): ChatSourceReader {
  let call = 0
  return { open: async () => undefined, history: async () => history, latest: async () => latest((call += 1)) }
}

// The watcher loop polls every few milliseconds instead of every 12 to 45 seconds.
const pollFast = (): void => configureWatchers({ sleep: async () => void (await Bun.sleep(4)) })

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
  const states = () =>
    events().flatMap((e) => (e.type === 'state' && 'state' in e.data ? [e.data.state as string] : []))
  const accounts = () => events().flatMap((e) => (e.type === 'state' && 'account' in e.data ? [e.data] : []))
  return { seen, events, states, accounts, url: `http://127.0.0.1:${server.port}/api/control` }
}

const withControl = (url: string, extra: Partial<JobConfig> = {}): JobConfig => ({
  ...base,
  ...extra,
  control: { url, token: '1.token' }
})

// Real time passes at each wait, so heartbeats and the watcher loop run while the fake clock does.
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

const logged = async (cfg: JobConfig) =>
  (await readFile(join(cfg.dataDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as MeetingEvent)

test('a link the watcher finds is joined at T-10, kept for a restart, and never reported', async () => {
  const d = fakeDeps({ states: ['ended'], watcher: { reader: reader([message('1', 'Lecturer', [LINK])]) } })
  const o = await runOccurrence(base, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(d.gotos).toEqual([LINK])
  expect(d.watcherStarts).toEqual([base.entry.link])

  const log = await logged(base)
  expect(log.find((e) => e.type === 'state' && e.data.state === 'joining')?.data).toEqual({
    state: 'joining',
    link: { source: 'watched', host: 'example.zoom.us' }
  })
  expect(log.filter((e) => e.type === 'state' && e.data.account === 'whatsapp').map((e) => e.data)).toEqual([
    { account: 'whatsapp', signedIn: true }
  ])
  // The link, with its passcode, is in the private file only.
  const kept = join(base.dataDir, 'joined-link')
  expect(await readFile(kept, 'utf8')).toBe(LINK)
  expect((await stat(kept)).mode & 0o777).toBe(0o600)
  expect(await readFile(join(base.dataDir, 'events.jsonl'), 'utf8')).not.toContain('PASSCODE')
  expect(JSON.stringify(d.pings)).not.toContain('PASSCODE')

  // The watcher stops, and its tab closes, before the profile is checkpointed.
  expect(d.calls.indexOf('watcher.stop')).toBeGreaterThan(d.calls.indexOf('leave'))
  expect(d.calls.indexOf('watcher.stop')).toBeLessThan(d.calls.indexOf('checkpointProfile'))
  expect(d.watcherTabs).toEqual([{ closed: true }])
})

test('a pasted link beats the watched one; the newest watched link beats an older one', async () => {
  const history = [message('1', 'Lecturer', [LINK]), message('2', 'Lecturer', [NEWER])]
  const watched = fakeDeps({ states: ['ended'], watcher: { reader: reader(history) } })
  await runOccurrence(base, watched)
  expect(watched.gotos).toEqual([NEWER])

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Heartbeat
      return Response.json({ ackedEvents: body.events.length, commands: [], link: PASTED })
    }
  })
  servers.push({ stop: () => server.stop(true) })
  const pasted = fake({ states: ['ended'], watcher: { reader: reader(history) } })
  const cfg = withControl(`http://127.0.0.1:${server.port}/api/control`, { dataDir: join(base.dataDir, '..', 'again') })
  await runOccurrence(cfg, pasted)
  expect(pasted.gotos).toEqual([PASTED])
  const joining = (await logged(cfg)).find((e) => e.type === 'state' && e.data.state === 'joining')
  expect(joining?.data).toEqual({ state: 'joining', link: { source: 'pasted', host: 'example.zoom.us' } })
  await rm(cfg.dataDir, { recursive: true, force: true })
})

test('a restarted attempt rejoins the link an earlier attempt kept, with no watcher to find it again', async () => {
  await mkdir(base.dataDir, { recursive: true })
  await writeFile(join(base.dataDir, 'joined-link'), LINK, { mode: 0o600 })
  const d = fakeDeps({ states: ['ended'] })
  const o = await runOccurrence({ ...base, attempt: 2 }, d)
  expect(o).toMatchObject({ result: 'completed' })
  expect(d.gotos).toEqual([LINK])
  expect(d.watcherStarts).toEqual([])
  const joining = (await logged(base)).find((e) => e.type === 'state' && e.data.state === 'joining')
  expect(joining?.data).toEqual({ state: 'joining', link: { source: 'watched', host: 'example.zoom.us' } })
})

test('a first attempt ignores a kept link it did not write', async () => {
  const d = fakeDeps({ states: ['ended'], watcher: { reader: reader([message('1', 'Lecturer', [LINK])]) } })
  await mkdir(base.dataDir, { recursive: true })
  await writeFile(join(base.dataDir, 'joined-link'), NEWER)
  await runOccurrence(base, d)
  expect(d.gotos).toEqual([LINK])
})

test('no link by T+30: the member is pinged at T and again when the bot stops, and the watcher stops first', async () => {
  const d = fakeDeps({ watcher: { reader: reader([]) } })
  const o = await runOccurrence(base, d)
  expect(o).toMatchObject({ result: 'failed', reason: 'no_link' })
  expect(d.calls).not.toContain('startRecorder')
  expect(d.pings.map((p) => p.title).sort()).toEqual(['Alert: Data Mining', 'Not attended: Data Mining'])
  expect(d.pings.find((p) => p.title.startsWith('Not attended'))).toEqual({
    title: 'Not attended: Data Mining',
    message: 'No meeting link arrived by Wed 21 Oct, 20:30, so the bot stopped without joining Data Mining.',
    priority: 'default',
    actions: [{ label: 'Open meeting page', url: 'https://tolong.example.com/meetings/occ-1' }]
  })
  expect(d.calls.indexOf('watcher.stop')).toBeLessThan(d.calls.indexOf('checkpointProfile'))
  expect(d.calls).toContain('checkpointProfile')
  await expect(stat(join(base.dataDir, 'joined-link'))).rejects.toThrow()
})

test('a chat the watcher cannot find is pinged with its reason, and the entry goes on with pasted links only', async () => {
  const d = fakeDeps({ watcher: { fails: () => new WatcherChatError('not_found') } })
  const o = await runOccurrence(base, d)
  expect(o).toMatchObject({ result: 'failed', reason: 'no_link' })
  const ping = d.pings.find((p) => p.title === 'Not watching WhatsApp: Data Mining')
  expect(ping?.message).toBe(
    "The bot couldn't find the chat named on the timetable entry. Check it, and paste the meeting link on the meeting page this time."
  )
  expect(ping?.actions).toEqual([{ label: 'Open meeting page', url: 'https://tolong.example.com/meetings/occ-1' }])
  expect((await logged(base)).some((e) => e.type === 'error' && e.data.reason === 'watcher_not_found')).toBe(true)
  expect(d.watcherTabs).toEqual([{ closed: true }])
})

test('an app with no watcher yet leaves a chat entry to pasted links without a ping', async () => {
  const cfg = {
    ...base,
    entry: { ...base.entry, link: { kind: 'chat', app: 'teams', chat: 'Data Mining' } }
  } as JobConfig
  const d = fakeDeps({ watcher: {} })
  d.startWatcher = () => null
  const o = await runOccurrence(cfg, d)
  expect(o).toMatchObject({ reason: 'no_link' })
  expect(d.pings.map((p) => p.title).sort()).toEqual(['Alert: Data Mining', 'Not attended: Data Mining'])
  expect(d.watcherTabs).toEqual([])
})

// The member signs in through the desk pause: the server sends pause_for_signin, then resume_after_signin.
function signinServer() {
  let sentPause = false
  let sentResume = false
  return control((b, events) => {
    if (b.state !== 'waiting_for_signin') return []
    if (!sentPause) return ((sentPause = true), ['pause_for_signin'])
    const paused = events.some((e) => e.type === 'state' && e.data.signin === 'paused')
    if (paused && !sentResume) return ((sentResume = true), ['resume_after_signin'])
    return []
  })
}

test('a chat app that is signed out waits for the member, then the watcher starts again and finds the link', async () => {
  const c = signinServer()
  const d = fake(
    {
      states: ['ended'],
      watcher: {
        reader: reader([message('1', 'Lecturer', [LINK])]),
        fails: (call) => (call === 1 ? new WatcherSigninError('web.whatsapp.com') : null)
      }
    },
    20
  )
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed' })
  expect(c.states().slice(0, 5)).toEqual([
    'verifying_accounts',
    'waiting_for_signin',
    'verifying_accounts',
    'watching_for_link',
    'joining'
  ])
  expect(c.accounts().filter((a) => a.account === 'whatsapp')).toEqual([
    { account: 'whatsapp', signedIn: false },
    { account: 'whatsapp', signedIn: true }
  ])
  const pings = d.pings.filter((p) => p.title === 'Not watching WhatsApp: Data Mining')
  expect(pings).toHaveLength(1)
  expect(pings[0]!.actions?.map((a) => a.label)).toEqual(['Open meeting page', 'Sign in again'])
  expect(d.watcherStarts).toHaveLength(2)
  expect(d.gotos).toEqual([LINK])
})

test('a second failed start leaves the entry with pasted links only, with no second ping and no second wait', async () => {
  const c = signinServer()
  const d = fake({ watcher: { fails: () => new WatcherSigninError('web.whatsapp.com') } }, 20)
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'failed', reason: 'no_link' })
  expect(d.watcherStarts).toHaveLength(2)
  expect(c.states().filter((s) => s === 'waiting_for_signin')).toHaveLength(1)
  expect(d.pings.filter((p) => p.title === 'Not watching WhatsApp: Data Mining')).toHaveLength(1)
  expect(c.accounts().filter((a) => a.signedIn === false)).toHaveLength(2)
})

test('in the meeting the watcher offers form links; a sign-out and a return are reported', async () => {
  pollFast()
  const d = fake({
    states: [...Array<'in_meeting'>(120).fill('in_meeting'), 'ended'],
    watcher: {
      reader: (() => {
        let after = 0
        return reader([message('1', 'Lecturer', [LINK])], () => {
          if (d.joinCount === 0) return []
          after += 1
          if (after === 1) return [message('2', 'Lecturer', [FORM])]
          if (after === 3) throw new WatcherSigninError('web.whatsapp.com')
          return []
        })
      })()
    }
  })
  const c = control(() => [])
  const o = await runOccurrence(withControl(c.url), d)
  expect(o).toMatchObject({ result: 'completed' })
  expect(d.forms?.offers.map((f) => f.url)).toEqual([FORM])
  expect(c.accounts().filter((a) => a.account === 'whatsapp')).toEqual([
    { account: 'whatsapp', signedIn: true },
    { account: 'whatsapp', signedIn: false },
    { account: 'whatsapp', signedIn: true }
  ])
  const out = d.pings.filter((p) => p.title === 'Not watching WhatsApp: Data Mining')
  expect(out.map((p) => p.message)).toEqual([
    "WhatsApp signed the bot out while it was watching. Sign in again; until then, new links in the chat aren't seen."
  ])
  expect(c.events().some((e) => e.type === 'error' && e.data.reason === 'watcher_signed_out')).toBe(true)
})

test('a work entry takes the meeting link from the chat but sees no forms', async () => {
  pollFast()
  const work = { ...(await makeCfg('work')), entry: { ...base.entry, type: 'work' as const } }
  const d = fake({
    states: [...Array<'in_meeting'>(60).fill('in_meeting'), 'ended'],
    watcher: {
      reader: reader([message('1', 'Lecturer', [LINK])], () =>
        d.joinCount > 0 ? [message('2', 'Lecturer', [FORM])] : []
      )
    }
  })
  const o = await runOccurrence({ ...work, entry: { ...work.entry, type: 'work' } }, d)
  expect(o).toMatchObject({ result: 'completed' })
  expect(d.gotos).toEqual([LINK])
  expect(d.forms).toBeNull()
  expect(d.pings.some((p) => p.message.includes('form'))).toBe(false)
  await rm(join(work.dataDir, '..'), { recursive: true, force: true })
})

test('a sign-in pause opens no second tab on the watcher host and keeps the watcher tab', async () => {
  pollFast()
  let sentPause = false
  const c = control((b) => (b.state === 'in_meeting' && !sentPause ? ((sentPause = true), ['pause_for_signin']) : []))
  const d = fake({
    states: [...Array<'in_meeting'>(60).fill('in_meeting'), 'ended'],
    watcher: { reader: reader([message('1', 'Lecturer', [LINK])]) }
  })
  const opened: string[][] = []
  const inner = d.openSigninTabs
  d.openSigninTabs = async (...args) => {
    const close = await inner(...args)
    opened.push([...d.tabs])
    return close
  }
  await runOccurrence(withControl(c.url), d)
  expect(d.signinOptions).toEqual([{ exclude: ['web.whatsapp.com'] }])
  expect(opened).toHaveLength(1)
  expect(opened[0]!.some((u) => u.includes('web.whatsapp.com'))).toBe(false)
  expect(opened[0]).toHaveLength(5)
})

test('a sign-in pause while the watcher is still starting keeps its tabs off the chat host', async () => {
  pollFast()
  const opening = Promise.withResolvers<void>()
  const pauseSent = Promise.withResolvers<void>()
  let sentPause = false
  let sentResume = false
  const c = control((b, events) => {
    if (!sentPause && b.state === 'verifying_accounts')
      return ((sentPause = true), pauseSent.resolve(), ['pause_for_signin'])
    const paused = events.some((e) => e.type === 'state' && e.data.signin === 'paused')
    if (paused && !sentResume) return ((sentResume = true), ['resume_after_signin'])
    return []
  })
  // The chat opens slowly (up to a minute in a real run): the pause comes while `open` is still in flight, and the
  // watcher is not set yet.
  const slow: ChatSourceReader = {
    ...reader([message('1', 'Lecturer', [LINK])]),
    open: async () => {
      await opening.promise
    }
  }
  const d = fake({ states: ['ended'], watcher: { reader: slow } }, 10)
  const opened: string[][] = []
  const inner = d.openSigninTabs
  d.openSigninTabs = async (...args) => {
    const close = await inner(...args)
    opened.push([...d.tabs])
    return close
  }
  const run = runOccurrence(withControl(c.url), d)
  await pauseSent.promise
  await Bun.sleep(100)
  opening.resolve()
  expect(await run).toMatchObject({ result: 'completed' })
  expect(d.signinOptions[0]?.exclude).toEqual(['web.whatsapp.com'])
  expect(opened).toHaveLength(1)
  expect(opened[0]!.some((u) => u.includes('web.whatsapp.com'))).toBe(false)
  expect(d.watcherTabs).toEqual([{ closed: true }])
})

test('a restarted attempt hands the forms in the chat to a dispatcher that already exists', async () => {
  configureWatchers({ sleep: async () => void (await Bun.sleep(4)) })
  await mkdir(base.dataDir, { recursive: true })
  await writeFile(join(base.dataDir, 'joined-link'), LINK, { mode: 0o600 })
  const d = fakeDeps({ states: ['ended'], watcher: { reader: reader([message('1', 'Lecturer', [FORM])]) } })
  await runOccurrence({ ...base, attempt: 2 }, d)
  expect(d.calls.indexOf('startFormDispatcher')).toBeLessThan(d.calls.indexOf('startWatcher'))
  expect(d.forms?.offers.map((f) => f.url)).toEqual([FORM])
  // No "link seen, not checked" ping: the form went to the dispatcher.
  expect(d.pings.filter((p) => p.title.startsWith('Form') || p.title.startsWith('Link'))).toEqual([])
})
