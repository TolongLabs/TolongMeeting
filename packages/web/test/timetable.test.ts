import { afterAll, beforeAll, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { aiKeys, identities, occurrences, timetableEntries, type Db } from '../db'
import { FakeNotifier } from '../db/notifier'
import { createTestDb, dropAllTestDbs, FakeQueue, seedMember } from '../db/testing'
import { InputError, InUseError } from '../lib/identities'
import { createScope, type MemberScope } from '../lib/scope'
import {
  ChatLinkSchema,
  deleteEntry,
  EntryInputSchema,
  maskedLink,
  type EntryDeps,
  NoWorkingKeyError,
  saveEntry,
  setPaused
} from '../lib/timetable'
import { expectNotLogged } from './no-log'

// Migrations and database drops share one Postgres with other suites; 5 seconds is too tight under that load.
const HOOK_TIMEOUT_MS = 30_000

let db: Db

beforeAll(async () => {
  db = await createTestDb()
}, HOOK_TIMEOUT_MS)

afterAll(async () => {
  await dropAllTestDbs()
}, HOOK_TIMEOUT_MS)

const now = new Date('2026-10-20T00:00:00Z')
const PASSCODE = 's3cretPass'

const base = {
  name: 'Data Mining',
  type: 'lecture',
  repeat: { kind: 'weekly', days: [3], from: '2026-10-01' },
  start: '14:00',
  end: '16:00',
  link: { kind: 'fixed', url: `https://example.zoom.us/j/00000000000?pwd=${PASSCODE}` },
  trustedSenders: ['Lecturer Name'],
  formDetails: { course_code: 'ABC1234', section: '1', lecturer: 'Lecturer Name' },
  attendanceKeywords: ['kehadiran']
}

/** A member with an identity named "University" and, unless `withKey` is false, a working AI key. */
async function member(withKey = true) {
  const { memberId, identityId } = await seedMember(db, { full: false })
  await db.update(identities).set({ name: 'University' }).where(eq(identities.id, identityId))
  if (!withKey) await db.delete(aiKeys).where(eq(aiKeys.memberId, memberId))
  const deps: EntryDeps = {
    queue: new FakeQueue(),
    notifier: new FakeNotifier(),
    ensureNtfy: async () => {},
    now,
    publicUrl: 'https://tm.example'
  }
  return { scope: createScope(db, memberId), memberId, identityId, deps }
}

test('lectures default to live and work meetings to native, without lecture-only fields', () => {
  const identityId = '5f2d8f0e-1b7a-4c2e-9a3e-0d8f6c1b2a10'
  expect(EntryInputSchema.parse({ ...base, identityId }).transcription).toBe('live')
  expect(EntryInputSchema.parse({ ...base, identityId, type: 'work' })).toMatchObject({
    transcription: 'native',
    trustedSenders: [],
    formDetails: {},
    attendanceKeywords: []
  })
})

test('a chat link is refused until link watchers exist, and chat targets are checked per app', () => {
  const identityId = '5f2d8f0e-1b7a-4c2e-9a3e-0d8f6c1b2a10'
  const r = EntryInputSchema.safeParse({
    ...base,
    identityId,
    link: { kind: 'chat', app: 'whatsapp', chat: 'Class group' }
  })
  expect(r.success).toBe(false)
  expect(r.error?.issues[0]?.message).toBe('Watching a chat arrives with link watchers.')
  expect(ChatLinkSchema.safeParse({ kind: 'chat', app: 'discord', chat: 'general' }).success).toBe(false)
  expect(
    ChatLinkSchema.safeParse({ kind: 'chat', app: 'discord', chat: 'https://discord.com/channels/1/2' }).success
  ).toBe(true)
  expect(ChatLinkSchema.safeParse({ kind: 'chat', app: 'whatsapp', chat: 'Class group' }).success).toBe(true)
})

test('a fixed link is accepted only if the worker would accept it, and the trimmed original is kept', () => {
  const identityId = '5f2d8f0e-1b7a-4c2e-9a3e-0d8f6c1b2a10'
  const parse = (url: string) => EntryInputSchema.safeParse({ ...base, identityId, link: { kind: 'fixed', url } })
  expect(parse('https://example.zoom.us/j/00000000000?pwd=abc').success).toBe(true)
  expect(parse('https://example.zoom.us/wc/join/00000000000?pwd=abc').success).toBe(true)
  const padded = parse('  https://example.zoom.us/j/00000000000?pwd=abc  ')
  expect(padded.data?.link).toEqual({ kind: 'fixed', url: 'https://example.zoom.us/j/00000000000?pwd=abc' })
  for (const url of [
    'http://example.zoom.us/j/00000000000',
    'https://evil.example.com/j/00000000000',
    'https://zoom.us.example.com/j/00000000000',
    'https://user:pass@example.zoom.us/j/00000000000',
    'https://example.zoom.us:8443/j/00000000000',
    'https://example.zoom.us/my/lecturer',
    'https://example.zoom.us/signin',
    'https://example.zoom.us/j/0000\t0000000',
    'not a url'
  ]) {
    expect(parse(url).success).toBe(false)
  }
})

test('a chat target must be https', () => {
  expect(
    ChatLinkSchema.safeParse({ kind: 'chat', app: 'discord', chat: 'http://discord.com/channels/1/2' }).success
  ).toBe(false)
  expect(
    ChatLinkSchema.safeParse({ kind: 'chat', app: 'teams', chat: 'http://teams.microsoft.com/l/chat/x' }).success
  ).toBe(false)
  expect(
    ChatLinkSchema.safeParse({ kind: 'chat', app: 'teams', chat: 'https://teams.microsoft.com/l/chat/x' }).success
  ).toBe(true)
})

test('entry name and lists reject control characters and are length-capped', () => {
  const identityId = '5f2d8f0e-1b7a-4c2e-9a3e-0d8f6c1b2a10'
  expect(EntryInputSchema.safeParse({ ...base, identityId, name: 'Data\tMining' }).success).toBe(false)
  expect(EntryInputSchema.safeParse({ ...base, identityId, name: 'x'.repeat(101) }).success).toBe(false)
  expect(EntryInputSchema.safeParse({ ...base, identityId, name: '' }).success).toBe(false)
  expect(
    EntryInputSchema.safeParse({ ...base, identityId, trustedSenders: Array.from({ length: 11 }, (_, i) => `n${i}`) })
      .success
  ).toBe(false)
})

test('saving needs a working AI key', async () => {
  const { scope, identityId, deps } = await member(false)
  await expect(saveEntry(scope, { ...base, identityId }, deps)).rejects.toThrow(NoWorkingKeyError)
  await expect(saveEntry(scope, { ...base, identityId }, deps)).rejects.toThrow(
    'Add a working DashScope key on the AI keys page before scheduling meetings.'
  )
})

test("an entry can't use another member's identity", async () => {
  const mine = await member()
  const theirs = await member()
  await expect(saveEntry(mine.scope, { ...base, identityId: theirs.identityId }, mine.deps)).rejects.toThrow(
    'No such identity.'
  )
})

test('a saved entry writes its occurrences and queues their launches, and an edit renames them', async () => {
  const { scope, identityId, deps } = await member()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  const rows = await scope.select(occurrences, eq(occurrences.entryId, entryId))
  expect(rows.map((r) => r.scheduledStart.toISOString()).sort()).toEqual([
    '2026-10-21T06:00:00.000Z',
    '2026-10-28T06:00:00.000Z'
  ])
  expect((deps.queue as FakeQueue).sent.filter((s) => s.name === 'launch')).toHaveLength(2)

  await saveEntry(scope, { ...base, id: entryId, identityId, name: 'Data Mining 2' }, deps)
  const renamed = await scope.select(occurrences, eq(occurrences.entryId, entryId))
  expect(renamed.map((r) => r.entryName)).toEqual(['Data Mining 2', 'Data Mining 2'])
})

test('a clashing entry is saved, pinged once and reported', async () => {
  const { scope, identityId, deps } = await member()
  await saveEntry(scope, { ...base, identityId }, deps)
  const r = await saveEntry(scope, { ...base, name: 'Statistics', identityId, start: '15:00', end: '17:00' }, deps)
  expect(r.clashes[0]).toEqual({
    loser: 'Statistics',
    winner: 'Data Mining',
    when: 'Wed 21 Oct, 15:00'
  })
  expect((deps.notifier as FakeNotifier).sent.map((s) => s.ping.title)).toEqual(['Timetable clash on University'])
})

test('the save result and the ping never carry the meeting passcode', async () => {
  const { scope, identityId, deps } = await member()
  await saveEntry(scope, { ...base, identityId }, deps)
  await expectNotLogged(PASSCODE, async () => {
    const r = await saveEntry(scope, { ...base, name: 'Statistics', identityId, start: '15:00', end: '17:00' }, deps)
    expect(JSON.stringify(r)).not.toContain(PASSCODE)
  })
  expect(JSON.stringify((deps.notifier as FakeNotifier).sent)).not.toContain(PASSCODE)
})

test("an entry with a meeting in progress can't be deleted", async () => {
  const { scope, identityId, deps } = await member()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  await scope.update(occurrences, { state: 'in_meeting' }, eq(occurrences.entryId, entryId))
  await expect(deleteEntry(scope, entryId, deps)).rejects.toThrow(InUseError)
  await expect(deleteEntry(scope, entryId, deps)).rejects.toThrow('This entry has a meeting in progress.')
})

test('deleting an entry removes its future sessions and never touches occurrences that already ran', async () => {
  const { scope, identityId, deps } = await member()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  const ranAt = new Date('2026-10-13T06:00:00Z')
  await scope.insert(occurrences, {
    entryId,
    identityId,
    entryName: 'Data Mining',
    entryType: 'lecture',
    transcription: 'live',
    scheduledStart: ranAt,
    scheduledEnd: new Date(ranAt.getTime() + 2 * 3_600_000),
    state: 'completed',
    deleteAfter: new Date(ranAt.getTime() + 30 * 24 * 3_600_000)
  })

  await deleteEntry(scope, entryId, deps)

  expect(await db.select().from(timetableEntries).where(eq(timetableEntries.id, entryId))).toEqual([])
  const left = await scope.select(occurrences)
  expect(left.map((r) => [r.state, r.entryName, r.scheduledStart.toISOString()])).toEqual([
    ['completed', 'Data Mining', '2026-10-13T06:00:00.000Z']
  ])
})

test('pausing removes future sessions and unpausing restores them', async () => {
  const { scope, identityId, deps, memberId } = await member()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  const count = async () => (await scope.select(occurrences, eq(occurrences.entryId, entryId))).length

  await setPaused(scope, entryId, true, deps)
  expect(await count()).toBe(0)
  const [row] = await db
    .select()
    .from(timetableEntries)
    .where(and(eq(timetableEntries.id, entryId), eq(timetableEntries.memberId, memberId)))
  expect(row?.paused).toBe(true)

  await setPaused(scope, entryId, false, deps)
  expect(await count()).toBe(2)
})

test("another member's entry can't be paused or deleted", async () => {
  const mine = await member()
  const theirs = await member()
  const { entryId } = await saveEntry(theirs.scope, { ...base, identityId: theirs.identityId }, theirs.deps)
  await expect(setPaused(mine.scope, entryId, true, mine.deps)).rejects.toThrow(InputError)
  await expect(deleteEntry(mine.scope, entryId, mine.deps)).rejects.toThrow('No such entry.')
})

test('saving again without paused leaves a paused entry paused', async () => {
  const { scope, identityId, deps } = await member()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  await setPaused(scope, entryId, true, deps)
  await saveEntry(scope, { ...base, id: entryId, identityId, name: 'Data Mining 2' }, deps)
  const [row] = await scope.select(timetableEntries, eq(timetableEntries.id, entryId))
  expect(row?.paused).toBe(true)
  expect(row?.name).toBe('Data Mining 2')
  expect(await scope.select(occurrences, eq(occurrences.entryId, entryId))).toHaveLength(0)
})

test('a new entry is not paused unless it says so', async () => {
  const { scope, identityId, deps } = await member()
  const a = await saveEntry(scope, { ...base, identityId }, deps)
  const b = await saveEntry(
    scope,
    { ...base, name: 'Other', identityId, start: '08:00', end: '09:00', paused: true },
    deps
  )
  const [rowA] = await scope.select(timetableEntries, eq(timetableEntries.id, a.entryId))
  const [rowB] = await scope.select(timetableEntries, eq(timetableEntries.id, b.entryId))
  expect([rowA?.paused, rowB?.paused]).toEqual([false, true])
})

test('an edit with link keep, or no link, leaves the stored link; a create needs a link', async () => {
  const { scope, identityId, deps } = await member()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  const { link: _link, ...noLink } = base
  await saveEntry(scope, { ...base, id: entryId, identityId, link: { kind: 'keep' }, name: 'Renamed' }, deps)
  await saveEntry(scope, { ...noLink, id: entryId, identityId, name: 'Renamed again' }, deps)
  const [row] = await scope.select(timetableEntries, eq(timetableEntries.id, entryId))
  expect(row?.name).toBe('Renamed again')
  expect(row?.link).toEqual({ kind: 'fixed', url: base.link.url })

  await expect(saveEntry(scope, { ...base, identityId, link: { kind: 'keep' } }, deps)).rejects.toThrow(InputError)
  await expect(saveEntry(scope, { ...noLink, identityId }, deps)).rejects.toThrow(InputError)
})

test('a masked link shows the host and meeting id, never the passcode', () => {
  const masked = maskedLink({ link: { kind: 'fixed', url: `https://example.zoom.us/j/00000000000?pwd=${PASSCODE}` } })
  expect(masked).toEqual({ kind: 'fixed', host: 'example.zoom.us', meetingId: '00000000000' })
  expect(JSON.stringify(masked)).not.toContain(PASSCODE)
  expect(maskedLink({ link: { kind: 'paste' } })).toEqual({ kind: 'paste' })
  expect(maskedLink({ link: { kind: 'chat', app: 'whatsapp', chat: 'Class group' } })).toEqual({
    kind: 'chat',
    app: 'whatsapp'
  })
})

test("another member's entry can't be edited", async () => {
  const mine = await member()
  const theirs = await member()
  const { entryId } = await saveEntry(theirs.scope, { ...base, identityId: theirs.identityId }, theirs.deps)
  await expect(
    saveEntry(mine.scope, { ...base, id: entryId, identityId: mine.identityId, name: 'Hijacked' }, mine.deps)
  ).rejects.toThrow('No such entry.')
  const [row] = await theirs.scope.select(timetableEntries, eq(timetableEntries.id, entryId))
  expect(row?.name).toBe('Data Mining')
})

test('a failing queue send rolls the whole save back', async () => {
  const { scope, identityId, deps } = await member()
  const failing: EntryDeps = {
    ...deps,
    queue: {
      send: async () => {
        throw new Error('queue down')
      }
    }
  }
  await expect(saveEntry(scope, { ...base, identityId }, failing)).rejects.toThrow('queue down')
  expect(await scope.select(timetableEntries)).toEqual([])
  expect(await scope.select(occurrences)).toEqual([])
})
