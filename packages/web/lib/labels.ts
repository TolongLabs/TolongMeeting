import type { AccountKind, OccurrenceState } from '@tm/core'

/** What the member reads for each meeting state: plain words, no state names. Safe to import anywhere. */
export const STATE_LABELS: Record<OccurrenceState, string> = {
  scheduled: 'Scheduled',
  starting: 'Starting',
  verifying_accounts: 'Checking your accounts',
  waiting_for_signin: 'Waiting for you to sign in',
  watching_for_link: 'Waiting for a meeting link',
  no_link: 'No meeting link found',
  joining: 'Joining',
  in_lobby: 'In the lobby',
  denied: 'Not admitted',
  in_meeting: 'In the meeting',
  restarting: 'Rejoining after a drop',
  left_by_member: 'You made the bot leave',
  leaving: 'Leaving',
  uploading: 'Saving the recording',
  transcribing: 'Transcribing',
  waiting_for_pc: 'Waiting for your PC',
  post_processing: 'Writing the summary',
  completed: 'Completed',
  skipped_capacity: 'Skipped: two meetings were already running',
  skipped_identity_clash: 'Skipped: the identity was in another meeting',
  skipped_pc_offline: 'Skipped: your PC was offline',
  failed: 'Failed',
  deleted: 'Deleted'
}

/** The name of each account kind a profile can be signed in to. */
export const ACCOUNT_LABELS: Record<AccountKind, string> = {
  zoom: 'Zoom',
  microsoft: 'Microsoft',
  google: 'Google',
  whatsapp: 'WhatsApp Web',
  discord: 'Discord',
  teams: 'Teams'
}
