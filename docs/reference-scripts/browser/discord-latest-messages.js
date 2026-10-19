/*
 * discord-latest-messages.js: summarise the last N messages of an open Discord channel.
 *
 * Purpose: watch a channel for a posted meeting link without a bot or the Discord API, by
 *   reading the Discord web page the user is already logged in to. For each of the last N
 *   rendered messages it returns the timestamp, the first 160 characters of text, how many
 *   zoom.us links the message holds and the meeting IDs parsed from them. Full link URLs, which
 *   carry the passcode in ?pwd=, are never returned.
 * Runs in: a Discord web tab on the channel (discord.com/channels/<server>/<channel>), top
 *   document, scrolled to the newest message. Chrome on Windows, through javascript_tool.
 * Call: set N, then pass this whole file as `text` to javascript_tool. The session used N = 4
 *   to poll for the link and N = 1 as the last-message probe at each meeting check-in.
 * Returns: an array of { time, text, zoomLinks, meetingIds }, oldest first. time is the
 *   datetime attribute of the message's <time> element (ISO 8601, UTC), or null if it has none.
 * Limits:
 *   - The selectors (li[id^="chat-messages-"], [id^="message-content-"], time[datetime]) are
 *     undocumented Discord markup and may change.
 *   - Discord renders only the messages in view, so if the channel is scrolled up, the "last N"
 *     are not the newest.
 *   - Meeting IDs are 9 to 11 digits after /j/, /w/, /wc/join/ or /wc/; other link shapes (for
 *     example personal vanity links) give no ID. The IDs appear in the tool output, the
 *     passcode does not.
 *   - Joining needs the full link. In the session it came from the extension's find tool, whose
 *     output was not redacted and so exposed the passcode in the transcript.
 *   - javascript_tool cuts each returned string at 1000 characters and blocks strings that look
 *     like cookies, query strings or tokens.
 * First used (MYT, UTC+8, 19 Oct 2026): 18:28:05 as a manual check; every 5 minutes from 18:34
 *   by a scheduled prompt, which found the link at 19:34:09; with N = 1 at each meeting check-in
 *   from 20:05.
 */

const N = 4;
const hostPath = s => s.replace(/https?:\/\/\S+/g, u => { try { const x = new URL(u); return '<' + x.host + x.pathname.replace(/\/$/, '') + '>'; } catch (e) { return '<link>'; } });
[...document.querySelectorAll('li[id^="chat-messages-"]')].slice(-N).map(li => {
  const c = li.querySelector('[id^="message-content-"]'), t = li.querySelector('time');
  const links = [...li.querySelectorAll('a[href]')].map(a => a.href).filter(h => /zoom\.us/i.test(h));
  return {
    time: t && t.getAttribute('datetime'),
    // Fix: URLs in the text become <host/path>, as in the session's follow-up read of the post.
    // The polling version returned the raw text, which could include a link with its passcode.
    text: hostPath(c ? c.innerText : '').slice(0, 160),
    zoomLinks: links.length,
    meetingIds: links.map(h => (h.match(/\/(?:j|w|wc\/join|wc)\/(\d{9,11})/) || [])[1]).filter(Boolean)
  };
})
