/*
 * zoom-root.js: find the Zoom web client's document and install it as window.sdcRoot().
 *
 * Purpose: the web client's DOM is not always in the same place. When a meeting is reached
 *   through the /j/ launcher page and "Join from browser", the client renders inside a
 *   same-origin <iframe id="webclient"> (class pwa-webclient__iframe). When the tab opens the
 *   web-client join URL directly, it renders in the top document. sdcRoot() returns whichever
 *   applies and re-resolves on every call, so it follows a reloaded iframe.
 * Runs in: the Zoom meeting tab (app.zoom.us/wc/...), top document; it reaches into the iframe
 *   itself. Chrome on Windows, through the claude-in-chrome extension's javascript_tool.
 * Call: pass this whole file as `text` to javascript_tool (action "javascript_exec", the meeting
 *   tab's tabId), once per page load. zoom-chat-capture.js, zoom-checkin.js and zoom-leave.js
 *   call window.sdcRoot() and throw "Run zoom-root.js first" if it is missing. Run it again
 *   after any reload or navigation, because page state on window is lost.
 * Returns: { inIframe, buttons, chatList }: whether the client is in the iframe, how many
 *   buttons the root holds (rehearsal: 25 in the iframe, 2 in the top document), and whether
 *   the chat list is rendered.
 * Limits: javascript_tool returns at most 1000 characters per string and redacts values that
 *   look like cookies, query strings or tokens. The iframe id and the class names are
 *   undocumented Zoom internals and may change. While the iframe is still loading, its
 *   contentDocument can be an empty about:blank document.
 * First used (MYT, UTC+8, 19 Oct 2026): 18:19:06 in an iframe-only form, in a rehearsal on
 *   Zoom's test meeting; 19:49:20 in the iframe-or-top form below, after the iframe-only form
 *   threw "Cannot read properties of null (reading 'contentDocument')" in the live meeting.
 */

window.sdcRoot = function sdcRoot() {
  const f = document.getElementById('webclient');
  return (f && f.contentDocument) || document;
};

const root = sdcRoot();
({ inIframe: root !== document, buttons: root.querySelectorAll('button').length, chatList: !!root.querySelector('.chat-container__chat-list') })
