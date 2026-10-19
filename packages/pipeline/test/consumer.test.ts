import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { AiKeyError } from '@tm/ai'
import type { JobConfig, OccurrenceState } from '@tm/core'
import { eq } from 'drizzle-orm'
import { artefacts, occurrences, schema } from '@tm/web/db'
import { buildEntrySnapshot } from '@tm/web/db/job-config'
import { FakeNotifier } from '@tm/web/db/notifier'
import { sealColumn } from '@tm/web/db/secrets'
import { bossQueue, QUEUES } from '@tm/web/db/queues'
import { createTestDb, dropAllTestDbs, seedMember, testDbUrl } from '@tm/web/db/testing'
import { PgBoss } from 'pg-boss'
import { handlePipelineJob, type PipelineDeps } from '../src/consumer'
import { workPipeline } from '../src/consumer-main'
import type { PipelineResult } from '../src/pipeline'

const MASTER = Buffer.alloc(32, 5)
const START = new Date('2026-10-21T06:00:00Z')

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp('/home/user/.cache/tm-tmp/consumer-')
})
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

interface Options {
  state: OccurrenceState
  transcription: 'live' | 'native'
  stateReason?: string
  /** One entry per call of `run`, consumed in order: an error is thrown, `undefined` succeeds. */
  runFails?: (Error | undefined)[]
  /** Called inside `run`, with the job's data directory. */
  during?: (dir: string) => Promise<void>
}

async function pipelineFixture(o: Options) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  await db
    .update(schema.members)
    .set({ ntfyTopic: 'tm-topic', ntfyTokenEnc: sealColumn(MASTER, memberId, 'members.ntfy_token', 'ntfy-secret') })
    .where(eq(schema.members.id, memberId))
  await db
    .update(schema.aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(MASTER, memberId, 'ai_keys.dashscope_key', 'sk-dash-secret') })
    .where(eq(schema.aiKeys.memberId, memberId))
  const [entry] = await db
    .insert(schema.timetableEntries)
    .values({
      memberId,
      identityId,
      name: 'Data Mining',
      type: 'lecture',
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '14:00',
      endTime: '16:00',
      link: { kind: 'fixed', url: 'https://example.zoom.us/j/11111111111' },
      transcription: o.transcription
    })
    .returning()
  const [occ] = await db
    .insert(occurrences)
    .values({
      memberId,
      identityId,
      entryId: entry!.id,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: o.transcription,
      scheduledStart: START,
      scheduledEnd: new Date(START.getTime() + 2 * 3_600_000),
      deleteAfter: new Date(START.getTime() + 30 * 24 * 3_600_000),
      attempt: 1,
      state: o.state,
      stateReason: o.stateReason ?? null
    })
    .returning()
  const id = occ!.id
  await db
    .update(occurrences)
    .set({ entrySnapshot: await buildEntrySnapshot(db, id) })
    .where(eq(occurrences.id, id))

  const env = {
    dataRoot: await mkdtemp(`${tmp}/data-`),
    profileRoot: `${tmp}/profiles`,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const notifier = new FakeNotifier()
  const fails = [...(o.runFails ?? [])]
  const f = {
    db,
    id,
    env,
    notifier,
    memberId,
    runCfgs: [] as JobConfig[],
    remuxed: [] as string[],
    runs: 0,
    deps: undefined as unknown as PipelineDeps,
    occurrence: async () => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!
  }
  f.deps = {
    db,
    notifier,
    master: MASTER,
    env,
    run: async (cfg): Promise<PipelineResult> => {
      f.runs++
      f.runCfgs.push(cfg)
      await o.during?.(cfg.dataDir)
      const fail = fails.shift()
      if (fail) throw fail
      return { summaryPath: '', transcriptPath: '', slidesPath: '', chatPath: '' }
    },
    remux: async (dir) => {
      f.remuxed.push(dir)
    }
  }
  return f
}

describe('handlePipelineJob', () => {
  test('live mode runs the pipeline, remuxes the recording and completes', async () => {
    const f = await pipelineFixture({
      state: 'transcribing',
      transcription: 'live',
      during: async (dir) => {
        await mkdir(`${dir}/out`, { recursive: true })
        await writeFile(`${dir}/out/transcript.md`, '# Transcript')
      }
    })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('completed')
    const dir = `${f.env.dataRoot}/occurrences/${f.id}`
    expect(f.runCfgs.map((c) => c.dataDir)).toEqual([dir])
    expect(f.runCfgs[0]!.control).toBeNull()
    expect(f.runCfgs[0]!.ai.apiKey).toBe('sk-dash-secret')
    expect(f.remuxed).toEqual([dir])
    expect(await f.occurrence()).toMatchObject({ state: 'completed', stateReason: null })
    const rows = await f.db.select().from(artefacts).where(eq(artefacts.occurrenceId, f.id))
    expect(rows.map((r) => [r.kind, r.path])).toEqual([['transcript', 'out/transcript.md']])
    expect(f.notifier.sent).toEqual([])
  })

  test('native mode waits for the PC with one ping', async () => {
    const f = await pipelineFixture({ state: 'transcribing', transcription: 'native' })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('waiting_for_pc')
    expect(await handlePipelineJob(f.deps, f.id)).toBe('stale')
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Waiting for your PC: Data Mining'])
    expect((await f.occurrence()).state).toBe('waiting_for_pc')
    expect(f.runs).toBe(0)
  })

  test('a rejected key keeps everything and a re-run completes', async () => {
    const f = await pipelineFixture({
      state: 'transcribing',
      transcription: 'live',
      runFails: [new AiKeyError(401, 'bad key')]
    })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('key_error')
    expect(await f.occurrence()).toMatchObject({ state: 'post_processing', stateReason: 'ai_key_error' })
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Summary needs your key: Data Mining'])
    expect(f.remuxed).toEqual([])
    expect(await handlePipelineJob(f.deps, f.id)).toBe('completed')
    expect(await f.occurrence()).toMatchObject({ state: 'completed', stateReason: null })
    expect(f.notifier.sent).toHaveLength(1)
  })

  test('a re-run queued by the member (rerun_queued) is run and the reason is cleared', async () => {
    const f = await pipelineFixture({ state: 'post_processing', transcription: 'live', stateReason: 'rerun_queued' })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('completed')
    expect(await f.occurrence()).toMatchObject({ state: 'completed', stateReason: null })
  })

  test('a job that died in post_processing is resumed', async () => {
    const f = await pipelineFixture({ state: 'post_processing', transcription: 'live' })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('completed')
    expect(f.runs).toBe(1)
  })

  test('other failures fail the occurrence with one ping and keep the artefacts that exist', async () => {
    const f = await pipelineFixture({
      state: 'transcribing',
      transcription: 'live',
      runFails: [new Error('disk full')],
      during: async (dir) => {
        await mkdir(`${dir}/out`, { recursive: true })
        await writeFile(`${dir}/out/chat.md`, 'chat')
      }
    })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('failed')
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'pipeline_error' })
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Summary failed: Data Mining'])
    const rows = await f.db.select().from(artefacts).where(eq(artefacts.occurrenceId, f.id))
    expect(rows.map((r) => r.kind)).toEqual(['chat'])
    expect(await handlePipelineJob(f.deps, f.id)).toBe('stale')
    expect(f.notifier.sent).toHaveLength(1)
  })

  test('a failing remux fails the occurrence', async () => {
    const f = await pipelineFixture({ state: 'transcribing', transcription: 'live' })
    f.deps.remux = async () => {
      throw new Error('ffmpeg failed')
    }
    expect(await handlePipelineJob(f.deps, f.id)).toBe('failed')
    expect((await f.occurrence()).state).toBe('failed')
  })

  test.each<[OccurrenceState, string | undefined]>([
    ['completed', undefined],
    ['failed', 'pipeline_error'],
    ['in_meeting', undefined],
    ['uploading', undefined],
    ['waiting_for_pc', undefined],
    ['deleted', undefined],
    ['post_processing', 'something_else']
  ])('a job for an occurrence in %s (%s) is dropped', async (state, stateReason) => {
    const f = await pipelineFixture({ state, transcription: 'live', stateReason })
    expect(await handlePipelineJob(f.deps, f.id)).toBe('stale')
    expect(f.runs).toBe(0)
    expect((await f.occurrence()).state).toBe(state)
    expect(f.notifier.sent).toEqual([])
  })

  test('a job for an occurrence that does not exist is dropped', async () => {
    const f = await pipelineFixture({ state: 'transcribing', transcription: 'live' })
    expect(await handlePipelineJob(f.deps, '00000000-0000-4000-8000-000000000000')).toBe('stale')
  })

  test('two jobs for one occurrence never run at once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const f = await pipelineFixture({
      state: 'transcribing',
      transcription: 'live',
      during: async () => {
        started()
        await gate
      }
    })
    const first = handlePipelineJob(f.deps, f.id)
    await running
    expect(await handlePipelineJob(f.deps, f.id)).toBe('stale')
    release()
    expect(await first).toBe('completed')
    expect(f.runs).toBe(1)
  })
})

describe('workPipeline', () => {
  test('a job queued the way the website queues it runs the pipeline for its occurrence', async () => {
    const f = await pipelineFixture({ state: 'transcribing', transcription: 'live' })
    const boss = new PgBoss(testDbUrl(f.db))
    boss.on('error', (error) => {
      throw error
    })
    await boss.start()
    try {
      await workPipeline(boss, f.deps)
      await bossQueue(boss).send(QUEUES.pipeline, { occurrenceId: f.id })
      const deadline = Date.now() + 30_000
      while ((await f.occurrence()).state !== 'completed') {
        if (Date.now() > deadline) throw new Error('the job did not complete')
        await Bun.sleep(200)
      }
      expect(f.runs).toBe(1)
    } finally {
      await boss.stop({ graceful: false })
    }
  }, 40_000)
})
