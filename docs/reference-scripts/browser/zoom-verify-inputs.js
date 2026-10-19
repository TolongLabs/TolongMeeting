/*
 * zoom-verify-inputs.js: read the values of text inputs in the page and its same-origin iframes.
 *
 * Purpose: confirm what was typed into a form from the DOM rather than from a screenshot. In the
 *   session a half-scale screenshot of the Zoom pre-join screen made a typed "T" look like a
 *   "1"; this read showed the display name was right before Join was clicked.
 * Runs in: any page; in the session, the Zoom web client's pre-join screen
 *   (app.zoom.us/wc/<meeting-id>/join). It reads the top document and every same-origin iframe
 *   one level down; cross-origin iframes are skipped. Chrome on Windows, through javascript_tool.
 * Call: pass this whole file as `text` to javascript_tool. It does not need zoom-root.js.
 * Returns: an array of JSON-quoted values, one per text input, so leading and trailing spaces
 *   are visible.
 * Limits:
 *   - Every text input is returned, including ones hidden with CSS (in the session one held the
 *     web client's build URL), so do not run it on pages with sensitive fields.
 *   - Only type="text" inputs are read; email, search, password and other types are skipped.
 *     The !i.type test never matches, because input.type reports "text" when the attribute is
 *     missing. Nested iframes are not searched.
 *   - javascript_tool cuts each returned string at 1000 characters and blocks values that look
 *     like cookies, query strings or tokens.
 * First used (MYT, UTC+8, 19 Oct 2026): 19:48:45.
 */

const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument; } catch (e) { return null; } }).filter(Boolean)];
docs.flatMap(d => [...d.querySelectorAll('input')].filter(i => i.type === 'text' || !i.type).map(i => JSON.stringify(i.value)))
