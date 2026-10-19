import { z } from 'zod'
import type { EntryType, SavedDetail, TranscriptionMode, FormProvider } from './types'

export type LinkSource =
  | { kind: 'fixed'; url: string }
  | { kind: 'chat'; app: 'whatsapp' | 'discord' | 'teams'; chat: string } // URL or exact chat name
  | { kind: 'paste' }

export interface AiConfig {
  baseUrl: string // OpenAI-compatible base URL
  apiKey: string
  asrUrl: string // DashScope real-time WebSocket URL
  models: { summary: string; vision: string; formMatch: string; asr: string }
}

export interface NtfyConfig {
  url: string
  topic: string
  token: string
}

export interface JobConfig {
  occurrenceId: string
  attempt: number
  entry: {
    name: string
    type: EntryType
    start: string // ISO 8601 with offset
    end: string
    timeZone: string // IANA, e.g. "Asia/Kuala_Lumpur"
    link: LinkSource
    trustedSenders: string[]
    transcription: TranscriptionMode
    formDetails: Record<string, string> // per-entry: course_code, section, lecturer
    attendanceKeywords: string[]
  }
  identity: { id: string; name: string; zoomGuestName: string; formProviders: FormProvider[] }
  member: {
    id: string
    displayName: string
    mentionNames: string[]
    details: SavedDetail[]
  }
  ai: AiConfig
  ntfy: NtfyConfig
  dataDir: string // the occurrence's directory, see "Data directory layout"
  profileDir: string // decrypted working copy of the identity's profile
  control: { url: string; token: string } | null // null in 1A
}

export class JobError extends Error {
  paths: string[]

  constructor(paths: string[]) {
    super(`invalid job config: ${paths.join(', ')}`)
    this.name = 'JobError'
    this.paths = paths
  }
}

const nonEmpty = z.string().min(1)

function isIanaTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch (e) {
    if (e instanceof RangeError) return false
    throw e
  }
}

const LinkSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), url: z.url() }),
  z.object({ kind: z.literal('chat'), app: z.enum(['whatsapp', 'discord', 'teams']), chat: nonEmpty }),
  z.object({ kind: z.literal('paste') })
])

const SavedDetailSchema = z.object({
  key: nonEmpty,
  value: z.string(),
  labels: z.array(z.string())
})

const EntrySchema = z
  .object({
    name: nonEmpty,
    type: z.enum(['lecture', 'work']),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timeZone: z.string().refine(isIanaTimeZone, 'unknown IANA time zone'),
    link: LinkSourceSchema,
    trustedSenders: z.array(z.string()),
    transcription: z.enum(['live', 'native']),
    formDetails: z.record(z.string(), z.string()),
    attendanceKeywords: z.array(z.string())
  })
  .superRefine((entry, ctx) => {
    if (Date.parse(entry.end) <= Date.parse(entry.start)) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'must be after start', input: entry.end })
    }
  })

export const JobConfigSchema: z.ZodType<JobConfig> = z.object({
  occurrenceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  attempt: z.number().int().min(1),
  entry: EntrySchema,
  identity: z.object({
    id: nonEmpty,
    name: nonEmpty,
    zoomGuestName: nonEmpty,
    formProviders: z.array(z.enum(['google', 'microsoft']))
  }),
  member: z.object({
    id: nonEmpty,
    displayName: nonEmpty,
    mentionNames: z.array(z.string()),
    details: z.array(SavedDetailSchema)
  }),
  ai: z.object({
    baseUrl: z.url(),
    apiKey: nonEmpty,
    asrUrl: z.string().startsWith('wss://'),
    models: z.object({ summary: nonEmpty, vision: nonEmpty, formMatch: nonEmpty, asr: nonEmpty })
  }),
  ntfy: z.object({ url: z.url(), topic: nonEmpty, token: nonEmpty }),
  dataDir: z.string().startsWith('/'),
  profileDir: z.string().startsWith('/'),
  control: z.object({ url: z.url(), token: z.string() }).nullable()
})

// Reports issue paths only. Zod messages and input values can carry secrets (apiKey, token), so they are dropped.
export function parseJob(json: unknown): JobConfig {
  const result = JobConfigSchema.safeParse(json)
  if (!result.success) {
    const paths = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)'))]
    throw new JobError(paths)
  }
  return result.data
}
