import { z } from 'zod'
import { loadSelectors, pattern, selector } from '../selectors'

// Strict at every level: a key the adapter does not read, or a misspelt one, fails when the map loads.
export const MeetSelectorsSchema = z
  .object({
    // Host names a sign-in page may be served from.
    signInHosts: z.array(z.string().min(1)).min(1),
    // Exact join-button texts, in order of preference.
    joinButtons: z.array(z.string().min(1)).min(1),
    // CSS selectors, usable in document.querySelectorAll.
    selectors: z
      .object({
        prejoinNameInput: selector,
        micToggle: selector,
        micOff: selector,
        cameraToggle: selector,
        cameraOff: selector,
        leaveButton: selector,
        chatButton: selector,
        peopleButton: selector,
        sidePanel: selector,
        chatScroller: selector,
        chatGroup: selector,
        chatSender: selector,
        chatTime: selector,
        chatMessage: selector,
        peopleList: selector,
        peopleItem: selector,
        moreButton: selector,
        dialogClose: selector,
        captionsOnButton: selector,
        captionsRegion: selector,
        sharedScreen: selector,
        // Where Meet shows a notice: a button outside one is never clicked.
        noticeContainers: selector
      })
      .strict(),
    // Regular expression sources, matched case-insensitively against visible text. Apostrophes are written as `.`.
    texts: z
      .object({
        blocked: pattern,
        invalidLink: pattern,
        permissionContinue: pattern,
        lobby: pattern,
        lobbyDenied: pattern,
        lobbyExpired: pattern,
        leaveConfirm: pattern,
        layoutMenu: pattern,
        spotlight: pattern,
        breakoutPrompt: pattern,
        endScreen: pattern,
        ended: pattern,
        removed: pattern,
        // A dialog matching one of these asks for something: an OK or Got it in it is not a plain acknowledgement.
        noticeDanger: z.array(z.object({ name: z.string().min(1), source: pattern }).strict()).min(1)
      })
      .strict(),
    // Exact button texts the adapter may click inside a notice.
    noticeAllowlist: z.array(z.string().min(1)).min(1)
  })
  .strict()
export type MeetSelectors = z.infer<typeof MeetSelectorsSchema>

// Not cached: every call reads TM_SELECTORS_DIR again, so a changed directory is picked up.
export function meetSelectors(): Promise<MeetSelectors> {
  return loadSelectors('meet', MeetSelectorsSchema)
}
