import type { OccurrenceState } from './types'
import { IllegalTransition } from './form-machine'

/** The states in which a worker runs. They hold an identity and a server slot. */
export type WorkerState =
  | 'starting'
  | 'verifying_accounts'
  | 'waiting_for_signin'
  | 'watching_for_link'
  | 'joining'
  | 'in_lobby'
  | 'in_meeting'
  | 'leaving'
  | 'uploading'

export type OccurrenceTrigger =
  | 'launch'
  | 'skip_capacity'
  | 'skip_identity_clash'
  | 'skip_pc_offline'
  | 'worker_up'
  | 'signin_needed'
  | 'signed_in'
  | 'accounts_ok'
  | 'link_found'
  | 'link_timeout'
  | 'lobby'
  | 'knock_again'
  | 'admitted'
  | 'denied'
  | 'meeting_over'
  | 'left'
  | 'uploaded'
  | 'wait_for_pc'
  | 'pc_claimed'
  | 'transcript_ready'
  | 'summary_done'
  | 'crash'
  | `resume:${WorkerState}`
  | 'member_left'
  | 'fail'
  | 'delete'

export const WORKER_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  'starting',
  'verifying_accounts',
  'waiting_for_signin',
  'watching_for_link',
  'joining',
  'in_lobby',
  'in_meeting',
  'leaving',
  'uploading'
])

export const ACTIVE_STATES: ReadonlySet<OccurrenceState> = new Set<OccurrenceState>([...WORKER_STATES, 'restarting'])

type Edges = Partial<Record<OccurrenceTrigger, OccurrenceState>>

// The explicit edges from the TRD diagram. The group rules (crash, member_left, resume, fail, delete) are added by edgesFrom.
const EXPLICIT: Record<OccurrenceState, Edges> = {
  scheduled: { launch: 'starting' },
  starting: {
    skip_capacity: 'skipped_capacity',
    skip_identity_clash: 'skipped_identity_clash',
    skip_pc_offline: 'skipped_pc_offline',
    worker_up: 'verifying_accounts'
  },
  verifying_accounts: { signin_needed: 'waiting_for_signin', accounts_ok: 'watching_for_link' },
  waiting_for_signin: { signed_in: 'verifying_accounts' },
  watching_for_link: { link_found: 'joining', link_timeout: 'no_link' },
  no_link: {},
  joining: { lobby: 'in_lobby', admitted: 'in_meeting' },
  in_lobby: { knock_again: 'in_lobby', admitted: 'in_meeting', denied: 'denied' },
  denied: {},
  in_meeting: { meeting_over: 'leaving' },
  restarting: {},
  left_by_member: {},
  leaving: { left: 'uploading' },
  uploading: { uploaded: 'transcribing' },
  transcribing: { transcript_ready: 'post_processing', wait_for_pc: 'waiting_for_pc' },
  waiting_for_pc: { pc_claimed: 'transcribing', transcript_ready: 'post_processing' },
  post_processing: { summary_done: 'completed' },
  completed: {},
  skipped_capacity: {},
  skipped_identity_clash: {},
  skipped_pc_offline: {},
  failed: {},
  deleted: {}
}

const NO_FAIL: ReadonlySet<OccurrenceState> = new Set<OccurrenceState>(['failed', 'deleted'])

function edgesFrom(from: OccurrenceState): Map<OccurrenceTrigger, OccurrenceState> {
  const edges = new Map<OccurrenceTrigger, OccurrenceState>(
    Object.entries(EXPLICIT[from]) as [OccurrenceTrigger, OccurrenceState][]
  )
  if (ACTIVE_STATES.has(from)) {
    edges.set('crash', 'restarting')
    edges.set('member_left', 'left_by_member')
  }
  if (from === 'restarting') {
    for (const s of WORKER_STATES) edges.set(`resume:${s}` as OccurrenceTrigger, s)
  }
  if (!NO_FAIL.has(from)) edges.set('fail', 'failed')
  if (!ACTIVE_STATES.has(from) && from !== 'deleted') edges.set('delete', 'deleted')
  return edges
}

/** The state after `event` from `from`. Throws `IllegalTransition` when the event does not apply. */
export function nextOccurrenceState(from: OccurrenceState, event: OccurrenceTrigger): OccurrenceState {
  const next = edgesFrom(from).get(event)
  if (next === undefined) throw new IllegalTransition(from, event)
  return next
}

/** The trigger that moves `from` to `to`, or null when no single trigger does. */
export function triggerFor(from: OccurrenceState, to: OccurrenceState): OccurrenceTrigger | null {
  for (const [trigger, target] of edgesFrom(from)) if (target === to) return trigger
  return null
}
