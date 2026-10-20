import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { artefacts, events, forms, occurrences, type Db } from '../db'
import { hashEventData } from '../db/transitions'
import { createTestDb, dropAllTestDbs, FakeQueue, seedMember } from '../db/testing'
import { InputError, InUseError } from '../lib/identities'
import {
  ArtefactTooLargeError,
  MAX_ARTEFACT_BYTES,
  controlState,
  makeBotLeave,
  takeOver,
  meetingData,
  parseTranscript,
  pasteLink,
  requestDeleteNow,
  rerunPipeline,
  SLIDE_UNREADABLE
} from '../lib/meeting'
import { createScope, type MemberScope } from '../lib/scope'
import type { JobConfig } from '@tm/core'
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

test('a transcript file with no "## Transcript" heading has no lines', () => {
  expect(parseTranscript('# x: transcript\n\n**[00:00:05]** Not under the heading.\n')).toEqual([])
  expect(parseTranscript('')).toEqual([])
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

async function addEvent(scope: MemberScope, occurrenceId: string, data: Record<string, unknown>) {
  await scope.insert(events, {
    occurrenceId,
    attempt: 1,
    at: new Date(),
    type: 'error',
    data,
    dataHash: hashEventData(data)
  })
}

test('the meeting data never holds the meeting link or the passcode', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  await addEvent(scope, occurrenceId, {
    link: 'https://example.zoom.us/j/00000000000?pwd=SECRETPWD',
    passcode: 'SECRETPWD',
    message:
      'could not open https://example.zoom.us/j/00000000000?pwd=SECRETPWD or https://forms.example.org/a?pwd=SECRETPWD&b=1',
    nested: [{ note: 'Passcode: SECRETPWD', url: 'https://teams.microsoft.com/l/meetup-join/abc?p=SECRETPWD' }]
  })
  const v = (await meetingData(scope, occurrenceId))!
  const text = JSON.stringify(v)
  expect(text).not.toContain('SECRETPWD')
  // Only the masked `joinedLink` (host and meeting id) may carry the meeting id; the events and the rest never do.
  expect(JSON.stringify({ ...v, occurrence: { ...v.occurrence, joinedLink: null } })).not.toContain('00000000000')
  expect(text).not.toContain('11111111111')
  expect(text).not.toContain('forms.example.org')
})

test('event data nested far deeper than any worker event is cut instead of walked', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  let deep: unknown = { text: 'Passcode: SECRETPWD' }
  for (let i = 0; i < 3000; i++) deep = { n: deep }
  await addEvent(scope, occurrenceId, { keep: 'kept', deep: deep as Record<string, unknown> })
  const v = (await meetingData(scope, occurrenceId))!
  const text = JSON.stringify(v.events.at(-1)!.data)
  expect(text).toContain('"keep":"kept"')
  expect(text).toContain('[too deep to show]')
  expect(text).not.toContain('SECRETPWD')
})

test('event data drops secret-looking keys in any case or snake_case', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  await addEvent(scope, occurrenceId, {
    join_url: 'x1',
    pasted_link: 'x2',
    meeting_passcode: 'x3',
    Invite: 'x4',
    PWD: 'x5',
    zoom_password: 'x6',
    joinLink: 'x7',
    inner: { 'meeting-url': 'x8', keep: 'kept' },
    reason: 'sign_in_failed'
  })
  const v = (await meetingData(scope, occurrenceId))!
  const data = v.events.at(-1)!.data
  expect(data).toEqual({ inner: { keep: 'kept' }, reason: 'sign_in_failed' })
})

test('event text loses passcode phrases to the end of the clause, and any URL that is not a form', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  await addEvent(scope, occurrenceId, {
    a: 'Passcode 123456',
    b: 'passcode is xk9q',
    c: 'Passcode: 123 456',
    d: 'Password: hunter 2; then more',
    e: 'retry (passcode 998 877) later',
    f: 'Meeting says Passcode: 123 456. Next step ok.',
    g: 'see https://evil.example/join?room=SECRETROOM and zoom.us/j/33333333333 and zoommtg://zoom.us/join?confno=44444444444',
    h: 'form https://docs.google.com/forms/d/e/x/viewform?pwd=SECRETPWD kept, https://forms.office.com/r/abc kept'
  })
  const v = (await meetingData(scope, occurrenceId))!
  const d = v.events.at(-1)!.data as Record<string, string>
  const text = JSON.stringify(d)
  for (const secret of [
    '123456',
    'xk9q',
    '123 456',
    'hunter',
    '998',
    'SECRETROOM',
    '33333333333',
    '44444444444',
    'SECRETPWD'
  ])
    expect([secret, text.includes(secret)]).toEqual([secret, false])
  expect(d.d).toContain('then more')
  expect(d.e).toBe('retry ([passcode removed]) later')
  expect(d.f).toBe('Meeting says [passcode removed]. Next step ok.')
  expect(d.h).toBe('form https://docs.google.com/forms/d/e/x/viewform kept, https://forms.office.com/r/abc kept')
})

test('a file above the size cap is refused with a message the page can show', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const path = join(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId, 'out/chat.md')
  await truncate(path, MAX_ARTEFACT_BYTES + 1)
  const error = await meetingData(scope, occurrenceId).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ArtefactTooLargeError)
  expect((error as Error).message).toBe('out/chat.md is too large to show here (20.0 MB; the limit is 20 MB).')
  await truncate(path, MAX_ARTEFACT_BYTES)
  expect((await meetingData(scope, occurrenceId))!.chatMd).toHaveLength(MAX_ARTEFACT_BYTES)
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

test.each(['transcribing', 'waiting_for_pc', 'post_processing'] as const)(
  'delete now in %s waits for the pipeline: delete_after moves to now and state_reason is untouched',
  async (state) => {
    const { scope, occurrenceId, queue } = await meetingFixture()
    await scope.update(occurrences, { state, stateReason: 'ai_key_error' }, eq(occurrences.id, occurrenceId))
    const before = await stateOf(scope, occurrenceId)
    expect(await requestDeleteNow(scope, occurrenceId, queue)).toBe('after_processing')
    expect(queue.sent).toEqual([])
    const after = await stateOf(scope, occurrenceId)
    expect(after.stateReason).toBe('ai_key_error')
    expect(after.state).toBe(state)
    expect(after.deleteAfter.getTime()).toBeLessThanOrEqual(Date.now())
    expect(after.deleteAfter.getTime()).toBeLessThan(before.deleteAfter.getTime())
    // The re-run after a key error still works.
    if (state === 'post_processing') await rerunPipeline(scope, occurrenceId, queue)
  }
)

test('delete now in a finished state queues the delete at once', async () => {
  const { scope, occurrenceId, queue } = await meetingFixture()
  await scope.update(occurrences, { state: 'failed' }, eq(occurrences.id, occurrenceId))
  expect(await requestDeleteNow(scope, occurrenceId, queue)).toBe('queued')
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

test('submitting a re-run twice queues one job, and a failed send puts the reason back', async () => {
  const { scope, occurrenceId, queue } = await meetingFixture()
  await scope.update(
    occurrences,
    { state: 'post_processing', stateReason: 'ai_key_error' },
    eq(occurrences.id, occurrenceId)
  )
  const results = await Promise.allSettled([
    rerunPipeline(scope, occurrenceId, queue),
    rerunPipeline(scope, occurrenceId, queue)
  ])
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(queue.sent).toHaveLength(1)
  expect((await stateOf(scope, occurrenceId)).stateReason).toBe('rerun_queued')

  await scope.update(occurrences, { stateReason: 'ai_key_error' }, eq(occurrences.id, occurrenceId))
  const broken = { send: async () => Promise.reject(new Error('queue down')) }
  await expect(rerunPipeline(scope, occurrenceId, broken)).rejects.toThrow('queue down')
  expect((await stateOf(scope, occurrenceId)).stateReason).toBe('ai_key_error')
})

const FIXED = 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
const snapshot = (link: JobConfig['entry']['link']): JobConfig['entry'] => ({
  name: 'Data Mining',
  type: 'lecture',
  start: '2026-10-21T06:00:00Z',
  end: '2026-10-21T08:00:00Z',
  timeZone: 'Asia/Kuala_Lumpur',
  link,
  trustedSenders: [],
  transcription: 'live',
  formDetails: {},
  attendanceKeywords: []
})

test('take over queues once and returns the owner the full fixed link, passcode included', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  await scope.update(
    occurrences,
    {
      state: 'in_meeting',
      linkUsed: 'https://example.zoom.us/j/00000000000',
      pastedLink: null,
      entrySnapshot: snapshot({ kind: 'fixed', url: FIXED })
    },
    eq(occurrences.id, occurrenceId)
  )
  const expected = { link: FIXED, passcodeFromChat: false, alreadyLeft: false }
  expect(await takeOver(scope, occurrenceId)).toEqual(expected)
  expect(await takeOver(scope, occurrenceId)).toEqual(expected)
  expect((await stateOf(scope, occurrenceId)).pendingCommands).toEqual(['take_over'])
})

test('take over returns the pasted link when the bot joined that one', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const pasted = 'https://example.zoom.us/j/22222222222?pwd=PASTEDPWD'
  await scope.update(
    occurrences,
    {
      state: 'in_meeting',
      linkUsed: 'https://example.zoom.us/j/22222222222',
      pastedLink: pasted,
      entrySnapshot: snapshot({ kind: 'fixed', url: FIXED })
    },
    eq(occurrences.id, occurrenceId)
  )
  expect(await takeOver(scope, occurrenceId)).toEqual({ link: pasted, passcodeFromChat: false, alreadyLeft: false })
})

test('a link from a watched chat has no passcode here: the member is told to take it from the chat', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  await scope.update(
    occurrences,
    {
      state: 'in_meeting',
      linkUsed: 'https://example.zoom.us/j/33333333333?pwd=CHATPWD&next=https://evil.com#frag',
      pastedLink: null,
      entrySnapshot: snapshot({ kind: 'chat', app: 'whatsapp', chat: 'Class group' })
    },
    eq(occurrences.id, occurrenceId)
  )
  const got = await takeOver(scope, occurrenceId)
  // Only the host and the meeting id are kept: no passcode, no query, no fragment.
  expect(got).toEqual({
    link: 'https://example.zoom.us/wc/join/33333333333',
    passcodeFromChat: true,
    alreadyLeft: false
  })
})

test('take over hands the passcode to the owner only and stores nothing new', async () => {
  const { a, scopeA, scopeB } = await twoMembers()
  const id = a.ids.occurrences
  await scopeA.update(
    occurrences,
    {
      state: 'in_meeting',
      linkUsed: 'https://example.zoom.us/j/00000000000',
      pastedLink: null,
      entrySnapshot: snapshot({ kind: 'fixed', url: FIXED })
    },
    eq(occurrences.id, id)
  )
  const before = await stateOf(scopeA, id)
  const eventsBefore = await scopeA.select(events, eq(events.occurrenceId, id))
  expect(await takeOver(scopeB, id)).toBeNull()
  expect((await stateOf(scopeA, id)).pendingCommands).toEqual([])
  expect((await takeOver(scopeA, id))!.link).toBe(FIXED)
  const after = await stateOf(scopeA, id)
  // Only the queued command changed: the passcode went into no column and no event, and the view never holds it.
  expect({ ...after, pendingCommands: [] }).toEqual({ ...before, pendingCommands: [] })
  expect([after.linkUsed, after.pastedLink]).toEqual(['https://example.zoom.us/j/00000000000', null])
  expect(await scopeA.select(events, eq(events.occurrenceId, id))).toEqual(eventsBefore)
  expect(JSON.stringify(await meetingData(scopeA, id))).not.toContain('PASSCODE')
})

test('take over gives no link when the stored one is not an https meeting link', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  for (const bad of ['javascript:alert(1)', 'https://evil.com/j/1', 'https://zoom.us.evil.com/j/1']) {
    await scope.update(occurrences, { state: 'in_meeting', linkUsed: bad }, eq(occurrences.id, occurrenceId))
    expect(await takeOver(scope, occurrenceId), bad).toEqual({
      link: null,
      passcodeFromChat: false,
      alreadyLeft: false
    })
  }
  await scope.update(occurrences, { linkUsed: null }, eq(occurrences.id, occurrenceId))
  expect(await takeOver(scope, occurrenceId)).toEqual({ link: null, passcodeFromChat: false, alreadyLeft: false })
})

test('a bot that is leaving or uploading has already left: take over says so and queues nothing', async () => {
  for (const state of ['leaving', 'uploading'] as const) {
    const { scope, occurrenceId } = await meetingFixture()
    await scope.update(occurrences, { state }, eq(occurrences.id, occurrenceId))
    const got = await takeOver(scope, occurrenceId)
    expect(got?.alreadyLeft, state).toBe(true)
    expect((await stateOf(scope, occurrenceId)).pendingCommands, state).toEqual([])
  }
})

test('the joined link shown on the page is cut to the host and meeting id', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const shown = async (linkUsed: string) => {
    await scope.update(occurrences, { linkUsed }, eq(occurrences.id, occurrenceId))
    return (await meetingData(scope, occurrenceId))!.occurrence.joinedLink
  }
  for (const stored of [
    'https://example.zoom.us/j/123?a=1;pwd=SECRETPWD',
    'https://example.zoom.us/j/123?pwd%3DSECRETPWD',
    'https://example.zoom.us/j/123#success?pwd=SECRETPWD',
    'https://example.zoom.us/j/123?next=https://evil.com#@evil.com'
  ]) {
    const joined = await shown(stored)
    expect(joined, stored).toEqual({ host: 'example.zoom.us', meetingId: '123' })
    expect(JSON.stringify(joined)).not.toMatch(/SECRETPWD|evil/)
  }
  expect(await shown('https://evil.com/j/123')).toBeNull()
})

test("a finished meeting refuses take over; another member's is not found", async () => {
  const { a, b, scopeA, scopeB } = await twoMembers()
  await scopeA.update(occurrences, { state: 'completed' }, eq(occurrences.id, a.ids.occurrences))
  await expect(takeOver(scopeA, a.ids.occurrences)).rejects.toThrow('The bot is not in this meeting.')
  expect(await takeOver(scopeB, a.ids.occurrences)).toBeNull()
  expect(await controlState(scopeB, a.ids.occurrences)).toBeNull()
  expect(await takeOver(scopeB, 'not-a-uuid')).toBeNull()
  expect(await controlState(scopeA, a.ids.occurrences)).toEqual({ state: 'completed' })
  expect(b.ids.occurrences).not.toBe(a.ids.occurrences)
})

test("another member can't make the bot leave, and nothing is queued for it", async () => {
  const { a, scopeA, scopeB } = await twoMembers()
  await scopeA.update(occurrences, { state: 'in_meeting' }, eq(occurrences.id, a.ids.occurrences))
  await expect(makeBotLeave(scopeB, a.ids.occurrences)).rejects.toThrow('The bot is not in this meeting.')
  await expect(takeOver(scopeB, a.ids.occurrences)).resolves.toBeNull()
  expect((await stateOf(scopeA, a.ids.occurrences)).pendingCommands).toEqual([])
})

test('the meeting page data shows where the bot joined without the passcode', async () => {
  const { scope, occurrenceId } = await meetingFixture()
  const v = (await meetingData(scope, occurrenceId))!
  expect(v.occurrence.joinedLink).toEqual({ host: 'example.zoom.us', meetingId: '00000000000' })
  expect(JSON.stringify(v)).not.toContain('SECRETPWD')
})
