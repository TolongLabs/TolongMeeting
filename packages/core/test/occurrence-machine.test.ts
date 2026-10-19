import { expect, test } from 'bun:test'
import {
  IllegalTransition,
  nextOccurrenceState,
  triggerFor,
  type OccurrenceState,
  type OccurrenceTrigger
} from '@tm/core'

test('the main line runs from scheduled to completed', () => {
  const path: [OccurrenceTrigger, OccurrenceState][] = [
    ['launch', 'starting'],
    ['worker_up', 'verifying_accounts'],
    ['accounts_ok', 'watching_for_link'],
    ['link_found', 'joining'],
    ['lobby', 'in_lobby'],
    ['admitted', 'in_meeting'],
    ['meeting_over', 'leaving'],
    ['left', 'uploading'],
    ['uploaded', 'transcribing'],
    ['transcript_ready', 'post_processing'],
    ['summary_done', 'completed']
  ]
  let s: OccurrenceState = 'scheduled'
  for (const [t, want] of path) {
    s = nextOccurrenceState(s, t)
    expect(s).toBe(want)
  }
})

test('side exits', () => {
  expect(nextOccurrenceState('verifying_accounts', 'signin_needed')).toBe('waiting_for_signin')
  expect(nextOccurrenceState('waiting_for_signin', 'signed_in')).toBe('verifying_accounts')
  expect(nextOccurrenceState('watching_for_link', 'link_timeout')).toBe('no_link')
  expect(nextOccurrenceState('in_lobby', 'knock_again')).toBe('in_lobby')
  expect(nextOccurrenceState('in_lobby', 'denied')).toBe('denied')
  expect(nextOccurrenceState('in_meeting', 'crash')).toBe('restarting')
  expect(nextOccurrenceState('restarting', 'resume:in_meeting')).toBe('in_meeting')
  expect(nextOccurrenceState('restarting', 'crash')).toBe('restarting')
  expect(nextOccurrenceState('joining', 'member_left')).toBe('left_by_member')
  expect(nextOccurrenceState('starting', 'skip_capacity')).toBe('skipped_capacity')
  expect(nextOccurrenceState('transcribing', 'wait_for_pc')).toBe('waiting_for_pc')
  expect(nextOccurrenceState('post_processing', 'fail')).toBe('failed')
  expect(nextOccurrenceState('completed', 'delete')).toBe('deleted')
})

test('illegal moves throw', () => {
  expect(() => nextOccurrenceState('scheduled', 'admitted')).toThrow(IllegalTransition)
  expect(() => nextOccurrenceState('in_meeting', 'delete')).toThrow(IllegalTransition)
  expect(() => nextOccurrenceState('deleted', 'fail')).toThrow(IllegalTransition)
  expect(() => nextOccurrenceState('completed', 'crash')).toThrow(IllegalTransition)
})

test('triggerFor finds the trigger between two states', () => {
  expect(triggerFor('verifying_accounts', 'watching_for_link')).toBe('accounts_ok')
  expect(triggerFor('restarting', 'starting')).toBe('resume:starting')
  expect(triggerFor('uploading', 'transcribing')).toBe('uploaded')
  expect(triggerFor('in_meeting', 'completed')).toBeNull()
})

test('no edge leads back to scheduled, so deleting a scheduled row never loses a started occurrence', () => {
  const all: Record<OccurrenceState, true> = {
    scheduled: true,
    starting: true,
    verifying_accounts: true,
    waiting_for_signin: true,
    watching_for_link: true,
    no_link: true,
    joining: true,
    in_lobby: true,
    denied: true,
    in_meeting: true,
    restarting: true,
    left_by_member: true,
    leaving: true,
    uploading: true,
    transcribing: true,
    waiting_for_pc: true,
    post_processing: true,
    completed: true,
    skipped_capacity: true,
    skipped_identity_clash: true,
    skipped_pc_offline: true,
    failed: true,
    deleted: true
  }
  for (const from of Object.keys(all) as OccurrenceState[]) expect(triggerFor(from, 'scheduled')).toBeNull()
})
