import type { FormState } from './types'

export type FormTrigger = 'resolve' | 'resolved' | 'untrusted' | 'manual_only' | 'fail'

export class IllegalTransition extends Error {
  constructor(from: string, trigger: string) {
    super(`${from} --${trigger}-->`)
    this.name = 'IllegalTransition'
  }
}

// 1A table. Plan 01b adds 'trusted' (checking_trust -> opening) and the later triggers; it does not change these rows.
const table: Partial<Record<FormState, Partial<Record<FormTrigger, FormState>>>> = {
  detected: { resolve: 'resolving', fail: 'failed' },
  resolving: { resolved: 'checking_trust', fail: 'failed' },
  checking_trust: {
    untrusted: 'untrusted',
    manual_only: 'needs_member',
    fail: 'failed'
  }
}

export function nextFormState(from: FormState, trigger: FormTrigger): FormState {
  const next = table[from]?.[trigger]
  if (next === undefined) throw new IllegalTransition(from, trigger)
  return next
}
