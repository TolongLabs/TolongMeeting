import { z } from 'zod'
import { loadSelectors } from '../selectors'

const selector = z.string().min(1)
// A regular expression source: compiled here, so a bad one fails when the map loads and not on a live meeting.
const pattern = z
  .string()
  .min(1)
  .refine(
    (source) => {
      try {
        new RegExp(source, 'i')
        return true
      } catch {
        return false
      }
    },
    { message: 'not a valid regular expression' }
  )

export const ZoomSelectorsSchema = z.object({
  rootIframe: selector,
  selectors: z.object({
    continueWithoutDevices: selector,
    nameInput: selector,
    joinButton: selector,
    leaveButton: selector,
    leaveConfirm: selector,
    audioButton: selector,
    videoButton: selector,
    joinAudioByComputer: selector,
    openChat: selector,
    participantsButton: selector,
    chatList: selector,
    chatItem: selector,
    chatSender: selector,
    chatReceiver: selector,
    chatTime: selector,
    chatText: selector,
    chatReplyQuote: selector,
    shareSurface: selector
  }),
  // Regular expression sources, matched case-insensitively against page text or labels.
  texts: z.object({
    signInRequired: pattern,
    accountBusy: pattern,
    lobby: pattern,
    lobbyDenied: pattern,
    ended: pattern,
    removed: pattern,
    breakout: pattern,
    roleLabel: pattern,
    devicesOnLabel: pattern
  }),
  noticeAllowlist: z.array(z.string().min(1)).min(1)
})
export type ZoomSelectors = z.infer<typeof ZoomSelectorsSchema>

let cached: Promise<ZoomSelectors> | null = null

// Loaded once per process, on first use (importing the adapter reads nothing).
export function zoomSelectors(): Promise<ZoomSelectors> {
  cached ??= loadSelectors('zoom', ZoomSelectorsSchema)
  return cached
}

export function textPattern(source: string): RegExp {
  return new RegExp(source, 'i')
}
