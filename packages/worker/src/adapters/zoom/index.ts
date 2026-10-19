import type { PlatformAdapter } from '../types'
import { zoomAssertDevicesOff, zoomJoin, zoomLeave, zoomWaitUntilAdmitted } from './join'
import { normaliseZoomLink } from './link'

// Task 14 replaces these with the in-meeting signals.
function notYet(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`zoomAdapter.${name} is not implemented yet`))
}

export const zoomAdapter: PlatformAdapter = {
  platform: 'zoom',
  normaliseLink: normaliseZoomLink,
  join: zoomJoin,
  waitUntilAdmitted: zoomWaitUntilAdmitted,
  assertDevicesOff: zoomAssertDevicesOff,
  leave: zoomLeave,
  connectOutputAudio: notYet('connectOutputAudio'),
  ensureLayout: notYet('ensureLayout'),
  readChat: notYet('readChat'),
  sweepChat: notYet('sweepChat'),
  sharedScreenRegion: notYet('sharedScreenRegion'),
  participantCount: notYet('participantCount'),
  meetingState: notYet('meetingState'),
  dismissNotices: notYet('dismissNotices')
}
