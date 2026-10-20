import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { FormRecord } from '@tm/core'
import {
  finished,
  keepOrRemove,
  readEvents,
  startShared,
  startWorld,
  textFiles,
  until,
  type Running,
  type Shared,
  type World
} from './harness'

export const MINUTE = 60_000

export interface Ctx {
  readonly world: World
  /** Remember the run so the hooks stop it and clean up after the test. */
  track(r: Running): Running
}

// The hooks every e2e spec file needs: a fresh world (fakes for Zoom, ntfy, AI, ASR and control) per test, and, after it,
// the run stopped (a failed test must not leave a browser behind) and the world removed unless the test failed.
export function useWorld(): Ctx {
  let shared: Shared
  let world: World
  let runs: Running[] = []
  test.beforeAll(() => {
    shared = startShared()
  })
  test.beforeEach(async () => {
    world = await startWorld(shared)
    runs = []
  })
  test.afterEach(async ({}, testInfo) => {
    for (const run of runs) {
      run.abort()
      await Promise.race([run.outcome.catch(() => undefined), new Promise((r) => setTimeout(r, 70_000))])
    }
    await world.stop()
    await keepOrRemove(world, testInfo.status !== testInfo.expectedStatus)
  })
  return {
    get world() {
      return world
    },
    track: (r) => {
      runs.push(r)
      return r
    }
  }
}

export const stateReached = (r: Running, state: string) => async () =>
  (await readEvents(r.dataDir)).some((e) => e.type === 'state' && e.data.state === state)

export const eventsOf = async (r: Running, type: string) => (await readEvents(r.dataDir)).filter((e) => e.type === type)

export const formRecords = async (dataDir: string): Promise<FormRecord[]> => {
  const dir = join(dataDir, 'forms')
  const records: FormRecord[] = []
  for (const name of await readdir(dir))
    records.push(JSON.parse(await readFile(join(dir, name, 'record.json'), 'utf8')) as FormRecord)
  return records
}

/** The form of this provider has reached a state it stays in (the record file is written with the last event). */
export const formSettled = async (r: Running, provider: string): Promise<boolean> =>
  (await eventsOf(r, 'form')).some(
    (e) =>
      e.data.provider === provider &&
      ['submitted', 'untrusted', 'failed', 'not_attendance'].includes(String(e.data.state))
  )

export const formStates = async (r: Running): Promise<string[]> =>
  (await r.events())
    .filter((e) => e.type === 'form' && typeof e.data.state === 'string')
    .map((e) => String(e.data.state))

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Lobby, the host lets the bot in, and the first loops are running. */
export async function joinMeeting(world: World, r: Running, admit: () => void | Promise<void>): Promise<void> {
  const alive = finished(r)
  await until('the bot in the waiting room', 90_000, stateReached(r, 'in_lobby'), alive)
  await admit()
  await until('the bot in the meeting', 60_000, async () => (await eventsOf(r, 'joined')).length === 1, alive)
  await until('the joined ping', 30_000, () => world.ntfy.titled('Joined:').length === 1, alive)
}

/**
 * No join link or passcode in any ping, any file of the run but the raw chat, any event, the console output, or what the
 * AI service was sent. `hosts` are the join links' host names: the AI service gets none of them either.
 */
export async function expectNoSecrets(world: World, r: Running, secrets: string[], hosts: string[]): Promise<void> {
  for (const ping of world.ntfy.pings)
    for (const secret of secrets) expect(ping.raw, `ping ${ping.title}`).not.toContain(secret)
  for (const request of world.ai.requests) {
    for (const secret of [...secrets, ...hosts, 'A00000000', 'student@example.edu.my'])
      expect(request.body, `AI request to ${request.model}`).not.toContain(secret)
  }
  const files = await textFiles(r.dataDir)
  for (const [name, text] of files)
    for (const key of ['sk-e2e-key', 'tk-e2e-token', world.control.token]) expect(text, name).not.toContain(key)
  for (const secret of [...secrets, 'sk-e2e-key', 'tk-e2e-token', world.control.token])
    expect(r.logs.join('\n'), 'console output').not.toContain(secret)
  const holding = [...files].filter(([, text]) => secrets.some((s) => text.includes(s))).map(([name]) => name)
  // The chat is kept as it arrived; nothing derived from it holds a secret.
  expect(holding.filter((name) => name !== 'chat.jsonl')).toEqual([])
}
