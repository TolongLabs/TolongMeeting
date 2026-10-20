import { expect, test } from 'bun:test'
import { sampleRecord } from '@tm/core/testing'
import {
  applyFormTrigger,
  IllegalTransition,
  isTerminalFormState,
  nextFormState,
  TERMINAL_FORM_STATES,
  type FormTrigger
} from '../src/form-machine'
import type { FormState } from '../src/types'

const EDGES: [FormState, FormTrigger, FormState][] = [
  ['detected', 'resolve_started', 'resolving'],
  ['resolving', 'resolved', 'checking_trust'],
  ['checking_trust', 'trusted', 'opening'],
  ['checking_trust', 'trust_deferred', 'opening'],
  ['checking_trust', 'trust_failed', 'untrusted'],
  ['untrusted', 'trusted_candidate_seen', 'checking_trust'],
  ['opening', 'signin_wall', 'awaiting_signin'],
  ['awaiting_signin', 'signed_in', 'opening'],
  ['opening', 'page_loaded', 'inspecting'],
  ['opening', 'already_answered_seen', 'already_answered'],
  ['inspecting', 'org_check_failed', 'untrusted'],
  ['inspecting', 'quiz_detected', 'quiz'],
  ['inspecting', 'no_attendance_terms', 'not_attendance'],
  ['inspecting', 'inspected', 'filling'],
  ['filling', 'next_page', 'inspecting'],
  ['filling', 'unmatched_required', 'needs_member'],
  ['filling', 'submit_clicked', 'submitting'],
  ['submitting', 'confirmed', 'submitted'],
  ['submitting', 'already_answered_seen', 'already_answered']
]
test.each(EDGES)('%s --%s--> %s', (from, t, to) => expect(nextFormState(from, t)).toBe(to))

test('every non-terminal state fails on error', () => {
  const nonTerminal: FormState[] = [
    'detected',
    'resolving',
    'checking_trust',
    'opening',
    'awaiting_signin',
    'inspecting',
    'filling',
    'submitting'
  ]
  for (const s of nonTerminal) expect(nextFormState(s, 'error')).toBe('failed')
})

test('terminal states and skipped steps are illegal', () => {
  expect(() => nextFormState('submitted', 'error')).toThrow(IllegalTransition)
  expect(() => nextFormState('needs_member', 'submit_clicked')).toThrow(IllegalTransition)
  expect(() => nextFormState('untrusted', 'page_loaded')).toThrow(IllegalTransition)
  expect(() => nextFormState('untrusted', 'error')).toThrow(IllegalTransition)
  expect(() => nextFormState('needs_member', 'error')).toThrow(IllegalTransition)
  expect(() => nextFormState('failed', 'error')).toThrow(IllegalTransition)
  expect(() => nextFormState('checking_trust', 'submit_clicked')).toThrow(IllegalTransition)
  expect(() => nextFormState('opening', 'inspected')).toThrow('opening --inspected-->')
  expect(() => nextFormState('detected', 'resolved')).toThrow('detected --resolved-->')
})

test('terminal states are exactly the handler-final states', () => {
  expect([...TERMINAL_FORM_STATES].sort()).toEqual([
    'already_answered',
    'failed',
    'needs_member',
    'not_attendance',
    'quiz',
    'submitted',
    'untrusted'
  ])
  expect(isTerminalFormState('quiz')).toBe(true)
  expect(isTerminalFormState('filling')).toBe(false)
})

test('applyFormTrigger appends to history without mutating', () => {
  const r = sampleRecord({
    state: 'detected',
    history: [{ state: 'detected', at: 'T0' }]
  })
  const next = applyFormTrigger(r, 'resolve_started', 'T1')
  expect(next.state).toBe('resolving')
  expect(next.history).toEqual([
    { state: 'detected', at: 'T0' },
    { state: 'resolving', at: 'T1' }
  ])
  expect(r.state).toBe('detected')
  expect(r.history).toHaveLength(1)
})
