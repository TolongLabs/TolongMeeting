import { handleJobsRequest } from '../../../../lib/companion/jobs'
import { withDevice } from '../../../../lib/companion/scope'

export const dynamic = 'force-dynamic'

/** The jobs this PC may claim, and the ones it holds. */
export const GET = withDevice(handleJobsRequest)
