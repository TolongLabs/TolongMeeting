/*
 * zoom-hide-agent-overlays.js: hide the browser extension's own overlays on the page.
 *
 * Purpose: the claude-in-chrome extension draws a glow border around the tab and a "Claude is
 *   active in this tab group" pill, as fixed-position elements with z-index 2147483646 and
 *   2147483647. OBS captured the meeting window, so both showed up in the recording. This
 *   injects <style id="sdc-hide-overlays"> that sets display: none !important on them. It is
 *   idempotent: the style is only added once. Do not click the pill's close button instead;
 *   that could end the extension's control of the tab.
 * Runs in: any tab the extension controls; in the session, the Zoom meeting tab
 *   (app.zoom.us/wc/...). Top document only, on purpose: the extension injects its overlays
 *   there, not into the web client's iframe. Chrome on Windows, through javascript_tool.
 * Call: pass this whole file as `text` to javascript_tool, once. zoom-checkin.js re-adds the
 *   same style at every check-in in case the page dropped it.
 * Returns: { added, hidden }: whether the style was added on this call, and "id: display" for
 *   each overlay element found ("none" means hidden; an empty list means none were found).
 * Limits: the element ids are the extension's internals and may change. To find the current
 *   ones, list the direct children of <body> that have a shadow root or mention claude, mcp or
 *   agent (the session also found a BROWSER-MCP-CONTAINER host and left it alone):
 *     [...document.querySelectorAll('body > *')].filter(e => e.shadowRoot || /claude|mcp|agent/i.test(e.tagName + ' ' + e.id + ' ' + String(e.className))).map(e => e.tagName + '#' + e.id)
 *   javascript_tool returns at most 1000 characters per string.
 * First used (MYT, UTC+8, 19 Oct 2026): 19:50:39, after an OBS test screenshot at 19:50:09
 *   showed the overlays in the recording.
 */

const SDC_OVERLAYS = '#claude-agent-glow-border, #claude-static-indicator-container'
let added = false
if (!document.getElementById('sdc-hide-overlays')) {
  const s = document.createElement('style')
  s.id = 'sdc-hide-overlays'
  s.textContent = SDC_OVERLAYS + ' { display: none !important; }'
  document.head.appendChild(s)
  added = true
}
;({ added, hidden: [...document.querySelectorAll(SDC_OVERLAYS)].map((e) => e.id + ': ' + getComputedStyle(e).display) })
