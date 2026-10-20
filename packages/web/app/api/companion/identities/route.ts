import { companionDeps } from '../../../../lib/companion/deps'
import { withDevice } from '../../../../lib/companion/scope'
import { handleCompanionIdentities } from '../../../../lib/run-locations/settings'

/** The identities that run on the calling PC, and the worker image it pulls. */
export const GET = withDevice(async (_request, scope) => handleCompanionIdentities(companionDeps().db, scope.device))
