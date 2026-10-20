import type { Page } from 'playwright'
import type { MeetSelectors } from './selectors'

// True when the case-insensitive regular expression `pattern` matches a line of the page's visible text. Text inside
// the side panel (chat, people) and the captions region never counts: a classmate typing "you left the meeting", or a
// lecturer saying it, must not read as a state signal. Each text node is one line, so `^` and `$` anchor to it.
export async function meetTextSignal(page: Page, sel: MeetSelectors, pattern: string): Promise<boolean> {
  const excluded = [sel.selectors.sidePanel, sel.selectors.captionsRegion].join(', ')
  return page.evaluate(
    ({ pattern, excluded }) => {
      const re = new RegExp(pattern, 'im')
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent?.trim()
        const parent = node.parentElement
        if (!text || parent === null || parent.closest('script, style, noscript') !== null) continue
        if (parent.closest(excluded) !== null || !parent.checkVisibility()) continue
        if (re.test(text)) return true
      }
      return false
    },
    { pattern, excluded }
  )
}
