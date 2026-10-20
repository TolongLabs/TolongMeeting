import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobConfig } from '@tm/core'
import { runOccurrence } from '../src/run'
import { fakeDeps, makeCfg, type FakeDeps } from './helpers/fake-deps'

const TEAMS_LINK = 'https://teams.live.com/meet/9876543210987?p=TESTPASS'

let cfg: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT }

beforeEach(async () => {
  const base = await makeCfg('lecture')
  cfg = { ...base, entry: { ...base.entry, link: { kind: 'fixed', url: TEAMS_LINK } } }
  profileRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-profiles-'))
  process.env.TM_PROFILE_ROOT = profileRoot
})

afterEach(async () => {
  if (saved.root === undefined) delete process.env.TM_PROFILE_ROOT
  else process.env.TM_PROFILE_ROOT = saved.root
  await rm(join(cfg.dataDir, '..'), { recursive: true, force: true })
  await rm(profileRoot, { recursive: true, force: true })
})

const events = async () =>
  (await readFile(join(cfg.dataDir, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
const titles = (d: FakeDeps) => d.pings.map((p) => p.title)

test('a Teams run joins, stays in the meeting and ends with it', async () => {
  const d = fakeDeps({ platform: 'teams', states: ['in_meeting', 'in_meeting', 'ended'] })
  const o = await runOccurrence(cfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(d.gotos[0]).toBe(TEAMS_LINK)
  expect(d.calls).toContain('join')
  expect(titles(d)).toEqual(['Joined: Data Mining'])
  const states = (await events()).filter((e) => e.type === 'state').map((e) => e.data.state)
  expect(states).toContain('in_meeting')
})

test('a Teams sign-in wall records the Microsoft account and pings once', async () => {
  const d = fakeDeps({ platform: 'teams', joins: [{ kind: 'signin_required', host: 'login.microsoftonline.com' }] })
  expect(await runOccurrence(cfg, d)).toMatchObject({ result: 'failed', reason: 'signin_required' })
  expect(d.pings).toHaveLength(1)
  expect(d.pings[0]!.message).toContain('Teams asked to sign in')
  const accounts = (await events()).filter((e) => e.type === 'state' && e.data.signedIn === false)
  expect(accounts.map((e) => e.data)).toEqual([{ account: 'teams', signedIn: false }])
})

test('a Zoom sign-in wall still records the Zoom account', async () => {
  const d = fakeDeps({ joins: [{ kind: 'signin_required', host: 'zoom.us' }] })
  await runOccurrence(cfg, d)
  expect(d.pings[0]!.message).toContain('Zoom')
  const accounts = (await events()).filter((e) => e.type === 'state' && e.data.signedIn === false)
  expect(accounts.map((e) => e.data)).toEqual([{ account: 'zoom', signedIn: false }])
})

test('removal from a Teams meeting pings once', async () => {
  const d = fakeDeps({ platform: 'teams', states: ['in_meeting', 'removed'] })
  expect(await runOccurrence(cfg, d)).toMatchObject({ endedBy: 'removed' })
  expect(d.pings.filter((p) => p.message.includes('removed the bot'))).toHaveLength(1)
})

test('the layout is kept on every 10-second refresh, not only after joining', async () => {
  const d = fakeDeps({ platform: 'teams', states: ['in_meeting', 'in_meeting', 'in_meeting', 'ended'] })
  await runOccurrence(cfg, d)
  expect(d.layoutCalls).toBeGreaterThan(1)
})
