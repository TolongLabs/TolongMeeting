import type { OrgConfig } from '@tm/core'
import type { FormPage, Restriction } from './types'

const ATTENDANCE_TERMS = /\b(attendance|kehadiran|hadir|register|sign in sheet)\b/
const POINTS_LINE =
  /^\(?\d+(\.\d+)?\s*(point|points|mark|marks|mata|markah)\)?$|^(points|marks|mata|markah)\s*:\s*\d+(\.\d+)?$/i
const CONFIRM_POSITIVE = /\b(present|presence|attend|attending|attended|attendance|hadir|kehadiran)\b/
const CONFIRM_NEGATIVE = /\b(not|no|absent|tidak|tak|bukan|belum|cannot|unable|never|can t|won t|didn t|don t)\b/

// NFKC, lower case, every run of characters that are not letters or digits becomes one space.
export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
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
  return keywords.some((keyword) => {
    const k = normaliseText(keyword)
    return k !== '' && text.includes(k)
  })
}

// `line` is one trimmed line of a question's text.
export function isPointsLine(line: string): boolean {
  return POINTS_LINE.test(line.trim())
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

export function confirmsAttendance(option: string): boolean {
  const t = normaliseText(option)
  return CONFIRM_POSITIVE.test(t) && !CONFIRM_NEGATIVE.test(t)
}
