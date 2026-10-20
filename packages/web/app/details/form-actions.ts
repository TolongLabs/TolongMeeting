'use server'

import { redirect } from 'next/navigation'
import { BUILTIN_DETAILS, DetailsInputSchema } from '../../lib/details'
import { requireMember } from '../../lib/session'
import { saveDetailsAction } from './actions'
import type { DetailsFormState } from './form-state'

// The details form's handler. It reads the form's fields, checks them so each problem lands on its own field, then uses
// `saveDetailsAction`. It takes only the form and gets the member from the session.

const TOO_LONG: Record<string, string> = {
  value: 'Use at most 200 characters.',
  labels: 'Use at most 10 labels, each at most 120 characters.',
  mention: 'Use at most 20 names, each at most 60 characters.'
}
const GENERIC = 'Check this field.'
const LIST_TOO_LONG = 'You can save at most 50 details.'

const lines = (value: FormDataEntryValue | null) =>
  (typeof value === 'string' ? value : '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
const one = (formData: FormData, name: string) => {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** `Staff number` becomes `staff_number`, the key a detail is saved under. */
const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)

interface Row {
  key: string
  value: string
  labels: string[]
  /** Field ids for the row's name (custom rows), value and labels. */
  ids: { name?: string; value: string; labels: string }
}

export async function saveDetailsFormAction(
  _previous: DetailsFormState,
  formData: FormData
): Promise<DetailsFormState> {
  await requireMember()
  const values: Record<string, string> = {}
  for (const [name, value] of formData.entries()) if (typeof value === 'string') values[name] = value
  const fields: Record<string, string> = {}

  const rows: Row[] = []
  for (const { key } of BUILTIN_DETAILS) {
    const value = one(formData, `value-${key}`)
    const labels = lines(formData.get(`labels-${key}`))
    const ids = { value: `value-${key}`, labels: `labels-${key}` }
    if (!value && labels.length > 0) fields[ids.value] = 'Enter the value, or clear its labels.'
    if (value) rows.push({ key, value, labels, ids })
  }
  for (let i = 0; formData.has(`custom-name-${i}`); i++) {
    const name = one(formData, `custom-name-${i}`)
    const value = one(formData, `custom-value-${i}`)
    const labels = lines(formData.get(`custom-labels-${i}`))
    const ids = { name: `custom-name-${i}`, value: `custom-value-${i}`, labels: `custom-labels-${i}` }
    if (!name && !value && labels.length === 0) continue
    if (!name) fields[ids.name] = 'Give this detail a name.'
    else if (!keyOf(name)) fields[ids.name] = 'Use letters or digits in the name.'
    if (!value) fields[ids.value] = 'Enter the value.'
    rows.push({ key: keyOf(name), value, labels, ids })
  }
  const names = lines(formData.get('mention-names'))

  const parsed = DetailsInputSchema.safeParse({
    details: rows.map(({ key, value, labels }) => ({ key, value, labels })),
    mentionNames: names
  })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [section, index, part] = issue.path
      const text =
        issue.code === 'too_big'
          ? (TOO_LONG[section === 'mentionNames' ? 'mention' : String(part ?? 'value')] ?? LIST_TOO_LONG)
          : issue.code === 'custom' || issue.code === 'invalid_format'
            ? issue.message
            : GENERIC
      const row = section === 'details' && typeof index === 'number' ? rows[index] : undefined
      const id =
        section === 'mentionNames'
          ? 'mention-names'
          : row
            ? part === 'labels'
              ? row.ids.labels
              : part === 'key' && row.ids.name
                ? row.ids.name
                : row.ids.value
            : undefined
      if (id) fields[id] ??= text
      else if (issue.code === 'custom' && issue.message.startsWith('Each detail key')) {
        // Two rows with one key: say it on the custom row that repeats a built-in or earlier name.
        const seen = new Set<string>()
        for (const r of rows) {
          if (seen.has(r.key) && r.ids.name) fields[r.ids.name] ??= 'This name is already used by another detail.'
          seen.add(r.key)
        }
      } else return { status: 'error', message: text, fields, values }
    }
  }
  if (!parsed.success || Object.keys(fields).length > 0) return { status: 'error', fields, values }

  const result = await saveDetailsAction(parsed.data)
  if (!result.ok) return { status: 'error', message: result.error, fields: {}, values }
  redirect('/details?notice=saved')
}
