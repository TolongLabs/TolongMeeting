import { withDevice } from '../../../../lib/companion/scope'
import { handleSummariesRequest } from '../../../../lib/companion/summaries'

export const dynamic = 'force-dynamic'

/** The member's summaries ready after a time. */
export const GET = withDevice(handleSummariesRequest)
