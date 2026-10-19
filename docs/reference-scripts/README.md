# Reference scripts

These are the helper scripts an AI agent (Claude Code on Windows 11 with WSL2) wrote while it attended a Zoom briefing as a guest in the Zoom web client, recorded it with OBS Studio, transcribed it and collected the meeting's shared Google Drive files. They are kept as a reference for building a general-purpose meeting-automation app. Each one worked once, on one machine, for one meeting, and none of them is production code.

Contents:

1.  [Layout](#layout)
    1.  [Order of use in the session](#order-of-use-in-the-session)
1.  [Changes from the session copies](#changes-from-the-session-copies)
1.  [Dependencies](#dependencies)
1.  [Desktop scripts](#desktop-scripts)
    1.  [wins.py](#winspy)
    1.  [desk.py](#deskpy)
    1.  [place.py](#placepy)
    1.  [zui.py](#zuipy)
    1.  [chrome_tab.py](#chrome_tabpy)
    1.  [kill_zoom_join.py](#kill_zoom_joinpy)
1.  [Browser scripts](#browser-scripts)
    1.  [zoom-root.js](#zoom-rootjs)
    1.  [zoom-hide-agent-overlays.js](#zoom-hide-agent-overlaysjs)
    1.  [zoom-chat-capture.js](#zoom-chat-capturejs)
    1.  [zoom-checkin.js](#zoom-checkinjs)
    1.  [zoom-verify-inputs.js](#zoom-verify-inputsjs)
    1.  [zoom-leave.js](#zoom-leavejs)
    1.  [discord-latest-messages.js](#discord-latest-messagesjs)
    1.  [links-host-path.js](#links-host-pathjs)
1.  [Capture scripts](#capture-scripts)
    1.  [obs_setup.py](#obs_setuppy)
    1.  [watch.py](#watchpy)
    1.  [keeper.py](#keeperpy)
    1.  [crop.py](#croppy)
    1.  [sheet.py](#sheetpy)
    1.  [grid.py](#gridpy)
1.  [Transcription scripts](#transcription-scripts)
    1.  [run.sh](#runsh)
    1.  [clips.sh](#clipssh)
    1.  [segs.py](#segspy)
    1.  [xcheck.py](#xcheckpy)
    1.  [check_ts.py](#check_tspy)
1.  [Write-up scripts](#write-up-scripts)
    1.  [build_slides.py](#build_slidespy)
1.  [Source scripts](#source-scripts)
    1.  [drive_ls.py](#drive_lspy)
    1.  [drive_get.py](#drive_getpy)
    1.  [pdf_dump.py](#pdf_dumppy)
    1.  [sorted_dump.py](#sorted_dumppy)
    1.  [mddiff.py](#mddiffpy)
    1.  [bagdiff.py](#bagdiffpy)
1.  [Not included](#not-included)

## Layout

```text
reference-scripts/
    desktop/         window enumeration, placement, UI Automation, Chrome tabs, input
        wins.py  desk.py  place.py  zui.py  chrome_tab.py  kill_zoom_join.py
    browser/         JavaScript run in the Zoom web client, Discord and portal tabs through the Chrome extension
        zoom-root.js  zoom-hide-agent-overlays.js  zoom-chat-capture.js  zoom-checkin.js
        zoom-verify-inputs.js  zoom-leave.js  discord-latest-messages.js  links-host-path.js
    capture/         OBS scene setup, slide watcher, window keeper, cropping, contact sheets
        obs_setup.py  watch.py  keeper.py  crop.py  sheet.py  grid.py
    transcription/   OpenAI cross-check runs, segment formatting, side-by-side builder, timestamp check
        run.sh  clips.sh  segs.py  xcheck.py  check_ts.py
    write-up/        slides document builder
        build_slides.py
    sources/         Drive listing and download, PDF dumps, Markdown-vs-PDF diffs
        drive_ls.py  drive_get.py  pdf_dump.py  sorted_dump.py  mddiff.py  bagdiff.py
```

The Python scripts in `desktop/` and `capture/` ran on Windows with Python 3.12. The shell scripts in `transcription/` and `xcheck.py` ran in WSL (Ubuntu), where the local Whisper project and the audio file lived. The `browser/` snippets ran in Chrome on Windows, in the Zoom web client, Discord and event portal tabs.

### Order of use in the session

1.  Before the meeting: `obs_setup.py` built the OBS scene, `kill_zoom_join.py` stood ready to close Zoom desktop client dialogs while the join link opened in Chrome, and `wins.py`, `place.py`, `zui.py`, `chrome_tab.py` and `desk.py` found, placed and inspected windows. `discord-latest-messages.js` polled the announcements channel for the join link, and `zoom-leave.js` left Zoom's test meeting after each rehearsal.
1.  During the meeting: `watch.py` saved slide keyframes and watched the recording, and `keeper.py` kept the meeting window from staying minimised. In the meeting tab, `zoom-verify-inputs.js` checked the display name before joining, `zoom-root.js`, `zoom-hide-agent-overlays.js` and `zoom-chat-capture.js` set up the page, and `zoom-checkin.js` ran every 10 minutes alongside `discord-latest-messages.js`.
1.  After the meeting: `sheet.py`, `grid.py` and `crop.py` turned frames into review sheets and slide images. `run.sh`, `xcheck.py`, `clips.sh` with `segs.py`, and `check_ts.py` produced and checked the transcript. `build_slides.py` assembled the slides document. `links-host-path.js` listed the links on the event portal once the problem statements were published.
1.  For the shared material: `drive_ls.py` and `drive_get.py` fetched the Drive folder, `pdf_dump.py` and `sorted_dump.py` extracted the PDFs, and `mddiff.py` and `bagdiff.py` checked the Markdown rewrites against them.

## Changes from the session copies

Of the 24 Python and shell files, five differ from what ran in the session. The other 19 are byte-for-byte copies.

- `capture/watch.py` and `capture/keeper.py`: one added `sys.path.insert` line each, so `wins.py` is found in `desktop/`. `chrome_tab.py` and `kill_zoom_join.py` import `wins.py` from their own folder, and `bagdiff.py` imports `mddiff.py` from its own folder, so those need no change.
- `transcription/run.sh`: the working directory, the meeting audio path and the API key source (in the session, another project's `.env`) are now the env vars `WORKDIR`, `SRC`, and `OPENAI_API_KEY` or `ENV_FILE`.
- `transcription/clips.sh`: the same env vars. Its vocabulary prompt held the names of the MCs, speakers and sponsor representatives, which are now `<MC_1>`, `<SPEAKER_1>`, `<SPONSOR_SPEAKER_1>` and similar placeholders. It now calls `segs.py` from its own directory. In the session, a copy of `segs.py` sat in the working directory.
- `transcription/xcheck.py`: the hard-coded paths to the Whisper JSON and the chunk directory (under the session user's home, named after the meeting date) are now CLI arguments.

The eight files in `browser/` were never files in the session. The agent typed the JavaScript straight into the extension's `javascript_tool` and revised it between calls, and the code here comes from the tool inputs recorded in the session transcript. Each file merges those versions into the last working one and keeps its behaviour. These are the changes, most of them marked `Fix:` or `Added:` in the code:

- The Zoom snippets query the document that `sdcRoot()` from `zoom-root.js` returns instead of `document`, so they also work when the client runs in `iframe#webclient`. The live meeting ran in the top document, where the two are the same.
- `zoom-chat-capture.js` merges the parser, the scroll timer, the pull and the sweep into one idempotent install, which also opens the chat panel as the session's join probe did. Its helpers sit inside a function, because the tool's REPL mode makes top-level `const` names global and a later snippet could replace them. The default page size is 900 characters instead of 1300, the install no longer marks messages as read, the sweep always restarts the scroll timer, computed styles come from each element's own window, and a message id is only taken from an ancestor inside the chat list.
- `discord-latest-messages.js` reduces URLs in the message text to host and path, as the session's follow-up read of the post did.
- `links-host-path.js` falls back to the whole page when there is no `<main>`, skips non-web links such as `mailto:` (which would have returned an email address), and reduces URLs in link text.
- `zoom-leave.js` is rebuilt from the session notes, which recorded the steps but not the code. It adds an approval switch that is off by default, and waits up to 3 s for the confirmation button.

No script contained a meeting ID, passcode, password, token or email address. `obs_setup.py` reads the obs-websocket password from OBS's own config at runtime. Some constants are specific to the meeting but not secret, so they were kept and are listed under each script's assumptions. They include the OBS collection name `sdc-hack`, the event and sponsor names in `run.sh` and `build_slides.py`, `END=5250` and the stop times.

All Python files pass `python -m py_compile` and both shell scripts pass `bash -n`. None of the scripts was run while packaging, and the JavaScript files were not syntax-checked.

## Dependencies

Python packages (Python 3.8 or later, because `drive_get.py` uses `:=`):

```shell
pip install obsws-python Pillow uiautomation pymupdf
```

- `obsws-python`: `obs_setup.py`, `watch.py`.
- `Pillow`: `desk.py`, `watch.py`, `crop.py`, `sheet.py`, `grid.py`.
- `uiautomation` (pulls in `comtypes`): `zui.py`, `chrome_tab.py`.
- `pymupdf` (PyMuPDF 1.24 or later, for the `pymupdf` import name): `pdf_dump.py`, `sorted_dump.py`, `bagdiff.py`.
- Standard library only: everything else.

System tools and services:

- Windows 10 or 11 for every script in `desktop/` and for `obs_setup.py`, `watch.py` and `keeper.py`, which use `ctypes.windll`, UI Automation and Windows-only OBS sources. `crop.py`, `sheet.py` and `grid.py` are plain Pillow and run anywhere.
- OBS Studio 30.2.2 with obs-websocket v5 (bundled since OBS 28) enabled on `localhost:4455` with authentication on.
- Google Chrome, plus the Zoom desktop client for `zui.py` and `kill_zoom_join.py`.
- The claude-in-chrome Chrome extension, whose `javascript_tool` ran the `browser/` snippets. The DevTools console runs them too, but without the 1000-character cap and redaction they were written around.
- WSL2 (Ubuntu) or any Linux or macOS shell with `bash`, `ffmpeg`, `curl` 7.76 or later (for `--fail-with-body`) and `python3`, for `run.sh` and `clips.sh`.
- An OpenAI API key with access to `gpt-4o-transcribe` and `whisper-1`.
- The Whisper medium-model JSON that `xcheck.py` and `check_ts.py` read came from a separate local Whisper project in WSL, which is not included here.

## Desktop scripts

### wins.py

Lists the visible top-level windows that belong to one executable, with handle, title, class, rectangle and minimised state.

```shell
python desktop/wins.py chrome.exe
python desktop/wins.py
```

- Session use: finding window handles to pass to `place.py` and `desk.py focus`. It is also imported as a library by `chrome_tab.py`, `kill_zoom_join.py`, `watch.py` and `keeper.py`.
- Inputs and outputs: an optional executable name, `Zoom.exe` by default and matched case-insensitively. It prints one dict per window, and `windows(exe)` returns the same dicts as a list.
- Dependencies: `ctypes` on Windows (`EnumWindows`, `QueryFullProcessImageNameW`).
- Assumptions: windows are matched on the process image's base name only. The script does not set DPI awareness itself, so when it runs alone on a scaled display the rectangles can be DPI-virtualised. The callers that need pixels (`desk.py`, `place.py`, `keeper.py`) set per-monitor awareness.
- Failure modes: if `OpenProcess` fails (for example on an elevated process), the window's executable name comes back empty and the window is silently skipped.
- To generalise: put a window-listing layer behind one interface: this code on Windows, `CGWindowListCopyWindowInfo` or Accessibility on macOS, and X11 tools on Linux (Wayland offers no general equivalent). Identify windows by a stable handle, not by title.

### desk.py

A minimal desktop driver that takes screenshots, clicks, sends key chords, focuses windows and types text, all in physical pixels.

```shell
python desktop/desk.py shot desk.png
python desktop/desk.py shot region.png -1920 0 1920 1080
python desktop/desk.py click 960 540 double
python desktop/desk.py key ctrl+v
python desktop/desk.py focus HWND
python desktop/desk.py type some text
```

- Session use: looking at the screen when a window or dialog needed checking, and as the fallback for clicks and keys when no UI Automation control or page script could do the job.
- Inputs and outputs: `shot` writes a PNG and prints its path and size. The other commands print nothing.
- Dependencies: `Pillow` (`ImageGrab`), Windows `user32` and `shcore` (`SetProcessDpiAwareness` needs Windows 8.1 or later).
- Assumptions: the process is per-monitor DPI aware (level 2). `shot` without a box grabs the primary monitor only, and boxes use virtual-desktop coordinates (negative for monitors left of or above the primary). Key names are limited to the `VK` table plus single characters.
- Failure modes: `keybd_event` and `mouse_event` inject into whatever window is in the foreground, so input lands in the wrong place if focus moves, and it takes over the user's mouse and keyboard. `focus` depends on an Alt-tap trick to get past the foreground lock. `type` maps characters through `VkKeyScanW`, so only characters on the current keyboard layout work, and AltGr characters are not handled. `key` raises on unknown multi-letter names such as `f5`.
- To generalise: prefer accessibility APIs or in-page scripting to synthetic input. Where raw input is unavoidable, use `SendInput` with `KEYEVENTF_UNICODE` or a cross-platform library, and use `mss` for screenshots.

### place.py

Moves and resizes a window without activating it, rewriting its `WINDOWPLACEMENT` first so a maximised or minimised window is restored to the given rectangle.

```shell
python desktop/place.py HWND 0 0 1600 900
```

- Session use: giving the meeting's Chrome window a fixed position and size, which the capture constants in `watch.py` and `crop.py` depend on, without taking focus from the user.
- Inputs and outputs: `HWND X Y W H`. It prints whether the foreground window is unchanged.
- Dependencies: `ctypes` on Windows.
- Assumptions: coordinates are physical pixels. The rectangle includes Windows 10 and 11's invisible resize borders, so the visible window is a few pixels smaller than `W x H`. The script does its work at import time (there is no `main` guard).
- Failure modes: moving a window to a monitor with a different DPI lets the application rescale itself, so the final size can differ from the request.
- To generalise: use a per-OS placement API (Accessibility `AXPosition` and `AXSize` on macOS; Wayland does not allow it). Better still, capture the meeting from a source that does not depend on window geometry.

### zui.py

A UI Automation helper for Zoom desktop client windows. It lists them, dumps a window's control tree, and invokes, toggles or selects a control by name.

```shell
python desktop/zui.py windows
python desktop/zui.py tree ZPPTEnhanceLoginMainWindowClassEx 8
python desktop/zui.py invoke WINDOW_CLASS_OR_TITLE "CONTROL NAME" ButtonControl
```

- Session use: inspecting and operating the Zoom desktop client windows that appeared when the join link was opened, without moving the mouse. The meeting itself was attended in the web client.
- Inputs and outputs: `tree` prints `ControlType 'Name' [Class] 'AutomationId'`, plus the toggle state where there is one. `invoke` prints `ok` or `clicked` and exits with a message when nothing matches.
- Dependencies: `uiautomation`, `tasklist` (Windows).
- Assumptions: the Zoom process is named `Zoom.exe`. Control names are the English UI labels. The first match in a depth-25 walk is the intended control. The global search timeout is 3 s.
- Failure modes: Zoom exposes only part of its UI to UI Automation, and control names are localised and change between Zoom versions. When a control has no Invoke, Toggle or SelectionItem pattern, the script falls back to a real mouse click, which moves the cursor and needs the control to be visible. Deep tree walks are slow.
- To generalise: avoid the desktop client (use the web client or the Zoom Meeting SDK), or put UIA, macOS AX and AT-SPI behind one accessibility layer and match on automation IDs rather than localised names.

### chrome_tab.py

Lists, activates or closes Chrome tabs through UI Automation, then gives focus back to the user's window and sends Chrome to the bottom of the z-order.

```shell
python desktop/chrome_tab.py list
python desktop/chrome_tab.py activate "TAB TITLE SUBSTRING"
python desktop/chrome_tab.py close "TAB TITLE SUBSTRING"
```

- Session use: switching and closing tabs in the agent's Chrome window, for example to bring the meeting tab forward, without disturbing what the user was doing.
- Inputs and outputs: `list` prints each tab name, cut to 90 characters. `activate` and `close` print the window title afterwards and whether focus was restored.
- Dependencies: `uiautomation`, `wins.py` (same folder).
- Assumptions: the first enumerated window whose title ends with `Google Chrome` (the topmost one) is the right window. The first button inside a tab item is its close button. Tabs are matched by substring, and the first match wins.
- Failure modes: if no Chrome window or tab matches, it raises a bare `StopIteration`. With several Chrome windows or profiles it acts on whichever is topmost. `restore` always sends Chrome to the bottom, even if the user had it in front. Activating a tab changes the window title, which `watch.py` and `keeper.py` use to find the meeting.
- To generalise: drive the browser through its own automation instead of UIA, using the Chrome DevTools Protocol or an extension's `chrome.tabs` API. Both work on every platform.

### kill_zoom_join.py

For N seconds (30 by default), closes the Zoom desktop client's join and name dialogs with `WM_CLOSE`, and minimises the Zoom home window without activating anything.

```shell
python desktop/kill_zoom_join.py 45
```

- Session use: running while the meeting link opened in Chrome, so the `zoommtg:` hand-off to the desktop client would not leave dialogs on screen and the meeting could be joined from the browser. The script's log from the session is empty, so in that run it found nothing to close.
- Inputs and outputs: an optional duration in seconds. It prints `closed CLASS TITLE` or `minimized CLASS` lines.
- Dependencies: `ctypes`, `wins.py` (same folder).
- Assumptions: Zoom's window classes are `zWaitingMeetingIDWndClass`, `ZPConfJoinWndClass`, anything starting with `zWaiting`, and `ZPPTEnhanceLoginMainWindowClassEx` for the home window. It polls every 200 ms.
- Failure modes: these class names are undocumented and change between Zoom releases. The `zWaiting` prefix could also match a waiting-room window of a meeting the desktop client really joined, and the script would close it.
- To generalise: do not trigger the desktop client at all. Open the web client URL directly (for example `https://app.zoom.us/wc/join/MEETING_ID`) or decline the `zoommtg:` protocol prompt. On macOS and Linux these dialogs are different anyway.

## Browser scripts

These are JavaScript snippets, not programs. The agent ran them in Chrome on Windows through the claude-in-chrome extension's `javascript_tool`, which evaluates code in a tab with REPL semantics: top-level `await` works and the value of the last expression is returned. Each returned string is cut at 1000 characters (with a `[TRUNCATED]` suffix), and strings that look like cookies, query strings or tokens are replaced with `[BLOCKED: ...]`, so every snippet returns small structured values and reduces URLs to host and path. Each file is used the same way, by sending its whole text to the tab:

```text
javascript_tool  action: javascript_exec  tabId: TAB_ID  text: <contents of the .js file>
```

State that has to outlive one call is kept on `window` under `sdc` names, so it is lost whenever the page reloads or navigates. The Zoom and Discord selectors are undocumented class names, ids and English aria-labels, and any release can change them. Each file's header comment gives its purpose, page, call, result, limits and the session time it was first used.

### zoom-root.js

Installs `window.sdcRoot()`, which returns the Zoom web client's document: the document of the same-origin `iframe#webclient` when the page has one, and the top document otherwise.

```javascript
// in a later snippet on the meeting tab
const d = sdcRoot();
d.querySelectorAll("button").length;
```

- Session use: in the rehearsals on Zoom's test meeting, reached through the `/j/` launcher page and "Join from browser", the client ran inside `iframe#webclient`. The live meeting was opened at the web-client join URL and ran in the top document, so the iframe-only snippet failed at 19:49:09 and this form replaced it at 19:49:20.
- Inputs and outputs: no inputs. It returns `{inIframe, buttons, chatList}`.
- Dependencies: none. `zoom-chat-capture.js`, `zoom-checkin.js` and `zoom-leave.js` need it.
- Assumptions: the iframe's id is `webclient` and it is same-origin with the tab. `sdcRoot()` resolves again on every call, so it follows a reloaded iframe.
- Failure modes: while the iframe loads, `contentDocument` can be an empty `about:blank` document. A reload of the tab removes `window.sdcRoot`, and the snippets that need it throw `Run zoom-root.js first`.
- To generalise: resolve the app's root at runtime and after every navigation instead of hard-coding the DOM seen in a rehearsal. With the Chrome DevTools Protocol or Playwright, pick the frame by its URL.

### zoom-hide-agent-overlays.js

Adds `<style id="sdc-hide-overlays">` to the top document, which hides the extension's glow border and its "Claude is active in this tab group" indicator (`#claude-agent-glow-border` and `#claude-static-indicator-container`) with `display: none !important`.

```javascript
// if the ids change, list the candidate overlay hosts
[...document.querySelectorAll("body > *")]
  .filter(
    (e) =>
      e.shadowRoot ||
      /claude|mcp|agent/i.test(
        e.tagName + " " + e.id + " " + String(e.className),
      ),
  )
  .map((e) => e.tagName + "#" + e.id);
```

- Session use: at 19:50:39, after an OBS test screenshot showed both overlays burned into the recording. `zoom-checkin.js` re-added the style at every check-in.
- Inputs and outputs: no inputs. It returns `{added, hidden}`, where `hidden` gives each overlay's id and computed `display`.
- Dependencies: none. It does not use `sdcRoot()`, because the extension puts its overlays in the top document.
- Assumptions: the overlays are plain elements under `<body>` with those ids. A third host, `BROWSER-MCP-CONTAINER`, was found and left alone.
- Failure modes: the ids are the extension's internals, and if they change the overlays stay visible with no error. The indicator was hidden rather than closed, because closing it might end the extension's control of the tab.
- To generalise: an app that records a page it drives must keep its own UI out of the capture. Hide it, or capture a surface that never contains it, such as the meeting's video element, or drive the page through the Chrome DevTools Protocol, which draws nothing on it.

### zoom-chat-capture.js

Captures the in-meeting chat. It installs a parser (`window.__sdcMsgs`) that turns each rendered chat item into `{seen, time, sender, to, text}`, a timer (`window.__sdcScroll`) that keeps the chat list scrolled to the bottom, a paging reader (`window.__sdcPull(max)`) that returns new messages as TSV with URLs reduced to `<host/path>`, and a sweep (`window.__sdcSweep()`) that scrolls through the whole list so that a virtualised list renders every item once.

```javascript
// read new messages until pending is 0, saving each page before the next call
window.__sdcPull(900);
// now and then, and always before the meeting ends: render every item, then read
await window.__sdcSweep();
window.__sdcPull(900);
// a page was lost: rewind to the first index not saved (46 in the session) and read again
window.__sdcMsgs.pulled = 46;
window.__sdcPull(900);
```

- Session use: the parser went in at 20:05:40, replacing a first observer that stored `innerText` snapshots of the whole list and came out noisy, with avatar initials, counters and no message boundaries. During the Q&A at 21:05 the panel was found scrolled up with new messages not rendering, so the scroll timer, the pull and a sweep were added, and the sweep recovered 10 messages. A last sweep and pull at 21:19 ran before the meeting could end. 104 lines were saved, 99 of them unique.
- Inputs and outputs:
  - The file returns `{installed, total, pulled, pending, scrollerFound}`.
  - `__sdcPull(max)` returns `{pending, out}`, with one `index, seen, time, sender, to, text` line per message and at most `max` characters, and moves the read cursor past those lines. A single message longer than `max` is cut and marked `[CUT]`.
  - `__sdcSweep()` returns `{swept, before, after}`.
  - Saving happens outside the page (see [Not included](#not-included)).
- Dependencies: `zoom-root.js`.
- Assumptions: the Zoom class names `chat-container__chat-list`, `chat-item-container`, `chat-item__sender`, `chat-item__receiver`, `new-chat-item__chat-info-time-stamp` and `new-chat-message__text-box`, found by dumping the list's class names, and the button label `open the chat panel`. A grouped follow-up message takes the sender and time of the item above it.
- Failure modes:
  - The read cursor moves when `__sdcPull` returns, not when the lines are saved, so a cut or failed tool result loses lines until the cursor is rewound. An early check-in that marked messages as read the same way lost lines at 21:05.
  - Zoom's `time` has minute resolution, and `seen` is when the parser first saw an item, so messages recovered by a sweep carry the sweep's time.
  - Without stable ids a message can be captured twice.
  - A sweep scrolls the visible chat panel for a few seconds, which shows in a recording.
  - Reduced URLs can still hold IDs in their paths, such as the meeting ID in a Zoom link.
  - Everything is lost if the page reloads.
- To generalise: read chat from an event stream rather than a virtualised view (the Zoom Meeting SDK, for example), key messages on Zoom's own ids, and move the cursor only after a page is saved.

### zoom-checkin.js

A probe that runs every 10 minutes on the meeting tab. It clicks visible buttons whose whole text is `OK` or `Got it`, re-adds the overlay-hiding style, and returns the tab title, the participant count, the audio and video button labels, the notices it clicked, a page of new chat lines and the first 120 characters of the page text.

```javascript
// after a check-in, while result.pull.pending > 0
window.__sdcPull(700);
```

- Session use: a recurring scheduled prompt ran it at 20:05 and every 10 minutes after, together with `discord-latest-messages.js` on the Discord tab. At 20:05 it acknowledged the notice that the host had started cloud recording, which the user had agreed to in advance. At 21:25 its page-text hint, with a screenshot, showed that the meeting had ended.
- Inputs and outputs: no inputs. It returns `{title, participants, audio, video, notices, scroll, pull, bodyHint}`.
- Dependencies: `zoom-root.js`, and `zoom-chat-capture.js` for `pull`.
- Assumptions: the participants button's aria-label contains `participants list`. The microphone button's label starts with `audio`, `mute` or `unmute`, and the camera button's with `video`, `start video` or `stop video`. In the session they read `audio` and `Video`, because the browser never had microphone or camera permission. A `mute` or `stop video` label would suggest a live microphone or camera, and the agent was to tell the user, never to click.
- Failure modes: any visible OK button is clicked without its dialog being read. Zoom kept the tab title, the toolbar and a stale participant count after the host ended the meeting, so title and count do not show the end, and at a 10-minute interval the end was noticed about nine minutes late. The scheduled prompt described the first chat helper's internals and went stale when the helpers changed.
- To generalise: give the scheduler one stable, versioned call (for example `window.__sdc.checkin()`) instead of describing internals in the prompt. Check every few seconds, and detect the end from in-page signals such as the end-of-meeting dialog or the Leave button disappearing. Limit the notice allowlist to notices the user has agreed to.

### zoom-verify-inputs.js

Returns the value of every text input in the page and in its same-origin iframes, JSON-quoted so that spaces show.

```javascript
// result shape: one JSON-quoted string per text input
['"DISPLAY NAME"'];
```

- Session use: at 19:48:45 on the pre-join screen. A half-scale screenshot had made the typed display name look wrong (a `T` read as `1`), and this read confirmed it before Join was clicked.
- Inputs and outputs: no inputs. It returns an array of strings.
- Dependencies: none.
- Assumptions: the field is an `<input type="text">` in the top document or one iframe level down.
- Failure modes: it returns every text input, including fields hidden with CSS (one held the web client's build URL), so it can expose values nobody meant to read. Other input types, nested iframes and cross-origin iframes are skipped.
- To generalise: check form state through the DOM or the accessibility tree, never by reading a downscaled screenshot, and read only the field that was filled.

### zoom-leave.js

Leaves the meeting: clicks the `Leave` toolbar button, waits up to 3 s for the confirmation, and clicks the button whose text matches `/leave meeting/i`. Run it only when the user has approved leaving.

```javascript
// change this line in the copy you send, and only after the user approves leaving
const USER_APPROVED_LEAVE = true;
```

- Session use: at 18:21:42 and 18:26:06, to leave Zoom's test meeting after each rehearsal. The live meeting did not need it, because the host ended it.
- Inputs and outputs: no inputs. It returns `{leaveClicked, confirmClicked}`, and throws while `USER_APPROVED_LEAVE` is `false`.
- Dependencies: `zoom-root.js`.
- Assumptions: a guest's view and English labels. The session's code was not recorded, so this is rebuilt from the recorded steps; the approval switch and the 3 s wait are additions.
- Failure modes: leaving changes the page, which loses the chat and all `window.__sdc*` state, so sweep and pull the chat first. If the labels change, nothing is clicked and the result shows `false`.
- To generalise: make leaving an explicit command that the user approves, and save the chat and the recording before it runs.

### discord-latest-messages.js

Summarises the last N messages of the Discord channel open in the tab: timestamp, the first 160 characters of text with URLs reduced to `<host/path>`, the number of `zoom.us` links, and the meeting IDs in those links. Full URLs, which carry the passcode, are not returned.

```javascript
// the first line of the file; the check-in probe used 1, the link poll 4
const N = 1;
```

- Session use: polled the event's announcements channel every 5 minutes from 18:34 until it found the meeting link at 19:34:09, then ran with `N = 1` at each meeting check-in to watch for new announcements.
- Inputs and outputs: `N`, set in the file. It returns an array of `{time, text, zoomLinks, meetingIds}`, oldest first.
- Dependencies: none. It needs a Discord web tab that is logged in and scrolled to the newest message.
- Assumptions: Discord's markup has `li[id^="chat-messages-"]` items with `[id^="message-content-"]` text and a `<time datetime>` element. Meeting IDs are 9 to 11 digits after `/j/`, `/w/`, `/wc/join/` or `/wc/`.
- Failure modes: the markup is undocumented and can change. Only rendered messages are read, so a channel scrolled up gives old messages. Meeting IDs do appear in the output. Joining needed the full link, which the agent got from the extension's `find` tool, whose output was not redacted and put the passcode into the session transcript.
- To generalise: take links from a bot or webhook where the server allows one, or from the calendar invite, and hand them to the joining step without echoing them into logs.

### links-host-path.js

Lists the links in a page's `<main>` element, or in the whole page if there is none, as `text -> host/path`. It keeps only `http` and `https` links and drops query strings and fragments.

```javascript
// many links: end the file's last expression with a slice and read the list in parts
}).filter(Boolean).slice(0, 15)
```

- Session use: at 22:02:28 on the event's participant portal, to see where the newly published problem statements were linked without returning query strings.
- Inputs and outputs: no inputs. It returns an array of strings, with the link text cut to 50 characters.
- Dependencies: none.
- Assumptions: the content is in `<main>`, and the links are ordinary anchors already in the page.
- Failure modes: paths can still carry IDs, such as Google Drive file and folder IDs, which give access to link-shared files. Links inside iframes or shadow roots, or added after the call, are missed.
- To generalise: make URL reduction one shared function that every page reader in the app uses, with an allowlist of what may leave the page.

## Capture scripts

### obs_setup.py

Creates or switches to an OBS scene collection named `sdc-hack`, adds a window-capture source `Zoom Meeting` and an application-audio source `Zoom Audio`, mutes the global desktop and mic sources, fits the window source to the 1920x1080 canvas, and prints the windows each source could bind to. It also provides the `client()` helper that `watch.py` imports.

```shell
python capture/obs_setup.py
```

- Session use: run once before the meeting to build the recording scene. The window for each source was set afterwards, outside this script (see [Not included](#not-included)).
- Inputs and outputs: no arguments. It prints the scene, the inputs, the muted sources and the candidate windows.
- Dependencies: `obsws-python`, and OBS 30.2.2 running with obs-websocket v5.
- Assumptions: OBS runs on the same machine under the same user, so the password can be read from `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`. The port is 4455 and the base canvas is 1920x1080. The window source uses capture method 2 (Windows Graphics Capture), client area only, without the cursor. The window-match `priority` is 0 for the video source and 2 for the audio source. After a collection switch it waits 3 s and reconnects. The new collection's default scene is named `Scene`, and `watch.py` relies on that name.
- Failure modes: switching collections drops pending requests, which is why it reconnects. The sources are created without a window, so nothing is captured until one is set. The printed choices only include windows whose title, class or executable contains "zoom", so a Chrome meeting window only shows up if its tab title does. Application audio capture works per process, so pointing it at Chrome records every tab's sound.
- To generalise: OBS source kinds differ by platform (Windows `window_capture` and `wasapi_*`, ScreenCaptureKit on macOS, PipeWire on Linux). Take host, port and password from the app's config, bind the source to its window in the same step, and read the canvas size with `GetVideoSettings`.

### watch.py

Runs for the length of the meeting. Every 2 s it takes a screenshot of the OBS scene and saves a PNG keyframe whenever the left part of the frame changes and then settles, skipping near-duplicates with a dHash. It also watches for the meeting's Chrome window by title and stops the recording when the meeting ends.

```shell
python capture/watch.py --title "MEETING TOPIC" --out OUT_DIR --stop-after 21:30 --hard-stop 23:30
```

- Session use: started at 19:49:56 with the meeting topic as `--title`. By 21:25 it had saved 91 keyframes, with a heartbeat every 10 minutes that showed the meeting window present throughout. The log ends at 21:25 with no `ENDED` or `ERROR` line, so the process was stopped from outside and the automatic stop path was not exercised.
- Inputs and outputs:
  - Keyframes go to `OUT_DIR/frames/NNN_HHMMSS_recHHMMSS.png`: full 1920x1080 scene captures named with the wall-clock time and the recording timecode, which ties slides to the transcript.
  - `OUT_DIR/latest.jpg` is refreshed every 30 s.
  - Events go to `OUT_DIR/watch.log` and stdout: `SLIDES`, `ALERT`, `ENDED`, `HEARTBEAT` and `ERROR`, as described in the docstring.
  - It does not start the recording. It only raises an alert when the recording is inactive.
- Dependencies: `obsws-python`, `Pillow`, `obs_setup.py` (same folder), `wins.py` (in `desktop/`).
- Assumptions:
  - The scene is named `Scene` and is 1920x1080. Only the left 74 % of each frame (`DIFF_WIDTH`) is compared, because the Zoom chat panel was docked on the right.
  - A new keyframe needs a mean difference of at least `CHANGE` 7.0 (on a 128x72 greyscale thumbnail) from the last kept frame and at most `STABLE` 2.0 from the previous sample. It counts as a duplicate within `HASH_DUP` 12 bits of the 256-bit dHash of any earlier keyframe.
  - The meeting counts as present while any `chrome.exe` window title contains `--title`. Chrome shows the active tab's title, and the Zoom web client tab used the meeting topic.
  - The meeting counts as ended once the window has been gone for 60 s after `--stop-after`, or at `--hard-stop`. Both are clock times for today.
- Failure modes:
  - A slide has to stay on screen for two consecutive samples (4 s or more) to be caught.
  - A slide shown again later is never saved again, because the dHash check compares against every earlier keyframe, so revisits drop out of the timeline.
  - Switching the meeting window to another tab hides the title. Before `--stop-after` that only raises an `ALERT`; after it, the recording stops.
  - Stop times are computed for today, so starting after the `--hard-stop` time, or a meeting that runs past midnight, stops the recording at once.
  - The capture lost the screen share from about 20:09 to 20:16, so those sponsor slides are missing from the write-up. The first `keeper.py` restore of a minimised meeting window is logged at 20:16:00, so start `keeper.py` before the meeting begins.
  - `dhash` uses `Image.getdata`, which a smoke run flagged as deprecated and due for removal in Pillow 14 (2027-10).
- To generalise: detect the share region or read it from the meeting page's DOM rather than fixing it as a fraction of the frame. Capture the shared content at the source (the web client's video element, or Zoom Meeting SDK raw data) rather than a desktop window. Take meeting-end from the client's own state, and use durations rather than wall-clock times. Use a maintained hashing library and keep slide revisits as timeline events.

### keeper.py

Every second, finds Chrome windows whose title contains the given substring and, if one is minimised, restores it at the given rectangle at the bottom of the z-order without activating it, then logs an `ALERT` line.

```shell
python capture/keeper.py "MEETING TOPIC" OUT_DIR/watch.log X Y W H
```

- Session use: ran alongside `watch.py` and wrote to the watcher's log. It restored the minimised meeting window twice, at 20:16:00 and 20:28:55, without changing the user's focus either time.
- Inputs and outputs: it appends to `LOGFILE` only when it acts, and runs until it is killed.
- Dependencies: `ctypes`, `wins.py` (in `desktop/`).
- Assumptions: the same physical-pixel rectangle as `place.py`, and the window is matched by a title substring. Windows Graphics Capture keeps capturing a window that other windows cover, but not a minimised one, which is why this script exists.
- Failure modes: a minimised window goes uncaptured for up to 1 s per event. There is no exit condition. After a tab switch changes the title, it no longer recognises the window.
- To generalise: this is not needed if the app captures from a source that does not depend on window state, such as a headless or dedicated browser, a virtual display or the SDK. Otherwise, subscribe to minimise events (`SetWinEventHook` with `EVENT_SYSTEM_MINIMIZESTART`) instead of polling.

### crop.py

Crops each watcher keyframe to the shared screen: inside a fixed region, it keeps the span of rows and columns that contain enough non-dark pixels.

```shell
python capture/crop.py OUT_DIR/frames OUT_DIR/slides --webp
```

- Session use: after the meeting, cutting the slide area out of the 1920x1080 keyframes for the slides write-up.
- Inputs and outputs: each `.png` in `SRC_DIR` becomes a `.png`, or a `.webp` at quality 90, with the same name in `OUT_DIR`. It prints each name and the cropped size.
- Dependencies: `Pillow` (built with WebP support for `--webp`).
- Assumptions: `REGION = (0, 290, 1410, 962)` on a 1920x1080 frame, which is below the web client's thumbnail strip and "You are viewing" bar and left of the docked chat panel. The canvas counts as dark below luminance `DARK` 40. A row or column counts once at least `MIN_FRACTION` 4 % of its sampled pixels are brighter than that.
- Failure modes: dark slides and dark video stills are cropped too tightly. When nothing passes the threshold, the whole region is kept. Any change to the window size, panel layout or view mode moves the share outside `REGION`. The pixel loops are pure Python and slow, which was fine for about 100 frames.
- To generalise: find the share rectangle in each frame, or take it from the page's video element bounds, instead of using fixed numbers, and use NumPy for the scan.

### sheet.py

Makes a contact sheet of watcher keyframes: three columns of 480x270 thumbnails, each labelled with its file name.

```shell
python capture/sheet.py OUT_DIR/frames sheet_1.jpg 1 12
```

- Session use: reviewing the 91 keyframes in sheets of 12, starting at frames 1, 13, 25 and so on up to 85, to map slides to keyframes.
- Inputs and outputs: `FRAMES_DIR OUT.jpg [first_index] [count]`. It writes one JPEG at quality 80 and prints the path and frame count.
- Dependencies: `Pillow`.
- Assumptions: every `.png` name starts with the watcher's three-digit index. Labels use Pillow's default bitmap font.
- Failure modes: any other `.png` in the folder raises `ValueError`, and more than 999 frames would break the naming.
- To generalise: take any ordered list of frames. Sheets like this are an efficient way for an agent to review many images at once, so a generic contact-sheet step is worth keeping.

### grid.py

Tiles a folder of same-size `.jpg` frames into 2x3 sheets and labels each tile with an `m:ss` time worked out from its index.

```shell
python capture/grid.py FRAME_DIR 10 OUT_PREFIX
```

- Session use: skimming stretches of the recording from frames sampled at a fixed interval with `ffmpeg`.
- Inputs and outputs: `FRAME_DIR STEP_SECONDS OUT_PREFIX`. It writes `OUT_PREFIX_1.jpg`, `OUT_PREFIX_2.jpg` and so on, and prints each path.
- Dependencies: `Pillow`, plus `ffmpeg` to produce the frames.
- Assumptions: frame `i` stands for the middle of interval `i` (`i * STEP + STEP / 2` seconds from the start of the sampled clip). All tiles are the size of the first.
- Failure modes: the labels are approximate and relative to the sampled clip, not the recording. The 70-pixel label box fits `m:ss` but not `h:mm:ss`. The last sheet can have empty tiles.
- To generalise: label tiles with real frame timestamps (from `ffprobe` or `-frame_pts`) as absolute recording offsets.

## Transcription scripts

### run.sh

The cross-check transcription. It cuts the meeting audio into 180 s mono 16 kHz MP3 chunks with `ffmpeg` and sends each chunk to OpenAI `gpt-4o-transcribe` with a vocabulary prompt. It can be resumed, because chunks that already have a non-empty JSON file are skipped.

```bash
export WORKDIR=/path/to/openai-chunks SRC=/path/to/meeting-audio.flac ENV_FILE=/path/to/.env
bash transcription/run.sh
```

- Session use: in WSL, over the first 01:27:30 of the recording (`END=5250`, which gives 30 chunks). It produced `chunk_00.json` to `chunk_29.json` for `xcheck.py`.
- Inputs and outputs: the env vars `WORKDIR`, `SRC`, and `OPENAI_API_KEY` or `ENV_FILE` (an absolute path; it is read after the `cd`). It writes `chunk_NN.mp3` and `chunk_NN.json` (`{"text": ...}`) in `WORKDIR`, and prints `chunk NN ok` or `chunk NN FAILED:` with the first 300 bytes of the error, then a count.
- Dependencies: `bash`, `ffmpeg`, `curl` 7.76 or later, and an OpenAI API key.
- Assumptions: `END` and the vocabulary `PROMPT` (event, organiser and sponsor names) are specific to this meeting. The language is fixed to `en`.
- Failure modes: chunks are cut at fixed boundaries, so words at a cut can be split or doubled. `gpt-4o-transcribe` JSON output has no timestamps, which is why Whisper supplied the timing. A failed chunk is reported and skipped with no retry, and re-running the script fills it in.
- To generalise: rewrite it with the `openai` SDK. Chunk at silences with some overlap, retry with backoff, build the prompt from the meeting's agenda and participant list, and take the end time from `ffprobe`.

### clips.sh

Re-transcribes short named clips twice: `gpt-4o-transcribe` for the text and `whisper-1` `verbose_json` for segment timestamps.

```bash
export WORKDIR=/path/to/openai-chunks SRC=/path/to/meeting-audio.flac ENV_FILE=/path/to/.env
bash transcription/clips.sh intro 1220 45 qa_start 4380 60 > clips.md
```

- Session use: settling passages where the Whisper medium text and the `gpt-4o-transcribe` text disagreed, mostly over names, and getting timestamps for those passages.
- Inputs and outputs: argument triples `name start_s dur_s` and the same env vars as `run.sh`. It writes `WORKDIR/clips/NAME.mp3` and prints one block per clip: `## name @Ss+D`, then `G:` with the `gpt-4o-transcribe` text and `W:` with the `whisper-1` segments stamped as absolute `[HH:MM:SS]` times.
- Dependencies: `bash`, `ffmpeg`, `curl`, `python3`, `segs.py` (same folder) and an OpenAI API key.
- Assumptions: the `<...>` placeholders in `PROMPT` have to be replaced with the real names before running, because the prompt is what fixed the spelling of names. The `chr(116)+'ext'` in the inline Python is just the key `"text"`.
- Failure modes: there is no `--fail-with-body` or other error check, so an API error shows up as `?` after `G:` and as the raw error dict after `W:`. Each clip costs two paid calls.
- To generalise: make it a "re-check this span" operation in the transcription service.

### segs.py

Reads `whisper-1` `verbose_json` from stdin and prints its segments on one line as `[HH:MM:SS] text`, joined with `|` and offset by `argv[1]` seconds.

```bash
python3 transcription/segs.py 1220 < whisper_verbose.json
```

- Session use: called by `clips.sh`.
- Inputs and outputs: JSON on stdin, one line on stdout. When there are no segments, for example after an API error, it prints the whole dict.
- Dependencies: standard library.
- Assumptions: segment `start` values are relative to the clip.
- Failure modes: none seen.
- To generalise: fold it into a transcript data model with absolute times.

### xcheck.py

Builds a Markdown review document. For each 3-minute window it shows the local Whisper medium paragraphs with timestamps (`M:`) next to the matching `gpt-4o-transcribe` chunk text (`O:`), then the Whisper-only text after 01:30:00.

```bash
python3 transcription/xcheck.py xcheck.md /path/to/whisper-medium.json /path/to/openai-chunks
```

- Session use: produced the side-by-side file (about 127 KB) that the agent read to reconcile the two transcripts into the final one.
- Inputs and outputs: `OUT.md WHISPER_JSON CHUNK_DIR`. The Whisper JSON uses the openai-whisper format, with `segments[]` entries holding `start`, `end` and `text`. It writes `OUT.md` and prints the character count.
- Dependencies: standard library.
- Assumptions: 30 windows of 180 s (matching `run.sh`'s `END`) and the 5400 s cut-off are hard-coded. A new paragraph starts after a gap of more than 1.2 s or after 400 characters.
- Failure modes: if any chunk file is missing, for example because a `run.sh` chunk failed, it raises `FileNotFoundError`. The output file is opened with the platform's default encoding, so on Windows any non-ASCII text can raise `UnicodeEncodeError`. It ran in WSL, where the default is UTF-8.
- To generalise: derive the windows from the chunks that exist, align the transcripts by timestamp, and flag disagreements automatically so nobody has to read the whole side-by-side.

### check_ts.py

Checks the speaker timestamps in the finished transcript. For each `**[HH:MM:SS] Speaker:** text` paragraph, it fuzzy-matches the first seven words against Whisper medium segments within 90 s either side and reports stamps that are more than 4 s off or that only match weakly.

```shell
python transcription/check_ts.py transcript.md whisper-medium.json
```

- Session use: the final check of the timestamps in `transcript.md`.
- Inputs and outputs: it prints only flagged paragraphs, as `stamp speaker best=HH:MM:SS score=0.xx << | text`.
- Dependencies: standard library (`difflib`).
- Assumptions: paragraphs follow that exact format. Where a phrase falls inside a segment is estimated linearly from its word position. The thresholds are 90 s, seven words, 4 s and a score of 0.6.
- Failure modes: `SequenceMatcher` runs once for every paragraph, segment and word offset, which gets slow on long meetings. A paragraph whose opening words were cleaned up or paraphrased scores low and is flagged even when its stamp is right.
- To generalise: keep word-level timestamps from speech recognition (Whisper's `word_timestamps`) and carry them through editing instead of re-aligning afterwards.

## Write-up scripts

### build_slides.py

Assembles `slides.md`: a fixed H1 and introduction, a `Contents:` list that links every `## Slide NN: title` heading, then the slide body.

```shell
python write-up/build_slides.py slides_body.md slides.md
```

- Session use: the last step of the slides write-up. The body was the per-slide sections (image plus transcribed text) that the agent had written, joined into one file.
- Inputs and outputs: `BODY.md OUT.md`. It writes `OUT.md` with LF line endings and prints the slide count.
- Dependencies: standard library.
- Assumptions: the `INTRO` text is hard-coded for this meeting: title, event, date, the note about the missing sponsor slides, and links to `transcript.md` and `chat.md`. Headings must match `## Slide \d\d: ...`, which allows at most 99 slides. Anchors use a simplified GitHub slug.
- Failure modes: duplicate headings get the same anchor, where GitHub would add `-1` and `-2`.
- To generalise: fill the introduction from meeting metadata, and generate anchors with the same library the target renderer uses.

## Source scripts

### drive_ls.py

Lists a Google Drive folder shared with "anyone with the link", recursively, by scraping the public `embeddedfolderview` page. It needs no API key and no login.

```shell
python sources/drive_ls.py FOLDER_ID > drive_tree.tsv
```

- Session use: listing the participant Drive folder shared in the meeting, so its files could be downloaded.
- Inputs and outputs: a folder ID. It prints `kind<TAB>id<TAB>name` for each entry, indented two spaces per level.
- Dependencies: standard library.
- Assumptions: the page has `<a href=...>` entries with `flip-entry-title` divs. Folder links contain `/folders/ID`, and file links contain `/d/ID` or `?id=ID`.
- Failure modes: it depends on undocumented Drive markup, so a markup change makes it print nothing without any error. A private folder gives an empty listing or an `HTTPError`. Native Google Docs, Sheets and Slides are listed as files, but `drive_get.py` cannot download them. It has not been tested on very large folders.
- To generalise: use Drive API v3 `files.list` with an API key, which works for link-shared items, and `files.export` for native Google files.

### drive_get.py

Downloads link-shared Drive files by ID from `drive.usercontent.google.com` with `confirm=t`, which skips the large-file virus-scan page. Files already present are skipped.

```shell
python sources/drive_get.py OUT_DIR FILE_ID=Rulebook.pdf FILE_ID=Timeline.pdf
```

- Session use: downloading the files that `drive_ls.py` found.
- Inputs and outputs: `OUT_DIR` (it must already exist) followed by `id=name` pairs. Each file is written to `NAME.part` and then renamed, and the script prints the name, size and `Content-Type`.
- Dependencies: standard library.
- Assumptions: the files are binary files shared with anyone who has the link. Names come from the caller and are not sanitised.
- Failure modes: an error, quota or permission page is saved as if it were the file, and only a printed `Content-Type` of `text/html` gives it away. Native Google files fail. There is no retry or resume. A name that contains a path separator writes outside `OUT_DIR`.
- To generalise: use the Drive API (`files.get?alt=media` and `files.export`), check the content type and size, and sanitise names.

### pdf_dump.py

For each PDF in a folder, writes its text to `OUT_DIR/STEM.txt` with `===== page N =====` markers and renders every page to `OUT_DIR/STEM/NN.png` at 90 dpi.

```shell
python sources/pdf_dump.py SRC_DIR OUT_DIR
```

- Session use: turning the downloaded PDFs into text and page images, which the agent read to write Markdown versions.
- Inputs and outputs: as above. It prints the page count, word count and page size for each PDF.
- Dependencies: `pymupdf`.
- Assumptions: the extension is lowercase `.pdf` and the PDFs have a text layer.
- Failure modes: scanned PDFs produce no text, because there is no OCR. The default extraction order can scramble multi-column pages, which is why `sorted_dump.py` exists. Page file names are two digits wide.
- To generalise: add an OCR fallback and keep structured output (text blocks with their positions).

### sorted_dump.py

Dumps a single PDF's text with `get_text(sort=True)`, which orders blocks top to bottom and then left to right, using the same page markers as `pdf_dump.py`.

```shell
python sources/sorted_dump.py SRC.pdf OUT.txt
```

- Session use: re-dumping PDFs whose default text order came out scrambled, before comparing them with the Markdown.
- Inputs and outputs: one PDF in, one text file out. It prints nothing.
- Dependencies: `pymupdf`.
- Assumptions: reading order follows page position.
- Failure modes: sorting by position can interleave side-by-side columns.
- To generalise: make it an option of the main PDF extraction step.

### mddiff.py

A word-level diff between a PDF text dump and a cleaned-up Markdown version. Both are normalised first (quotes, URLs, case, punctuation, page numbers, hyphenation), and chunks that also occur elsewhere in the other document are marked as moved.

```shell
python sources/mddiff.py PDF_TXT MD_FILE
```

- Session use: checking that the Markdown rewrites of the Drive PDFs had not dropped or changed any words.
- Inputs and outputs: a PDF text dump and a Markdown file. It prints a summary line, then each non-matching section with context.
- Dependencies: standard library.
- Assumptions: the Markdown follows the house style: H1, introduction and `Contents:` before the first H2 (all skipped), with `## See also` and everything after it ignored. Link text is kept and URLs dropped, and table separator rows are ignored.
- Failure modes: a Markdown file with no `## ` heading leaves `first_h2` at -1, so only its last character is compared and the whole document shows up as missing. PDF lines that hold nothing but a number of one to three digits are dropped as page numbers, even when they are real content.
- To generalise: turn it into a library function with configurable normalisation and use it as an automatic check on document conversion.

### bagdiff.py

An order-independent companion to `mddiff.py`. It prints the PDF's metadata, word and image counts per page, the context around words such as version, updated, effective, dated, revision, `v1` and last, and the word-count differences between the Markdown and the PDF dump.

```shell
python sources/bagdiff.py SRC.pdf PDF_TXT MD_FILE
```

- Session use: confirming that the differences `mddiff.py` reported were layout reordering rather than missing words, and finding each document's version or date.
- Inputs and outputs: the PDF, its text dump and the Markdown file. Everything goes to stdout.
- Dependencies: `pymupdf`, and `mddiff.py` from the same folder (the script adds its own folder to `sys.path`).
- Assumptions: the same normalisation as `mddiff.py`.
- Failure modes: the `last` pattern matches any word that contains "last", which makes the output noisy.
- To generalise: merge it with `mddiff.py` into one fidelity report.

## Not included

Much of the session's work was done inline rather than as script files, so it is not in this folder:

- One-off JavaScript probes that are not in `browser/`: closing Zoom's microphone and camera banner, computing element centres for coordinate clicks, listing View menu items (which found none), dumping the chat's class names, and the first chat observer, which stored `innerText` snapshots and was replaced by `zoom-chat-capture.js`.
- Saving the chat: each page from `__sdcPull` was written to a TSV file and appended to a JSONL file with inline Python, then deduplicated at write-up on sender, time and the first 200 characters of text.
- obs-websocket calls typed ad hoc, such as binding the capture sources to the meeting window, starting and stopping the recording, and taking test screenshots.
- One-off `ffmpeg` commands, such as extracting the audio from the recording and sampling frames for `grid.py`.
- The local Whisper transcription in WSL, which ran from a separate project, and the hand-written Markdown for the transcript, chat and slides.

These steps are documented in the main docs in the parent `meeting-automation-docs` folder.
