import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NATIVE_UPLOAD_MAX_BODY_BYTES, NATIVE_UPLOAD_MAX_FILE_BYTES, type NativeJobPayload } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionJobs, deviceTokens, occurrences, type Db } from '../db'
import { claimJob, createCompanionJob } from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { QUEUES, type Queue } from '../db/queues'
import { createTestDb, dropAllTestDbs, FakeQueue } from '../db/testing'
import { handleAudioRequest, handleTranscriptRequest } from '../lib/companion/native'
import { withDevice } from '../lib/companion/scope'
import { newDeviceToken } from '../lib/companion/tokens'
import { openOccurrenceFile } from '../lib/files'

let db: Db
let fx: Awaited<ReturnType<typeof seedCompanionFixture>>
let work: string
let occDir: string
let previousRoot: string | undefined
let queue: FakeQueue | Queue
const tokens = {} as Record<'a1' | 'a2' | 'b1', string>

const ORIGIN = 'https://tm.example'
const deps = () => ({ db })
const AUDIO = withDevice(async (r, scope, ctx: { id: string }) => handleAudioRequest(r, scope, ctx.id), deps)
const UPLOAD = withDevice(
  async (r, scope, ctx: { id: string }) => handleTranscriptRequest(r, scope, { db, queue }, ctx.id),
  deps
)

const FLAC = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
const SRT = '1\n00:00:01,000 --> 00:00:02,000\nSecret lecture words\n'
const JSON_OK = '{"segments":[{"start":1,"end":2,"text":" Secret lecture words"}]}'
const GOOD = { txt: 'Secret lecture words', srt: SRT, json: JSON_OK }

const payload = (occurrenceId: string): NativeJobPayload => ({
  occurrenceId,
  entryName: 'Data Mining',
  start: '2026-10-21T14:00:00+08:00',
  timeZone: 'Asia/Kuala_Lumpur',
  durationSec: 5400,
  flacBytes: FLAC.length
})

/** A native job that device `a1` holds, with `audio.flac` on disk and the occurrence in `transcribing`. */
async function heldJob(): Promise<string> {
  await rm(occDir, { recursive: true, force: true })
  await mkdir(occDir, { recursive: true })
  await writeFile(join(occDir, 'audio.flac'), FLAC)
  await db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, fx.occA))
  const id = await createCompanionJob(db, {
    memberId: fx.a1.memberId,
    occurrenceId: fx.occA,
    kind: 'native_transcription',
    payload: payload(fx.occA)
  })
  expect(await claimJob(db, fx.a1, id)).toMatchObject({ id, state: 'claimed' })
  return id
}

const authed = (path: string, token: string, init: RequestInit & { duplex?: 'half' } = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })
const download = (id: string, token = tokens.a1, range?: string) =>
  AUDIO(authed(`/api/companion/jobs/${id}/audio`, token, range ? { headers: { range } } : {}), { id })
const formOf = (fields: Record<string, string | Buffer>, filename = (k: string) => `audio.${k}`) => {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, new Blob([value]), filename(key))
  return form
}
const upload = (id: string, body: BodyInit, token = tokens.a1, headers: Record<string, string> = {}) =>
  UPLOAD(authed(`/api/companion/jobs/${id}/transcript`, token, { method: 'POST', body, headers }), { id })
const stateOf = async (id: string) => (await db.select().from(companionJobs).where(eq(companionJobs.id, id)))[0]!.state
const occState = async () => (await db.select().from(occurrences).where(eq(occurrences.id, fx.occA)))[0]!.state
const nativeFiles = () => readdir(join(occDir, 'transcript', 'native')).catch(() => [] as string[])

beforeAll(async () => {
  db = await createTestDb()
  fx = await seedCompanionFixture(db)
  for (const key of ['a1', 'a2', 'b1'] as const) {
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx[key].deviceId))
    tokens[key] = token
  }
  work = await mkdtemp(join(tmpdir(), 'tm-companion-native-'))
  previousRoot = process.env.TM_DATA_ROOT
  process.env.TM_DATA_ROOT = join(work, 'data')
  occDir = join(work, 'data', 'occurrences', fx.occA)
}, 60_000)

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.TM_DATA_ROOT
  else process.env.TM_DATA_ROOT = previousRoot
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 60_000)

beforeEach(() => {
  queue = new FakeQueue()
})

const sent = () => (queue as FakeQueue).sent

describe('audio download', () => {
  test('goes only to the device that holds the live lease', async () => {
    const id = await heldJob()
    const ok = await download(id)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await ok.arrayBuffer()).equals(FLAC)).toBe(true)

    for (const token of [tokens.a2, tokens.b1]) {
      const res = await download(id, token)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Not found')
    }
  })

  test('a lapsed lease, an unclaimed job and a bad id all answer the same 404', async () => {
    const id = await heldJob()
    await db
      .update(companionJobs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(companionJobs.id, id))
    const lapsed = await download(id)
    expect(lapsed.status).toBe(404)
    const body = await lapsed.text()

    const pending = await createCompanionJob(db, {
      memberId: fx.a1.memberId,
      occurrenceId: fx.occA,
      kind: 'native_transcription',
      payload: payload(fx.occA)
    })
    for (const other of [pending, 'not-a-uuid', '6f1c0a9e-1111-4222-8333-944455556666']) {
      const res = await download(other)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe(body)
    }
  })

  test('a Range request resumes the download', async () => {
    const id = await heldJob()
    const res = await download(id, tokens.a1, 'bytes=400-')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 400-999/1000')
    expect(Buffer.from(await res.arrayBuffer()).equals(FLAC.subarray(400))).toBe(true)
  })

  test('answers 410 when audio.flac is gone, a link, or not a regular file', async () => {
    const id = await heldJob()
    const outside = join(work, 'secret.txt')
    await writeFile(outside, 'not for the PC')
    await rm(join(occDir, 'audio.flac'))
    expect((await download(id)).status).toBe(410)

    await symlink(outside, join(occDir, 'audio.flac'))
    const linked = await download(id)
    expect(linked.status).toBe(410)
    expect(await linked.text()).not.toContain('not for the PC')

    await rm(join(occDir, 'audio.flac'))
    await mkdir(join(occDir, 'audio.flac'))
    expect((await download(id)).status).toBe(410)
  })

  test('the opener refuses a path that leaves the occurrence directory or goes through a linked directory', async () => {
    await heldJob()
    const outside = join(work, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'audio.flac'), 'elsewhere')
    await symlink(outside, join(occDir, 'linked'))
    await writeFile(join(work, 'data', 'occurrences', 'sibling.bin'), 'sibling')

    for (const rel of ['../sibling.bin', '/etc/hostname', '', 'linked/audio.flac', 'a\0b']) {
      expect(await openOccurrenceFile(occDir, rel)).toBeNull()
    }
    const file = await openOccurrenceFile(occDir, 'audio.flac')
    expect(file).not.toBeNull()
    await file!.handle.close()
  })
})

describe('transcript upload', () => {
  test('a valid upload stores the files, deletes the audio, completes the job and queues the pipeline once', async () => {
    const id = await heldJob()
    const res = await upload(id, formOf(GOOD))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    const dir = join(occDir, 'transcript', 'native')
    expect(await readFile(join(dir, 'audio.txt'), 'utf8')).toBe(GOOD.txt)
    expect(await readFile(join(dir, 'audio.srt'), 'utf8')).toBe(SRT)
    expect(await readFile(join(dir, 'audio.json'), 'utf8')).toBe(JSON_OK)
    expect((await nativeFiles()).sort()).toEqual(['audio.json', 'audio.srt', 'audio.txt'])
    expect(existsSync(join(occDir, 'audio.flac'))).toBe(false)
    expect(await stateOf(id)).toBe('done')
    expect(await occState()).toBe('post_processing')
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({ name: QUEUES.pipeline, data: { occurrenceId: fx.occA } })
  })

  test('also works when the PC waits in waiting_for_pc', async () => {
    const id = await heldJob()
    await db.update(occurrences).set({ state: 'waiting_for_pc' }).where(eq(occurrences.id, fx.occA))
    expect((await upload(id, formOf(GOOD))).status).toBe(204)
    expect(await occState()).toBe('post_processing')
  })

  test('a second upload after success is refused and changes nothing', async () => {
    const id = await heldJob()
    expect((await upload(id, formOf(GOOD))).status).toBe(204)
    const again = await upload(id, formOf({ ...GOOD, json: '{"segments":[]}' }))
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: 'not_found' })
    expect(await readFile(join(occDir, 'transcript', 'native', 'audio.json'), 'utf8')).toBe(JSON_OK)
    expect(sent()).toHaveLength(1)
  })

  test('two uploads at once: one wins, one pipeline job', async () => {
    const id = await heldJob()
    const results = await Promise.all([upload(id, formOf(GOOD)), upload(id, formOf(GOOD))])
    expect(results.map((r) => r.status).sort()).toEqual([204, 404])
    expect(sent()).toHaveLength(1)
    expect(await stateOf(id)).toBe('done')
  })

  test('another device, another member and a lapsed lease get 404 and write nothing', async () => {
    const id = await heldJob()
    for (const token of [tokens.a2, tokens.b1]) expect((await upload(id, formOf(GOOD), token)).status).toBe(404)
    await db
      .update(companionJobs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(companionJobs.id, id))
    expect((await upload(id, formOf(GOOD))).status).toBe(404)
    expect(await nativeFiles()).toEqual([])
    expect(existsSync(join(occDir, 'audio.flac'))).toBe(true)
    expect(sent()).toEqual([])
    expect(await occState()).toBe('transcribing')
  })

  describe('is checked before anything is written', () => {
    const refused: [string, () => BodyInit, Record<string, string>, number, string][] = [
      ['a missing srt', () => formOf({ txt: 'Hello', json: '{"segments":[]}' }), {}, 400, 'invalid_upload'],
      ['an extra field', () => formOf({ ...GOOD, extra: 'x' }), {}, 400, 'invalid_upload'],
      [
        'segments of the wrong type',
        () => formOf({ ...GOOD, json: '{"segments":[{"start":"a"}]}' }),
        {},
        400,
        'invalid_transcript'
      ],
      ['json that is not json', () => formOf({ ...GOOD, json: '{"segments":' }), {}, 400, 'invalid_transcript'],
      ['no segments key', () => formOf({ ...GOOD, json: '{"text":"x"}' }), {}, 400, 'invalid_transcript'],
      [
        'invalid UTF-8 text',
        () => formOf({ ...GOOD, txt: Buffer.from([0xff, 0xfe, 0x41]) }),
        {},
        400,
        'invalid_transcript'
      ],
      ['a body that is not multipart', () => JSON_OK, { 'content-type': 'application/json' }, 400, 'invalid_upload'],
      [
        'a truncated multipart body',
        () => '--x\r\nContent-Disposition: form-data; name="txt"\r\n\r\nabc',
        { 'content-type': 'multipart/form-data; boundary=x' },
        400,
        'invalid_upload'
      ]
    ]
    for (const [name, body, headers, status, error] of refused) {
      test(`${name}: ${status}, keeps audio.flac and the claim`, async () => {
        const id = await heldJob()
        const res = await upload(id, body(), tokens.a1, headers)
        expect(res.status).toBe(status)
        expect(await res.json()).toEqual({ error })
        expect(existsSync(join(occDir, 'audio.flac'))).toBe(true)
        expect(await nativeFiles()).toEqual([])
        expect(await stateOf(id)).toBe('claimed')
        expect(await occState()).toBe('transcribing')
        expect(sent()).toEqual([])
      })
    }

    test('a duplicate field is refused', async () => {
      const id = await heldJob()
      const form = formOf(GOOD)
      form.append('txt', new Blob(['again']), 'audio.txt')
      expect((await upload(id, form)).status).toBe(400)
      expect(await nativeFiles()).toEqual([])
    })
  })

  describe('byte caps are enforced while the body is read', () => {
    /** A multipart body whose `field` part never ends; `pulled()` says how many bytes the server asked for. */
    function endless(field: string, boundary = 'edge') {
      let pulled = 0
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="audio.${field}"\r\n\r\n`
      )
      const filler = Buffer.alloc(64 * 1024, 0x61)
      let first = true
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = first ? head : filler
          first = false
          pulled += chunk.length
          controller.enqueue(chunk)
          if (pulled > 4 * NATIVE_UPLOAD_MAX_BODY_BYTES) controller.error(new Error('the server kept reading'))
        }
      })
      return { body, pulled: () => pulled, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
    }

    for (const field of ['txt', 'srt', 'json']) {
      test(`the ${field} part stops at ${NATIVE_UPLOAD_MAX_FILE_BYTES} bytes`, async () => {
        const id = await heldJob()
        const stream = endless(field)
        const res = await UPLOAD(
          authed(`/api/companion/jobs/${id}/transcript`, tokens.a1, {
            method: 'POST',
            body: stream.body,
            headers: stream.headers,
            duplex: 'half'
          }),
          { id }
        )
        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({ error: 'body_too_large' })
        expect(stream.pulled()).toBeGreaterThan(NATIVE_UPLOAD_MAX_FILE_BYTES)
        expect(stream.pulled()).toBeLessThan(NATIVE_UPLOAD_MAX_FILE_BYTES + 1024 * 1024)
        expect(await nativeFiles()).toEqual([])
        expect(await stateOf(id)).toBe('claimed')
      }, 60_000)
    }

    test('a declared length over the body cap is refused without reading', async () => {
      const id = await heldJob()
      let pulled = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1
          controller.enqueue(new Uint8Array(10))
        }
      })
      const res = await UPLOAD(
        authed(`/api/companion/jobs/${id}/transcript`, tokens.a1, {
          method: 'POST',
          body,
          duplex: 'half',
          headers: {
            'content-type': 'multipart/form-data; boundary=edge',
            'content-length': String(NATIVE_UPLOAD_MAX_BODY_BYTES + 1)
          }
        }),
        { id }
      )
      expect(res.status).toBe(413)
      expect(pulled).toBeLessThanOrEqual(1)
    })

    test('a part of exactly the cap is accepted', async () => {
      const id = await heldJob()
      const pad = ' '.repeat(NATIVE_UPLOAD_MAX_FILE_BYTES - JSON_OK.length)
      const json = JSON_OK + pad
      expect(json.length).toBe(NATIVE_UPLOAD_MAX_FILE_BYTES)
      expect((await upload(id, formOf({ ...GOOD, json }))).status).toBe(204)
    }, 60_000)
  })

  describe('never writes through a path the client or the worker controls', () => {
    test('a client file name with path parts is ignored', async () => {
      const id = await heldJob()
      const res = await upload(
        id,
        formOf(GOOD, () => '../../../../evil.txt')
      )
      expect(res.status).toBe(204)
      expect((await nativeFiles()).sort()).toEqual(['audio.json', 'audio.srt', 'audio.txt'])
      expect(existsSync(join(work, 'evil.txt'))).toBe(false)
      expect(existsSync(join(occDir, 'evil.txt'))).toBe(false)
    })

    test('a linked transcript directory refuses the upload and keeps the claim', async () => {
      const id = await heldJob()
      const outside = join(work, 'elsewhere')
      await mkdir(outside, { recursive: true })
      await symlink(outside, join(occDir, 'transcript'))
      const res = await upload(id, formOf(GOOD))
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'conflict' })
      expect(await readdir(outside)).toEqual([])
      expect(await stateOf(id)).toBe('claimed')
      expect(await occState()).toBe('transcribing')
      expect(sent()).toEqual([])
    })

    test('a linked native directory refuses the upload', async () => {
      const id = await heldJob()
      const outside = join(work, 'elsewhere-native')
      await mkdir(outside, { recursive: true })
      await mkdir(join(occDir, 'transcript'))
      await symlink(outside, join(occDir, 'transcript', 'native'))
      expect((await upload(id, formOf(GOOD))).status).toBe(409)
      expect(await readdir(outside)).toEqual([])
      expect(await stateOf(id)).toBe('claimed')
    })

    test('a linked occurrence directory refuses the upload', async () => {
      const id = await heldJob()
      const real = join(work, 'moved-occurrence')
      await rm(real, { recursive: true, force: true })
      await mkdir(real)
      await rm(occDir, { recursive: true })
      await symlink(real, occDir)
      expect((await upload(id, formOf(GOOD))).status).toBe(409)
      expect(await readdir(real)).toEqual([])
      expect(await stateOf(id)).toBe('claimed')
    })

    test('an audio.json that is already there is not replaced', async () => {
      const id = await heldJob()
      await mkdir(join(occDir, 'transcript', 'native'), { recursive: true })
      await writeFile(join(occDir, 'transcript', 'native', 'audio.json'), '{"segments":[]}')
      expect((await upload(id, formOf(GOOD))).status).toBe(409)
      expect(await readFile(join(occDir, 'transcript', 'native', 'audio.json'), 'utf8')).toBe('{"segments":[]}')
      expect(await nativeFiles()).toEqual(['audio.json'])
      expect(await stateOf(id)).toBe('claimed')
    })
  })

  test('an occurrence that no longer waits for a transcript answers 409 and keeps the claim', async () => {
    const id = await heldJob()
    await db.update(occurrences).set({ state: 'failed' }).where(eq(occurrences.id, fx.occA))
    const res = await upload(id, formOf(GOOD))
    expect(res.status).toBe(409)
    expect(await stateOf(id)).toBe('claimed')
    expect(await nativeFiles()).toEqual([])
    expect(sent()).toEqual([])
  })

  test('a queue that fails rolls everything back and the PC can send again', async () => {
    const id = await heldJob()
    queue = {
      send: async () => {
        throw new Error('queue is down')
      }
    }
    await expect(upload(id, formOf(GOOD))).rejects.toThrow('queue is down')
    expect(await stateOf(id)).toBe('claimed')
    expect(await occState()).toBe('transcribing')
    expect(await nativeFiles()).toEqual([])
    expect(existsSync(join(occDir, 'audio.flac'))).toBe(true)

    queue = new FakeQueue()
    expect((await upload(id, formOf(GOOD))).status).toBe(204)
    expect(sent()).toHaveLength(1)
  })

  test('no transcript text, token or path reaches a log line or an error body', async () => {
    const lines: string[] = []
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')))
    )
    try {
      const id = await heldJob()
      const bodies = [
        await (await upload(id, formOf({ ...GOOD, json: '{"segments":[{"start":"Secret lecture words"}]}' }))).text(),
        await (await upload(id, formOf(GOOD), tokens.b1)).text(),
        await (await download(id, tokens.b1)).text()
      ]
      expect((await upload(id, formOf(GOOD))).status).toBe(204)
      for (const text of [...bodies, ...lines]) {
        expect(text).not.toContain('Secret lecture words')
        expect(text).not.toContain(tokens.a1)
        expect(text).not.toContain(work)
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
