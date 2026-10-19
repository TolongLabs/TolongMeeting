/*
 * zoom-chat-capture.js: capture the Zoom web client's in-meeting chat as structured messages.
 *
 * Purpose: installs four things on window. Re-running the file is safe: the parser and the
 *   scroll timer start only if they are missing, and the two functions are redefined.
 *   - window.__sdcMsgs = { list, keys, pulled }. A MutationObserver plus a 3 s timer parse every
 *     rendered .chat-item-container into { seen, time, sender, to, text } and append new ones
 *     to list. Grouped follow-up messages have no sender or time of their own and inherit the
 *     previous item's. Messages are deduplicated by element id when there is one, otherwise
 *     by "sender|time|text".
 *   - window.__sdcScroll: the id of a 1.5 s timer that keeps the chat list scrolled to the
 *     bottom. Zoom's chat list is virtualised, so while the panel is scrolled up new messages
 *     are never rendered and the parser never sees them.
 *   - window.__sdcPull(max = 900): returns { pending, out }. out holds one TSV line per
 *     message not yet pulled (index, seen, time, sender, to, text), up to max characters, and
 *     __sdcMsgs.pulled moves past the lines returned. Newlines in a message become " / ", and
 *     every URL becomes <host/path>, dropping query strings and fragments so passcodes and
 *     tokens stay out of the output. A single line longer than max is cut and ends in " [CUT]".
 *   - window.__sdcSweep(): async. Stops the scroll timer, scrolls the list from top to bottom
 *     in steps of max(200 px, half the visible height) with 300 ms pauses so that every item
 *     renders once and gets parsed, scrolls back to the bottom and restarts the timer.
 *     Returns { swept, before, after } message counts.
 * Runs in: the Zoom meeting tab (app.zoom.us/wc/...), on the document sdcRoot() returns (top
 *   document or iframe#webclient). If the chat list is not rendered, the install first clicks
 *   the button labelled "open the chat panel". Chrome on Windows, through javascript_tool.
 * Call:
 *   1. Run zoom-root.js, then pass this whole file as `text` to javascript_tool. It returns
 *      { installed, total, pulled, pending, scrollerFound }.
 *   2. Read new messages a page at a time with  window.__sdcPull(900)  until pending is 0, and
 *      save each page durably before pulling the next.
 *   3. Now and then, and always before the meeting ends (the chat goes with it):
 *        await window.__sdcSweep(); window.__sdcPull(900)
 *   Recovery: if a page was lost, rewind with  window.__sdcMsgs.pulled = N  (N = the first
 *   index not saved) and pull again. Re-read without moving the cursor with
 *   window.__sdcMsgs.list.slice(A, B).map(x => JSON.stringify(x)).join('\n'), and read the rest
 *   of a [CUT] line with  window.__sdcMsgs.list[I].text.slice(900, 1800).
 * Returns: see Call.
 * Limits:
 *   - javascript_tool cuts each returned string at 1000 characters (suffix [TRUNCATED]) and
 *     blocks strings that look like cookies, query strings or tokens, so keep max below 1000
 *     and never return raw HTML or full URLs.
 *   - __sdcPull moves the cursor when it returns, not when the caller has saved the lines, so a
 *     truncated or failed tool result loses those lines until you rewind.
 *   - The class names (chat-container__chat-list, chat-item-container, chat-item__sender,
 *     chat-item__receiver, new-chat-item__chat-info-time-stamp, new-chat-message__text-box,
 *     new-chat-message__content, chat-item__chat-msg-container) and the aria-label are
 *     undocumented Zoom internals found by dumping the list's class names. They may change in
 *     any web-client release.
 *   - Zoom's time field has minute resolution. seen is the browser's local time when the parser
 *     first saw the item, so messages recovered by a sweep carry the sweep's time.
 *   - Without stable ids a message can be captured twice, for example when it re-renders with a
 *     different inherited sender. Deduplicate when writing up (the session kept 99 unique lines
 *     of 104 saved).
 *   - A sweep visibly scrolls the chat panel for a few seconds, which shows in a recording.
 *   - A path can still identify something, for example the meeting ID in a Zoom /j/ link.
 *   - All state lives in the page and is lost on reload or navigation.
 * First used (MYT, UTC+8, 19 Oct 2026): parser 20:05:40, replacing a 19:51:30 observer that
 *   stored innerText snapshots of the whole list; scroll timer 21:05:37; pull and sweep
 *   21:06:58; sweep and pull before teardown 21:19:12.
 */

// Fix: the helpers live inside a function. javascript_tool evaluates with REPL semantics, which
// makes top-level const bindings global, so a later snippet reusing a name could replace a
// helper that the timers still call.
await (async () => {
  if (!window.sdcRoot) throw new Error('Run zoom-root.js first');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const chatList = () => sdcRoot().querySelector('.chat-container__chat-list');
  // Fix: computed style comes from the element's own window, so this also works in the iframe.
  const scrollable = e => /(auto|scroll)/.test(e.ownerDocument.defaultView.getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight;
  const chatScroller = () => { const l = chatList(); return l && [l, ...l.querySelectorAll('*')].find(scrollable); };
  const pinToBottom = () => { const s = chatScroller(); if (s) s.scrollTop = s.scrollHeight; };

  if (!chatList()) {
    const openChat = [...sdcRoot().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'open the chat panel');
    if (openChat) { openChat.click(); await sleep(1200); }
  }

  let installed = false;
  if (!window.__sdcMsgs) {
    window.__sdcMsgs = { list: [], keys: new Set(), pulled: 0 };
    const parse = () => {
      const m = window.__sdcMsgs, l = chatList(); if (!l) return;
      let lastSender = '', lastTime = '';
      for (const it of l.querySelectorAll('.chat-item-container')) {
        const q = s => { const e = it.querySelector(s); return e ? e.innerText.trim() : ''; };
        const sender = q('.chat-item__sender') || lastSender, to = q('.chat-item__receiver'), time = q('.new-chat-item__chat-info-time-stamp') || lastTime;
        const text = q('.new-chat-message__text-box') || q('.new-chat-message__content') || q('.chat-item__chat-msg-container');
        lastSender = sender; lastTime = time;
        // Fix: an id-bearing ancestor counts only if it is inside the list. One outside the list
        // would be shared by every message and collapse them all into one key.
        const anc = it.closest('[id]');
        const id = it.id || it.getAttribute('data-id') || (anc && anc !== l && l.contains(anc) ? anc.id : '');
        const key = id ? 'id:' + id : sender + '|' + time + '|' + text;
        if (text && !m.keys.has(key)) { m.keys.add(key); m.list.push({ seen: new Date().toLocaleTimeString('en-GB'), time, sender, to, text }); }
      }
    };
    window.__sdcMsgsObs = new MutationObserver(parse);
    window.__sdcMsgsObs.observe(sdcRoot().body, { childList: true, subtree: true, characterData: true });
    window.__sdcMsgsTimer = setInterval(parse, 3000);
    parse();
    installed = true;
  }

  if (!window.__sdcScroll) window.__sdcScroll = setInterval(pinToBottom, 1500);
  pinToBottom();

  // Fix: default page size 900 instead of 1300, so a full page (plus " [CUT]") stays under the
  // tool's 1000-character limit. The session called it with 700 to 1400.
  window.__sdcPull = (max = 900) => {
    const clean = s => s.replace(/https?:\/\/\S+/g, u => { try { const x = new URL(u); return '<' + x.host + x.pathname.replace(/\/$/, '') + '>'; } catch (e) { return '<link>'; } });
    const m = window.__sdcMsgs; let out = '', i = m.pulled;
    while (i < m.list.length) {
      const x = m.list[i];
      const line = [i, x.seen, x.time, x.sender, x.to || '', clean(x.text).replace(/\n+/g, ' / ')].join('\t') + '\n';
      if (out && out.length + line.length > max) break;
      out += line.length > max ? line.slice(0, max) + ' [CUT]\n' : line;
      i++;
    }
    m.pulled = i;
    return { pending: m.list.length - i, out };
  };

  window.__sdcSweep = async () => {
    const m = window.__sdcMsgs, sc = chatScroller(), before = m.list.length;
    if (!sc) return { swept: false, before, after: before };
    clearInterval(window.__sdcScroll); window.__sdcScroll = null;
    try {
      for (let y = 0; y <= sc.scrollHeight; y += Math.max(200, sc.clientHeight / 2)) { sc.scrollTop = y; await sleep(300); }
      sc.scrollTop = sc.scrollHeight;
    } finally {
      // Fix: the keep-at-bottom timer is restarted even if the loop throws.
      window.__sdcScroll = setInterval(pinToBottom, 1500);
    }
    return { swept: true, before, after: m.list.length };
  };

  // Fix: the install reports counts and no longer moves the cursor. In the session the install
  // and the early check-ins returned new messages and marked them read at once, which lost lines
  // at 21:05 when the output was cut at 1000 characters.
  const m = window.__sdcMsgs;
  return { installed, total: m.list.length, pulled: m.pulled, pending: m.list.length - m.pulled, scrollerFound: !!chatScroller() };
})()
