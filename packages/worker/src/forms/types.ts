import type { EventType, FormProvider, FormRecord, JobConfig } from '@tm/core'
import type { Ping } from '@tm/notify'
import type { Page } from 'playwright'
import type { FormLinks } from './pings'

// date and time are set from the widget in the DOM (never from the label); other: grid, file upload, any widget not recognised
export type QuestionType = 'text' | 'paragraph' | 'radio' | 'checkbox' | 'dropdown' | 'date' | 'time' | 'other'

export interface FormQuestion {
  id: string // `p<page>q<n>`, n = 0-based position among the page's questions
  label: string // without the required marker or points line
  type: QuestionType
  options: string[] // [] for text, paragraph, date, time and other
  required: boolean
  // Current answer; null when empty. A date reads as `YYYY-MM-DD` and a time as `HH:MM` when the widget shows one;
  // anything the driver cannot normalise is kept as shown, so it never equals a planned value.
  value: string | string[] | null
}

export interface Restriction {
  organisation: string | null // from the provider's own footer
  signedInAs: string | null // email in the provider's own account line
  orgOnly: boolean // the provider's own "only your organisation" notice is shown
}

export interface FormPage {
  index: number // 1-based
  title: string
  description: string // for looksLikeAttendance only; never sent to a model
  questions: FormQuestion[]
  quiz: boolean // some question shows a points line
  sendCopy: boolean | null // the "send me a copy" box: null if absent, else whether ticked
  hasNext: boolean
  hasSubmit: boolean
  restriction: Restriction
}

export type PageKind =
  'form' | 'signin' | 'already_answered' | 'confirmation' | 'closed' | 'no_access' | 'captcha' | 'unknown'

export interface MatchQuestion {
  id: string
  label: string
  options: string[]
}

export type Answer =
  | {
      questionId: string
      kind: 'text'
      value: string
      detailKey: string
      via: 'label' | 'model'
    }
  | {
      questionId: string
      kind: 'choose'
      option: string
      detailKey: string | null
      via: 'label' | 'model' | 'confirmation'
    }
  // Only from a required date or time question whose label equals a session_date or session_start label variant.
  | {
      questionId: string
      kind: 'date'
      value: string // YYYY-MM-DD in the entry's time zone
      detailKey: 'session_date'
      via: 'label'
    }
  | {
      questionId: string
      kind: 'time'
      value: string // HH:MM, 24 hours, in the entry's time zone
      detailKey: 'session_start'
      via: 'label'
    }

export interface PagePlan {
  answers: Answer[]
  unmatchedRequired: FormQuestion[]
}

export interface FormContextBase {
  cfg: JobConfig
  desk: Page
  links: FormLinks
  emitEvent(type: EventType, data: Record<string, unknown>): Promise<void>
  ping(p: Ping): Promise<void>
  matchLabels(questions: MatchQuestion[], detailKeys: string[]): Promise<Map<string, string>>
  waitForSignin(tab: Page, provider: FormProvider, signal: AbortSignal): Promise<boolean>
  /** Resolves when the member does not hold the desk (a sign-in pause). Absent: the desk is always free. */
  deskOpen?(): Promise<void>
}

export interface FormContext extends FormContextBase {
  previous: FormRecord | null // the record to continue after a trust upgrade (Task 13), else null
  signal: AbortSignal // aborted when the dispatcher closes
}
