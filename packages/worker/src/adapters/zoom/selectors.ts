import { z } from 'zod'
import { loadSelectors, pattern, selector } from '../selectors'

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
    shareSurface: selector,
    // Where Zoom shows a notice: a button outside one is never clicked, and ended/removed/breakout are read from inside.
    noticeContainer: selector
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
    devicesOnLabel: pattern,
    // A dialog matching one of these asks for something: an OK or Got it in it is not a plain acknowledgement.
    noticeDanger: z.array(z.object({ name: z.string().min(1), source: pattern })).min(1)
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
