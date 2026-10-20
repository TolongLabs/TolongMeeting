import { z } from 'zod'
import { loadSelectors, pattern, selector } from '../selectors'

// Strict at every level: a key the adapter does not read, or a misspelt one, fails when the map loads.
export const TeamsSelectorsSchema = z
  .object({
    // Host names a sign-in page may be served from.
    signInHosts: z.array(z.string().min(1)).min(1),
    // CSS selectors, usable in document.querySelectorAll.
    selectors: z
      .object({
        launcherWebJoin: selector,
        prejoinJoinButton: selector,
        prejoinNameInput: selector,
        prejoinCameraToggle: selector,
        prejoinMicToggle: selector,
        prejoinComputerAudio: selector,
        lobbyScreen: selector,
        hangupButton: selector,
        micButton: selector,
        micOff: selector,
        cameraButton: selector,
        cameraOff: selector,
        moreButton: selector,
        incomingAudioOff: selector,
        chatButton: selector,
        chatPane: selector,
        chatScroller: selector,
        chatItem: selector,
        chatMessage: selector,
        chatAuthor: selector,
        chatTime: selector,
        chatBody: selector,
        rosterButton: selector,
        rosterPane: selector,
        rosterItem: selector,
        viewButton: selector,
        sharedScreen: selector,
        noticeContainers: selector,
        breakoutRoomBanner: selector,
        endScreen: selector
      })
      .strict(),
    // Regular expression sources, matched case-insensitively against visible text. Apostrophes are written as `.`.
    texts: z
      .object({
        deviceBlocked: pattern,
        invalidLink: pattern,
        permissionContinue: pattern,
        lobby: pattern,
        lobbyDenied: pattern,
        lobbyExpired: pattern,
        hangupLeave: pattern,
        incomingAudioOn: pattern,
        focusOnContent: pattern,
        breakoutPrompt: pattern,
        ended: pattern,
        removed: pattern
      })
      .strict(),
    // Exact button texts the adapter may click inside a notice.
    noticeAllowlist: z.array(z.string().min(1)).min(1)
  })
  .strict()
export type TeamsSelectors = z.infer<typeof TeamsSelectorsSchema>

// Not cached: every call reads TM_SELECTORS_DIR again, so a changed directory is picked up.
export function teamsSelectors(): Promise<TeamsSelectors> {
  return loadSelectors('teams', TeamsSelectorsSchema)
}
