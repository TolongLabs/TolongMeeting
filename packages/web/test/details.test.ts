import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { BUILTIN_DETAILS, DetailsInputSchema, loadDetails, saveDetails } from '../lib/details'
import { createScope, type MemberScope } from '../lib/scope'

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
  expect(await loadDetails(scope)).toEqual({
    details: [
      {
        key: 'student_id',
        value: 'S0000000',
        labels: ['Matric No.', 'No. Matrik']
      }
    ],
    mentionNames: ['Short Name', 'S0000000']
  })
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

test('one member never sees another member’s details', async () => {
  const a = await bare()
  const b = await bare()
  await saveDetails(a, { details: [{ key: 'programme', value: 'Law', labels: [] }], mentionNames: ['Ann'] })
  expect(await loadDetails(b)).toEqual(EMPTY)
})
