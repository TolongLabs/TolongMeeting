import type { Platform } from '@tm/core'
import { meetSmoke } from './meet'
import { teamsSmoke } from './teams'
import { zoomSmoke } from './zoom'

// What the monthly smoke test checks on one platform: the selector keys that must match an element at each stage of a
// join, a read of the meeting and a leave. Every key names a `selectors` entry of the platform's selector map.
export interface SmokeEntry {
  platform: Platform
  selectors(): Promise<{ selectors: Record<string, string> }>
  checkpoints: { inMeeting: string[]; afterLayout: string[]; afterSweep: string[]; afterLeave: string[] }
}

export const SMOKE_ENTRIES: SmokeEntry[] = [zoomSmoke, teamsSmoke, meetSmoke]
