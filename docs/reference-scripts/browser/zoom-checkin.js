/*
 * zoom-checkin.js: periodic health probe for a Zoom web-client meeting tab.
 *
 * Purpose: one call an agent runs on a schedule (every 10 minutes in the session) to keep the
 *   meeting tab usable and report its state. It:
 *   - clicks visible buttons whose whole text is "OK" or "Got it" (case-insensitive). These
 *     dismiss Zoom's notices, including the acknowledgement that the meeting is being recorded
 *     or transcribed. The user had agreed in advance to acknowledging those notices. Nothing
 *     else is clicked: never mute, unmute, start video or Leave;
 *   - re-adds the overlay-hiding style from zoom-hide-agent-overlays.js if it is missing (in the
 *     top document, where the extension's overlays live);
 *   - reports the tab title and the participants button text (the count, for example
 *     "105Participants");
 *   - reports the aria-labels of the audio and video buttons as a safety check that the
 *     microphone and camera are not live. In the session they read "audio" and "Video", with
 *     browser permission for both blocked. A label starting with "mute" or "stop video" would
 *     suggest the microphone or camera is live: tell the user, do not click it;
 *   - pulls up to 700 characters of new chat lines if zoom-chat-capture.js is installed;
 *   - returns the first 120 characters of the page text as a hint of the meeting's state.
 * Runs in: the Zoom meeting tab (app.zoom.us/wc/...), on the document sdcRoot() returns. Chrome
 *   on Windows, through javascript_tool.
 * Call: run zoom-root.js once (and zoom-chat-capture.js for the pull), then pass this whole
 *   file as `text` to javascript_tool at each check-in. Save pull.out durably; while
 *   pull.pending is above 0, call window.__sdcPull(700) again.
 * Returns: { title, participants, audio, video, notices, scroll, pull, bodyHint }. notices lists
 *   the texts of the buttons clicked; scroll says whether the keep-at-bottom timer is running;
 *   pull is __sdcPull's { pending, out }, or 'no pull fn'.
 * Limits:
 *   - Any visible OK button is clicked without reading its dialog. Review the allowlist before
 *     reusing this in a meeting whose notices the user has not agreed to.
 *   - Zoom kept the tab title after the host ended the meeting, and the toolbar and a stale
 *     participant count stayed in the DOM, so title and count do not show the end. In the
 *     session, bodyHint plus a screenshot did, about nine minutes late.
 *   - bodyHint can include the meeting title and display names.
 *   - javascript_tool cuts each returned string at 1000 characters and blocks strings that look
 *     like cookies, query strings or tokens.
 *   - The aria-labels are undocumented, English-only Zoom UI strings and may change.
 * First used (MYT, UTC+8, 19 Oct 2026): 20:05:27 (notices, style re-add, and a dump of chat item
 *   class names whose raw-HTML sample the extension blocked); 20:35:22 (returned new chat as
 *   JSONL); 21:15:20 (pull through __sdcPull); 21:25:20 (bodyHint; this run showed that the
 *   meeting had ended).
 */

// Fix: queries go through sdcRoot() instead of document, so the probe also works when the client
// is in iframe#webclient. The live meeting used the top document, where the two are the same.
if (!window.sdcRoot) throw new Error('Run zoom-root.js first');
const d = sdcRoot();
const btns = [...d.querySelectorAll('button')];
const label = b => b.getAttribute('aria-label') || '';
const notices = btns.filter(b => /^(OK|Got it)$/i.test(b.textContent.trim()) && b.offsetParent);
notices.forEach(b => b.click());
if (!document.getElementById('sdc-hide-overlays')) { const s = document.createElement('style'); s.id = 'sdc-hide-overlays'; s.textContent = '#claude-agent-glow-border, #claude-static-indicator-container { display: none !important; }'; document.head.appendChild(s); }
({
  title: document.title,
  participants: (btns.find(b => /participants list/i.test(label(b))) || {}).textContent,
  audio: btns.filter(b => /^(audio|mute|unmute)/i.test(label(b))).map(label),
  video: btns.filter(b => /^(video|start video|stop video)/i.test(label(b))).map(label),
  notices: notices.map(b => b.textContent.trim()),
  scroll: !!window.__sdcScroll,
  pull: window.__sdcPull ? window.__sdcPull(700) : 'no pull fn',
  bodyHint: d.body.innerText.slice(0, 120)
})
