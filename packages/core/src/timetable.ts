import { DateTime } from 'luxon'
import { z } from 'zod'

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type RepeatRule = { kind: 'once'; date: string } | { kind: 'weekly'; days: IsoWeekday[]; from: string }

// A real calendar date written `YYYY-MM-DD`: `2026-02-30` is refused.
const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => DateTime.fromISO(s, { zone: 'utc' }).isValid, 'not a calendar date')

const Weekday = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7)
])

export const RepeatRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date: DateString }),
  z.object({ kind: z.literal('weekly'), days: z.array(Weekday).min(1), from: DateString })
]) satisfies z.ZodType<RepeatRule>
