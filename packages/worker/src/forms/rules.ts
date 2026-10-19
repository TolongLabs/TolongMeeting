import type { OrgConfig } from '@tm/core'
import type { FormPage, Restriction } from './types'

const ATTENDANCE_TERMS = /\b(attendance|kehadiran|hadir|register|sign in sheet)\b/
// Matched against normaliseText output, so "1.5" arrives as "1 5" and "Points: 5 / 10" as "points 5 10".
const NUMBER = String.raw`\d+(?: \d+)?`
const UNIT = String.raw`(?:pts?|points?|marks?|mata|markah|poin)`
// "point(s)" normalises to "point s", hence the optional " s" after a unit.
const POINTS_LINE = new RegExp(
  String.raw`^(?:${NUMBER} ${UNIT}(?: s)?|${NUMBER} (?:out )?of ${NUMBER} ${UNIT}(?: s)?|(?:${UNIT}|score|skor|jumlah markah) ${NUMBER}(?: (?:(?:out )?of )?${NUMBER})?|total ${NUMBER} ${UNIT}|total ${UNIT} ${NUMBER})$`
)
const CONFIRM_POSITIVE = /\b(present|hadir|attend|attending|attended|attendance|here)\b/
// A negation word, or a lone "t" left when an apostrophe splits a contraction ("can't" -> "can t", "T/Hadir" -> "t hadir").
const CONFIRM_NEGATIVE =
  /\b(not|no|non|neither|nor|never|absent|unavailable|unable|unattend\w*|cannot|cant|dont|wont|didnt|isnt|wasnt|arent|werent|havent|hasnt|couldnt|wouldnt|tidak|tak|tiada|bukan|belum|takde|tdk|gak|ketiadaan|skip|skipping|nope)\b|\bt\b/

// NFKC first (folds full-width digits and letters), then drop format and combining characters (soft hyphens,
// zero-width joiners, decomposed accents), lower case, and turn each run of other non-letters or digits into one space.
export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{M}]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Judges page 1 only: a later page cannot be seen without filling page 1.
export function looksLikeAttendance(page: FormPage, keywords: string[]): boolean {
  if (page.index !== 1) throw new Error(`looksLikeAttendance judges page 1 only, got page ${page.index}`)
  const texts = [page.title, page.description, ...page.questions.flatMap((q) => [q.label, ...q.options])]
  const text = normaliseText(texts.join(' '))
  if (ATTENDANCE_TERMS.test(text)) return true
  // Whole words or phrases only ("bm" must not match "submit it"). Keywords under 3 characters are ignored.
  const haystack = ` ${text} `
  return keywords.some((keyword) => {
    const k = normaliseText(keyword)
    return k.length >= 3 && haystack.includes(` ${k} `)
  })
}

// `line` is one line of a question's text.
export function isPointsLine(line: string): boolean {
  return POINTS_LINE.test(normaliseText(line))
}

function emailAtDomain(email: string, domain: string): boolean {
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const host = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  const want = domain.trim().toLowerCase()
  return host === want || host.endsWith(`.${want}`)
}

export function orgRestricted(r: Restriction, org: OrgConfig | null): boolean {
  if (org === null || r.signedInAs === null) return false
  if (!emailAtDomain(r.signedInAs, org.emailDomain)) return false
  return r.orgOnly || (r.organisation !== null && normaliseText(r.organisation) === normaliseText(org.name))
}

// Every word of a confirming option must come from this list. "I'm" normalises to "i m", so both halves are listed.
const CONFIRM_VOCABULARY = new Set([
  'present',
  'presence',
  'hadir',
  'attend',
  'attending',
  'attended',
  'attendance',
  'here',
  'i',
  'im',
  'm',
  'am',
  'is',
  'me',
  'my',
  'confirm',
  'confirmed',
  'confirming',
  'that',
  'this',
  'the',
  'class',
  'lecture',
  'session',
  'today',
  'kelas',
  'kuliah',
  'saya',
  'ya',
  'yes',
  'yep',
  'online',
  'in',
  'person',
  'physically',
  'physical',
  'late',
  'lewat',
  'on',
  'time',
  'and',
  'mark',
  'marked',
  'as',
  'sudah',
  'telah',
  'dah'
])

// An option confirms only with a confirmation word, no negation, and nothing but confirmation vocabulary. Any other
// word (a letter like "tk", a group label, a section, a room number) leaves it unconfirmed, so the member is pinged.
export function confirmsAttendance(option: string): boolean {
  const t = normaliseText(option)
  if (!CONFIRM_POSITIVE.test(t) || CONFIRM_NEGATIVE.test(t)) return false
  return t.split(' ').every((word) => CONFIRM_VOCABULARY.has(word))
}
