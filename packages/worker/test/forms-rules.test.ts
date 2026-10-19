import { expect, test } from 'bun:test'
import type { OrgConfig } from '@tm/core'
import { confirmsAttendance, isPointsLine, looksLikeAttendance, normaliseText, orgRestricted } from '../src/forms/rules'
import type { FormPage } from '../src/forms/types'

const page = (p: Partial<FormPage>): FormPage => ({
  index: 1,
  title: '',
  description: '',
  questions: [],
  quiz: false,
  sendCopy: null,
  hasNext: false,
  hasSubmit: true,
  restriction: { organisation: null, signedInAs: null, orgOnly: false },
  ...p
})
const org: OrgConfig = { name: 'Example University', emailDomain: 'example.edu.my' }

test('attendance terms in English and Malay, whole words only', () => {
  for (const title of ['Week 5 Attendance', 'Borang Kehadiran', 'Sign-in sheet', 'Register here'])
    expect(looksLikeAttendance(page({ title }), [])).toBe(true)
  expect(
    looksLikeAttendance(
      page({
        title: 'Week 5',
        questions: [
          {
            id: 'p1q0',
            label: 'Status',
            type: 'radio',
            options: ['Hadir', 'Tidak hadir'],
            required: true,
            value: null
          }
        ]
      }),
      []
    )
  ).toBe(true)
  expect(looksLikeAttendance(page({ description: 'Isi untuk kehadiran' }), [])).toBe(true)
  expect(looksLikeAttendance(page({ title: 'Course registration feedback' }), [])).toBe(false)
  expect(looksLikeAttendance(page({ title: 'ABC1234 check-in' }), ['abc1234 check'])).toBe(true)
})

test('only page 1 is judged, and blank entry keywords never match', () => {
  expect(() => looksLikeAttendance(page({ index: 2, title: 'Attendance' }), [])).toThrow()
  expect(looksLikeAttendance(page({ title: 'Course feedback' }), ['', '  -- '])).toBe(false)
})

test('points lines mark a quiz; labels that mention points do not', () => {
  for (const l of ['1 point', '2 points', '(1 point)', 'Points: 5', '1 mata', '  2 points  ']) {
    expect(isPointsLine(l)).toBe(true)
  }
  expect(isPointsLine('Explain 2 points from today')).toBe(false)
})

test('normalisation folds width and punctuation, keeps apostrophes as spaces', () => {
  expect(normaliseText('  Sign-in  Sheet!! ')).toBe('sign in sheet')
  expect(normaliseText("I can't attend")).toBe('i can t attend')
  expect(normaliseText('ＨＡＤＩＲ')).toBe('hadir')
})

test('confirmation options', () => {
  for (const o of ['Present', 'Hadir', 'I confirm I am attending this class', 'Saya hadir', 'Present (late)'])
    expect(confirmsAttendance(o)).toBe(true)
  for (const o of ['Absent', 'Not present', 'Tidak hadir', "I can't attend", 'Presentation', 'Yes'])
    expect(confirmsAttendance(o)).toBe(false)
})

test('a second confirming option is still a confirmation; the one-choice rule lives in Task 6', () => {
  // "Present" and "Present (online)" both confirm. Neither is chosen on its own: the pair is ambiguous.
  expect(confirmsAttendance('Present')).toBe(true)
  expect(confirmsAttendance('Present (online)')).toBe(true)
  // A denying option next to a confirming one does not make the confirmation ambiguous.
  expect(confirmsAttendance('Not present')).toBe(false)
})

test('organisation evidence', () => {
  expect(
    orgRestricted(
      {
        organisation: 'Example University',
        signedInAs: 'student@example.edu.my',
        orgOnly: false
      },
      org
    )
  ).toBe(true)
  expect(
    orgRestricted(
      {
        organisation: null,
        signedInAs: 'student@graduate.example.edu.my',
        orgOnly: true
      },
      org
    )
  ).toBe(true)
  expect(
    orgRestricted(
      {
        organisation: 'Other University',
        signedInAs: 'student@example.edu.my',
        orgOnly: false
      },
      org
    )
  ).toBe(false)
  expect(orgRestricted({ organisation: 'Example University', signedInAs: null, orgOnly: false }, org)).toBe(false)
  expect(orgRestricted({ organisation: null, signedInAs: 'someone@gmail.com', orgOnly: true }, org)).toBe(false)
  expect(
    orgRestricted(
      {
        organisation: 'Example University',
        signedInAs: 'student@example.edu.my',
        orgOnly: true
      },
      null
    )
  ).toBe(false)
})

test('organisation domain matches whole labels only', () => {
  expect(orgRestricted({ organisation: null, signedInAs: 'student@notexample.edu.my', orgOnly: true }, org)).toBe(false)
  expect(
    orgRestricted({ organisation: null, signedInAs: 'student@example.edu.my.evil.test', orgOnly: true }, org)
  ).toBe(false)
  expect(orgRestricted({ organisation: null, signedInAs: 'no-at-sign', orgOnly: true }, org)).toBe(false)
})
