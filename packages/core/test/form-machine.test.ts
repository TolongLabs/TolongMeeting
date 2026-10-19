import { test, expect } from 'bun:test'
import { nextFormState, IllegalTransition } from '../src/form-machine'

test('1A path to a manual-submission ping', () => {
  expect(nextFormState('detected', 'resolve')).toBe('resolving')
  expect(nextFormState('resolving', 'resolved')).toBe('checking_trust')
  expect(nextFormState('checking_trust', 'manual_only')).toBe('needs_member')
  expect(nextFormState('checking_trust', 'untrusted')).toBe('untrusted')
  for (const s of ['detected', 'resolving', 'checking_trust'] as const) expect(nextFormState(s, 'fail')).toBe('failed')
})

test('terminal states accept no trigger', () => {
  for (const s of ['untrusted', 'needs_member', 'failed'] as const)
    expect(() => nextFormState(s, 'fail')).toThrow(IllegalTransition)
  expect(() => nextFormState('detected', 'resolved')).toThrow('detected --resolved-->')
})
