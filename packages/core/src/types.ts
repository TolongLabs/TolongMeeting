export type Platform = 'zoom' | 'teams' | 'meet'
export type EntryType = 'lecture' | 'work'
export type TranscriptionMode = 'live' | 'native'
export type RunLocation = 'server' | 'server_via_home' | 'local'
export type SenderRole = 'host' | 'co_host' | 'participant' | 'unknown'

export type OccurrenceState =
  | 'scheduled'
  | 'starting'
  | 'verifying_accounts'
  | 'waiting_for_signin'
  | 'watching_for_link'
  | 'no_link'
  | 'joining'
  | 'in_lobby'
  | 'denied'
  | 'in_meeting'
  | 'restarting'
  | 'left_by_member'
  | 'leaving'
  | 'uploading'
  | 'transcribing'
  | 'waiting_for_pc'
  | 'post_processing'
  | 'completed'
  | 'skipped_capacity'
  | 'skipped_identity_clash'
  | 'skipped_pc_offline'
  | 'failed'
  | 'deleted'

export type FormState =
  | 'detected'
  | 'resolving'
  | 'checking_trust'
  | 'untrusted'
  | 'opening'
  | 'awaiting_signin'
  | 'inspecting'
  | 'not_attendance'
  | 'quiz'
  | 'filling'
  | 'needs_member'
  | 'submitting'
  | 'submitted'
  | 'already_answered'
  | 'failed'

export type FormSource = 'qr' | 'meeting_chat' | 'watched_chat'
export type FormProvider = 'google' | 'microsoft'
export type TrustReason = 'qr_on_screen' | 'host' | 'co_host' | 'trusted_sender' | 'org_restricted'

export interface ChatMessage {
  key: string // platform message id, else `${sender}|${time}|${text.slice(0, 200)}`
  sender: string
  senderRole: SenderRole
  time: string // as displayed by the platform
  seenAt: string // ISO 8601, when the worker read it
  text: string
  links: string[] // absolute URLs found in the message
  replyTo: string | null // key of the parent message for a thread reply
}

export interface FormCandidate {
  url: string
  source: FormSource
  sender: string | null
  senderRole: SenderRole | null
  seenAt: string
}

export interface ResolvedForm extends FormCandidate {
  finalUrl: string
  provider: FormProvider
}

export interface SavedDetail {
  key: string // e.g. "full_name", "student_id", or a custom key
  value: string
  labels: string[] // label variants, e.g. ["Matric No.", "No. Matrik"]
}

export type EventType =
  | 'state'
  | 'joined'
  | 'notice_dismissed'
  | 'form'
  | 'alert'
  | 'error'
  | 'keyframe'
  | 'recording_gap'
  | 'mention'
  | 'deletion'

export interface MeetingEvent {
  occurrenceId: string
  attempt: number // 1-based worker attempt
  at: string // ISO 8601
  type: EventType
  data: Record<string, unknown>
}

export type ControlCommand = 'leave_now' | 'take_over' | 'pause_for_signin' | 'resume_after_signin' | 'stop'

export interface Heartbeat {
  occurrenceId: string
  attempt: number
  state: OccurrenceState
  recording: boolean
  participants: number | null
  events: MeetingEvent[] // events since the last acknowledged heartbeat
}

export interface HeartbeatReply {
  ackedEvents: number // how many of the sent events were stored
  commands: ControlCommand[]
  link: string | null // the link the member pasted on the website; the worker uses it instead of watching for one
}
