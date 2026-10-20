import { afterAll, beforeAll, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { inspect } from 'node:util'
import { details, type Db } from '../db'
import { DbError } from '../db/errors'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { BUILTIN_DETAILS, DetailsInputSchema, loadDetails, MENTION_NAMES_COPY, saveDetails } from '../lib/details'
import { InputError } from '../lib/identities'
import { createScope, type MemberScope } from '../lib/scope'
import { expectNotLogged } from './no-log'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

/** A member with no details or mention names. */
async function bare(): Promise<MemberScope> {
  const { memberId } = await seedMember(db, { full: false })
  return createScope(db, memberId)
}

const EMPTY = { details: [], mentionNames: [] }

test('details and mention names round-trip with label variants', async () => {
  const scope = await bare()
  await saveDetails(scope, {
    details: [
      {
        key: 'student_id',
        value: 'S0000000',
        labels: ['Matric No.', 'No. Matrik']
      }
    ],
    mentionNames: ['Short Name', 'S0000000']
  })
  const loaded = await loadDetails(scope)
  expect(loaded.details).toEqual([
    {
      key: 'student_id',
      value: 'S0000000',
      labels: ['Matric No.', 'No. Matrik']
    }
  ])
  // Mention names have no position column yet, so they come back in id order: stable, not the typed order.
  expect([...loaded.mentionNames].sort()).toEqual(['S0000000', 'Short Name'])
  expect(await loadDetails(scope)).toEqual(loaded)
})

test('duplicate labels and a malformed university email are refused', () => {
  expect(
    DetailsInputSchema.safeParse({
      details: [
        {
          key: 'student_id',
          value: 'S1',
          labels: ['Matric No.', 'matric no.']
        }
      ],
      mentionNames: []
    }).success
  ).toBe(false)
  expect(
    DetailsInputSchema.safeParse({
      details: [{ key: 'university_email', value: 'not-an-email', labels: [] }],
      mentionNames: []
    }).success
  ).toBe(false)
})

test('the built-in keys are the four the forms use', () => {
  expect(BUILTIN_DETAILS.map((d) => d.key)).toEqual(['full_name', 'student_id', 'university_email', 'programme'])
})

test('saving replaces everything and keeps the input order', async () => {
  const scope = await bare()
  await saveDetails(scope, {
    details: [
      { key: 'programme', value: 'Computing', labels: [] },
      { key: 'full_name', value: 'Ada Lovelace', labels: [] }
    ],
    mentionNames: ['Ada']
  })
  await saveDetails(scope, {
    details: [{ key: 'full_name', value: 'Ada King', labels: [] }],
    mentionNames: []
  })
  expect(await loadDetails(scope)).toEqual({
    details: [{ key: 'full_name', value: 'Ada King', labels: [] }],
    mentionNames: []
  })
})

test('an empty save clears the member’s details', async () => {
  const scope = await bare()
  await saveDetails(scope, { details: [{ key: 'programme', value: 'Law', labels: [] }], mentionNames: ['L'] })
  await saveDetails(scope, EMPTY)
  expect(await loadDetails(scope)).toEqual(EMPTY)
})

test('values are trimmed and lengths are enforced', () => {
  const parsed = DetailsInputSchema.parse({
    details: [{ key: 'programme', value: '  Law  ', labels: [' Course '] }],
    mentionNames: ['  Lee  ']
  })
  expect(parsed.details[0]).toMatchObject({ value: 'Law', labels: ['Course'] })
  expect(parsed.mentionNames).toEqual(['Lee'])
  expect(
    DetailsInputSchema.safeParse({
      details: [{ key: 'programme', value: 'x'.repeat(201), labels: [] }],
      mentionNames: []
    }).success
  ).toBe(false)
  expect(
    DetailsInputSchema.safeParse({ details: [{ key: 'Programme', value: 'Law', labels: [] }], mentionNames: [] })
      .success
  ).toBe(false)
  expect(
    DetailsInputSchema.safeParse({
      details: [{ key: 'programme', value: 'Law', labels: ['x'.repeat(121)] }],
      mentionNames: []
    }).success
  ).toBe(false)
  expect(DetailsInputSchema.safeParse({ details: [], mentionNames: ['x'.repeat(61)] }).success).toBe(false)
  expect(
    DetailsInputSchema.safeParse({ details: [], mentionNames: Array.from({ length: 21 }, (_, i) => `n${i}`) }).success
  ).toBe(false)
})

test('keys are unique and a university email must be an email address', () => {
  expect(
    DetailsInputSchema.safeParse({
      details: [
        { key: 'programme', value: 'Law', labels: [] },
        { key: 'programme', value: 'Medicine', labels: [] }
      ],
      mentionNames: []
    }).success
  ).toBe(false)
  expect(
    DetailsInputSchema.safeParse({
      details: [{ key: 'university_email', value: 'ada@uni.edu.my', labels: [] }],
      mentionNames: []
    }).success
  ).toBe(true)
})

test('mention names are unique ignoring case', () => {
  expect(DetailsInputSchema.safeParse({ details: [], mentionNames: ['Lee', 'lee'] }).success).toBe(false)
})

test('a save refused by validation leaves the saved details as they were', async () => {
  const scope = await bare()
  await saveDetails(scope, { details: [{ key: 'programme', value: 'Law', labels: [] }], mentionNames: [] })
  await expect(
    saveDetails(scope, { details: [{ key: 'programme', value: '', labels: [] }], mentionNames: [] })
  ).rejects.toThrow()
  expect((await loadDetails(scope)).details).toEqual([{ key: 'programme', value: 'Law', labels: [] }])
})

/** The text a logger would print for an error: its message, stack, own properties and cause. */
function errorText(error: unknown): string {
  return inspect(error, { showHidden: true, depth: 10 })
}

/** Resolves once a query is blocked on a row lock, so the test knows the second save has reached its insert. */
async function untilBlockedOnLock(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await db.execute(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    )
    if (Number(result.rows[0]?.waiting) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The second save never waited on the first')
}

test('a NUL byte in a saved value is refused and the value is never echoed', async () => {
  const scope = await bare()
  let error: unknown
  await expectNotLogged('Secret', async () => {
    error = await saveDetails(scope, {
      details: [{ key: 'programme', value: 'Lo\u0000Secret', labels: [] }],
      mentionNames: []
    }).catch((e: unknown) => e)
  })
  expect(error).toBeInstanceOf(InputError)
  expect(errorText(error)).not.toContain('Secret')
  expect((await loadDetails(scope)).details).toEqual([])
})

test('control characters are refused in every free-text field', () => {
  for (const input of [
    { details: [{ key: 'programme', value: 'Law\nSchool', labels: [] }], mentionNames: [] },
    { details: [{ key: 'programme', value: 'Law', labels: ['Course\u0001'] }], mentionNames: [] },
    { details: [], mentionNames: ['Lee\u009f'] }
  ]) {
    expect(DetailsInputSchema.safeParse(input).success).toBe(false)
  }
})

test('a concurrent duplicate (member, key) save fails with a code only, never the saved values', async () => {
  const { memberId } = await seedMember(db, { full: false })
  const scope = createScope(db, memberId)
  const HELD = 'HeldSecret'
  const SAVED = 'SavedSecret'
  let rowInserted!: () => void
  const inserted = new Promise<void>((resolve) => (rowInserted = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  // A transaction on another connection inserts (member, 'programme') and holds it uncommitted.
  const holder = db.transaction(async (tx) => {
    await tx.insert(details).values({ memberId, key: 'programme', value: HELD, labels: [], position: 0 })
    rowInserted()
    await released
  })
  await inserted
  let error: unknown
  await expectNotLogged(HELD, () =>
    expectNotLogged(SAVED, async () => {
      const saving = saveDetails(scope, {
        details: [{ key: 'programme', value: SAVED, labels: [] }],
        mentionNames: []
      }).then(
        () => undefined,
        (e: unknown) => e
      )
      try {
        await untilBlockedOnLock()
      } finally {
        release()
        await holder
      }
      error = await saving
    })
  )
  expect(error).toBeInstanceOf(DbError)
  expect((error as DbError).code).toBe('23505')
  expect((error as Error).cause).toBeUndefined()
  for (const secret of [HELD, SAVED]) expect(errorText(error)).not.toContain(secret)
})

test('one member never sees another member’s details', async () => {
  const a = await bare()
  const b = await bare()
  await saveDetails(a, { details: [{ key: 'programme', value: 'Law', labels: [] }], mentionNames: ['Ann'] })
  expect(await loadDetails(b)).toEqual(EMPTY)
})

test('the names copy says short names are not watched', () => {
  expect(MENTION_NAMES_COPY.hint).toContain('at least 3 letters (2 for Chinese, Japanese, Thai, Lao, Khmer and Myanmar')
  expect(MENTION_NAMES_COPY.hint).toContain('Shorter names are not watched')
})
