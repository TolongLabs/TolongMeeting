import type { ElementHandle, Frame as PwFrame, Page } from 'playwright'
import type { MeetingState, Rect } from '../types'
import { logStep, shown, visible, ZOOM_TIMEOUTS } from './join'
import { duringNavigation, zoomRoot } from './root'
import { textPattern, zoomSelectors } from './selectors'

// Where Zoom shows a notice. A button outside one is judged by its parent's text.
const NOTICE_CONTAINER = "[role='dialog'], [role='alertdialog'], .zm-modal, .ReactModal__Content"
// Toolbar and chat controls are never notice buttons, whatever their text.
const NEVER_A_NOTICE = 'footer'

// The text a person sees on the page, without the chat: a message that says "the meeting has ended" or "breakout
// room" must not change the meeting state.
async function pageText(root: PwFrame, chatList: string): Promise<string> {
  return root.evaluate((chatSelector) => {
    const lines: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim()
      const el = node.parentElement
      if (!text || !el) continue
      if (el.closest('script, style, noscript, template') || el.closest(chatSelector)) continue
      if (!el.checkVisibility({ checkVisibilityCSS: true })) continue
      lines.push(text)
    }
    return lines.join('\n')
  }, chatList)
}

export async function zoomMeetingState(page: Page): Promise<MeetingState> {
  const { selectors: sel, texts } = await zoomSelectors()
  const state = await duringNavigation(async (): Promise<MeetingState> => {
    const root = await zoomRoot(page)
    const text = await pageText(root, sel.chatList)
    if (textPattern(texts.ended).test(text)) return 'ended'
    if (textPattern(texts.removed).test(text)) return 'removed'
    if (textPattern(texts.breakout).test(text)) return 'breakout_prompt'
    if (textPattern(texts.lobby).test(text)) return 'lobby'
    if (await visible(root, sel.leaveButton)) return 'in_meeting'
    return 'unknown'
  })
  // A page that is navigating shows no state yet.
  return state ?? 'unknown'
}

// Clicks the visible allowlist buttons (OK, Got it) and returns their texts, in page order. A button in a prompt that
// mentions a breakout room is never clicked: such a prompt is the supervisor's to report, not to answer.
export async function zoomDismissNotices(page: Page): Promise<string[]> {
  const { selectors: sel, texts, noticeAllowlist } = await zoomSelectors()
  const clicked: string[] = []
  await duringNavigation(async () => {
    const root = await zoomRoot(page)
    const buttons = await root.locator('button').filter({ visible: true }).elementHandles()
    try {
      for (const button of buttons) {
        const text = await noticeText(button, {
          allowlist: noticeAllowlist.map((t) => t.toLowerCase()),
          breakout: texts.breakout,
          excluded: [NEVER_A_NOTICE, sel.chatList].join(', '),
          container: NOTICE_CONTAINER
        })
        // An earlier click can close the dialog that holds the next button.
        if (text === null || !(await button.isVisible())) continue
        await button.click({ timeout: ZOOM_TIMEOUTS.step })
        clicked.push(text)
        logStep(`click notice ${text}`)
      }
    } finally {
      await Promise.all(buttons.map((button) => button.dispose()))
    }
  })
  return clicked
}

// The button's text when it is an allowlist notice button outside a breakout prompt, else null.
function noticeText(
  button: ElementHandle<Node>,
  rule: { allowlist: string[]; breakout: string; excluded: string; container: string }
): Promise<string | null> {
  return button.evaluate((node, r) => {
    const el = node as HTMLElement
    const text = el.innerText.trim()
    if (!r.allowlist.includes(text.toLowerCase())) return null
    if (el.closest(r.excluded)) return null
    const container = el.closest<HTMLElement>(r.container) ?? el.parentElement
    if (new RegExp(r.breakout, 'i').test(container?.innerText ?? '')) return null
    return text
  }, rule)
}

// Opens the chat panel when its list is not on screen. The only control it clicks is the open-chat button.
export async function zoomEnsureLayout(page: Page): Promise<void> {
  const { selectors: sel } = await zoomSelectors()
  const root = await zoomRoot(page)
  if (await visible(root, sel.chatList)) return
  await shown(root, sel.openChat).click({ timeout: ZOOM_TIMEOUTS.step })
  logStep('click openChat')
  await shown(root, sel.chatList).waitFor({ state: 'visible', timeout: ZOOM_TIMEOUTS.step })
}

// Joins computer audio so the meeting can be heard and recorded. The microphone stays off: with its permission
// denied Zoom joins for listening only. Does nothing when the prompt is not showing (already joined).
export async function zoomConnectOutputAudio(page: Page): Promise<void> {
  const { selectors: sel } = await zoomSelectors()
  const root = await zoomRoot(page)
  const button = shown(root, sel.joinAudioByComputer)
  if (!(await button.isVisible())) return
  await button.click({ timeout: ZOOM_TIMEOUTS.step })
  logStep('click joinAudioByComputer')
  await button.waitFor({ state: 'hidden', timeout: ZOOM_TIMEOUTS.audio })
}

// N from the participants button's "[N]" label, else the digits on the button, else null.
export async function zoomParticipantCount(page: Page): Promise<number | null> {
  const { selectors: sel } = await zoomSelectors()
  const root = await zoomRoot(page)
  const button = await root.evaluate((selector) => {
    const el = document.querySelector(selector)
    return el ? { label: el.getAttribute('aria-label') ?? '', text: el.textContent ?? '' } : null
  }, sel.participantsButton)
  if (!button) return null
  const digits = /\[(\d+)\]/.exec(button.label)?.[1] ?? /\d+/.exec(button.text)?.[0]
  return digits === undefined ? null : Number(digits)
}

// The shared screen's box in page coordinates (the iframe's offset added), or null when nothing is shared.
export async function zoomSharedScreenRegion(page: Page): Promise<Rect | null> {
  const { selectors: sel } = await zoomSelectors()
  const root = await zoomRoot(page)
  const box = await root.evaluate((selector) => {
    for (const el of document.querySelectorAll(selector)) {
      const { x, y, width, height } = el.getBoundingClientRect()
      if (width > 0 && height > 0 && el.checkVisibility({ checkVisibilityCSS: true })) return { x, y, width, height }
    }
    return null
  }, sel.shareSurface)
  if (!box) return null
  let [dx, dy] = [0, 0]
  if (root !== page.mainFrame()) {
    const frameEl = await root.frameElement()
    const outer = await frameEl.boundingBox()
    const [borderLeft, borderTop] = await frameEl.evaluate((el) => [
      (el as Element).clientLeft,
      (el as Element).clientTop
    ])
    await frameEl.dispose()
    if (!outer) return null
    dx = outer.x + (borderLeft ?? 0)
    dy = outer.y + (borderTop ?? 0)
  }
  return {
    x: Math.round(box.x + dx),
    y: Math.round(box.y + dy),
    width: Math.round(box.width),
    height: Math.round(box.height)
  }
}
