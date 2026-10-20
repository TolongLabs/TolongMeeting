import type { PlatformAdapter } from './types'
import { teamsAdapter, TEAMS_TIMEOUTS } from './teams'
import { zoomAdapter } from './zoom'

export { loadSelectors } from './selectors'
export { ZOOM_TIMEOUTS, zoomRoot, ZoomSelectorsSchema } from './zoom'

export { DevicesOnError } from './types'
export type { PlatformAdapter } from './types'
export { TEAMS_TIMEOUTS, teamsAdapter, zoomAdapter }

const ADAPTERS: PlatformAdapter[] = [zoomAdapter, teamsAdapter]

// The adapter whose platform owns this meeting link, or null when none does.
export function adapterFor(url: string): PlatformAdapter | null {
  return ADAPTERS.find((adapter) => adapter.normaliseLink(url) !== null) ?? null
}
