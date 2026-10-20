import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobConfig } from '@tm/core'
import { runOccurrence } from '../src/run'
import { fakeDeps, makeCfg } from './helpers/fake-deps'

const MEET_LINK = 'https://meet.google.com/abc-defg-hij'

let cfg: JobConfig
let profileRoot: string
const saved = { root: process.env.TM_PROFILE_ROOT }

beforeEach(async () => {
  const base = await makeCfg('lecture')
  cfg = { ...base, entry: { ...base.entry, link: { kind: 'fixed', url: MEET_LINK } } }
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

test('a Meet run joins, stays in the meeting and ends with it', async () => {
  const d = fakeDeps({ platform: 'meet', states: ['in_meeting', 'in_meeting', 'ended'] })
  expect(await runOccurrence(cfg, d)).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(d.gotos[0]).toBe(MEET_LINK)
  expect(d.calls).toContain('join')
  expect(d.pings.map((p) => p.title)).toEqual(['Joined: Data Mining'])
})

test('a Meet sign-in wall records the Google account and pings meet_signin once', async () => {
  const d = fakeDeps({ platform: 'meet', joins: [{ kind: 'signin_required', host: 'accounts.google.com' }] })
  expect(await runOccurrence(cfg, d)).toMatchObject({ result: 'failed', reason: 'signin_required' })
  expect(d.pings).toHaveLength(1)
  expect(d.pings[0]!.message).toContain('Google asked to sign in')
  const accounts = (await events()).filter((e) => e.type === 'state' && e.data.signedIn === false)
  expect(accounts.map((e) => e.data)).toEqual([{ account: 'google', signedIn: false }])
})

test('a Meet join whose device toggle cannot be read fails the run', async () => {
  const d = fakeDeps({ platform: 'meet', joins: [{ kind: 'failed', reason: 'device_toggle_missing' }] })
  expect(await runOccurrence(cfg, d)).toMatchObject({ result: 'failed', reason: 'device_toggle_missing' })
  expect(d.calls).not.toContain('connectOutputAudio')
})

test('the layout is kept on every 10-second refresh of a Meet run', async () => {
  const d = fakeDeps({ platform: 'meet', states: ['in_meeting', 'in_meeting', 'in_meeting', 'ended'] })
  await runOccurrence(cfg, d)
  expect(d.layoutCalls).toBeGreaterThan(1)
})
