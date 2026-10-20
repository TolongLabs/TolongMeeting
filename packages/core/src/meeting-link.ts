import { normaliseMeetLink } from './meet-link'
import { normaliseTeamsLink } from './teams-link'
import { normaliseZoomLink } from './zoom-link'

/**
 * The one rule for "is this a meeting link we can join": Zoom, then Teams, then Google Meet. Callers store the trimmed
 * original and let the worker's adapter normalise it again.
 */
export function normaliseMeetingLink(url: string): string | null {
  return normaliseZoomLink(url) ?? normaliseTeamsLink(url) ?? normaliseMeetLink(url)
}
