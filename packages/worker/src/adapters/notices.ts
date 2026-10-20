import type { ElementHandle, Page } from 'playwright'
import { isTimeout, STEP_TIMEOUT_MS } from './common'
import { navigationGuard } from './zoom/root'

// How long a clicked notice button gets to go away, and the most clicks one call makes.
const NOTICE_CLOSE_MS = 1_000
const MAX_NOTICE_PASSES = 20

// The race a notice button can lose: it closed between the query and the click. Handled where it is a race, not a fault.
const NOT_ATTACHED = /Element is not attached to the DOM/

export interface NoticeRule {
  // Where a notice shows: a button outside one is never clicked.
  container: string
  // Regions that are never searched (chat, people, the side panel).
  excluded: string
  // Exact button texts that may be clicked (compared case-insensitively against the text and the aria-label).
  allowlist: string[]
  // A notice whose text matches one of these asks for something: its button is left alone. `source` is a regular
  // expression source, matched case-insensitively.
  danger: { name: string; source: string }[]
}

// What the page says about one allowlisted button: one to click, or one to leave alone and why.
type Verdict = { kind: 'click'; text: string } | { kind: 'skip'; text: string; reason: string }

// Serialised by Playwright and evaluated in the page: self-contained, and not to be bundled with `--minify` or
// `--keep-names`. One pass over the page keeps the visible buttons whose text or label is on the allowlist (all the
// others are dropped here) and decides for each, in page order. Returns the verdicts and the buttons they are about.
function inspectNotices(r: NoticeRule): { verdicts: Verdict[]; buttons: HTMLElement[] } {
  const allowed = new Set(r.allowlist.map((text) => text.toLowerCase()))
  const danger = r.danger.map((d) => ({ name: d.name, pattern: new RegExp(d.source, 'i') }))
  const verdicts: Verdict[] = []
  const buttons: HTMLElement[] = []
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (!el.checkVisibility({ visibilityProperty: true })) continue
    const box = el.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) continue
    const name = [el.innerText.trim(), el.getAttribute('aria-label')?.trim() ?? ''].find((t) =>
      allowed.has(t.toLowerCase())
    )
    if (name === undefined) continue
    if (el.closest(r.excluded)) continue
    // The outermost container, so the danger check reads the whole dialog even when containers are nested.
    let container = el.closest<HTMLElement>(r.container)
    for (let outer = container?.parentElement?.closest<HTMLElement>(r.container); outer;) {
      container = outer
      outer = outer.parentElement?.closest<HTMLElement>(r.container) ?? null
    }
    let verdict: Verdict = { kind: 'click', text: name }
    if (!container) verdict = { kind: 'skip', text: name, reason: 'no dialog around it' }
    else {
      const hit = danger.find((d) => d.pattern.test(container.innerText))
      if (hit) verdict = { kind: 'skip', text: name, reason: `dialog mentions ${hit.name}` }
    }
    verdicts.push(verdict)
    buttons.push(el)
  }
  return { verdicts, buttons }
}

// Clicks the visible allowlist buttons (Got it, OK, Dismiss) and returns their texts, in page order. It fails closed: a
// button is clicked only inside a recognised notice container, never in an excluded region, and never when the notice's
// text matches a danger pattern (join, start video, allow, unmute, share, record consent, the breakout prompt). Such a
// prompt is the supervisor's to report, not to answer. Only allowlisted button texts and the name of the matched
// pattern are logged, never the notice's text.
export async function dismissNotices(page: Page, platform: string, rule: NoticeRule): Promise<string[]> {
  const clicked: string[] = []
  // Handles go stale when the client redraws after a click, so every click starts from a fresh look at the page: the
  // first clickable button not already tried. A button that is still showing after its click is stepped over, so a
  // notice that will not close is clicked once, not forever.
  let stepOver = 0
  await navigationGuard('dismissNotices', platform).run(async () => {
    for (let pass = 0; pass < MAX_NOTICE_PASSES; pass++) {
      const found = await page.evaluateHandle(inspectNotices, rule)
      const list = await found.getProperty('buttons')
      const props = await list.getProperties()
      const handles = [...props.values()].flatMap((handle) => handle.asElement() ?? [])
      try {
        const verdicts = await found.evaluate((f) => f.verdicts)
        if (verdicts.length !== handles.length) throw new Error(`${platform}: notice buttons changed while being read`)
        const targets: { button: ElementHandle<Node>; text: string }[] = []
        verdicts.forEach((verdict, i) => {
          if (verdict.kind === 'click') targets.push({ button: handles[i]!, text: verdict.text })
          else if (pass === 0) console.info(`${platform}: skip notice ${verdict.text}: ${verdict.reason}`)
        })
        const target = targets[stepOver]
        if (!target) return
        try {
          await target.button.click({ timeout: STEP_TIMEOUT_MS })
        } catch (error) {
          if (!(error instanceof Error && NOT_ATTACHED.test(error.message))) throw error
          console.info(`${platform}: notice closed before it was clicked`)
          continue
        }
        clicked.push(target.text)
        console.info(`${platform}: click notice ${target.text}`)
        const closed = await target.button.waitForElementState('hidden', { timeout: NOTICE_CLOSE_MS }).then(
          () => true,
          (error: unknown) => {
            if (isTimeout(error)) return false
            throw error
          }
        )
        if (!closed) stepOver += 1
      } finally {
        await Promise.all(handles.map((button) => button.dispose()))
        await list.dispose()
        await found.dispose()
      }
    }
  })
  return clicked
}
