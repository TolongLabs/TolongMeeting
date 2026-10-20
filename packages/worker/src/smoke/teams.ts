import { teamsSelectors } from '../adapters/teams'
import type { SmokeEntry } from './entries'

export const teamsSmoke: SmokeEntry = {
  platform: 'teams',
  selectors: teamsSelectors,
  checkpoints: {
    inMeeting: [
      'hangupButton',
      'micButton',
      'micOff',
      'cameraButton',
      'cameraOff',
      'chatButton',
      'rosterButton',
      'viewButton',
      'moreButton'
    ],
    afterLayout: ['chatPane', 'chatScroller', 'chatItem', 'chatMessage', 'chatAuthor', 'chatTime', 'chatBody'],
    afterSweep: ['chatPane'],
    afterLeave: ['endScreen']
  }
}
