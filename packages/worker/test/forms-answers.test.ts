import { tmpdir } from 'node:os'
import { expect, test } from 'bun:test'
import type { JobConfig } from '@tm/core'
import { buildDetailPool } from '../src/forms/details'
import { confirmationAnswer, exactLabelMatches, planPage, questionsForModel, verifyFill } from '../src/forms/plan'
import type { FormPage, FormQuestion, QuestionType } from '../src/forms/types'
import { testJob } from './forms/job'

const DIR = `${tmpdir()}/job-test`
const pool = buildDetailPool(testJob(DIR))
const value = (key: string) => pool.find((d) => d.key === key)?.value

const q = (id: string, label: string, type: QuestionType, options: string[] = [], required = false): FormQuestion => ({
  id,
  label,
  type,
  options,
  required,
  value: null
})
const pageOf = (questions: FormQuestion[]): FormPage => ({
  index: 1,
  title: '',
  description: '',
  questions,
  quiz: false,
  sendCopy: null,
  hasNext: false,
  hasSubmit: true,
  restriction: { organisation: null, signedInAs: null, orgOnly: false }
})

test('derived values use the entry time zone', () => {
  expect([value('session_date'), value('session_start'), value('course_code'), value('section')]).toEqual([
    '20/10/2026',
    '20:00',
    'ABC1234',
    '02'
  ])
  expect(pool.find((d) => d.key === 'student_id')?.labels).toContain('No. Matrik')

  // The entry's zone decides the wall-clock time, even when the start string carries another offset.
  const base = testJob(DIR)
  const utc = buildDetailPool({ ...base, entry: { ...base.entry, start: '2026-10-20T16:30:00Z' } })
  expect([utc.find((d) => d.key === 'session_date')?.value, utc.find((d) => d.key === 'session_start')?.value]).toEqual(
    ['21/10/2026', '00:30']
  )
  const london = buildDetailPool({ ...base, entry: { ...base.entry, timeZone: 'Europe/London' } })
  expect([
    london.find((d) => d.key === 'session_date')?.value,
    london.find((d) => d.key === 'session_start')?.value
  ]).toEqual(['20/10/2026', '13:00'])
})

test('form details override member details; empty values are dropped', () => {
  const base = testJob(DIR)
  const cfg: JobConfig = {
    ...base,
    member: {
      ...base.member,
      details: [
        { key: 'section', value: '01', labels: ['Seksyen kelas'] },
        { key: 'programme', value: '  ', labels: [] }
      ]
    },
    entry: { ...base.entry, formDetails: { section: '02', course_code: ' ' } }
  }
  const p = buildDetailPool(cfg)
  expect(p.find((d) => d.key === 'section')).toEqual({
    key: 'section',
    value: '02',
    labels: expect.arrayContaining(['Seksyen kelas', 'Section', 'Seksyen'])
  })
  expect(p.find((d) => d.key === 'programme')).toBeUndefined()
  expect(p.find((d) => d.key === 'course_code')).toBeUndefined()
})

test('exact label variants match; ambiguous labels do not', () => {
  const p = pageOf([
    q('p1q0', 'Full name *', 'text'),
    q('p1q1', 'No. Matrik:', 'text'),
    q('p1q2', 'Programme of study', 'text'),
    q('p1q3', 'Section', 'dropdown', ['01', '02', '03'])
  ])
  expect(exactLabelMatches(p, pool)).toEqual(
    new Map([
      ['p1q0', 'full_name'],
      ['p1q1', 'student_id'],
      ['p1q3', 'section']
    ])
  )
  expect(
    exactLabelMatches(pageOf([q('p1q0', 'Full name', 'text')]), [
      ...pool,
      { key: 'nickname', value: 'TS', labels: ['Full name'] }
    ]).size
  ).toBe(0)
})

test('confirmations need exactly one confirming option on a required radio or checkbox', () => {
  expect(confirmationAnswer(q('a', 'Attendance', 'radio', ['Present', 'Absent'], true))).toEqual({
    questionId: 'a',
    kind: 'choose',
    option: 'Present',
    detailKey: null,
    via: 'confirmation'
  })
  expect(
    confirmationAnswer(q('b', 'Attendance declaration', 'checkbox', ['I confirm I am attending this class'], true))
      ?.kind
  ).toBe('choose')
  expect(confirmationAnswer(q('c', 'Status', 'radio', ['Present', 'Present (online)', 'Absent'], true))).toBeNull()
  expect(confirmationAnswer(q('d', 'Status', 'radio', ['Not present', 'Tidak hadir'], true))).toBeNull()
  expect(confirmationAnswer(q('e', 'Attendance', 'radio', ['Present', 'Absent'], false))).toBeNull()
  expect(confirmationAnswer(q('f', 'Attendance', 'dropdown', ['Present', 'Absent'], true))).toBeNull()
})

test('a confirmation also needs attendance words in the question label', () => {
  expect(confirmationAnswer(q('p', 'Which describes the sample?', 'radio', ['Present', 'Absent'], true))).toBeNull()
  expect(confirmationAnswer(q('a', 'Attendance', 'radio', ['Present', 'Absent'], true))).toMatchObject({
    kind: 'choose',
    option: 'Present'
  })
  expect(confirmationAnswer(q('k', 'Kehadiran', 'radio', ['Hadir', 'Tidak hadir'], true))).toMatchObject({
    kind: 'choose',
    option: 'Hadir'
  })
  const plan = planPage(
    pageOf([q('p1q0', 'Which describes the sample?', 'radio', ['Present', 'Absent'], true)]),
    pool,
    new Map(),
    new Map()
  )
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])
})

test('a lone denying option is never chosen or ticked', () => {
  expect(confirmationAnswer(q('g', 'Attendance', 'radio', ['Absent'], true))).toBeNull()
  expect(confirmationAnswer(q('h', 'Attendance declaration', 'checkbox', ["I can't attend"], true))).toBeNull()
  const plan = planPage(pageOf([q('p1q0', 'Attendance', 'radio', ['Absent'], true)]), pool, new Map(), new Map())
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])
})

test('the send-me-a-copy box is never ticked, even when its wording mentions attendance', () => {
  const required = q(
    'p1q0',
    'Send me a copy of my attendance record',
    'checkbox',
    ['Send me a copy of my attendance record'],
    true
  )
  expect(confirmationAnswer(required)).toBeNull()
  const plan = planPage(pageOf([required]), pool, new Map(), new Map())
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])

  const optional = q('p1q1', 'Options', 'checkbox', ['Send me a copy'], false)
  expect(planPage(pageOf([optional]), pool, new Map(), new Map([['p1q1', 'university_email']])).answers).toEqual([])
  expect(questionsForModel(pageOf([optional]), new Map())).toEqual([])
})

test('copy boxes in other wording and languages are never ticked or sent to the model', () => {
  const microsoft = q(
    'p1q0',
    'Send me an email receipt of my responses',
    'checkbox',
    ['Send me an email receipt of my responses'],
    true
  )
  const malay = q('p1q1', 'Kehadiran', 'checkbox', ['Hadir', 'Hantar salinan jawapan kepada saya'], true)
  const emailed = q('p1q2', 'Receipt', 'checkbox', ['Get an e-mail copy'], false)
  for (const box of [microsoft, malay, emailed]) {
    expect(confirmationAnswer(box)).toBeNull()
  }
  const page = pageOf([microsoft, malay, emailed])
  expect(planPage(page, pool, new Map(), new Map()).answers).toEqual([])
  expect(questionsForModel(page, new Map())).toEqual([])
})

test('choice questions need an option exactly equal to the saved value', () => {
  const p = pageOf([
    q('p1q0', 'Section', 'dropdown', ['01', '02', '03'], true),
    q('p1q1', 'Section', 'radio', ['Section 1', 'Section 2'], true)
  ])
  const plan = planPage(
    p,
    pool,
    new Map([
      ['p1q0', 'section'],
      ['p1q1', 'section']
    ]),
    new Map()
  )
  expect(plan.answers).toEqual([
    {
      questionId: 'p1q0',
      kind: 'choose',
      option: '02',
      detailKey: 'section',
      via: 'label'
    }
  ])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q1'])
})

test('choice equality ignores case and spacing, but not punctuation or extra words', () => {
  const p = pageOf([
    q('p1q0', 'Lecturer', 'radio', ['Prof Other', '  DR   EXAMPLE '], true),
    q('p1q1', 'Lecturer', 'dropdown', ['Dr. Example', 'Dr Example Jr'], true),
    q('p1q2', 'Lecturer', 'radio', ['Dr Example', 'DR EXAMPLE'], true)
  ])
  const exact = new Map([
    ['p1q0', 'lecturer'],
    ['p1q1', 'lecturer'],
    ['p1q2', 'lecturer']
  ])
  const plan = planPage(p, pool, exact, new Map())
  expect(plan.answers).toEqual([
    { questionId: 'p1q0', kind: 'choose', option: '  DR   EXAMPLE ', detailKey: 'lecturer', via: 'label' }
  ])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q1', 'p1q2'])
})

test('a short saved choice does not match a longer option that starts with it', () => {
  const cPool = [{ key: 'language', value: 'C', labels: ['Language'] }]
  const exact = new Map([['p1q0', 'language']])
  const withC = pageOf([q('p1q0', 'Language', 'radio', ['C', 'C++', 'C#'], true)])
  expect(planPage(withC, cPool, exact, new Map()).answers).toEqual([
    { questionId: 'p1q0', kind: 'choose', option: 'C', detailKey: 'language', via: 'label' }
  ])
  const withoutC = pageOf([q('p1q0', 'Language', 'radio', ['C++', 'C#'], true)])
  const plan = planPage(withoutC, cPool, exact, new Map())
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])
})

test('an email differing only by "." and "_" is never chosen for the other', () => {
  const emailPool = [{ key: 'university_email', value: 'a.b@example.edu.my', labels: ['Email'] }]
  const exact = new Map([['p1q0', 'university_email']])
  const onlyUnderscore = pageOf([q('p1q0', 'Email', 'dropdown', ['a_b@example.edu.my'], true)])
  expect(planPage(onlyUnderscore, emailPool, exact, new Map()).unmatchedRequired).toHaveLength(1)
  const both = pageOf([q('p1q0', 'Email', 'dropdown', ['a_b@example.edu.my', 'a.b@example.edu.my'], true)])
  expect(planPage(both, emailPool, exact, new Map()).answers).toEqual([
    { questionId: 'p1q0', kind: 'choose', option: 'a.b@example.edu.my', detailKey: 'university_email', via: 'label' }
  ])
})

test('a date widget matched by label is still not filled', () => {
  const p = pageOf([q('p1q0', 'Date', 'other', [], true)])
  const exact = exactLabelMatches(p, pool)
  expect(exact.get('p1q0')).toBe('session_date')
  const plan = planPage(p, pool, exact, new Map())
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])
})

test('optional unmatched questions are left blank; required ones block', () => {
  const p = pageOf([
    q('p1q0', 'Any comments?', 'paragraph'),
    q('p1q1', 'What did you learn today?', 'paragraph', [], true),
    q('p1q2', 'Date', 'other', [], true),
    q('p1q3', 'Programme of study', 'text')
  ])
  const plan = planPage(p, pool, new Map(), new Map([['p1q3', 'programme']]))
  expect(plan.answers).toEqual([
    {
      questionId: 'p1q3',
      kind: 'text',
      value: 'MSc Example',
      detailKey: 'programme',
      via: 'model'
    }
  ])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q1', 'p1q2'])
})

test('a model choice answer needs the same exact option match', () => {
  const p = pageOf([q('p1q0', 'Course', 'radio', ['MSc Example', 'MSc Other'], true)])
  expect(planPage(p, pool, new Map(), new Map([['p1q0', 'programme']])).answers).toEqual([
    { questionId: 'p1q0', kind: 'choose', option: 'MSc Example', detailKey: 'programme', via: 'model' }
  ])
  const mismatch = pageOf([q('p1q0', 'Course', 'radio', ['MSc Example Extra'], true)])
  expect(planPage(mismatch, pool, new Map(), new Map([['p1q0', 'programme']])).unmatchedRequired).toHaveLength(1)
})

test('a model mapping to a key outside the pool fails loudly', () => {
  const p = pageOf([q('p1q0', 'Favourite colour', 'text')])
  expect(() => planPage(p, pool, new Map(), new Map([['p1q0', 'nickname']]))).toThrow('unknown detail key')
})

test('only unmatched, fillable questions go to the model, with text cut to 120 characters', () => {
  const p = pageOf([
    q('p1q0', 'Full name', 'text'),
    q('p1q1', 'Attendance', 'radio', ['Present', 'Absent'], true),
    q('p1q2', 'Date', 'other'),
    q('p1q3', 'Programme of study', 'text', [], false),
    q('p1q4', 'x'.repeat(200), 'text')
  ])
  const sent = questionsForModel(p, exactLabelMatches(p, pool))
  expect(sent).toEqual([
    { id: 'p1q3', label: 'Programme of study', options: [] },
    { id: 'p1q4', label: 'x'.repeat(120), options: [] }
  ])
})

test('verifyFill rejects a missing answer, a stray value or a ticked copy box', () => {
  const plan = {
    answers: [
      {
        questionId: 'p1q0',
        kind: 'text' as const,
        value: 'Test Student',
        detailKey: 'full_name',
        via: 'label' as const
      }
    ],
    unmatchedRequired: []
  }
  const ok = pageOf([
    { ...q('p1q0', 'Full name', 'text'), value: 'Test Student' },
    q('p1q1', 'Any comments?', 'paragraph')
  ])
  expect(verifyFill(plan, ok)).toBe(true)
  expect(verifyFill(plan, pageOf([q('p1q0', 'Full name', 'text')]))).toBe(false)
  expect(
    verifyFill(plan, {
      ...ok,
      questions: [ok.questions[0], { ...ok.questions[1], value: 'x' }]
    })
  ).toBe(false)
  expect(verifyFill(plan, { ...ok, sendCopy: true })).toBe(false)
})

test('verifyFill accepts only the single chosen option', () => {
  const plan = {
    answers: [
      {
        questionId: 'p1q0',
        kind: 'choose' as const,
        option: 'Present',
        detailKey: null,
        via: 'confirmation' as const
      }
    ],
    unmatchedRequired: []
  }
  const attendance = q('p1q0', 'Attendance', 'checkbox', ['Present', 'Absent'], true)
  expect(verifyFill(plan, pageOf([{ ...attendance, value: ['Present'] }]))).toBe(true)
  expect(verifyFill(plan, pageOf([{ ...attendance, value: ['Present', 'Absent'] }]))).toBe(false)
  expect(verifyFill(plan, pageOf([attendance]))).toBe(false)
})

const dateAnswer = (id: string, value: string) => ({
  questionId: id,
  kind: 'date' as const,
  value,
  detailKey: 'session_date' as const,
  via: 'label' as const
})
const timeAnswer = (id: string, value: string) => ({
  questionId: id,
  kind: 'time' as const,
  value,
  detailKey: 'session_start' as const,
  via: 'label' as const
})

test('a required date or time widget whose label is a session_date or session_start variant is answered', () => {
  const p = pageOf([
    q('p1q0', 'Date', 'date', [], true),
    q('p1q1', 'Start time', 'time', [], true),
    q('p1q2', 'Tarikh kelas', 'date', [], true),
    q('p1q3', 'Masa:', 'time', [], true)
  ])
  const plan = planPage(p, pool, exactLabelMatches(p, pool), new Map())
  expect(plan.answers).toEqual([
    dateAnswer('p1q0', '2026-10-20'),
    timeAnswer('p1q1', '20:00'),
    dateAnswer('p1q2', '2026-10-20'),
    timeAnswer('p1q3', '20:00')
  ])
  expect(plan.unmatchedRequired).toEqual([])
})

test('date and time values come from the entry time zone, not the host clock or the written offset', () => {
  const base = testJob(DIR)
  const late = buildDetailPool({ ...base, entry: { ...base.entry, start: '2026-10-20T16:30:00Z' } })
  const p = pageOf([q('p1q0', 'Date', 'date', [], true), q('p1q1', 'Time', 'time', [], true)])
  expect(planPage(p, late, exactLabelMatches(p, late), new Map()).answers).toEqual([
    dateAnswer('p1q0', '2026-10-21'),
    timeAnswer('p1q1', '00:30')
  ])
  const london = buildDetailPool({ ...base, entry: { ...base.entry, timeZone: 'Europe/London' } })
  expect(planPage(p, london, exactLabelMatches(p, london), new Map()).answers).toEqual([
    dateAnswer('p1q0', '2026-10-20'),
    timeAnswer('p1q1', '13:00')
  ])
})

test('an optional date or time stays blank and does not block', () => {
  const p = pageOf([q('p1q0', 'Date', 'date'), q('p1q1', 'Time', 'time')])
  const plan = planPage(p, pool, exactLabelMatches(p, pool), new Map())
  expect(plan).toEqual({ answers: [], unmatchedRequired: [] })
})

test('a date question with another label stays unmatched, and the model cannot match it', () => {
  const p = pageOf([q('p1q0', 'When did the class run?', 'date', [], true)])
  expect(questionsForModel(p, exactLabelMatches(p, pool)).map((x) => x.id)).toEqual([])
  const plan = planPage(p, pool, exactLabelMatches(p, pool), new Map([['p1q0', 'session_date']]))
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])
})

test('the widget type must agree with the label: a time widget labelled Date is not answered', () => {
  const p = pageOf([q('p1q0', 'Date', 'time', [], true), q('p1q1', 'Time', 'date', [], true)])
  const plan = planPage(p, pool, exactLabelMatches(p, pool), new Map())
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired.map((x) => x.id)).toEqual(['p1q0', 'p1q1'])
})

test('a session_date a form detail overrode with a non-date is not written into a date widget', () => {
  const base = testJob(DIR)
  const odd = buildDetailPool({
    ...base,
    entry: {
      ...base.entry,
      formDetails: { ...base.entry.formDetails, session_date: 'next Tuesday', session_start: '8pm' }
    }
  })
  const p = pageOf([q('p1q0', 'Date', 'date', [], true), q('p1q1', 'Time', 'time', [], true)])
  const plan = planPage(p, odd, exactLabelMatches(p, odd), new Map())
  expect(plan.answers).toEqual([])
  expect(plan.unmatchedRequired).toHaveLength(2)
})

test('verifyFill compares a date or time read-back to the planned value', () => {
  const plan = { answers: [dateAnswer('p1q0', '2026-10-20'), timeAnswer('p1q1', '20:00')], unmatchedRequired: [] }
  const shown = (date: string | null, time: string | null) =>
    pageOf([
      { ...q('p1q0', 'Date', 'date', [], true), value: date },
      { ...q('p1q1', 'Time', 'time', [], true), value: time }
    ])
  expect(verifyFill(plan, shown('2026-10-20', '20:00'))).toBe(true)
  expect(verifyFill(plan, shown('2026-10-21', '20:00'))).toBe(false) // the widget moved the day
  expect(verifyFill(plan, shown('2026-10-20', '21:00'))).toBe(false) // the widget moved the hour
  expect(verifyFill(plan, shown('2026-10-20', null))).toBe(false) // nothing stayed
  expect(verifyFill(plan, shown('20/10/2026', '20:00'))).toBe(false) // text the driver could not read as a date
})

test('verifyFill refuses a date or time left in a question that was not answered', () => {
  const stray = pageOf([{ ...q('p1q0', 'Date', 'date'), value: '2026-10-20' }])
  expect(verifyFill({ answers: [], unmatchedRequired: [] }, stray)).toBe(false)
})

test('a text date picker is filled only when day and month swap leaves the date unchanged', () => {
  const at = (start: string) => buildDetailPool({ ...testJob(DIR), entry: { ...testJob(DIR).entry, start } })
  const text = [
    { ...q('p1q0', 'Date', 'date', [], true), dateFormat: { source: 'placeholder' as const, pattern: 'M/d/yyyy' } }
  ]
  const answers = (start: string, questions: FormQuestion[]) => {
    const pl = at(start)
    return planPage(pageOf(questions), pl, exactLabelMatches(pageOf(questions), pl), new Map())
  }
  expect(answers('2026-10-05T12:00:00Z', text).unmatchedRequired.map((x) => x.id)).toEqual(['p1q0'])
  expect(answers('2026-10-20T12:00:00Z', text).answers).toEqual([dateAnswer('p1q0', '2026-10-20')])
  expect(answers('2026-10-10T12:00:00Z', text).answers).toEqual([dateAnswer('p1q0', '2026-10-10')])
  // input[type=date] lists no format: it is ISO, so an ambiguous day is still written.
  expect(answers('2026-10-05T12:00:00Z', [q('p1q0', 'Date', 'date', [], true)]).answers).toEqual([
    dateAnswer('p1q0', '2026-10-05')
  ])
})
