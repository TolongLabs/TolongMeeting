import type { MeetSelectors } from './selectors'

// One chat message as the page shows it. `id` is the message element's own id attribute, else null.
export interface RawMeetMessage {
  id: string | null
  sender: string
  time: string
  text: string
  hrefs: string[]
}

// Runs inside the Meet document through `page.evaluate(parseMeetMessages, sel)`, so it shares nothing with this module:
// every helper is declared in the function. Do not bundle or transform it with a tool that injects helpers
// (`--minify`, `--keep-names` and the like add `__name(...)` calls, which do not exist in the page).
//
// Reads each chat group's sender and time and each of its messages, in document order. Rules that keep chat rows true:
// - A group whose sender cannot be read yields no rows. A row from nobody would be stored as such and, once its sender
//   shows, stored again; the next read or sweep sees the group with its sender.
// - The id is the message element's own `data-message-id` (or `id`). Never an ancestor's: the group's attributes name
//   the sender, and a wrapper's id can be shared by every row it holds.
// - A message that contains another message element is a wrapper, not a row; only the innermost counts.
export function parseMeetMessages(sel: MeetSelectors): RawMeetMessage[] {
  const { chatScroller, chatGroup, chatSender, chatTime, chatMessage } = sel.selectors
  const scroller = [...document.querySelectorAll<HTMLElement>(chatScroller)].find((el) => el.checkVisibility())
  if (!scroller) return []
  const out: RawMeetMessage[] = []
  for (const group of scroller.querySelectorAll<HTMLElement>(chatGroup)) {
    const own = (selector: string) =>
      [...group.querySelectorAll<HTMLElement>(selector)].find((el) => el.closest(chatMessage) === null)
    const sender = own(chatSender)?.innerText.trim() ?? ''
    if (!sender) continue
    const time = own(chatTime)?.innerText.trim() ?? ''
    for (const message of group.querySelectorAll<HTMLElement>(chatMessage)) {
      if (message.querySelector(chatMessage) !== null) continue
      const text = message.innerText.trim()
      if (!text) continue
      out.push({
        id: message.getAttribute('data-message-id') || message.id || null,
        sender,
        time,
        text,
        hrefs: [...message.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.href)
      })
    }
  }
  return out
}
