/*
 * links-host-path.js: list a page's links as "text -> host/path", without query strings.
 *
 * Purpose: see where a page links to (in the session, the documents an event portal pointed
 *   to) without returning query strings or fragments, which can carry tokens, passcodes or
 *   tracking IDs and which the extension blocks anyway.
 * Runs in: any page; in the session, the hackathon's participant portal, top document. Links
 *   are taken from <main>, or from the whole page if there is no <main>. Chrome on Windows,
 *   through javascript_tool.
 * Call: pass this whole file as `text` to javascript_tool.
 * Returns: an array of strings "<link text, at most 50 characters> -> <host><path>".
 * Limits:
 *   - Paths can still carry IDs, for example Google Drive file and folder IDs, which act as
 *     access keys for link-shared files.
 *   - javascript_tool cuts returned strings at 1000 characters; on a page with many links,
 *     add .slice(A, B) to the expression and read the list in parts.
 *   - Links added after the call, or inside iframes or shadow roots, are not listed.
 * First used (MYT, UTC+8, 19 Oct 2026): 22:02:28, on the portal after the problem statements
 *   were published.
 */

// Fix: falls back to the whole page when there is no <main>.
const scope = document.querySelector('main') || document
const hostPath = (s) =>
  s.replace(/https?:\/\/\S+/g, (u) => {
    try {
      const x = new URL(u)
      return '<' + x.host + x.pathname.replace(/\/$/, '') + '>'
    } catch (e) {
      return '<link>'
    }
  })
;[...scope.querySelectorAll('a[href]')]
  .map((a) => {
    let u
    try {
      u = new URL(a.href)
    } catch (e) {
      return null
    }
    // Fix: only http and https links. A mailto: link would have returned an email address as its path.
    if (!/^https?:$/.test(u.protocol)) return null
    // Fix: URLs in the link text are reduced too, so a link whose text is its own full URL does not
    // return the query string that way.
    return hostPath(a.textContent.trim()).slice(0, 50) + ' -> ' + u.host + u.pathname
  })
  .filter(Boolean)
