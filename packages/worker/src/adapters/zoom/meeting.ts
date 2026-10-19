import type { ElementHandle, Frame as PwFrame, Page } from 'playwright'
import type { MeetingState, Rect } from '../types'
import { logStep, shown, visible, ZOOM_TIMEOUTS } from './join'
import { duringNavigation, zoomRoot } from './root'
import { textPattern, zoomSelectors } from './selectors'

// Where Zoom shows a notice. A button outside one is never clicked, and the ended/removed/breakout phrases are read
// only from inside one.
const NOTICE_CONTAINER = "[role='dialog'], [role='alertdialog'], .zm-modal, .ReactModal__Content"
// Toolbar and chat controls are never notice buttons, whatever their text.
const NEVER_A_NOTICE = 'footer'
// A dialog whose text matches one of these asks the user to do something (or says something is on offer): an OK or
// Got it in it is not a plain acknowledgement. The breakout pattern comes from the selector map (texts.breakout).
// "record" matches a consent request, not the notice "this meeting is being recorded".
const DANGER_TEXTS: { name: string; source: string }[] = [
  { name: 'join', source: '\\bjoin\\b' },
  { name: 'start video', source: 'start (my |your )?video' },
  { name: 'allow', source: '\\ballow\\b' },
  { name: 'unmute', source: '\\bunmute\\b' },
  { name: 'share', source: '\\bshare\\b' },
  {
    name: 'record',
    source: 'record\\w*[^.\\n]*(consent|permission|agree|request)|(consent|permission|agree|request\\w*)[^.\\n]*record'
  }
]

// The race a notice button can lose: it closed between the query and the click. Task 13 removed the generic swallow of
// this error, so it is handled here, at the one place where it is a race and not a fault.
const NOT_ATTACHED = /Element is not attached to the DOM/

// The text a person sees, as lines: all of it ('page'), and the part inside notices ('notices'). The chat is left out
// of both: a message that says "the meeting has ended" or "breakout room" must not change the meeting state.
//
// Serialised by Playwright and evaluated in the page: do not bundle it with `--minify` or `--keep-names`.
async function visibleText(root: PwFrame, chatList: string): Promise<{ page: string; notices: string }> {
  return root.evaluate(
    (r) => {
      const page: string[] = []
      const notices: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim()
        const el = node.parentElement
        if (!text || !el) continue
        if (el.closest('script, style, noscript, template') || el.closest(r.chatList)) continue
        if (!el.checkVisibility({ checkVisibilityCSS: true })) continue
        page.push(text)
        if (el.closest(r.container)) notices.push(text)
      }
      return { page: page.join('\n'), notices: notices.join('\n') }
    },
    { chatList, container: NOTICE_CONTAINER }
  )
}

export async function zoomMeetingState(page: Page): Promise<MeetingState> {
  const { selectors: sel, texts } = await zoomSelectors()
  const state = await duringNavigation('meetingState', async (): Promise<MeetingState> => {
    const root = await zoomRoot(page)
    const text = await visibleText(root, sel.chatList)
    if (textPattern(texts.ended).test(text.notices)) return 'ended'
    if (textPattern(texts.removed).test(text.notices)) return 'removed'
    if (textPattern(texts.breakout).test(text.notices)) return 'breakout_prompt'
    if (textPattern(texts.lobby).test(text.page)) return 'lobby'
    if (await visible(root, sel.leaveButton)) return 'in_meeting'
    return 'unknown'
  })
  // A page that is navigating shows no state yet.
  return state ?? 'unknown'
}

// What noticeVerdict says about one button: not a notice button at all, one to click, or one to leave alone and why.
type Verdict = { kind: 'ignore' } | { kind: 'click'; text: string } | { kind: 'skip'; text: string; reason: string }

// Clicks the visible allowlist buttons (OK, Got it) and returns their texts, in page order. It fails closed: a button
// is clicked only inside a recognised dialog whose text offers nothing to accept (breakout, join, start video, allow,
// unmute, share, record consent). Such a prompt is the supervisor's to report, not to answer.
export async function zoomDismissNotices(page: Page): Promise<string[]> {
  const { selectors: sel, texts, noticeAllowlist } = await zoomSelectors()
  const clicked: string[] = []
  await duringNavigation('dismissNotices', async () => {
    const root = await zoomRoot(page)
    const buttons = await root.locator('button').filter({ visible: true }).elementHandles()
    try {
      for (const button of buttons) {
        try {
          const verdict = await noticeVerdict(button, {
            allowlist: noticeAllowlist.map((t) => t.toLowerCase()),
            danger: [{ name: 'breakout', source: texts.breakout }, ...DANGER_TEXTS],
            excluded: [NEVER_A_NOTICE, sel.chatList].join(', '),
            container: NOTICE_CONTAINER
          })
          if (verdict.kind === 'ignore') continue
          if (verdict.kind === 'skip') {
            logStep(`skip notice ${verdict.text}: ${verdict.reason}`)
            continue
          }
          // An earlier click can close the dialog that holds the next button.
          if (!(await button.isVisible())) continue
          await button.click({ timeout: ZOOM_TIMEOUTS.step })
          clicked.push(verdict.text)
          logStep(`click notice ${verdict.text}`)
        } catch (error) {
          // The notice closed on its own between the query and the click: nothing left to dismiss.
          if (!(error instanceof Error && NOT_ATTACHED.test(error.message))) throw error
          logStep('notice closed before it was clicked')
        }
      }
    } finally {
      await Promise.all(buttons.map((button) => button.dispose()))
    }
  })
  return clicked
}

// Serialised by Playwright and evaluated in the page: do not bundle it with `--minify` or `--keep-names`.
function noticeVerdict(
  button: ElementHandle<Node>,
  rule: {
    allowlist: string[]
    danger: { name: string; source: string }[]
    excluded: string
    container: string
  }
): Promise<Verdict> {
  return button.evaluate((node, r): Verdict => {
    const el = node as HTMLElement
    const text = el.innerText.trim()
    if (!r.allowlist.includes(text.toLowerCase())) return { kind: 'ignore' }
    if (el.closest(r.excluded)) return { kind: 'ignore' }
    const container = el.closest<HTMLElement>(r.container)
    if (!container) return { kind: 'skip', text, reason: 'no dialog around it' }
    const dialogText = container.innerText
    const hit = r.danger.find((d) => new RegExp(d.source, 'i').test(dialogText))
    if (hit) return { kind: 'skip', text, reason: `dialog mentions ${hit.name}` }
    return { kind: 'click', text }
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
