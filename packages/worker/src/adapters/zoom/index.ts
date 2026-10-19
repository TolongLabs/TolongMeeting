import type { PlatformAdapter } from '../types'
import { zoomReadChat, zoomSweepChat } from './chat'
import { zoomAssertDevicesOff, zoomJoin, zoomLeave, zoomWaitUntilAdmitted } from './join'
import { normaliseZoomLink } from './link'
import {
  zoomConnectOutputAudio,
  zoomDismissNotices,
  zoomEnsureLayout,
  zoomMeetingState,
  zoomParticipantCount,
  zoomSharedScreenRegion
} from './meeting'

export { ZOOM_TIMEOUTS } from './join'
export { zoomRoot } from './root'
export { ZoomSelectorsSchema } from './selectors'
export { loadSelectors } from '../selectors'

export const zoomAdapter: PlatformAdapter = {
  platform: 'zoom',
  normaliseLink: normaliseZoomLink,
  join: zoomJoin,
  waitUntilAdmitted: zoomWaitUntilAdmitted,
  assertDevicesOff: zoomAssertDevicesOff,
  leave: zoomLeave,
  connectOutputAudio: zoomConnectOutputAudio,
  ensureLayout: zoomEnsureLayout,
  readChat: zoomReadChat,
  sweepChat: zoomSweepChat,
  sharedScreenRegion: zoomSharedScreenRegion,
  participantCount: zoomParticipantCount,
  meetingState: zoomMeetingState,
  dismissNotices: zoomDismissNotices
}
