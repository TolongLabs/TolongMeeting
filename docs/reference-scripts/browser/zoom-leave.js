/*
 * zoom-leave.js: leave a Zoom web-client meeting.
 *
 * ONLY RUN THIS WHEN THE USER HAS APPROVED LEAVING THIS MEETING.
 *
 * Purpose: clicks the toolbar button with aria-label "Leave", waits up to 3 s for the
 *   confirmation, then clicks the button whose text matches /leave meeting/i.
 * Runs in: the Zoom meeting tab (app.zoom.us/wc/...), on the document sdcRoot() returns. Chrome
 *   on Windows, through javascript_tool.
 * Call: only after the user has approved leaving: set USER_APPROVED_LEAVE to true in the text
 *   you send, then pass it as `text` to javascript_tool after zoom-root.js. Before leaving, run
 *   await window.__sdcSweep() and drain window.__sdcPull(900) to pending 0, because the chat
 *   and all window.__sdc* state are gone once the page changes.
 * Returns: { leaveClicked, confirmClicked }.
 * Limits:
 *   - The session's exact code was not recorded. This file follows the recorded steps (Leave by
 *     aria-label, then the /leave meeting/i button); the 3 s wait for the confirmation is an
 *     assumption.
 *   - It was only used as a guest. The labels are undocumented, English-only Zoom UI strings
 *     and may change.
 *   - javascript_tool cuts each returned string at 1000 characters.
 * First used (MYT, UTC+8, 19 Oct 2026): 18:21:42, leaving Zoom's test meeting during a rehearsal
 *   (client in iframe#webclient), and again at 18:26:06 after a second rehearsal. It was not
 *   used in the live meeting, which the host ended.
 */

// Added (not in the session): an approval switch, so this file cannot leave a meeting by accident.
const USER_APPROVED_LEAVE = false
if (!USER_APPROVED_LEAVE) throw new Error('zoom-leave.js: the user has not approved leaving this meeting')
if (!window.sdcRoot) throw new Error('Run zoom-root.js first')
const d = sdcRoot()
const leaveBtn = [...d.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Leave')
let confirmBtn = null
if (leaveBtn) {
  leaveBtn.click()
  for (let i = 0; i < 10 && !confirmBtn; i++) {
    await new Promise((r) => setTimeout(r, 300))
    confirmBtn = [...d.querySelectorAll('button')].find((b) => /leave meeting/i.test(b.textContent))
  }
  if (confirmBtn) confirmBtn.click()
}
;({ leaveClicked: !!leaveBtn, confirmClicked: !!confirmBtn })
