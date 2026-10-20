import type { SavedDetail } from '@tm/core'
import { clockTime, parseDate } from './datetime'
import { POOL_DATE_FORMAT } from './details'
import { confirmsAttendance, normaliseText } from './rules'
import type { Answer, FormPage, FormQuestion, MatchQuestion, PagePlan } from './types'

const MODEL_TEXT_LIMIT = 120
// Matched against normaliseText output, so "e-mail" arrives as "e mail".
const COPY_NOUN = /\b(?:copy|copies|receipt|salinan|resit)\b/
const COPY_VERB = /\b(?:send|email|e mail|get|receive|hantar|emel)\b/
// Attendance vocabulary for a confirmation question's label. Option text alone never makes a confirmation.
const ATTENDANCE_LABEL =
  /\b(?:attendance|kehadiran|hadir|present|presence|attend|attending|register|registration|sign in|sign in sheet|roll call|check in)\b/

// The copy box is never answered, even when its wording mentions attendance. A copy word and a send word anywhere
// in the question's label or options make it one.
function isCopyBox(q: FormQuestion): boolean {
  const text = normaliseText([q.label, ...q.options].join(' '))
  return COPY_NOUN.test(text) && COPY_VERB.test(text)
}

// Choice equality is stricter than normaliseText: NFKC, case-folded, trimmed, whitespace collapsed. Punctuation counts,
// so "Dr. Example" and "Dr Example" differ, and so do "a.b@x" and "a_b@x".
function strictText(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
}

function cut(text: string): string {
  return [...text].slice(0, MODEL_TEXT_LIMIT).join('')
}

// The key of the one detail that carries the question's normalised label; null for none or several.
function exactKey(q: FormQuestion, pool: SavedDetail[]): string | null {
  const label = normaliseText(q.label)
  if (label === '') return null
  const keys = new Set(pool.filter((d) => d.labels.some((l) => normaliseText(l) === label)).map((d) => d.key))
  return keys.size === 1 ? [...keys][0]! : null
}

// A question maps to a detail only when exactly one detail carries its normalised label.
export function exactLabelMatches(page: FormPage, pool: SavedDetail[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const q of page.questions) {
    const key = exactKey(q, pool)
    if (key !== null) found.set(q.id, key)
  }
  return found
}

// A date or time answer needs a required date or time widget (typed by the driver from the DOM) whose label equals a
// variant of session_date (date widget) or session_start (time widget), and a pool value that is a real date or time.
// The model never sees these questions, and an optional one stays blank. The pool value comes from the entry's own time
// zone, so the host clock is never read.
export function dateTimeAnswer(q: FormQuestion, pool: SavedDetail[]): Answer | null {
  if (!q.required || (q.type !== 'date' && q.type !== 'time')) return null
  const key = exactKey(q, pool)
  const detail = pool.find((d) => d.key === key)
  if (detail === undefined) return null
  if (q.type === 'date' && key === 'session_date') {
    const value = parseDate(detail.value, POOL_DATE_FORMAT)
    return value === null ? null : { questionId: q.id, kind: 'date', value, detailKey: 'session_date', via: 'label' }
  }
  if (q.type === 'time' && key === 'session_start') {
    const value = clockTime(detail.value)
    return value === null ? null : { questionId: q.id, kind: 'time', value, detailKey: 'session_start', via: 'label' }
  }
  return null
}

// A required radio or checkbox that asks about attendance (label), with exactly one confirming option.
// Zero or several confirming options mean no answer. The option text alone is judged by confirmsAttendance.
export function confirmationAnswer(q: FormQuestion): Answer | null {
  if (!q.required || (q.type !== 'radio' && q.type !== 'checkbox')) return null
  if (isCopyBox(q) || !ATTENDANCE_LABEL.test(normaliseText(q.label))) return null
  const confirming = q.options.filter(confirmsAttendance)
  if (confirming.length !== 1) return null
  return { questionId: q.id, kind: 'choose', option: confirming[0], detailKey: null, via: 'confirmation' }
}

// Choice questions take an option only when its strict text equals the strict saved value; none or several means null.
function answerFrom(q: FormQuestion, key: string, via: 'label' | 'model', pool: SavedDetail[]): Answer | null {
  const detail = pool.find((d) => d.key === key)
  if (!detail) throw new Error(`unknown detail key for question ${q.id}: ${key}`)
  if (q.type === 'text' || q.type === 'paragraph') {
    return { questionId: q.id, kind: 'text', value: detail.value, detailKey: key, via }
  }
  if (q.type === 'radio' || q.type === 'checkbox' || q.type === 'dropdown') {
    const want = strictText(detail.value)
    if (want === '') return null
    const matches = q.options.filter((o) => strictText(o) === want)
    if (matches.length !== 1) return null
    return { questionId: q.id, kind: 'choose', option: matches[0], detailKey: key, via }
  }
  return null
}

function planQuestion(
  q: FormQuestion,
  pool: SavedDetail[],
  exact: Map<string, string>,
  model: Map<string, string>
): Answer | null {
  const confirmation = confirmationAnswer(q)
  if (confirmation) return confirmation
  if (isCopyBox(q)) return null
  if (q.type === 'date' || q.type === 'time') return dateTimeAnswer(q, pool)
  const labelKey = exact.get(q.id)
  if (labelKey !== undefined) return answerFrom(q, labelKey, 'label', pool)
  const modelKey = model.get(q.id)
  if (modelKey !== undefined) return answerFrom(q, modelKey, 'model', pool)
  return null
}

// The caller has already checked trust and the attendance terms. Answers are never invented: an unmatched
// optional question stays blank, and an unmatched required one is listed for the member.
export function planPage(
  page: FormPage,
  pool: SavedDetail[],
  exact: Map<string, string>,
  model: Map<string, string>
): PagePlan {
  const answers: Answer[] = []
  const unmatchedRequired: FormQuestion[] = []
  for (const q of page.questions) {
    const answer = planQuestion(q, pool, exact, model)
    if (answer) answers.push(answer)
    else if (q.required) unmatchedRequired.push(q)
  }
  return { answers, unmatchedRequired }
}

// Questions the model may map to a detail: not exact-matched, not an attendance confirmation, not the copy box,
// and not a date, time or grid widget (a date or time is planned by dateTimeAnswer). Labels and options are cut to 120 characters.
export function questionsForModel(page: FormPage, exact: Map<string, string>): MatchQuestion[] {
  return page.questions
    .filter(
      (q) =>
        !exact.has(q.id) &&
        q.type !== 'other' &&
        q.type !== 'date' &&
        q.type !== 'time' &&
        !isCopyBox(q) &&
        confirmationAnswer(q) === null
    )
    .map((q) => ({ id: q.id, label: cut(q.label), options: q.options.map(cut) }))
}

function selected(value: FormQuestion['value']): string[] {
  if (value === null) return []
  return Array.isArray(value) ? value : [value]
}

function shows(q: FormQuestion, a: Answer): boolean {
  if (a.kind === 'text') return q.value === a.value
  // The read-back must be the planned value, in the same normal form: a widget that kept another value fails.
  if (a.kind === 'date' || a.kind === 'time') return q.type === a.kind && q.value === a.value
  const chosen = selected(q.value)
  return chosen.length === 1 && chosen[0] === a.option
}

// True only when every answer shows on the page, every unanswered question is empty, and the copy box is not ticked.
export function verifyFill(plan: PagePlan, after: FormPage): boolean {
  if (after.sendCopy === true) return false
  for (const a of plan.answers) {
    const q = after.questions.find((x) => x.id === a.questionId)
    if (!q || !shows(q, a)) return false
  }
  const answered = new Set(plan.answers.map((a) => a.questionId))
  return after.questions.every((q) => answered.has(q.id) || selected(q.value).every((v) => v === ''))
}
