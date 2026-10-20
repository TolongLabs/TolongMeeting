import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Db } from '../db'
import { FakeNotifier } from '../db/notifier'
import { createTestDb, dropAllTestDbs, FakeQueue, seedMember } from '../db/testing'
import {
  currentLinkText,
  describeLink,
  describeRepeat,
  entryFormValues,
  fieldErrors,
  inputFromForm
} from '../app/timetable/entry-form-data'
import { createScope } from '../lib/scope'
import { EntryInputSchema, maskedLink, saveEntry, setPaused, type EntryDeps } from '../lib/timetable'
import { entryById, timetableView, todayIn } from '../lib/timetable-view'

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
const LINK = `https://example.zoom.us/j/12345678901?pwd=${PASSCODE}`

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) data.append(key, v)
  return data
}

const lectureFields = {
  name: 'Data Mining',
  type: 'lecture',
  repeatKind: 'weekly',
  date: '2026-10-01',
  days: ['1', '3'],
  start: '14:00',
  end: '16:00',
  linkKind: 'fixed',
  url: LINK,
  trustedSenders: 'Lecturer Name\n\n  Tutor  \n',
  courseCode: 'ABC1234',
  section: '',
  lecturer: '',
  keywords: 'kehadiran',
  transcription: 'live'
}

async function member() {
  const { memberId, identityId } = await seedMember(db, { full: false })
  const deps: EntryDeps = {
    queue: new FakeQueue(),
    notifier: new FakeNotifier(),
    ensureNtfy: async () => {},
    now,
    publicUrl: 'https://tm.example',
    gate: { whatsapp: 'home_only', discord: 'allowed' }
  }
  return { scope: createScope(db, memberId), identityId, deps }
}

test('the form fields become the input the schema expects, and never set paused', () => {
  const input = inputFromForm(form({ ...lectureFields, identityId: '5f2d8f0e-1b7a-4c2e-9a3e-0d8f6c1b2a10' }))
  const parsed = EntryInputSchema.parse(input)
  expect(parsed).toMatchObject({
    name: 'Data Mining',
    repeat: { kind: 'weekly', days: [1, 3], from: '2026-10-01' },
    link: { kind: 'fixed', url: LINK },
    trustedSenders: ['Lecturer Name', 'Tutor'],
    formDetails: { course_code: 'ABC1234' },
    attendanceKeywords: ['kehadiran']
  })
  expect(parsed.formDetails).toEqual({ course_code: 'ABC1234' })
  expect(parsed.paused).toBeUndefined()
  expect(parsed.id).toBeUndefined()
})

test('an edit that keeps the link sends no link text', () => {
  const input = inputFromForm(form({ ...lectureFields, id: crypto.randomUUID(), linkKind: 'keep', url: '' }))
  expect(input).toMatchObject({ link: { kind: 'keep' } })
  expect(JSON.stringify(input)).not.toContain('example.zoom.us')
})

test('each problem is tied to its field, in plain words', () => {
  const result = EntryInputSchema.safeParse(
    inputFromForm(form({ type: 'lecture', repeatKind: 'weekly', linkKind: 'fixed' }))
  )
  expect(result.success).toBe(false)
  const { fields, unplaced } = fieldErrors(result.error!.issues)
  expect(fields).toMatchObject({
    name: 'Enter a name.',
    days: 'Choose at least one day.',
    date: 'Enter a real date, for example 2026-10-21.',
    start: 'Enter a start time as HH:MM.',
    end: 'Enter an end time as HH:MM.',
    identity: 'Choose an identity.',
    'link-url': 'Enter a Zoom, Teams or Meet meeting link that starts with https://.'
  })
  expect(unplaced).toEqual([])

  const chat = EntryInputSchema.safeParse(
    inputFromForm(
      form({ ...lectureFields, identityId: crypto.randomUUID(), linkKind: 'chat', chatApp: 'discord', chat: 'general' })
    )
  )
  expect(fieldErrors(chat.error!.issues).fields['link-chat']).toBe(
    "Paste the channel's address, such as https://discord.com/channels/<server>/<channel>."
  )
})

test('the list and the edit page show the host and meeting id, never the link or passcode', async () => {
  const { scope, identityId, deps } = await member()
  const { entryId } = await saveEntry(scope, inputFromForm(form({ ...lectureFields, identityId })), deps)
  const entry = (await entryById(scope, entryId))!
  expect(describeLink(maskedLink(entry))).toBe('Fixed link on example.zoom.us, meeting 12345678901')
  expect(currentLinkText(entry)).not.toContain(PASSCODE)
  expect(describeRepeat(entry.repeat)).toBe('Every Monday and Wednesday from 2026-10-01')
  const values = entryFormValues(entry, { identityId, today: '2026-10-20' })
  expect(values).toMatchObject({ linkKind: 'keep', url: '', start: '14:00', end: '16:00', days: ['1', '3'] })
  expect(JSON.stringify(values)).not.toContain(PASSCODE)
})

test('the timetable lists entries by name with their next session, and a paused one has none', async () => {
  const { scope, identityId, deps } = await member()
  const make = (name: string, start: string, end: string) =>
    saveEntry(scope, inputFromForm(form({ ...lectureFields, name, start, end, identityId })), deps)
  const second = await make('Statistics', '16:00', '17:00')
  await make('Algorithms', '09:00', '10:00')
  let view = await timetableView(scope, now)
  expect(view.entries.map((e) => e.entry.name)).toEqual(['Algorithms', 'Statistics'])
  expect(view.entries.every((e) => e.next !== null && e.next > now)).toBe(true)
  expect(view.hasKey).toBe(true)
  expect(view.identities.map((i) => i.id)).toEqual([identityId])
  expect(view.entries[0]!.identityName).toBe('Main')

  await setPaused(scope, second.entryId, true, deps)
  view = await timetableView(scope, now)
  expect(view.entries.find((e) => e.entry.name === 'Statistics')).toMatchObject({ next: null })
  expect(view.entries.find((e) => e.entry.paused)?.entry.name).toBe('Statistics')
})

test("another member's entry, and a malformed id, are not found", async () => {
  const mine = await member()
  const theirs = await member()
  const { entryId } = await saveEntry(
    theirs.scope,
    inputFromForm(form({ ...lectureFields, identityId: theirs.identityId })),
    theirs.deps
  )
  expect(await entryById(mine.scope, entryId)).toBeNull()
  expect(await entryById(mine.scope, 'not-an-id')).toBeNull()
  expect(await entryById(theirs.scope, entryId)).not.toBeNull()
})

test("today is the member's date, not the server's", () => {
  expect(todayIn('Asia/Kuala_Lumpur', new Date('2026-10-20T20:00:00Z'))).toBe('2026-10-21')
  expect(todayIn('UTC', new Date('2026-10-20T20:00:00Z'))).toBe('2026-10-20')
})
