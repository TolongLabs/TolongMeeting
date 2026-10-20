import { meetSelectors } from '../adapters/meet/selectors'
import type { SmokeEntry } from './entries'

// The Meet test meeting is a standing meeting with access set to "Open", so the smoke identity joins without knocking.
// The chat item keys are not checked: Meet keeps no chat until someone writes.
export const meetSmoke: SmokeEntry = {
  platform: 'meet',
  selectors: meetSelectors,
  checkpoints: {
    inMeeting: [
      'leaveButton',
      'micToggle',
      'micOff',
      'cameraToggle',
      'cameraOff',
      'chatButton',
      'peopleButton',
      'moreButton'
    ],
    afterLayout: ['sidePanel', 'chatScroller'],
    afterSweep: ['chatScroller'],
    afterLeave: []
  }
}
