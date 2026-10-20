import type { Page } from 'playwright'
import type { TeamsSelectors } from './selectors'

// True when the case-insensitive regular expression `pattern` matches the page's visible text outside the chat and
// roster panes, so a chat message ("The meeting has ended") never counts as a signal. The matched text is never
// returned or logged: it can hold names and chat.
export function teamsTextSignal(page: Page, sel: TeamsSelectors, pattern: string): Promise<boolean> {
  const skip = [sel.selectors.chatPane, sel.selectors.rosterPane]
  return page.evaluate(
    ({ source, skip }) => {
      const excluded = skip.flatMap((css) => [...document.querySelectorAll(css)])
      const lines: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        const text = node.textContent?.trim()
        if (!parent || !text) continue
        if (excluded.some((pane) => pane.contains(parent))) continue
        if (!parent.checkVisibility({ visibilityProperty: true })) continue
        lines.push(text)
      }
      return new RegExp(source, 'i').test(lines.join('\n'))
    },
    { source: pattern, skip }
  )
}
