import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionJob } from '@tm/core'
import { CompanionApiError } from '../src/api'
import { NativeRunner } from '../src/jobs/native-runner'
import type { SpawnLike } from '../src/jobs/whisper'
import { KeepAwake } from '../src/keep-awake'

// ASR-02: a local meeting and a transcription never run together. `pause` is the local runner's hook into this class.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-native-pause-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const job = (id: string): CompanionJob => ({
  id,
  kind: 'native_transcription',
  state: 'pending',
  occurrenceId: `occ_${id}`,
  attempts: 0,
  payload: {
    occurrenceId: `occ_${id}`,
    entryName: 'Maths',
    start: '2026-10-21T08:00:00Z',
    timeZone: 'Asia/Kuala_Lumpur',
    durationSec: 60,
    flacBytes: 1000
  }
})

function rig(releaseStatus = 0) {
  const events: string[] = []
  const noSpawn: SpawnLike = () => {
    throw new Error('the transcriber must not start')
  }
  const runner = new NativeRunner({
    api: {
      async claim(id) {
        events.push(`claim ${id}`)
        return job(id)
      },
      async progress() {},
      async fail(id, error) {
        events.push(`fail ${id} ${error}`)
      },
      // The download hangs until the runner aborts it, like a long transfer.
      async downloadAudio(id, dest, signal) {
        await writeFile(dest, Buffer.alloc(10))
        events.push(`download ${id}`)
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      },
      async uploadTranscript() {},
      async release(id) {
        events.push(`release ${id}`)
        if (releaseStatus) throw new CompanionApiError(releaseStatus)
      }
    },
    settings: () => ({
      serverUrl: 'https://tm.example.com',
      summariesDir: '/s',
      whisper: { command: 'w', cwd: dir, model: 'm' }
    }),
    jobsDir: join(dir, 'jobs'),
    keepAwake: new KeepAwake({ start: () => 1, stop: () => {} }),
    spawn: noSpawn,
    notifier: { show: () => {} },
    openSettings: () => {},
    onError: (e) => events.push(`error ${String(e)}`)
  })
  return { runner, events, jobsDir: join(dir, 'jobs') }
}

const until = async (cond: () => boolean) => {
  const end = Date.now() + 4000
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await Bun.sleep(5)
  }
}

test('pause ends the running job, removes its folder, hands the job back and reports no failure', async () => {
  const r = rig()
  r.runner.offer([job('j1')])
  await until(() => r.events.includes('download j1'))
  await r.runner.pause()
  expect(r.runner.busy).toBe(false)
  expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
  expect(r.events).toEqual(['claim j1', 'download j1', 'release j1'])
})

test('while paused nothing is claimed; after resume the next poll offers the job again', async () => {
  const r = rig()
  await r.runner.pause()
  r.runner.offer([job('j1')])
  expect(r.events).toEqual([])
  r.runner.resume()
  r.runner.offer([job('j1')])
  await until(() => r.events.includes('download j1'))
  await r.runner.stop()
})

test('a job the website already took back (409) is not an error, and an idle pause releases nothing', async () => {
  const r = rig(409)
  r.runner.offer([job('j1')])
  await until(() => r.events.includes('download j1'))
  await r.runner.pause()
  expect(r.events).toEqual(['claim j1', 'download j1', 'release j1'])
  const idle = rig()
  await idle.runner.pause()
  expect(idle.events).toEqual([])
})

test('a release that fails for another reason is thrown', async () => {
  const r = rig(500)
  r.runner.offer([job('j1')])
  await until(() => r.events.includes('download j1'))
  await expect(r.runner.pause()).rejects.toThrow('HTTP 500')
})
