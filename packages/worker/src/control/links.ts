import type { JobConfig } from '@tm/core'
import type { SiteLinks } from '@tm/notify'

/**
 * The website pages a ping can open, from `TM_PUBLIC_URL`: the meeting page, the sign-in page of the identity, and the
 * leave and take-over pages of the meeting. Null when the variable is unset (as in 1A). A value that is not an https
 * URL is an error: a ping must not carry a link the member cannot open.
 */
export function siteLinks(cfg: JobConfig, publicUrl: string | undefined = process.env.TM_PUBLIC_URL): SiteLinks | null {
  if (publicUrl === undefined || publicUrl === '') return null
  if (!URL.canParse(publicUrl) || new URL(publicUrl).protocol !== 'https:') {
    throw new Error('TM_PUBLIC_URL must be an https URL')
  }
  const base = new URL(publicUrl).origin
  const meetingPage = `${base}/meetings/${encodeURIComponent(cfg.occurrenceId)}`
  return {
    meetingPage,
    signIn: `${base}/accounts/${encodeURIComponent(cfg.identity.id)}/signin`,
    leave: `${meetingPage}/leave`,
    takeOver: `${meetingPage}/take-over`
  }
}
