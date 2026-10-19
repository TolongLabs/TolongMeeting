import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FormProvider, FormSource, FormState, ResolvedForm, SenderRole, TrustReason } from './types'

export type StopReason =
  | 'untrusted_source'
  | 'not_org_restricted'
  | 'tab_not_on_desk'
  | 'open_timeout'
  | 'signin_required_again'
  | 'signin_not_completed'
  | 'meeting_ended'
  | 'form_closed'
  | 'no_access'
  | 'captcha'
  | 'unknown_page'
  | 'fill_failed'
  | 'next_failed'
  | 'submit_failed'
  | 'deadline'
  | 'interrupted'
  | 'interrupted_submitting'
  | 'unexpected_error'

export interface FilledField {
  page: number // 1-based
  question: string // label, cut to 120 characters
  detailKey: string | null // null for an attendance confirmation
  value: string // text typed or option chosen; never logged
  via: 'label' | 'model' | 'confirmation'
}

export interface FormRecord {
  formId: string
  occurrenceId: string
  url: string // as first seen
  finalUrl: string // from resolveFormLink
  provider: FormProvider
  source: FormSource
  sender: string | null
  senderRole: SenderRole | null
  seenAt: string // ISO 8601, first sight
  state: FormState
  history: { state: FormState; at: string }[]
  trustReason: TrustReason | null
  reason: StopReason | null
  title: string | null
  fieldsFilled: FilledField[]
  unmatched: string[] // required question labels left unmatched, each cut to 120 characters
  screenshots: string[] // paths relative to the occurrence directory
  signinRetried: boolean
  submittedAt: string | null
  pings: { state: FormState; at: string }[]
}

// Each table lists every member of its union, so adding a member to the type fails to compile until it is added here.
const FORM_STATES: Record<FormState, true> = {
  detected: true,
  resolving: true,
  checking_trust: true,
  untrusted: true,
  opening: true,
  awaiting_signin: true,
  inspecting: true,
  not_attendance: true,
  quiz: true,
  filling: true,
  needs_member: true,
  submitting: true,
  submitted: true,
  already_answered: true,
  failed: true
}
const FORM_SOURCES: Record<FormSource, true> = { qr: true, meeting_chat: true, watched_chat: true }
const FORM_PROVIDERS: Record<FormProvider, true> = { google: true, microsoft: true }
const SENDER_ROLES: Record<SenderRole, true> = { host: true, co_host: true, participant: true, unknown: true }
const TRUST_REASONS: Record<TrustReason, true> = {
  qr_on_screen: true,
  host: true,
  co_host: true,
  trusted_sender: true,
  org_restricted: true
}
const STOP_REASONS: Record<StopReason, true> = {
  untrusted_source: true,
  not_org_restricted: true,
  tab_not_on_desk: true,
  open_timeout: true,
  signin_required_again: true,
  signin_not_completed: true,
  meeting_ended: true,
  form_closed: true,
  no_access: true,
  captcha: true,
  unknown_page: true,
  fill_failed: true,
  next_failed: true,
  submit_failed: true,
  deadline: true,
  interrupted: true,
  interrupted_submitting: true,
  unexpected_error: true
}

function enumOf<T extends string>(table: Record<T, true>): z.ZodType<T> {
  return z.enum(Object.keys(table) as [T, ...T[]])
}

const FormStateSchema = enumOf(FORM_STATES)
const stamp = z.iso.datetime({ offset: true })
const stateAt = z.object({ state: FormStateSchema, at: stamp })

const FilledFieldSchema = z.object({
  page: z.number().int().min(1),
  question: z.string().max(120),
  detailKey: z.string().nullable(),
  value: z.string(),
  via: z.enum(['label', 'model', 'confirmation'])
})

export const FormRecordSchema: z.ZodType<FormRecord> = z.object({
  formId: z.string().regex(/^[0-9a-f]{16}$/),
  occurrenceId: z.string().min(1),
  url: z.string().min(1),
  finalUrl: z.string().min(1),
  provider: enumOf(FORM_PROVIDERS),
  source: enumOf(FORM_SOURCES),
  sender: z.string().nullable(),
  senderRole: enumOf(SENDER_ROLES).nullable(),
  seenAt: stamp,
  state: FormStateSchema,
  history: z.array(stateAt),
  trustReason: enumOf(TRUST_REASONS).nullable(),
  reason: enumOf(STOP_REASONS).nullable(),
  title: z.string().nullable(),
  fieldsFilled: z.array(FilledFieldSchema),
  unmatched: z.array(z.string().max(120)),
  screenshots: z.array(z.string()),
  signinRetried: z.boolean(),
  submittedAt: stamp.nullable(),
  pings: z.array(stateAt)
})

const GOOGLE_FORM_PATH = /^\/forms\/(?:u\/\d+\/)?d\/(e\/)?([^/]+)/
const MICROSOFT_SHORT_PATH = /^\/[re]\/[^/]+/

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

// The one key for a form: the plain page that shows the form, whatever link shape it was posted in. It never carries
// pre-filled answers (`entry.*`, Microsoft `r<id>=`) or the direct-submit path, so opening it can neither submit
// nor answer anything.
export function canonicalFormUrl(finalUrl: string): string {
  const u = new URL(finalUrl)
  const host = u.hostname.toLowerCase()
  if (host === 'docs.google.com') {
    const match = GOOGLE_FORM_PATH.exec(u.pathname)
    if (match) return `https://docs.google.com/forms/d/${match[1] ?? ''}${match[2]}/viewform`
  }
  if (host === 'forms.office.com' || host === 'forms.microsoft.com') {
    const id = u.searchParams.get('id')
    if (u.pathname.toLowerCase() === '/pages/responsepage.aspx' && id) {
      return `https://forms.office.com/Pages/ResponsePage.aspx?${new URLSearchParams({ id })}`
    }
    const short = MICROSOFT_SHORT_PATH.exec(u.pathname)
    if (short) return `https://forms.office.com${trimTrailingSlash(short[0])}`
    return `https://forms.office.com${trimTrailingSlash(u.pathname)}`
  }
  return `${u.protocol}//${u.host}${trimTrailingSlash(u.pathname)}`
}

// One id per form per meeting: the first 16 hex characters of SHA-256 of the canonical URL.
export function formIdFor(finalUrl: string): string {
  return createHash('sha256').update(canonicalFormUrl(finalUrl)).digest('hex').slice(0, 16)
}

export function newFormRecord(f: ResolvedForm, occurrenceId: string): FormRecord {
  return {
    formId: formIdFor(f.finalUrl),
    occurrenceId,
    url: f.url,
    finalUrl: f.finalUrl,
    provider: f.provider,
    source: f.source,
    sender: f.sender,
    senderRole: f.senderRole,
    seenAt: f.seenAt,
    state: 'detected',
    history: [{ state: 'detected', at: f.seenAt }],
    trustReason: null,
    reason: null,
    title: null,
    fieldsFilled: [],
    unmatched: [],
    screenshots: [],
    signinRetried: false,
    submittedAt: null,
    pings: []
  }
}
