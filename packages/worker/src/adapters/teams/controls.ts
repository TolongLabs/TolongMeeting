import { setTimeout as sleep } from 'node:timers/promises'
import type { ElementHandle, Page } from 'playwright'
import { DevicesOnError } from '../types'
import { navigationGuard, type NavigationGuard } from '../zoom/root'
import { logStep, shown } from './join'
import type { TeamsSelectors } from './selectors'

const STEP_TIMEOUT_MS = 10_000
const MENU_TIMEOUT_MS = 2_000
const AUDIO_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 15_000
const RACE_POLL_MS = 250
// How long a clicked notice button gets to go away, and the most clicks one call makes.
const NOTICE_CLOSE_MS = 1_000
const MAX_NOTICE_PASSES = 20

// The race a notice button can lose: it closed between the query and the click. Handled where it is a race, not a fault.
const NOT_ATTACHED = /Element is not attached to the DOM/

// Runs `step` until the page holds still long enough for it to finish. A navigation under it is swallowed by the guard,
// which throws after a handful in a row; a step that never completed is never read as a pass.
async function settled<T>(guard: NavigationGuard, step: () => Promise<T>): Promise<T> {
  for (;;) {
    const result = await guard.run(step)
    if (result !== undefined) return result
    await sleep(RACE_POLL_MS)
  }
}

// Throws DevicesOnError when the microphone or camera might be live: a control whose "off" form is not on screen is
// reported by its aria-label, a missing control by name. Clicks nothing.
export async function assertTeamsDevicesOff(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors } = sel
  const live = await settled(navigationGuard('devicesOff', 'teams'), async () => {
    const labels: string[] = []
    for (const [name, control, off] of [
      ['microphone', selectors.micButton, selectors.micOff],
      ['camera', selectors.cameraButton, selectors.cameraOff]
    ] as const) {
      if (await shown(page, off).isVisible()) continue
      const button = shown(page, control)
      if (!(await button.isVisible())) labels.push(`${name} control not found`)
      else labels.push((await button.getAttribute('aria-label', { timeout: STEP_TIMEOUT_MS })) ?? name)
    }
    return labels
  })
  if (live.length > 0) throw new DevicesOnError(live)
}

// What noticeVerdict says about one button: not a notice button at all, one to click, or one to leave alone and why.
type Verdict = { kind: 'ignore' } | { kind: 'click'; text: string } | { kind: 'skip'; text: string; reason: string }

// Serialised by Playwright and evaluated in the page: do not bundle it with `--minify` or `--keep-names`.
function noticeVerdict(
  button: ElementHandle<Node>,
  rule: { allowlist: string[]; danger: { name: string; source: string }[]; excluded: string; container: string }
): Promise<Verdict> {
  return button.evaluate((node, r): Verdict => {
    const el = node as HTMLElement
    const text = el.innerText.trim()
    const label = el.getAttribute('aria-label')?.trim() ?? ''
    const name = [text, label].find((t) => r.allowlist.includes(t.toLowerCase()))
    if (name === undefined) return { kind: 'ignore' }
    if (el.closest(r.excluded)) return { kind: 'ignore' }
    // The outermost container, so the danger check reads the whole dialog even when containers are nested.
    let container = el.closest<HTMLElement>(r.container)
    for (let outer = container?.parentElement?.closest<HTMLElement>(r.container); outer;) {
      container = outer
      outer = outer.parentElement?.closest<HTMLElement>(r.container) ?? null
    }
    if (!container) return { kind: 'skip', text: name, reason: 'no dialog around it' }
    const dialogText = container.innerText
    const hit = r.danger.find((d) => new RegExp(d.source, 'i').test(dialogText))
    if (hit) return { kind: 'skip', text: name, reason: `dialog mentions ${hit.name}` }
    return { kind: 'click', text: name }
  }, rule)
}

// Clicks the visible allowlist buttons (Got it, OK, Dismiss) and returns their texts, in page order. It fails closed: a
// button is clicked only inside a recognised notice container, and never when the notice's text matches the breakout
// prompt or a noticeDanger pattern (join, start video, allow, unmute, share, record consent). Such a prompt is the
// supervisor's to report, not to answer. The chat and people panes are never searched. Only allowlisted button texts and
// the name of the matched pattern are logged, never the notice's text.
export async function dismissTeamsNotices(page: Page, sel: TeamsSelectors): Promise<string[]> {
  const { selectors, texts } = sel
  const rule = {
    allowlist: sel.noticeAllowlist.map((t) => t.toLowerCase()),
    danger: [{ name: 'breakout', source: texts.breakoutPrompt }, ...sel.noticeDanger],
    excluded: [selectors.chatPane, selectors.rosterPane].join(', '),
    container: selectors.noticeContainers
  }
  const clicked: string[] = []
  // Handles go stale when Teams redraws after a click, so every click starts from a fresh look at the page: the first
  // clickable button not already tried. A button that is still showing after its click is stepped over, so a notice that
  // will not close is clicked once, not forever.
  let stepOver = 0
  await navigationGuard('dismissNotices', 'teams').run(async () => {
    for (let pass = 0; pass < MAX_NOTICE_PASSES; pass++) {
      const buttons = await page.locator('button, [role="button"]').filter({ visible: true }).elementHandles()
      try {
        const targets: { button: ElementHandle<Node>; text: string }[] = []
        for (const button of buttons) {
          const verdict = await noticeVerdict(button, rule)
          if (verdict.kind === 'click') targets.push({ button, text: verdict.text })
          if (verdict.kind === 'skip' && pass === 0) logStep(`skip notice ${verdict.text}: ${verdict.reason}`)
        }
        const target = targets[stepOver]
        if (!target) return
        try {
          await target.button.click({ timeout: STEP_TIMEOUT_MS })
        } catch (error) {
          if (!(error instanceof Error && NOT_ATTACHED.test(error.message))) throw error
          logStep('notice closed before it was clicked')
          continue
        }
        clicked.push(target.text)
        logStep(`click notice ${target.text}`)
        const closed = await target.button.waitForElementState('hidden', { timeout: NOTICE_CLOSE_MS }).then(
          () => true,
          (error: unknown) => {
            if (error instanceof Error && error.name === 'TimeoutError') return false
            throw error
          }
        )
        if (!closed) stepOver += 1
      } finally {
        await Promise.all(buttons.map((button) => button.dispose()))
      }
    }
  })
  return clicked
}

// Turns incoming audio back on when Teams has it off: More, then the "turn on incoming audio" menu item. It never
// touches the device controls or any other menu item. Does nothing when the banner is not showing. Whether sound
// reaches the sink is checked afterwards, by 01a.
export async function connectTeamsOutputAudio(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors, texts } = sel
  const item = page
    .locator('[role="menu"]')
    .filter({ visible: true })
    .locator('[role="menuitem"], [role="menuitemradio"]')
    .filter({ hasText: new RegExp(texts.incomingAudioOn, 'i') })
    .first()
  // Re-checks the page each time, so a navigation under it never clicks More twice and closes the menu it opened.
  const turnedOn = await settled(navigationGuard('incomingAudio', 'teams'), async () => {
    if (!(await shown(page, selectors.incomingAudioOff).isVisible())) return false
    if (!(await item.isVisible())) {
      await shown(page, selectors.moreButton).click({ timeout: STEP_TIMEOUT_MS })
      logStep('click moreButton')
    }
    await item.click({ timeout: STEP_TIMEOUT_MS })
    logStep('click incomingAudioOn')
    return true
  })
  if (turnedOn)
    await page.locator(selectors.incomingAudioOff).first().waitFor({ state: 'hidden', timeout: AUDIO_TIMEOUT_MS })
}

// Clicks Leave. An organiser's Leave opens a menu: its "Leave" item is clicked and "End meeting" never. Then waits for
// the end screen. When any of that fails (no Leave button, no end screen in time), the page is closed instead, which
// drops the call. Only the error's name is logged, never its message, which can quote the page.
export async function leaveTeams(page: Page, sel: TeamsSelectors): Promise<void> {
  try {
    await clickLeave(page, sel)
  } catch (error) {
    logStep(`leave failed (${error instanceof Error ? error.name : 'unknown'}), closing the page`)
    await page.close()
  }
}

async function clickLeave(page: Page, sel: TeamsSelectors): Promise<void> {
  const { selectors, texts } = sel
  await shown(page, selectors.hangupButton).click({ timeout: STEP_TIMEOUT_MS })
  logStep('click hangupButton')
  const menu = page.locator('[role="menu"]').filter({ visible: true }).first()
  const opened = await menu.waitFor({ state: 'visible', timeout: MENU_TIMEOUT_MS }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') return false
      throw error
    }
  )
  if (opened) {
    await menu
      .locator('[role="menuitem"], button')
      .filter({ hasText: new RegExp(texts.hangupLeave, 'i') })
      .first()
      .click({ timeout: STEP_TIMEOUT_MS })
    logStep('click hangupLeave')
  }
  const until = Date.now() + LEAVE_TIMEOUT_MS
  await settled(navigationGuard('leave', 'teams'), async () => {
    await page
      .locator(selectors.endScreen)
      .first()
      .waitFor({ state: 'visible', timeout: Math.max(1, until - Date.now()) })
    return true
  })
}
