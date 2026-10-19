import type { FormProvider, FormRecord, FormSource, StopReason } from '@tm/core'
import { canonicalFormUrl } from '@tm/core'
import type { Ping, PingAction } from '@tm/notify'

// Set by the meeting page (1C). Both are null in 1B.
export interface FormLinks {
  meetingPage: string | null
  signIn: string | null
}

export interface FormPingOptions {
  entryName: string
  timeZone: string
  links: FormLinks
}

const PROVIDER_NAME: Record<FormProvider, string> = { google: 'Google Forms', microsoft: 'Microsoft Forms' }
const SOURCE_NAME: Record<FormSource, string> = {
  qr: 'shared screen',
  meeting_chat: 'meeting chat',
  watched_chat: 'watched chat'
}

// Reasons that can end a failed form. The two untrusted reasons end an untrusted form, not a failed one.
const FAILED_REASON: Record<Exclude<StopReason, 'untrusted_source' | 'not_org_restricted'>, string> = {
  tab_not_on_desk: "its tab didn't open on the unrecorded side",
  open_timeout: "it didn't load within 15 seconds",
  signin_required_again: 'it asked for sign-in again after you signed in',
  signin_not_completed: "sign-in wasn't completed within 15 minutes",
  meeting_ended: 'the meeting ended before sign-in was completed',
  form_closed: "it's no longer accepting responses",
  no_access: "your account doesn't have access to it",
  captcha: 'it asks for a CAPTCHA',
  unknown_page: "the page didn't look like a form",
  fill_failed: "an answer didn't stay filled in",
  next_failed: "its next page didn't open",
  submit_failed: "it didn't confirm the submission (check whether your response was recorded)",
  submit_unconfirmed:
    'it may have been submitted but never confirmed it (please check whether your response was recorded)',
  deadline: "it wasn't ready to submit within 2 minutes",
  interrupted: 'the worker restarted while handling it',
  interrupted_submitting: 'the worker restarted while submitting it (check whether your response was recorded)',
  unexpected_error: 'of an unexpected error'
}

const MAX_QUOTED_QUESTIONS = 3

// Returns the ping for a form state that reports an outcome, or null for the states that only pass through.
// Throws when an outcome lacks the field its copy names, rather than sending a blank.
export function formPing(rec: FormRecord, opts: FormPingOptions): Ping | null {
  const { entryName: entry, timeZone, links } = opts
  const provider = PROVIDER_NAME[rec.provider]
  const openForm: PingAction = { label: 'Open form', url: canonicalFormUrl(rec.finalUrl) }
  const sender = rec.sender ?? 'someone'
  const source = SOURCE_NAME[rec.source]

  switch (rec.state) {
    case 'submitted': {
      if (rec.submittedAt === null) {
        throw new Error(`formPing: submitted form ${rec.formId} has no submittedAt`)
      }
      const time = clock(rec.submittedAt, timeZone)
      if (links.meetingPage === null) {
        return {
          title: 'Attendance submitted',
          priority: 'high',
          actions: [],
          message: `${entry}: attendance form submitted at ${time} (${provider}). Screenshots: forms/${rec.formId}/ in the meeting folder.`
        }
      }
      return {
        title: 'Attendance submitted',
        priority: 'high',
        actions: [{ label: 'Open meeting page', url: links.meetingPage }],
        message: `${entry}: attendance form submitted at ${time} (${provider}). Screenshots are on the meeting page.`
      }
    }
    case 'awaiting_signin':
      return {
        title: 'Sign in again',
        priority: 'high',
        actions:
          links.signIn === null
            ? [{ label: 'Sign in again', url: canonicalFormUrl(rec.finalUrl) }]
            : [{ label: 'Sign in again', url: links.signIn }, openForm],
        message: `${entry}: an attendance form needs your ${provider} sign-in, which has expired. Sign in on the desk view and I'll try once more while the form is open, or open the form yourself.`
      }
    case 'needs_member': {
      if (rec.unmatched.length === 0) {
        throw new Error(`formPing: needs_member form ${rec.formId} has no unmatched questions`)
      }
      const shown = rec.unmatched
        .slice(0, MAX_QUOTED_QUESTIONS)
        .map((q) => `"${q}"`)
        .join(', ')
      const more = rec.unmatched.length - MAX_QUOTED_QUESTIONS
      const moreClause = more > 0 ? ` and ${more} more` : ''
      return {
        title: 'Form needs you',
        priority: 'high',
        actions: [openForm],
        message: `${entry}: I didn't submit this ${provider} form because no saved detail answers ${shown}${moreClause}.`
      }
    }
    case 'untrusted':
      switch (rec.reason) {
        case 'untrusted_source':
          return {
            title: 'Form seen, not submitted',
            priority: 'high',
            actions: [openForm],
            message: `${entry}: I didn't open this ${provider} form because ${sender} posted it in the ${source}, and they aren't the host or a trusted sender.`
          }
        case 'not_org_restricted':
          return {
            title: 'Form seen, not submitted',
            priority: 'high',
            actions: [openForm],
            message: `${entry}: I didn't submit this ${provider} form because ${sender} posted it in the ${source}, they aren't the host or a trusted sender, and the form isn't limited to your organisation.`
          }
        default:
          throw new Error(`formPing: untrusted form ${rec.formId} has reason ${rec.reason ?? 'null'}`)
      }
    case 'not_attendance':
      return {
        title: 'Form seen, not submitted',
        priority: 'default',
        actions: [openForm],
        message: `${entry}: this ${provider} form doesn't look like an attendance form, so I didn't submit it.`
      }
    case 'quiz':
      return {
        title: 'Form seen, not submitted',
        priority: 'default',
        actions: [openForm],
        message: `${entry}: this ${provider} form is a quiz (it shows points), so I didn't submit it.`
      }
    case 'already_answered':
      return {
        title: 'Form already answered',
        priority: 'default',
        actions: [openForm],
        message: `${entry}: ${provider} says this form was already answered, so nothing was sent.`
      }
    case 'failed': {
      const reason = rec.reason
      if (reason === null || reason === 'untrusted_source' || reason === 'not_org_restricted') {
        throw new Error(`formPing: failed form ${rec.formId} has reason ${reason ?? 'null'}`)
      }
      return {
        title: 'Form needs you',
        priority: 'high',
        actions: [openForm],
        message: `${entry}: I couldn't submit this ${provider} form because ${FAILED_REASON[reason]}. Please open it yourself.`
      }
    }
    case 'detected':
    case 'resolving':
    case 'checking_trust':
    case 'opening':
    case 'inspecting':
    case 'filling':
    case 'submitting':
      return null
  }
}

function clock(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone
  }).format(new Date(at))
}
