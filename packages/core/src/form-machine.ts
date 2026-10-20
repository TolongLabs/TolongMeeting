import type { FormRecord } from './form-record'
import type { FormState } from './types'

export type FormTrigger =
  | 'resolve_started'
  | 'resolved'
  | 'trusted'
  | 'trust_deferred'
  | 'trust_failed'
  | 'trusted_candidate_seen'
  | 'signin_wall'
  | 'signed_in'
  | 'page_loaded'
  | 'already_answered_seen'
  | 'org_check_failed'
  | 'quiz_detected'
  | 'no_attendance_terms'
  | 'inspected'
  | 'next_page'
  | 'unmatched_required'
  | 'submit_clicked'
  | 'confirmed'
  | 'error'

export class IllegalTransition extends Error {
  constructor(from: string, trigger: string) {
    super(`${from} --${trigger}-->`)
    this.name = 'IllegalTransition'
  }
}

export const TERMINAL_FORM_STATES: readonly FormState[] = [
  'untrusted',
  'not_attendance',
  'quiz',
  'needs_member',
  'submitted',
  'already_answered',
  'failed'
]

export function isTerminalFormState(s: FormState): boolean {
  return TERMINAL_FORM_STATES.includes(s)
}

const table: Partial<Record<FormState, Partial<Record<FormTrigger, FormState>>>> = {
  detected: { resolve_started: 'resolving' },
  resolving: { resolved: 'checking_trust' },
  checking_trust: {
    trusted: 'opening',
    trust_deferred: 'opening', // untrusted sender: open to look for organisation evidence
    trust_failed: 'untrusted' // untrusted sender and no organisation configured
  },
  untrusted: { trusted_candidate_seen: 'checking_trust' }, // only the dispatcher leaves untrusted
  opening: {
    signin_wall: 'awaiting_signin',
    page_loaded: 'inspecting',
    already_answered_seen: 'already_answered'
  },
  awaiting_signin: { signed_in: 'opening' }, // once per form
  inspecting: {
    org_check_failed: 'untrusted', // the organisation check happens after opening
    quiz_detected: 'quiz',
    no_attendance_terms: 'not_attendance',
    inspected: 'filling'
  },
  filling: {
    next_page: 'inspecting', // each later page is inspected (quiz check) before filling
    unmatched_required: 'needs_member',
    submit_clicked: 'submitting'
  },
  submitting: {
    confirmed: 'submitted',
    already_answered_seen: 'already_answered'
  }
}

export function nextFormState(from: FormState, event: FormTrigger): FormState {
  const next = table[from]?.[event]
  if (next !== undefined) return next
  // Every non-terminal state fails on error. Terminal states have no error edge.
  if (event === 'error' && !isTerminalFormState(from)) return 'failed'
  throw new IllegalTransition(from, event)
}

export function applyFormTrigger(rec: FormRecord, trigger: FormTrigger, at: string): FormRecord {
  const state = nextFormState(rec.state, trigger)
  return { ...rec, state, history: [...rec.history, { state, at }] }
}
