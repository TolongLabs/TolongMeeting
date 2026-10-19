import { isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { details, mentionNames } from '../db/schema'
import { InputError } from './identities'
import type { MemberScope } from './scope'

export const BUILTIN_DETAILS = [
  { key: 'full_name', label: 'Full name as registered' },
  { key: 'student_id', label: 'Student ID' },
  { key: 'university_email', label: 'University email' },
  { key: 'programme', label: 'Programme' }
] as const

export interface SavedDetail {
  key: string
  value: string
  labels: string[]
}

const MAX_DETAILS = 50

/** True when no two strings match ignoring case. */
const uniqueIgnoringCase = (values: string[]) => new Set(values.map((v) => v.toLowerCase())).size === values.length

const LabelSchema = z.string().trim().min(1).max(120)

const DetailSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_]{1,40}$/, { message: 'A detail key uses lower-case letters, digits and underscores.' }),
  value: z.string().trim().min(1).max(200),
  labels: z
    .array(LabelSchema)
    .max(10)
    .refine(uniqueIgnoringCase, { message: 'Each label for a detail must be different.' })
})

export const DetailsInputSchema = z.object({
  details: z
    .array(DetailSchema)
    .max(MAX_DETAILS)
    .superRefine((list, ctx) => {
      if (new Set(list.map((d) => d.key)).size !== list.length) {
        ctx.addIssue({ code: 'custom', message: 'Each detail key can appear only once.' })
      }
      for (const [index, detail] of list.entries()) {
        if (detail.key !== 'university_email') continue
        if (!z.email().safeParse(detail.value).success) {
          ctx.addIssue({ code: 'custom', message: 'Enter a valid university email address.', path: [index, 'value'] })
        }
      }
    }),
  mentionNames: z
    .array(z.string().trim().min(1).max(60))
    .max(20)
    .refine(uniqueIgnoringCase, { message: 'Each name you answer to must be different.' })
})

/** Replaces the member's details and mention names. Saved values are member data: they are never logged. */
export async function saveDetails(scope: MemberScope, input: unknown): Promise<void> {
  const parsed = DetailsInputSchema.safeParse(input)
  if (!parsed.success) throw new InputError(parsed.error.issues[0]!.message)
  const { details: list, mentionNames: names } = parsed.data
  await scope.transaction(async (s) => {
    await s.remove(details, isNotNull(details.id))
    await s.remove(mentionNames, isNotNull(mentionNames.id))
    for (const [position, detail] of list.entries()) {
      await s.insert(details, { key: detail.key, value: detail.value, labels: detail.labels, position })
    }
    for (const name of names) await s.insert(mentionNames, { name })
  })
}

/** The member's saved details in the order they were saved, and their mention names. */
export async function loadDetails(scope: MemberScope): Promise<{ details: SavedDetail[]; mentionNames: string[] }> {
  const rows = await scope.select(details)
  const names = await scope.select(mentionNames)
  return {
    details: rows
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ key: row.key, value: row.value, labels: row.labels })),
    mentionNames: names.map((row) => row.name)
  }
}
