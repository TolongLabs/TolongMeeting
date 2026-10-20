import { localParts, type JobConfig, type SavedDetail } from '@tm/core'
import { formatDate, parseDateFormat } from './datetime'

// Label variants per member detail key. A form question matches a detail when its label equals one of these.
export const DEFAULT_LABELS: Record<string, string[]> = {
  full_name: ['Name', 'Full name', 'Nama', 'Nama penuh'],
  student_id: ['Student ID', 'Matric No.', 'Matric number', 'No. Matrik', 'No. Pelajar'],
  university_email: ['Email', 'Email address', 'Student email', 'Emel'],
  programme: ['Programme', 'Program']
}

// Label variants for the values derived from the entry and for the per-entry form details.
export const DERIVED_LABELS: Record<string, string[]> = {
  session_date: ['Date', 'Class date', 'Tarikh', 'Tarikh kelas'],
  session_start: ['Time', 'Class time', 'Start time', 'Masa'],
  course_code: ['Course code', 'Subject code', 'Kod kursus', 'Kod subjek'],
  section: ['Section', 'Seksyen'],
  lecturer: ['Lecturer', 'Lecturer name', 'Pensyarah', 'Nama pensyarah']
}

// How the pool writes `session_date` (a text value for text and choice questions). plan.ts reads it back with this.
export const POOL_DATE_FORMAT = parseDateFormat('dd/MM/yyyy')!

function keyWords(key: string): string {
  return key.replace(/_/g, ' ')
}

// One detail per key. Sources apply in order: member details, then derived values, then the entry's form details.
// A later source replaces the value and adds its label variants. An empty value is dropped.
export function buildDetailPool(cfg: JobConfig): SavedDetail[] {
  const pool = new Map<string, SavedDetail>()

  const put = (key: string, value: string, labels: string[]): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    const existing = pool.get(key)
    const merged = [...new Set([...(existing?.labels ?? []), ...labels])]
    pool.set(key, { key, value: trimmed, labels: merged })
  }

  for (const detail of cfg.member.details) {
    put(detail.key, detail.value, [...detail.labels, ...(DEFAULT_LABELS[detail.key] ?? []), keyWords(detail.key)])
  }

  // Derived from the entry's start in the entry's own time zone, not the offset written in the start string.
  const parts = localParts(cfg.entry.start, cfg.entry.timeZone)
  put('session_date', formatDate(parts.date, POOL_DATE_FORMAT), [
    ...DERIVED_LABELS.session_date,
    keyWords('session_date')
  ])
  put('session_start', `${parts.hhmm.slice(0, 2)}:${parts.hhmm.slice(2)}`, [
    ...DERIVED_LABELS.session_start,
    keyWords('session_start')
  ])

  for (const [key, value] of Object.entries(cfg.entry.formDetails)) {
    put(key, value, [...(DERIVED_LABELS[key] ?? []), keyWords(key)])
  }

  return [...pool.values()]
}
