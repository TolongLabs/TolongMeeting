import { loadSelectors, ZoomSelectorsSchema } from '../adapters'
import type { SmokeEntry } from './entries'

export const zoomSmoke: SmokeEntry = {
  platform: 'zoom',
  selectors: () => loadSelectors('zoom', ZoomSelectorsSchema),
  checkpoints: {
    inMeeting: ['leaveButton', 'audioButton', 'videoButton', 'participantsButton'],
    afterLayout: ['chatList'],
    afterSweep: ['chatList'],
    afterLeave: []
  }
}
