import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { artefacts, events, forms, occurrences, type Db } from '../db'
import { hashEventData } from '../db/transitions'
import { createTestDb, dropAllTestDbs, FakeQueue, seedMember } from '../db/testing'
import { InputError, InUseError } from '../lib/identities'
import {
  makeBotLeave,
  meetingData,
  parseTranscript,
  pasteLink,
  requestDeleteNow,
  rerunPipeline,
  SLIDE_UNREADABLE
} from '../lib/meeting'
import { createScope, type MemberScope } from '../lib/scope'
// The real 01a writer, so the parser is tested against what it produces, not against a copy of the format.
import { buildTranscript } from '../../pipeline/src/transcript'
import { liveLine, makeOccurrence, removeOccurrence, writeAttempts, writeLines } from '../../pipeline/test/helpers'

let db: Db
let work: string
let previousRoot: string | undefined

beforeAll(async () => {
  db = await createTestDb()
  work = await mkdtemp(join(tmpdir(), 'tm-meeting-'))
  previousRoot = process.env.TM_DATA_ROOT
  process.env.TM_DATA_ROOT = join(work, 'data')
}, 30_000)

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.TM_DATA_ROOT
  else process.env.TM_DATA_ROOT = previousRoot
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 30_000)

test('transcript timestamps become seconds, in the format the pipeline writes', async () => {
  const occ = await makeOccurrence()
  try {
    await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [
      liveLine(65_000, 66_000, 'Good evening, everyone.'),
      liveLine(250_000, 251_000, 'Next slide.'),
      liveLine(3_723_000, 3_724_000, 'Done.')
    ])
    // The first attempt stops at 66 s and the second starts at 200 s: a 134 s recording gap.
    await writeAttempts(occ.dataDir, [
      { startMs: 0, stopMs: 66_000 },
      { startMs: 200_000, stopMs: null }
    ])
    const md = await Bun.file(await buildTranscript(occ.cfg, [])).text()
    expect(md).toContain('_[00:03:20] Recording gap of 2 minutes._')
    expect(parseTranscript(md)).toEqual([
      { seconds: 65, text: 'Good evening, everyone.' },
      { seconds: 200, text: 'Recording gap of 2 minutes.', note: true },
      { seconds: 250, text: 'Next slide.' },
      { seconds: 251, text: 'No speech for 58 minutes.', note: true },
      { seconds: 3723, text: 'Done.' }
    ])
  } finally {
    await removeOccurrence(occ.root)
  }
})

test('a silence note keeps its time; a transcript with no speech keeps its sentence', () => {
  expect(
    parseTranscript(
      '# x: transcript\n\nintro **[00:00:01]** not a paragraph\n\n## Transcript\n\n**[00:00:05]** First,\n\n_[00:00:06] No speech for 2 minutes._\n'
    )
  ).toEqual([
    { seconds: 5, text: 'First,' },
    { seconds: 6, text: 'No speech for 2 minutes.', note: true }
  ])
  expect(
    parseTranscript('# x: transcript\n\nintro\n\n## Transcript\n\n_No live transcript for this meeting._\n')
  ).toEqual([{ seconds: null, text: 'No live transcript for this meeting.', note: true }])
})

async function twoMembers() {
  const a = await seedMember(db)
  const b = await seedMember(db)
  return { a, b, scopeA: createScope(db, a.memberId), scopeB: createScope(db, b.memberId) }
}

/** An occurrence with files on disk, two forms, one of them with two screenshots, and a few events. */
async function meetingFixture() {
  const { memberId, identityId } = await seedMember(db, { full: false })
  const scope = createScope(db, memberId)
  const start = new Date('2026-10-21T06:00:00Z')
  const o = await scope.insert(occurrences, {
    identityId,
    entryName: 'Data Mining',
    entryType: 'lecture',
    transcription: 'live',
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 7_200_000),
    deleteAfter: new Date(start.getTime() + 30 * 86_400_000),
    linkUsed: 'https://example.zoom.us/j/00000000000?pwd=SECRETPWD',
    pastedLink: 'https://example.zoom.us/j/11111111111?pwd=SECRETPWD'
  })
  const occurrenceId = o.id
  const dir = join(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)
  const put = async (kind: (typeof artefacts.$inferInsert)['kind'], path: string, content: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
    await scope.insert(artefacts, { occurrenceId, kind, path, bytes: content.length })
  }
  await put('summary', 'out/2026-10-21 1400 Data Mining.md', '# Summary\n')
  await put('transcript', 'out/transcript.md', '# T\n\n## Transcript\n\n**[00:01:05]** Hello.\n')
  await put('chat', 'out/chat.md', '# Chat\n')
  await put('recording', 'recording/meeting.mp4', 'video')
  await put(
    'slides_json',
    'slides/slides.json',
    JSON.stringify([
      { n: 1, file: 'slides/01.webp', atMs: 1000, title: 'Intro', text: 'Hello' },
      { n: 2, file: 'slides/02.webp', atMs: 2000, title: '', text: '', failed: true }
    ])
  )
  await put('slide_image', 'slides/01.webp', 'img')
  await put('form_screenshot', 'forms/f1/filled.png', 'png')
  await put('form_screenshot', 'forms/f1/confirmation.png', 'png')
  await put('form_screenshot', 'forms/f10/filled.png', 'png')
  const base = { occurrenceId, url: 'https://docs.google.com/forms/d/e/x/viewform', source: 'qr' } as const
  await scope.insert(forms, { ...base, formKey: 'f1', state: 'submitted', seenAt: new Date('2026-10-21T06:10:00Z') })
  await scope.insert(forms, {
    ...base,
    formKey: 'f2',
    state: 'untrusted',
    trustReason: null,
    seenAt: new Date('2026-10-21T06:20:00Z')
  })
  return { scope, occurrenceId, queue: new FakeQueue(), memberId }
}

test("another member's meeting is not found", async () => {
  const { a, scopeB } = await twoMembers()
  expect(await meetingData(scopeB, a.ids.occurrences)).toBeNull()
  expect(await meetingData(scopeB, 'not-a-uuid')).toBeNull()
})

test('the attendance record shows each form with its own screenshots', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const v = await meetingData(scope, occurrenceId)
  expect(v!.forms.map((f) => [f.state, f.screenshotUrls.length])).toEqual([
    ['submitted', 2],
    ['untrusted', 0]
  ])
  expect(v!.forms[0]!.screenshotUrls.every((u) => u.startsWith(`/api/meetings/${occurrenceId}/files/forms/f1/`))).toBe(
    true
  )
})

test('the page data reads the files, and a failed slide is shown as unreadable, never blank', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const v = (await meetingData(scope, occurrenceId))!
  expect(v.summaryMd).toBe('# Summary\n')
  expect(v.chatMd).toBe('# Chat\n')
  expect(v.transcript).toEqual([{ seconds: 65, text: 'Hello.' }])
  expect(v.videoUrl).toBe(`/api/meetings/${occurrenceId}/files/recording/meeting.mp4`)
  expect(v.slides).toEqual([
    {
      n: 1,
      imageUrl: `/api/meetings/${occurrenceId}/files/slides/01.webp`,
      title: 'Intro',
      text: 'Hello',
      failed: false
    },
    {
      n: 2,
      imageUrl: `/api/meetings/${occurrenceId}/files/slides/02.webp`,
      title: '',
      text: SLIDE_UNREADABLE,
      failed: true
    }
  ])
})

test('a meeting with no files yet has empty parts, not errors', async () => {
  const { a, scopeA } = await twoMembers()
  await scopeA.remove(artefacts, eq(artefacts.occurrenceId, a.ids.occurrences))
  const v = (await meetingData(scopeA, a.ids.occurrences))!
  expect([v.summaryMd, v.chatMd, v.videoUrl, v.transcript, v.slides]).toEqual([null, null, null, [], []])
})

test('the meeting data never holds the meeting link or the passcode', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const data = {
    link: 'https://example.zoom.us/j/00000000000?pwd=SECRETPWD',
    passcode: 'SECRETPWD',
    message:
      'could not open https://example.zoom.us/j/00000000000?pwd=SECRETPWD or https://forms.example.org/a?pwd=SECRETPWD&b=1',
    nested: [{ note: 'Passcode: SECRETPWD', url: 'https://teams.microsoft.com/l/meetup-join/abc?p=SECRETPWD' }]
  }
  await scope.insert(events, {
    occurrenceId,
    attempt: 1,
    at: new Date(),
    type: 'error',
    data,
    dataHash: hashEventData(data)
  })
  const v = await meetingData(scope, occurrenceId)
  const text = JSON.stringify(v)
  expect(text).not.toContain('SECRETPWD')
  expect(text).not.toContain('00000000000')
  expect(text).not.toContain('11111111111')
  expect(text).toContain('forms.example.org/a?b=1')
})

async function stateOf(scope: MemberScope, id: string) {
  const [o] = await scope.select(occurrences, eq(occurrences.id, id))
  return o!
}

test('actions follow the occurrence state', async () => {
  const { scope, occurrenceId, queue } = await meetingFixture()
  await scope.update(occurrences, { state: 'in_meeting' }, eq(occurrences.id, occurrenceId))
  await makeBotLeave(scope, occurrenceId)
  await makeBotLeave(scope, occurrenceId)
  await expect(pasteLink(scope, occurrenceId, 'https://example.zoom.us/j/00000000000')).rejects.toThrow(InUseError)
  await expect(requestDeleteNow(scope, occurrenceId, queue)).rejects.toThrow(
    'Make the bot leave before deleting this meeting.'
  )
  expect((await stateOf(scope, occurrenceId)).pendingCommands).toEqual(['leave_now'])
  expect(queue.sent).toEqual([])
  await scope.update(occurrences, { state: 'completed' }, eq(occurrences.id, occurrenceId))
  await expect(makeBotLeave(scope, occurrenceId)).rejects.toThrow('The bot is not in this meeting.')
  await requestDeleteNow(scope, occurrenceId, queue)
  expect(queue.sent).toEqual([{ name: 'delete-occurrence', data: { occurrenceId }, opts: undefined }])
  expect((await stateOf(scope, occurrenceId)).stateReason).toBe('deleting')
})

test('a link can be pasted before the bot joins, only as https, and is never echoed', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  for (const bad of ['http://example.zoom.us/j/1?pwd=SECRETPWD', 'javascript:alert(1)', 'not a url', '']) {
    const error = await pasteLink(scope, occurrenceId, bad).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InputError)
    expect(String((error as Error).message)).not.toContain('SECRETPWD')
  }
  await pasteLink(scope, occurrenceId, ' https://example.zoom.us/j/22222222222 ')
  expect((await stateOf(scope, occurrenceId)).pastedLink).toBe('https://example.zoom.us/j/22222222222')
})

test("a member's actions cannot touch another member's meeting", async () => {
  const { a, scopeB } = await twoMembers()
  const queue = new FakeQueue()
  const id = a.ids.occurrences
  await expect(makeBotLeave(scopeB, id)).rejects.toThrow()
  await expect(pasteLink(scopeB, id, 'https://example.zoom.us/j/1')).rejects.toThrow()
  await expect(requestDeleteNow(scopeB, id, queue)).rejects.toThrow(InputError)
  await expect(rerunPipeline(scopeB, id, queue)).rejects.toThrow(InputError)
  expect(queue.sent).toEqual([])
})

test('the pipeline re-runs only after an AI key error', async () => {
  const { scope, occurrenceId, queue } = await meetingFixture()
  await expect(rerunPipeline(scope, occurrenceId, queue)).rejects.toThrow(InUseError)
  await scope.update(
    occurrences,
    { state: 'post_processing', stateReason: 'ai_key_error' },
    eq(occurrences.id, occurrenceId)
  )
  await rerunPipeline(scope, occurrenceId, queue)
  expect(queue.sent).toEqual([{ name: 'pipeline', data: { occurrenceId }, opts: undefined }])
})
