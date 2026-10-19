# Problems and fixes

This catalogue lists every problem hit when a Claude Code agent on Windows 11 and WSL2 attended a Zoom briefing as a guest through the Zoom web client in Chrome on 19 Oct 2026, recorded it with OBS, captured slides and chat, transcribed it, wrote and published Markdown deliverables and scraped a Google Drive folder. It merges three session note files, and each entry ends with a design rule for a general-purpose meeting-automation app. Times are MYT (UTC+8), with times after 22:33 taken from the transcript and git rather than the third note's estimates; IDs run in time order within each category, and Status is resolved, worked around or open.

Contents:

1.  [Top lessons](#top-lessons)
1.  [Desktop and window management](#desktop-and-window-management)
    1.  [DESK-01: Chrome meeting window minimised during capture](#desk-01-chrome-meeting-window-minimised-during-capture)
    1.  [DESK-02: Restoring Chrome stole focus and covered the user's work](#desk-02-restoring-chrome-stole-focus-and-covered-the-users-work)
    1.  [DESK-03: UIA tree walks failed with COM errors](#desk-03-uia-tree-walks-failed-with-com-errors)
    1.  [DESK-04: The user and the agent raced for the same dialog](#desk-04-the-user-and-the-agent-raced-for-the-same-dialog)
    1.  [DESK-05: A class-name filter missed a Zoom dialog](#desk-05-a-class-name-filter-missed-a-zoom-dialog)
    1.  [DESK-06: Selecting a Chrome tab through UIA activated Chrome](#desk-06-selecting-a-chrome-tab-through-uia-activated-chrome)
    1.  [DESK-07: A guessed focus-restore target left no foreground window](#desk-07-a-guessed-focus-restore-target-left-no-foreground-window)
    1.  [DESK-08: SetWindowPos did not move a maximised window](#desk-08-setwindowpos-did-not-move-a-maximised-window)
1.  [Browser and extension](#browser-and-extension)
    1.  [BRW-01: The extension redacted or blocked script results](#brw-01-the-extension-redacted-or-blocked-script-results)
    1.  [BRW-02: A script acted on a page that had already navigated](#brw-02-a-script-acted-on-a-page-that-had-already-navigated)
    1.  [BRW-03: Chrome's protocol prompt never appeared for a background tab](#brw-03-chromes-protocol-prompt-never-appeared-for-a-background-tab)
    1.  [BRW-04: Chrome tab names carried extra decorations](#brw-04-chrome-tab-names-carried-extra-decorations)
    1.  [BRW-05: A click used coordinates from the wrong frame](#brw-05-a-click-used-coordinates-from-the-wrong-frame)
    1.  [BRW-06: Chrome showed a notification permission bubble](#brw-06-chrome-showed-a-notification-permission-bubble)
    1.  [BRW-07: Chrome would not exit gracefully](#brw-07-chrome-would-not-exit-gracefully)
    1.  [BRW-08: The extension's tab group and tab IDs were lost](#brw-08-the-extensions-tab-group-and-tab-ids-were-lost)
    1.  [BRW-09: Closing a tab through UIA failed](#brw-09-closing-a-tab-through-uia-failed)
    1.  [BRW-10: A downscaled screenshot misread typed text](#brw-10-a-downscaled-screenshot-misread-typed-text)
    1.  [BRW-11: The agent called a tool action that does not exist](#brw-11-the-agent-called-a-tool-action-that-does-not-exist)
    1.  [BRW-12: Script results were cut at 1000 characters](#brw-12-script-results-were-cut-at-1000-characters)
    1.  [BRW-13: A parallel navigate and read ran before the page loaded](#brw-13-a-parallel-navigate-and-read-ran-before-the-page-loaded)
1.  [Zoom](#zoom)
    1.  [ZOOM-01: A coordinate click on Zoom desktop Settings did nothing](#zoom-01-a-coordinate-click-on-zoom-desktop-settings-did-nothing)
    1.  [ZOOM-02: Zoom join options were not where expected](#zoom-02-zoom-join-options-were-not-where-expected)
    1.  [ZOOM-03: The Zoom desktop guest name dialog could not be automated](#zoom-03-the-zoom-desktop-guest-name-dialog-could-not-be-automated)
    1.  [ZOOM-04: The meeting tab drifted to a Zoom marketing page](#zoom-04-the-meeting-tab-drifted-to-a-zoom-marketing-page)
    1.  [ZOOM-05: Zoom's launcher page opened the desktop app](#zoom-05-zooms-launcher-page-opened-the-desktop-app)
    1.  [ZOOM-06: Pre-join controls were missing from the accessibility tree](#zoom-06-pre-join-controls-were-missing-from-the-accessibility-tree)
    1.  [ZOOM-07: The mic and camera prompt appeared twice](#zoom-07-the-mic-and-camera-prompt-appeared-twice)
    1.  [ZOOM-08: Zoom popups and banners covered the meeting view](#zoom-08-zoom-popups-and-banners-covered-the-meeting-view)
    1.  [ZOOM-09: The in-meeting UI was invisible to the extension's page reader](#zoom-09-the-in-meeting-ui-was-invisible-to-the-extensions-page-reader)
    1.  [ZOOM-10: Fullscreen did not work from a background window](#zoom-10-fullscreen-did-not-work-from-a-background-window)
    1.  [ZOOM-11: The live meeting UI was in the top document, not the iframe](#zoom-11-the-live-meeting-ui-was-in-the-top-document-not-the-iframe)
    1.  [ZOOM-12: View Options menu items had no ARIA roles](#zoom-12-view-options-menu-items-had-no-aria-roles)
1.  [OBS and recording](#obs-and-recording)
    1.  [OBS-01: A PC with a crash history put the recording at risk](#obs-01-a-pc-with-a-crash-history-put-the-recording-at-risk)
    1.  [OBS-02: Switching scene collections could drop websocket requests](#obs-02-switching-scene-collections-could-drop-websocket-requests)
    1.  [OBS-03: Capture sources needed a live window to bind to](#obs-03-capture-sources-needed-a-live-window-to-bind-to)
    1.  [OBS-04: OBS recorded black frames while Chrome was covered](#obs-04-obs-recorded-black-frames-while-chrome-was-covered)
    1.  [OBS-05: The crop drifted after the window geometry changed](#obs-05-the-crop-drifted-after-the-window-geometry-changed)
    1.  [OBS-06: OBS in the tray was slow to exit and lost the collection switch](#obs-06-obs-in-the-tray-was-slow-to-exit-and-lost-the-collection-switch)
1.  [Watcher and capture quality](#watcher-and-capture-quality)
    1.  [CAP-01: Zoom's Audio button suggested audio was not connected](#cap-01-zooms-audio-button-suggested-audio-was-not-connected)
    1.  [CAP-02: Automation overlays were burned into the recording](#cap-02-automation-overlays-were-burned-into-the-recording)
    1.  [CAP-03: The watcher missed black frames and the gap was misdated](#cap-03-the-watcher-missed-black-frames-and-the-gap-was-misdated)
    1.  [CAP-04: The watcher did not detect the meeting end](#cap-04-the-watcher-did-not-detect-the-meeting-end)
    1.  [CAP-05: Raw keyframes needed manual curation](#cap-05-raw-keyframes-needed-manual-curation)
    1.  [CAP-06: Slide text was covered in the shared screen](#cap-06-slide-text-was-covered-in-the-shared-screen)
1.  [Chat capture](#chat-capture)
    1.  [CHAT-01: Snapshot chat capture was noisy and unstructured](#chat-01-snapshot-chat-capture-was-noisy-and-unstructured)
    1.  [CHAT-02: The virtualised chat list hid new messages](#chat-02-the-virtualised-chat-list-hid-new-messages)
    1.  [CHAT-03: The pull cursor skipped messages that were never saved](#chat-03-the-pull-cursor-skipped-messages-that-were-never-saved)
    1.  [CHAT-04: Chat records were duplicated and fuzzy](#chat-04-chat-records-were-duplicated-and-fuzzy)
1.  [Scheduling, state and agent harness](#scheduling-state-and-agent-harness)
    1.  [AGENT-01: Large tool outputs were saved to files](#agent-01-large-tool-outputs-were-saved-to-files)
    1.  [AGENT-02: The harness moved a shell call to the background](#agent-02-the-harness-moved-a-shell-call-to-the-background)
    1.  [AGENT-03: The meeting link was posted late](#agent-03-the-meeting-link-was-posted-late)
    1.  [AGENT-04: The scheduled join did not follow the stored plan](#agent-04-the-scheduled-join-did-not-follow-the-stored-plan)
    1.  [AGENT-05: The recurring check-in prompt went stale](#agent-05-the-recurring-check-in-prompt-went-stale)
    1.  [AGENT-06: The event monitor expired every 30 minutes](#agent-06-the-event-monitor-expired-every-30-minutes)
1.  [Transcription](#transcription)
    1.  [ASR-01: The plan included an obsolete LLM polish stage](#asr-01-the-plan-included-an-obsolete-llm-polish-stage)
    1.  [ASR-02: Transcription jobs were killed for low memory](#asr-02-transcription-jobs-were-killed-for-low-memory)
    1.  [ASR-03: The diarized cloud pilot cost more than the quote](#asr-03-the-diarized-cloud-pilot-cost-more-than-the-quote)
    1.  [ASR-04: Every engine misheard proper nouns](#asr-04-every-engine-misheard-proper-nouns)
    1.  [ASR-05: ASR hallucinated on silence and unclear audio](#asr-05-asr-hallucinated-on-silence-and-unclear-audio)
    1.  [ASR-06: Each engine dropped different passages](#asr-06-each-engine-dropped-different-passages)
    1.  [ASR-07: whisper-1 clip results were unreliable](#asr-07-whisper-1-clip-results-were-unreliable)
1.  [Write-up](#write-up)
    1.  [WRITE-01: Sources contradicted each other](#write-01-sources-contradicted-each-other)
    1.  [WRITE-02: The contents generator picked up headings inside a code fence](#write-02-the-contents-generator-picked-up-headings-inside-a-code-fence)
    1.  [WRITE-03: Hand-written transcript timestamps were off by seconds](#write-03-hand-written-transcript-timestamps-were-off-by-seconds)
    1.  [WRITE-04: A summary misreported an organiser's answer](#write-04-a-summary-misreported-an-organisers-answer)
1.  [Publishing](#publishing)
    1.  [PUB-01: The requested folder name differed from the precedent](#pub-01-the-requested-folder-name-differed-from-the-precedent)
    1.  [PUB-02: Prettier rewrote files at commit time](#pub-02-prettier-rewrote-files-at-commit-time)
    1.  [PUB-03: The pre-commit hook failed under Node 16](#pub-03-the-pre-commit-hook-failed-under-node-16)
    1.  [PUB-04: Files were committed with the executable bit](#pub-04-files-were-committed-with-the-executable-bit)
1.  [Post-event sources](#post-event-sources)
    1.  [SRC-01: Drive items would not open in the browser](#src-01-drive-items-would-not-open-in-the-browser)
    1.  [SRC-02: The Drive connector could not list a link-shared folder](#src-02-the-drive-connector-could-not-list-a-link-shared-folder)
    1.  [SRC-03: Text extraction from Canva PDFs was garbled](#src-03-text-extraction-from-canva-pdfs-was-garbled)
    1.  [SRC-04: A sample-repo zip carried someone's git history](#src-04-a-sample-repo-zip-carried-someones-git-history)
    1.  [SRC-05: Scene detection found almost no frames in a screen recording](#src-05-scene-detection-found-almost-no-frames-in-a-screen-recording)
    1.  [SRC-06: A tutorial video had no narration](#src-06-a-tutorial-video-had-no-narration)
1.  [Shell and environment](#shell-and-environment)
    1.  [ENV-01: A SessionStart hook path was mangled by bash](#env-01-a-sessionstart-hook-path-was-mangled-by-bash)
    1.  [ENV-02: WSL's distro listing printed UTF-16 text](#env-02-wsls-distro-listing-printed-utf-16-text)
    1.  [ENV-03: Sleep or lock could have broken the capture](#env-03-sleep-or-lock-could-have-broken-the-capture)
    1.  [ENV-04: Hidden-process logs had mojibake](#env-04-hidden-process-logs-had-mojibake)
    1.  [ENV-05: Start-Process split a quoted argument](#env-05-start-process-split-a-quoted-argument)
    1.  [ENV-06: Pillow warned about a deprecated call](#env-06-pillow-warned-about-a-deprecated-call)
    1.  [ENV-07: Successful commands reported non-zero exit codes](#env-07-successful-commands-reported-non-zero-exit-codes)
    1.  [ENV-08: PowerShell appends were fragile with quotes and non-ASCII text](#env-08-powershell-appends-were-fragile-with-quotes-and-non-ascii-text)
    1.  [ENV-09: Each helper script ran as two processes](#env-09-each-helper-script-ran-as-two-processes)
    1.  [ENV-10: Inline Python failed through two layers of shell quoting](#env-10-inline-python-failed-through-two-layers-of-shell-quoting)
    1.  [ENV-11: Git Bash mangled a Windows command switch](#env-11-git-bash-mangled-a-windows-command-switch)
1.  [Safety and consent incidents](#safety-and-consent-incidents)
    1.  [SAFE-01: A lasting browser permission was granted mid-run](#safe-01-a-lasting-browser-permission-was-granted-mid-run)
    1.  [SAFE-02: OS-level keystrokes went to the user's WhatsApp](#safe-02-os-level-keystrokes-went-to-the-users-whatsapp)
    1.  [SAFE-03: Chrome was force-restarted without asking](#safe-03-chrome-was-force-restarted-without-asking)
    1.  [SAFE-04: The meeting passcode leaked into tool output and agent state](#safe-04-the-meeting-passcode-leaked-into-tool-output-and-agent-state)
    1.  [SAFE-05: Consent notices were acknowledged on the user's behalf](#safe-05-consent-notices-were-acknowledged-on-the-users-behalf)
1.  [Open problems](#open-problems)

## Top lessons

The 12 lessons with the largest consequences in this session, most consequential first.

1.  Never synthesise OS-level keyboard or mouse input on a desktop the user is using; drive pages through the browser extension and windows through focus-free UIA patterns and Win32 messages ([SAFE-02](#safe-02-os-level-keystrokes-went-to-the-users-whatsapp)).
1.  Never activate a window: use no-activate flags for every restore, move and tab switch, and assert that the foreground window is unchanged after each step ([DESK-02](#desk-02-restoring-chrome-stole-focus-and-covered-the-users-work)).
1.  Run a minimise keeper on the capture window from the moment it exists; a minimised Chrome renders nothing, which cost 6.5 minutes of video ([DESK-01](#desk-01-chrome-meeting-window-minimised-during-capture)).
1.  Launch the capture browser with `--disable-features=CalculateNativeWinOcclusion` so it keeps rendering while covered, and verify that frames are not black ([OBS-04](#obs-04-obs-recorded-black-frames-while-chrome-was-covered)).
1.  Join Zoom through the web-client URL `https://<subdomain>.zoom.us/wc/join/<meeting-id>?pwd=<pwd>`; the `/j/` launcher page and the desktop app's guest dialog cannot be automated safely ([ZOOM-05](#zoom-05-zooms-launcher-page-opened-the-desktop-app)).
1.  Check every captured frame for black or uniform output and alert at once, stamped with the real frame time ([CAP-03](#cap-03-the-watcher-missed-black-frames-and-the-gap-was-misdated)).
1.  Detect the meeting end from in-page signals, not the window title, and check every few seconds ([CAP-04](#cap-04-the-watcher-did-not-detect-the-meeting-end)).
1.  Keep a virtualised chat list pinned to the bottom and sweep it top to bottom at intervals and before teardown ([CHAT-02](#chat-02-the-virtualised-chat-list-hid-new-messages)).
1.  Page every read from the page under the tool's 1000-character limit and advance read cursors only after a durable write ([CHAT-03](#chat-03-the-pull-cursor-skipped-messages-that-were-never-saved)).
1.  Never hard-code browser tab IDs; re-resolve tabs by purpose and URL before every scheduled job ([BRW-08](#brw-08-the-extensions-tab-group-and-tab-ids-were-lost)).
1.  Budget RAM and VRAM per stage and run heavy ASR jobs one at a time; concurrent runs were killed with no output ([ASR-02](#asr-02-transcription-jobs-were-killed-for-low-memory)).
1.  Give every ASR pass the event's vocabulary and cross-check two engines window by window; both engines misheard sponsor and venue names ([ASR-04](#asr-04-every-engine-misheard-proper-nouns)).

## Desktop and window management

ID prefix `DESK`: window state, focus and Win32 or UIA control on a desktop the user was using at the same time.

### DESK-01: Chrome meeting window minimised during capture

- **When:** 18:04:21 and 18:14:32 (rehearsal); 19:48:19-19:48:30 (pre-join); about 20:09:35-20:16:00 and 20:28:55 (live meeting).
- **Symptom:** Extension screenshots failed with `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab <id>. The renderer may be frozen or unresponsive.` During the meeting OBS recorded black video: `latest.jpg` was fully black at the 20:15 check-in and `wins.py` showed `'rect': (-32000, -32000, 160, 28), 'minimized': True`. Audio was unaffected because OBS captures Chrome's process audio separately.
- **Cause:** The Chrome window was minimised (IsIconic), and a minimised Chrome stops rendering, so both CDP screenshots and OBS window capture fail. Who minimised it is not established: at 18:14:32 the agent assumed the user did after the focus steal in [DESK-02](#desk-02-restoring-chrome-stole-focus-and-covered-the-users-work); during the meeting the user was actively using the PC and Win+D (show desktop) is suspected. The occlusion flag in [OBS-04](#obs-04-obs-recorded-black-frames-while-chrome-was-covered) covers covered windows, not minimised ones.
- **Fix:** Restored without activation: `SetWindowPlacement` with `showCmd=SW_SHOWNOACTIVATE` and a fixed `rcNormalPosition` on the left monitor, then `SetWindowPos(HWND_BOTTOM, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE)` (`place.py`). At 20:15:53 the agent wrote `keeper.py`, which polls once a second, restores a minimised match, checks that the foreground window is unchanged and appends an `ALERT` line to `watch.log`; it restored Chrome at 20:16:00 and repaired the 20:28:55 minimise within about 1 s. Asking the user not to minimise Chrome (18:28:42, 19:51:49, 20:12:30) did not prevent it.
- **Lesson for the app:** Start a minimise keeper together with the capture window and keep it running for the whole session; check IsIconic before every screenshot; restore without activation; never depend on the user leaving a window alone.
- **Status:** Worked around. The 20:09:35-20:16:00 gap (about 6.5 min, rec about 00:20:22-00:26:54) is missing from the video, including the sponsor slides between Alphared and Replit; the audio has them, and the organisers' own recording in their Drive could fill the gap (download needs user OK). Why the window kept being minimised is open.

### DESK-02: Restoring Chrome stole focus and covered the user's work

- **When:** 18:04:52.
- **Symptom:** `desk.py focus` on the Chrome window restored and maximised Chrome on the user's primary monitor and took focus from the user; Chrome was found minimised again at 18:14:32.
- **Cause:** `desk.py focus` activates its target (alt-tap plus `SetForegroundWindow`) instead of showing it without activation.
- **Fix:** `place.py` with `SW_SHOWNOACTIVATE` and `SWP_NOACTIVATE|SWP_NOZORDER` placed Chrome on the left monitor, later pushed to HWND_BOTTOM. Every later Win32 or UIA step saved `GetForegroundWindow()` first and printed "foreground unchanged".
- **Lesson for the app:** Never activate windows on a shared desktop; every window operation must use no-activate flags (`SW_SHOWNOACTIVATE`, `SWP_NOACTIVATE`, `SW_SHOWMINNOACTIVE`, HWND_BOTTOM) and assert that the foreground window is unchanged afterwards.
- **Status:** Resolved.

### DESK-03: UIA tree walks failed with COM errors

- **When:** 18:06:35, 18:09:19.
- **Symptom:** `_ctypes.COMError: (-2147220991, 'An event was unable to invoke any of the subscribers', (None, None, None, 0, None))` when walking every `Chrome_WidgetWin_1` window, and again from `auto.ControlFromHandle(hwnd)` on Zoom's guest name dialog.
- **Cause:** Some windows do not serve UIA: other Chromium and Electron apps (SpeakWav, Discord, Opera) and Zoom's `zWaitingMeetingIDWndClass` dialog.
- **Fix:** Walk only windows owned by the target PIDs, set `auto.SetGlobalSearchTimeout(2-3)` and wrap each window's walk in try/except.
- **Lesson for the app:** Treat UIA as best effort per app: scope walks to the target process, bound search timeouts and isolate failures per window.
- **Status:** Worked around.

### DESK-04: The user and the agent raced for the same dialog

- **When:** 18:08:12-18:08:35.
- **Symptom:** `LookupError: Find Control Timeout(3s): {Name: 'Open Zoom Meetings', ControlType: ButtonControl}`; Zoom had already opened its name dialog.
- **Cause:** The user clicked Chrome's "Open Zoom Meetings?" prompt first and ticked its Always-allow box ([SAFE-01](#safe-01-a-lasting-browser-permission-was-granted-mid-run)).
- **Fix:** None needed; the desktop app launched.
- **Lesson for the app:** On a shared desktop expect concurrent human actions: re-observe state before each action and treat a vanished element as possibly handled by the user, not as an error to retry.
- **Status:** Resolved.

### DESK-05: A class-name filter missed a Zoom dialog

- **When:** 18:08:47.
- **Symptom:** `no window matching 'zWaitingMeetingIDWndClass'`.
- **Cause:** `zui.py` filtered top-level windows by class prefixes (`ZP`, `zoom`, `Conf`, `Zoom`, `zWin`), none of which match `zWaiting...`.
- **Fix:** Filtered by Zoom.exe PIDs from `tasklist /FI "IMAGENAME eq Zoom.exe" /FO CSV /NH`. With that filter the dialog was still absent from the UIA tree, and `ControlFromHandle` failed ([ZOOM-03](#zoom-03-the-zoom-desktop-guest-name-dialog-could-not-be-automated)).
- **Lesson for the app:** Identify an app's windows by owning process (EnumWindows, GetWindowThreadProcessId, QueryFullProcessImageNameW), never by guessed class names.
- **Status:** Resolved.

### DESK-06: Selecting a Chrome tab through UIA activated Chrome

- **When:** 18:15:36-18:15:39.
- **Symptom:** `foreground unchanged: False`.
- **Cause:** `SelectionItemPattern.Select()` on a Chrome `TabItemControl` activates the Chrome window.
- **Fix:** Save `GetForegroundWindow()` before, call `SwitchToThisWindow(saved, True)` after, then push Chrome to HWND_BOTTOM (`chrome_tab.py restore()`).
- **Lesson for the app:** Wrap any UIA action that may activate a window in save-and-restore focus, and prefer the browser extension's tab APIs to UIA tab-strip control.
- **Status:** Worked around.

### DESK-07: A guessed focus-restore target left no foreground window

- **When:** 18:15:51-18:16:00.
- **Symptom:** `foreground now:` was empty.
- **Cause:** The restore picked the "top non-Chrome window in z-order", which was `SpeakWav`, a tool window.
- **Fix:** Found the terminal by title and called `SwitchToThisWindow`; afterwards the agent always restored the exact saved hwnd.
- **Lesson for the app:** Restore the remembered foreground hwnd, never a guessed one.
- **Status:** Resolved.

### DESK-08: SetWindowPos did not move a maximised window

- **When:** 18:22:50.
- **Symptom:** The relaunched Chrome window, maximised on the primary monitor, did not move with `SetWindowPos`.
- **Cause:** A maximised window keeps its maximised rect.
- **Fix:** `place.py` v2: `SetWindowPlacement` with `rcNormalPosition` and `showCmd=SW_SHOWNOACTIVATE`, then `SetWindowPos`; Chrome moved to (-1920,0,1920,1020) with focus unchanged.
- **Lesson for the app:** Un-maximise through window placement before moving a window, then verify the resulting rect.
- **Status:** Resolved.

## Browser and extension

ID prefix `BRW`: Chrome and the claude-in-chrome extension (tabs, tool limits, permission bubbles, browser lifecycle).

### BRW-01: The extension redacted or blocked script results

- **When:** 18:04:41, 18:19:06, 20:05:30.
- **Symptom:** `javascript_tool` results came back as `[BLOCKED: Cookie/query string data]` (a listing of Join elements and scripts; later the field holding `l.innerHTML.slice(0,1500)`), the iframe host as `[BLOCKED: JWT token]`, and tab URLs with parameters replaced (`pwd=REDACTED`, `_x_zm_rtaid=REDACTED ... wpk=REDACTED`).
- **Cause:** claude-in-chrome filters result text that looks like cookies, query strings or tokens. The filter is inconsistent: `find` results were not filtered and exposed the full passcode ([SAFE-04](#safe-04-the-meeting-passcode-leaked-into-tool-output-and-agent-state)).
- **Fix:** Return only the fields needed (host plus pathname, counts, booleans, parsed text), rewrite URLs to `<host/path>` and never return raw HTML.
- **Lesson for the app:** Treat the page-to-agent channel as lossy and redacting: page scripts must emit minimal structured data with URLs normalised, and secrets must be handled outside that channel.
- **Status:** Worked around.

### BRW-02: A script acted on a page that had already navigated

- **When:** 18:05:47-18:05:55.
- **Symptom:** `TypeError: Cannot read properties of undefined (reading 'click')`.
- **Cause:** The earlier Join click had already moved the tab to `zoom.us/j/<test-meeting-id>?pwd=<pwd>#success`, so the button no longer existed.
- **Fix:** Read `location` and the title before acting.
- **Lesson for the app:** Re-observe page state (URL, title, target element) before retrying any action, and guard every lookup against null.
- **Status:** Resolved.

### BRW-03: Chrome's protocol prompt never appeared for a background tab

- **When:** 18:06:21-18:08:06.
- **Symptom:** Clicking `Join from Zoom Workplace app` (an extension click, then a coordinate click) produced no "Open Zoom Meetings?" prompt and no app launch.
- **Cause:** The extension acts on a background tab, and Chrome renders the external-protocol dialog only for the active tab of a window; the window was showing the Discord tab.
- **Fix:** Activated the tab through Chrome's tab strip (UIA `TabItemControl` plus `SelectionItemPattern.Select()`, the same call that later stole focus in [DESK-06](#desk-06-selecting-a-chrome-tab-through-uia-activated-chrome)) and clicked again; the prompt appeared at 18:08:06.
- **Lesson for the app:** A step that needs a browser-level dialog requires its tab to be in front in its window; prefer flows that need no browser-level dialog at all ([ZOOM-05](#zoom-05-zooms-launcher-page-opened-the-desktop-app)).
- **Status:** Worked around, then avoided.

### BRW-04: Chrome tab names carried extra decorations

- **When:** 18:07-18:25.
- **Symptom:** Accessible tab names included suffixes such as `Part of group` plus the group name, `Memory usage - 139 MB`, `Audio playing`, `High memory usage - 988 MB` and `Permission requested, press F6 to respond`.
- **Cause:** Chrome appends group, memory, audio and permission state to accessible tab names.
- **Fix:** Matched tab names by substring.
- **Lesson for the app:** Match tab and window titles by substring or URL, never by exact string.
- **Status:** Resolved.

### BRW-05: A click used coordinates from the wrong frame

- **When:** 18:18:34.
- **Symptom:** The click on the speaker test's "Yes" missed.
- **Cause:** The coordinate came from the OBS 1920x1080 frame, not the extension's 1536x674 screenshot frame.
- **Fix:** Recomputed (560,490) at 18:18:41. From then on clicks used viewport coordinates from extension screenshots or `getBoundingClientRect`, and the mistake did not recur during the meeting.
- **Lesson for the app:** Tag every coordinate with the frame it came from (source, width, height), refuse clicks across frames, and re-derive coordinates from a fresh screenshot at the current viewport size.
- **Status:** Resolved.

### BRW-06: Chrome showed a notification permission bubble

- **When:** 18:19:54, 18:25:28; a sweep at 19:49:52 found none.
- **Symptom:** A separate top-level Chrome window titled `app.zoom.us wants to` (Show notifications; buttons Close, Allow, Block) appeared, and tab names gained `Permission requested, press F6 to respond`.
- **Cause:** The Zoom web client requested notification permission; the first bubble followed the Fullscreen attempt in [ZOOM-10](#zoom-10-fullscreen-did-not-work-from-a-background-window).
- **Fix:** Invoked the bubble's `Close` button through UIA (neither Allow nor Block) with focus unchanged, and swept for `wants to` windows again before starting the watcher.
- **Lesson for the app:** Watch for Chrome bubble windows by title and dismiss them without granting anything; never grant lasting browser permissions.
- **Status:** Worked around.

### BRW-07: Chrome would not exit gracefully

- **When:** 18:22:05-18:22:57; 22:58.
- **Symptom:** `chrome processes left after graceful close: 16`, then a `Restore pages?` bubble after the relaunch. At 22:58 no Chrome windows were open, but 13 `chrome.exe` processes kept running and `taskkill /im chrome.exe` had no effect.
- **Cause:** Chrome keeps background processes alive after its windows close (background mode); closing the extension's last tab had closed the window.
- **Fix:** `Stop-Process -Name chrome -Force` at 18:22 (not asked first: [SAFE-03](#safe-03-chrome-was-force-restarted-without-asking)) and a force-kill of the browser process tree at 22:58, when the user asked to shut Chrome down and there was no unsaved state. The `Restore pages?` bubble was closed with UIA `Close`. Both times Chrome held no user tabs, since the user browses in Opera.
- **Lesson for the app:** Run the meeting in a browser instance the app owns so it can be killed safely; confirm no user windows exist before a force-kill, and choose "Restore" rather than "Close" if the browser holds user tabs.
- **Status:** Worked around. The next Chrome launch drops the occlusion flag ([OBS-04](#obs-04-obs-recorded-black-frames-while-chrome-was-covered)) and may show `Restore pages?`.

### BRW-08: The extension's tab group and tab IDs were lost

- **When:** 18:23:07 (after the Chrome restart); 22:02:07 (scheduled portal capture).
- **Symptom:** After the restart, `tabs_context_mcp {createIfEmpty:true}` returned a new tab group and new tab IDs, with a stray ungrouped `New Tab`. At 22:02: `Tab 1947363225 is not in Claude's tab group for this session. Tools can only target tabs inside the group.`, followed by `Couldn't determine which page this action targets.`
- **Cause:** A browser restart discards the extension's tab group. The 22:02 loss is unclear: it followed closing the meeting tab with `tabs_close_mcp` at 21:36:36. The third note blames context compaction, but compaction happened at 22:33, after this failure, so the second note's account is used here.
- **Fix:** `tabs_context_mcp {createIfEmpty:true}` and re-navigation (new tab 1947363233 at 22:02). The link-polling prompt already had a fallback that found the discord.com tab again.
- **Lesson for the app:** Never hard-code tab IDs across restarts, tab closes or context compaction; store tabs by purpose and URL, and re-resolve and verify them before every scheduled job.
- **Status:** Worked around.

### BRW-09: Closing a tab through UIA failed

- **When:** 18:25:19.
- **Symptom:** `_ctypes.COMError: (-2147220992, None, (None, None, None, 0, None))` when `chrome_tab.py close "New Tab"` invoked the first ButtonControl under the tab.
- **Cause:** Unclear (wrong button, or not invokable).
- **Fix:** Left the stray tab open.
- **Lesson for the app:** Close tabs through the extension's tab API, not UIA.
- **Status:** Worked around.

### BRW-10: A downscaled screenshot misread typed text

- **When:** 19:48:41.
- **Symptom:** A zoomed screenshot made the typed display name look like "Team 1010NG".
- **Cause:** The screenshot is a JPEG at 0.5 scale, too blurry to read reliably.
- **Fix:** Read `input.value` from the DOM across the top document and same-origin iframes at 19:48:45: `"Team T010NG"`.
- **Lesson for the app:** Verify typed or form state through the DOM or accessibility tree, never by reading a downscaled screenshot.
- **Status:** Resolved.

### BRW-11: The agent called a tool action that does not exist

- **When:** 19:50:53-19:50:54.
- **Symptom:** `Invalid computer action: action: Invalid option: expected one of "left_click"|"right_click"|"type"|"screenshot"|"wait"|"scroll"|"key"|"left_click_drag"|"double_click"|"triple_click"|"zoom"|"scroll_to"|"hover"`.
- **Cause:** `find` is a separate tool, not a `computer` action.
- **Fix:** Located "View Options" with JS `getBoundingClientRect` at (751,180) in the 1522x666 viewport (CSS pixels match the screenshot frame) and clicked there.
- **Lesson for the app:** Validate tool actions against a typed schema before sending them, and compute click targets as element centres inside the page.
- **Status:** Resolved.

### BRW-12: Script results were cut at 1000 characters

- **When:** 21:05:22 onwards (measured on 4 results).
- **Symptom:** String results ended at exactly 1000 characters with a `[TRUNCATED]` suffix.
- **Cause:** A per-string result limit in `javascript_tool`. The agent first guessed "a link with a query string", which was wrong.
- **Fix:** Paged output under the limit: re-read by index ranges (`list.slice(20,33)`, ...), sliced a 963-character message (`t.slice(380,760)`), and wrote `__sdcPull(max)`, which returns TSV lines up to 700-1400 characters per call and reports how many remain. The data loss this caused is [CHAT-03](#chat-03-the-pull-cursor-skipped-messages-that-were-never-saved).
- **Lesson for the app:** Assume a hard size limit on every agent-to-page result: page every read, report the remainder, and never count a truncated read as complete.
- **Status:** Worked around.

### BRW-13: A parallel navigate and read ran before the page loaded

- **When:** 22:02.
- **Symptom:** `Can't interact with browser-internal or unparseable URLs. Navigate to a web page first.`; the reads ran against `chrome://newtab`.
- **Cause:** Navigate, wait and `get_page_text` were issued in parallel, so the reads ran before the new tab had loaded the portal.
- **Fix:** Re-queried the tab context and re-ran `get_page_text` on its own.
- **Lesson for the app:** Run dependent browser steps in sequence and wait for a load condition before reading.
- **Status:** Resolved.

## Zoom

ID prefix `ZOOM`: the Zoom desktop app and the Zoom web client, from settings through join to the in-meeting UI.

### ZOOM-01: A coordinate click on Zoom desktop Settings did nothing

- **When:** 17:59:26.
- **Symptom:** `desk.py click` at (354,820) on the Settings gear opened no Settings window.
- **Cause:** Unclear (wrong point, DPI or focus).
- **Fix:** UIA `InvokePattern` on `ButtonControl 'Settings'` (`zui.py invoke "Zoom Workplace" "Settings" ButtonControl`) opened `ZPSettingWndClass` at 18:01:35.
- **Lesson for the app:** Prefer UIA patterns to synthetic mouse input; they need neither coordinates nor focus.
- **Status:** Resolved.

### ZOOM-02: Zoom join options were not where expected

- **When:** 18:01:55-18:02:33.
- **Symptom:** Settings > Audio and Video & effects had no join-behaviour options.
- **Cause:** In Zoom 7 they live under Settings > `Meetings & webinars`, and their UIA names carry a trailing space (`'Keep my camera off '`).
- **Fix:** Enumerated CheckBox and RadioButton controls per category, matched exact names, toggled with TogglePattern and verified ToggleState: `Show video preview first` off; `Keep my camera off`, `Keep my microphone muted` and `Automatically connect to computer audio` on.
- **Lesson for the app:** Dump the control tree before acting, normalise (trim) control names, and read state back after every toggle.
- **Status:** Resolved; the desktop app was later dropped for the join ([ZOOM-03](#zoom-03-the-zoom-desktop-guest-name-dialog-could-not-be-automated)).

### ZOOM-03: The Zoom desktop guest name dialog could not be automated

- **When:** 18:08:32-18:10:11.
- **Symptom:** The `zWaitingMeetingIDWndClass` "Enter your name" dialog (400x365) was absent from the UIA tree even after PID filtering, and `auto.ControlFromHandle(hwnd)` raised the COMError in [DESK-03](#desk-03-uia-tree-walks-failed-with-com-errors).
- **Cause:** The dialog exposes no UIA tree.
- **Fix:** A keyboard fallback misfired into another app ([SAFE-02](#safe-02-os-level-keystrokes-went-to-the-users-whatsapp)); at 18:14:25 the desktop path was dropped for the Zoom web client in Chrome.
- **Lesson for the app:** Joining through the Zoom desktop app as a guest needs real keystrokes and clicks, so it requires exclusive use of the desktop; join through the web client instead.
- **Status:** Worked around (web client).

### ZOOM-04: The meeting tab drifted to a Zoom marketing page

- **When:** 18:14:54.
- **Symptom:** The meeting tab had moved to `zoom.com/en/lp/my-notes?from=web_join_post_meeting...`.
- **Cause:** Unclear.
- **Fix:** Navigated the tab back to `zoom.us/test`.
- **Lesson for the app:** Check each tab's URL against its expected state before every step and re-navigate when it has drifted.
- **Status:** Worked around.

### ZOOM-05: Zoom's launcher page opened the desktop app

- **When:** 18:16:22 (rehearsal); avoided from 19:47:19.
- **Symptom:** Every visit to a `/j/` page popped up the Zoom desktop app's `Connecting…` and name dialogs; the closer script logged `closed zWaitingMeetingIDWndClass Connecting…`.
- **Cause:** The `/j/` launcher page fires the `zoommtg` protocol, and once the user had ticked Chrome's Always-allow box ([SAFE-01](#safe-01-a-lasting-browser-permission-was-granted-mid-run)) Chrome opened the desktop app without asking.
- **Fix:** `kill_zoom_join.py` posted WM_CLOSE to `zWaiting*` and `ZPConfJoinWndClass` windows every 0.2 s (from 19:34:46 it also minimised the Zoom home window with `SW_SHOWMINNOACTIVE`). For the real join at 19:47:19 the agent navigated straight to `https://us06web.zoom.us/wc/join/<meeting-id>?pwd=<pwd>`, derived from the posted link by swapping `/j/` for `/wc/join/`; it redirected to `app.zoom.us/wc/<meeting-id>/join?...` and no desktop app launched.
- **Lesson for the app:** Derive the web-client URL `https://<subdomain>.zoom.us/wc/join/<meeting-id>?pwd=<pwd>` from any Zoom link and open it directly; never load `/j/` launcher pages.
- **Status:** Resolved.

### ZOOM-06: Pre-join controls were missing from the accessibility tree

- **When:** 18:16:46; the same screen at 18:24:07 and 19:47:33.
- **Symptom:** `find` for "Continue without microphone and camera" failed: "The accessibility tree provided contains only hidden textbox elements...".
- **Cause:** Unclear; the pre-join controls are not in the tree the extension reads.
- **Fix:** Coordinate clicks in the extension's screenshot frame: Continue at about (768,478) in a 1536x674 frame or (760,502) in 1522x722, then the Your Name field and Join. Typing through the extension's `computer` `type` action reaches only the page.
- **Lesson for the app:** Keep a coordinate fallback for pages without semantic markup, re-deriving coordinates from a fresh screenshot at the current viewport size, and prefer DOM queries with `getBoundingClientRect` wherever the DOM is reachable.
- **Status:** Worked around.

### ZOOM-07: The mic and camera prompt appeared twice

- **When:** 18:16:49-18:16:55, 18:24:07-18:24:21, 19:47:33-19:47:45.
- **Symptom:** After "Continue without microphone and camera" a second, near-identical prompt appeared.
- **Cause:** Zoom asks about microphone and camera, then about the microphone alone.
- **Fix:** Clicked "Continue without microphone and camera" twice; mic and camera showed blocked markers, and the mic test showed "Unrecognized microphone1".
- **Lesson for the app:** Repeat a dismissal until the prompt is gone (with a retry bound), then verify that mic and camera are blocked before joining.
- **Status:** Resolved.

### ZOOM-08: Zoom popups and banners covered the meeting view

- **When:** 18:18:41 and 18:18:59-18:19:16 (rehearsal); 19:49:46 (live).
- **Symptom:** A "My Notes" popup, an "Introducing My Notes" popup that ignored coordinate clicks, and an "enable access to your ..." mic and camera banner sat over the meeting view.
- **Cause:** Unclear; these are Zoom web-client prompts, and the banner asks for the mic and camera access that was blocked on purpose.
- **Fix:** Dismissed the first popup with a coordinate click, "Introducing My Notes" through the DOM (`Got it`, see [ZOOM-09](#zoom-09-the-in-meeting-ui-was-invisible-to-the-extensions-page-reader)), and the banner with a JS close-button match (`bannerFound:true, closed:true`). Each check-in also clicked visible `OK` and `Got it` notices ([SAFE-05](#safe-05-consent-notices-were-acknowledged-on-the-users-behalf)).
- **Lesson for the app:** After joining, and at every check-in, dismiss known popups and banners by text match in the DOM so they stay out of the recording.
- **Status:** Resolved.

### ZOOM-09: The in-meeting UI was invisible to the extension's page reader

- **When:** 18:18:59-18:19:16.
- **Symptom:** The "Introducing My Notes" popup ignored coordinate clicks, and `read_page` (interactive) returned nothing.
- **Cause:** In the rehearsal flow the meeting UI lived inside a same-origin `iframe#webclient` (class `pwa-webclient__iframe`), which the extension's accessibility tree did not include.
- **Fix:** Ran JS against `document.getElementById('webclient').contentDocument` and selected buttons by aria-label or text (clicked `Got it` and `View`).
- **Lesson for the app:** Drive the Zoom web client through its DOM, reaching into same-origin iframes and selecting buttons by aria-label.
- **Status:** Resolved.

### ZOOM-10: Fullscreen did not work from a background window

- **When:** 18:19:27-18:19:54.
- **Symptom:** `TypeError: Cannot read properties of undefined (reading 'getBoundingClientRect')` while locating the Fullscreen menu item; coordinate clicks on View, then Fullscreen, did not enter fullscreen and raised a notification permission bubble ([BRW-06](#brw-06-chrome-showed-a-notification-permission-bubble)).
- **Cause:** Unclear; the menu item was not present when queried, and fullscreen probably needs a real user gesture or a focused window.
- **Fix:** Abandoned; cropped the browser toolbar area in OBS instead ([OBS-05](#obs-05-the-crop-drifted-after-the-window-geometry-changed)).
- **Lesson for the app:** Do not rely on fullscreen in a background window; crop the capture instead.
- **Status:** Worked around.

### ZOOM-11: The live meeting UI was in the top document, not the iframe

- **When:** 19:49:09.
- **Symptom:** `JavaScript execution error: TypeError: Cannot read properties of null (reading 'contentDocument')`.
- **Cause:** The rehearsal path (`/j/` page, then "Join from browser") renders the client in `iframe#webclient`; the direct `/wc/join/` URL used live renders it in the top document.
- **Fix:** `const f = document.getElementById('webclient'); const d = (f && f.contentDocument) || document;`.
- **Lesson for the app:** Resolve the app root (iframe or top document) at run time and again after navigation, and rehearse with exactly the join path used live.
- **Status:** Resolved.

### ZOOM-12: View Options menu items had no ARIA roles

- **When:** 19:51:01-19:51:06.
- **Symptom:** After opening View Options, a query for `[role=menuitem]`, `[role=menuitemcheckbox]`, `[role=menuitemradio]`, `[role=option]` and `li a` returned `[]`.
- **Cause:** Unclear; this menu's markup does not use those roles. In the rehearsal at 18:19:16 the items of the `View` menu were listed.
- **Fix:** A screenshot showed only zoom levels and an audio-mute option, so the agent pressed Escape and kept the default layout (slides about 1000 px wide).
- **Lesson for the app:** Fall back to a screenshot when the DOM has no semantic roles, and prefer button aria-labels, which Zoom uses consistently (`open the chat panel`, `participants list`).
- **Status:** Worked around.

## OBS and recording

ID prefix `OBS`: OBS Studio driven through obs-websocket, from scene setup to restoring the user's configuration.

### OBS-01: A PC with a crash history put the recording at risk

- **When:** 17:48 (planning).
- **Symptom:** The PC had blue-screened before (from the agent's memory context).
- **Cause:** Unclear (earlier blue screens on this PC).
- **Fix:** Recorded to MKV, which is recoverable after a crash, instead of MP4, and advised the user not to run MemTest86 until after the meeting.
- **Lesson for the app:** Record into a crash-tolerant container by default.
- **Status:** Resolved; the recording completed.

### OBS-02: Switching scene collections could drop websocket requests

- **When:** 18:03 (handled in the setup script; never seen failing).
- **Symptom:** None observed; the setup script assumed that requests sent across a collection switch can be dropped.
- **Cause:** Unclear; the risk was anticipated, not observed.
- **Fix:** Sleep 3 s and reconnect after `CreateSceneCollection` or `SetCurrentSceneCollection`.
- **Lesson for the app:** Reconnect the websocket after any collection or profile change and verify the active collection before continuing.
- **Status:** Resolved by design.

### OBS-03: Capture sources needed a live window to bind to

- **When:** 18:03:20-18:03:30, 18:17:38, 18:24:38, 19:49:06.
- **Symptom:** At setup the window list held only `Zoom Workplace:ZPPTEnhanceLoginMainWindowClassEx:Zoom.exe`, so the new `Zoom Meeting` (window capture) and `Zoom Audio` (application audio) sources could not bind to a meeting, and the meeting window title changed between runs ("Test Zoom Meeting", "Zoom meeting on web", "SDC Hackathon Orientation"). The user's existing scene still had a Window Capture bound to an old Teams meeting window.
- **Cause:** Window and application-audio sources bind to a `title:class:exe` string that exists only once the meeting window does.
- **Fix:** Created the sources in a dedicated `sdc-hack` collection, then re-bound both with `SetInputSettings` once the meeting window existed, using priority 2 (match title, else same executable); at 19:49:06 bound them to `SDC Hackathon Orientation - Google Chrome:Chrome_WidgetWin_1:chrome.exe` and started recording.
- **Lesson for the app:** Bind window and app-audio sources only after the meeting window exists, re-bind on every title change, check a frame grab before recording, and use a dedicated scene collection so the user's own scenes are never touched.
- **Status:** Resolved.

### OBS-04: OBS recorded black frames while Chrome was covered

- **When:** 18:20:39-18:25:40.
- **Symptom:** After `cropTop: 180` was set, the OBS frame was nearly all black (18:20:46), and the extension's own screenshot showed the tab dark.
- **Cause:** Established: Chrome's native window occlusion tracking stops rendering a fully covered window, and the user's terminal sat over Chrome on the same left-monitor rect.
- **Fix:** Restarted Chrome with `--disable-features=CalculateNativeWinOcclusion` (checked in the browser process command line). Chrome then rendered at HWND_BOTTOM while covered, verified at 18:24:06 and by an OBS frame at 18:25:40. The restart itself was disruptive ([BRW-07](#brw-07-chrome-would-not-exit-gracefully), [SAFE-03](#safe-03-chrome-was-force-restarted-without-asking)).
- **Lesson for the app:** Launch the capture browser with native occlusion disabled before the meeting, verify the flag in its command line, and verify that OBS frames are not black. The flag does not help a minimised window ([DESK-01](#desk-01-chrome-meeting-window-minimised-during-capture)).
- **Status:** Resolved for the session; the flag lasts only for that Chrome launch.

### OBS-05: The crop drifted after the window geometry changed

- **When:** 18:24:38-18:25:40.
- **Symptom:** After Chrome was restarted and re-placed, the source changed from 1920x1020 to 1902x1011, so the 180 px top crop no longer matched the browser toolbar area.
- **Cause:** Re-placing the window changed its client-area size.
- **Fix:** Changed `cropTop` from 180 to 182 and verified with a frame at 18:25:40.
- **Lesson for the app:** Recompute the crop from `GetSceneItemTransform` `sourceWidth` and `sourceHeight` after any geometry change, and verify it with a frame.
- **Status:** Resolved.

### OBS-06: OBS in the tray was slow to exit and lost the collection switch

- **When:** 22:50-22:51.
- **Symptom:** OBS, minimised to the tray, ignored a graceful `taskkill` at first and exited a few seconds later; `global.ini` then showed the profile switched back to `Untitled` but not the scene collection.
- **Cause:** Unclear; the scene collection change made through the websocket was not persisted before exit.
- **Fix:** Waited, verified, and edited `global.ini` `SceneCollection` and `SceneCollectionFile` to `Untitled`; at 22:51 restored the websocket config from `config.json.bak-sdc` (server disabled).
- **Lesson for the app:** Restoring the user's OBS state needs a read-back after exit: check `global.ini`, patch what did not persist, and edit OBS config files only while OBS is not running.
- **Status:** Worked around.

## Watcher and capture quality

ID prefix `CAP`: the watcher (`watch.py`) and the quality of captured video, audio and slide frames.

### CAP-01: Zoom's Audio button suggested audio was not connected

- **When:** 19:49:20-19:49:31.
- **Symptom:** The Audio button read "Audio", not "Mute".
- **Cause:** The label reflects microphone join state (the mic was blocked on purpose), not speaker playback.
- **Fix:** Measured the growing MKV with ffmpeg `volumedetect`: `mean_volume: -20.7 dB`, `max_volume: -1.2 dB`.
- **Lesson for the app:** Verify capture by measuring the artefact (loudness of the growing file, frame brightness), never from UI labels; an MKV can be read while OBS is still writing it.
- **Status:** Resolved.

### CAP-02: Automation overlays were burned into the recording

- **When:** 19:50:09-19:50:40.
- **Symptom:** The extension's glow border and its "Claude is active in this tab group" pill appeared in the OBS frame.
- **Cause:** The extension injects fixed-position elements (`#claude-agent-glow-border`, `#claude-static-indicator-container`) at z-index 2147483646 and 2147483647.
- **Fix:** Injected `<style id="sdc-hide-overlays">` with `display:none !important` and re-added it at every check-in if missing. The pill's X was not clicked, because closing it could drop tab control.
- **Lesson for the app:** An app that records a page it drives must hide its own overlays and re-assert that after navigation, or capture a surface that has none.
- **Status:** Worked around.

### CAP-03: The watcher missed black frames and the gap was misdated

- **When:** About 20:09:35-20:16:00 (noticed at the 20:15 check-in); gap corrected at 21:26:23-21:27:03.
- **Symptom:** The watcher raised no alert while the recording was black, and the first gap estimate (20:12:15-20:16:00) was wrong.
- **Cause:** `watch.py` had no black- or uniform-frame check, so the problem surfaced only at the 10-minute check-in. The estimate used the time of the batched `SLIDES` event (batched every 180 s) instead of the frame time; keyframe filenames later showed the black frame `019_200935` (its crop came out at the full search-region size) and the next real frame at 20:16:07.
- **Fix:** `keeper.py` stopped the cause from recurring ([DESK-01](#desk-01-chrome-meeting-window-minimised-during-capture)); the gap was recomputed from keyframe filenames and contact sheets as 20:09:35-20:16:00, about 6.5 min. `watch.py` itself was not changed.
- **Lesson for the app:** Check every sampled frame for black or uniform output (for example, mean luminance under a threshold) and raise an alert at once, and stamp events with the frame time, not the batch time.
- **Status:** Open; the watcher still has no black-frame check.

### CAP-04: The watcher did not detect the meeting end

- **When:** About 21:16:34 (end) to 21:25:34 (manual stop).
- **Symptom:** The 21:20:03 heartbeat still said `meeting_present=True` and no `ENDED` event fired; the recording ran about 9 minutes past the end (rec 01:27:20 to 01:36:23).
- **Cause:** `meeting_present()` only checks for a Chrome window whose title contains "SDC Hackathon Orientation", and the web client keeps the document title after the host ends the meeting, because the end dialog is in-page. The DOM still showed the toolbar and a stale "107 Participants" (the count had peaked at about 635 at 20:45). Even with a working signal, `--stop-after 21:30` would have allowed only an ALERT before 21:30.
- **Fix:** At the 21:25 check-in the agent saw the ended state (`latest.jpg`, plus one `OK` notice clicked) and stopped OBS by hand at 21:25:34; the real end time was recovered later from keyframe `090_211634_rec012720`.
- **Lesson for the app:** Detect the end from in-page signals (the "meeting has been ended" dialog text, the Leave button disappearing, a participant count that drops or freezes, silence plus a frozen frame for N seconds), check every few seconds, and do not gate end detection on a fixed clock time.
- **Status:** Worked around by a manual stop; automatic end detection is open.

### CAP-05: Raw keyframes needed manual curation

- **When:** 21:26:23-21:29:29.
- **Symptom:** The watcher kept 91 frames for 65 usable slides: 7 pre-show sponsor-loop frames, 12 transitions, near-duplicates or partial frames, 1 black frame and 6 frames from after the share ended.
- **Cause:** The keyframer keeps any frame that is settled (difference from the previous sample at most 2.0), changed (at least 7.0 from the last kept frame) and not a dHash near-duplicate (Hamming distance over 12), whatever the meeting phase; the reason for dropping each frame was inferred from the selection, not recorded.
- **Fix:** Contact sheets (`sheet.py`, 12 frames each), auto-crop to the shared screen (`crop.py`), a hand-made map of 65 slides (`slide_map.tsv`) and WebP export (65 slides, 2.9 MB).
- **Lesson for the app:** Treat watcher keyframes as candidates: tag them with meeting phase and share state, and include a curation step (contact sheets plus human or model review) before publishing slides.
- **Status:** Worked around.

### CAP-06: Slide text was covered in the shared screen

- **When:** Captured during the meeting; flagged at 21:30-21:34 during slide transcription.
- **Symptom:** `[covered]` spots on slides 19, 23, 34, 42, 62 and 65.
- **Cause:** Tutorial callouts, the presenter's cursor or Zoom name labels covered slide text.
- **Fix:** Marked the spots `[covered]` instead of guessing.
- **Lesson for the app:** Mark covered text explicitly and never infer it, and keep several frames per slide so text covered in one frame may be readable in another.
- **Status:** Open; the covered text is still missing.

## Chat capture

ID prefix `CHAT`: capturing Zoom web-client chat through page JavaScript.

### CHAT-01: Snapshot chat capture was noisy and unstructured

- **When:** 19:51:30 (installed) to 20:05.
- **Symptom:** `innerText` snapshots of the chat list held lines like `"ZU"` and `"AO"` (avatar initials) and `"1".."6"`, with no message boundaries.
- **Cause:** The first observer (`window.__sdcChat`) stored the whole list's text, not messages.
- **Fix:** Dumped the unique class names once, then installed the structured parser `window.__sdcMsgs`: each `.chat-item-container` read with `.chat-item__sender`, `.chat-item__receiver`, `.new-chat-item__chat-info-time-stamp` and `.new-chat-message__text-box`, carrying sender and time forward for grouped consecutive messages and deduplicating by id or a `sender|time|text` key.
- **Lesson for the app:** Discover the chat item structure once, then parse messages structurally, carrying sender and time forward for grouped messages.
- **Status:** Resolved (the old observer stayed installed but unused).

### CHAT-02: The virtualised chat list hid new messages

- **When:** Found at 21:05:35; sweeps at 21:06:58 and 21:19:09-21:19:41.
- **Symptom:** During the busy Q&A, new messages were not being captured.
- **Cause:** The chat panel was scrolled up and Zoom renders only visible items, so the MutationObserver never saw new ones. Why it was scrolled up is unclear; probably Zoom stops auto-scrolling once the panel is not at the bottom.
- **Fix:** `__sdcScroll` set the scroll container's `scrollTop = scrollHeight` every 1.5 s; a top-to-bottom sweep in steps of `max(200, clientHeight/2)` px with 300-350 ms waits recovered 10 messages (52 to 62); a pre-emptive sweep and pull at 21:19, because chat disappears when the meeting ends, brought the saved total to 104 lines.
- **Lesson for the app:** Keep a virtualised list pinned to the bottom, sweep it fully at intervals, and always sweep and save before teardown.
- **Status:** Worked around.

### CHAT-03: The pull cursor skipped messages that were never saved

- **When:** 21:05:22-21:07:35.
- **Symptom:** The 21:05 check-in set `m.pulled = m.list.length`, marking 18 messages as read while half of the returned text was lost to `[TRUNCATED]` ([BRW-12](#brw-12-script-results-were-cut-at-1000-characters)).
- **Cause:** The cursor advanced when messages were read, not after they were written to disk.
- **Fix:** Re-read by index ranges, wrote `__sdcPull(max)` to advance only past lines it actually returns, rewound by hand (`__sdcMsgs.pulled = 46`) for 2 messages marked read but never written, and re-pulled: 62 lines saved at 21:07:35. Rows went to disk through `chat_batch.tsv` and a Python append ([ENV-08](#env-08-powershell-appends-were-fragile-with-quotes-and-non-ascii-text)).
- **Lesson for the app:** Use an acknowledge protocol: advance a read cursor only after a durable write, or make pulls idempotent by index.
- **Status:** Resolved.

### CHAT-04: Chat records were duplicated and fuzzy

- **When:** 21:35:23.
- **Symptom:** `99 unique of 104` lines in `chat_snaps.jsonl`.
- **Cause:** No stable message ids, re-fetches, senders inherited for grouped messages, and thread replies with an empty `to` that embed the quoted question. Zoom's `time` field has only minute resolution, and recovered messages carry a `seen` time equal to the recovery time.
- **Fix:** Deduplicated on `(sender, time, text[:200])`, which also collapses genuine repeats posted in the same minute; `chat.md` lists 99 messages in Zoom-timestamp order with thread replies after their parent.
- **Lesson for the app:** Capture Zoom's message id if one exists; otherwise keep the raw log, store capture time separately from message time, and deduplicate at write-up with review.
- **Status:** Worked around.

## Scheduling, state and agent harness

ID prefix `AGENT`: cron scheduling, durable state, event monitoring and Claude Code harness behaviour.

### AGENT-01: Large tool outputs were saved to files

- **When:** 18:00:48-18:01:27.
- **Symptom:** Large `gh api` outputs (133.9 KB) were auto-persisted to files instead of returned inline and had to be grepped.
- **Cause:** The harness persists large tool outputs to files.
- **Fix:** Grepped the persisted files.
- **Lesson for the app:** Request filtered, structured results from tools, and plan for large outputs to be stored and searched rather than read inline.
- **Status:** Worked around.

### AGENT-02: The harness moved a shell call to the background

- **When:** 18:08:35.
- **Symptom:** A PowerShell call was moved to the background by the harness, and its output had to be read from the task file.
- **Cause:** Unclear; harness behaviour with no recorded trigger.
- **Fix:** Read the output from the task file.
- **Lesson for the app:** Wrappers must cope with a call being backgrounded and collect its result from wherever the harness puts it.
- **Status:** Worked around.

### AGENT-03: The meeting link was posted late

- **When:** 18:28:24-19:34:42 (link posted at 19:32 for a 20:00 start).
- **Symptom:** 12 polls from 18:34 to 19:29 found no Zoom link; it appeared in Discord #announcements at 19:32.
- **Cause:** The organisers posted the link 28 minutes before the start.
- **Fix:** A recurring cron poll (`2-59/5 18-19 19 10 *`) ran a JS check on the logged-in Discord tab; when the link appeared the agent deleted the poll and set a one-shot join cron for 19:47 (`47 19 19 10 *`). A fallback to other channels and Gmail at about 19:40 was planned. The cron jobs were session-only and would have died with the Claude process.
- **Lesson for the app:** Poll the announced source on a schedule with a deadline-driven escalation path (more sources, then the user), and run the scheduler in a process that outlives the agent session.
- **Status:** Resolved.

### AGENT-04: The scheduled join did not follow the stored plan

- **When:** 19:47:19.
- **Symptom:** The stored `join_plan` said to click the Discord link, pass the "Leaving Discord" interstitial and use "Join from browser" on the `/j/` page; the agent instead navigated straight to the `/wc/join/` URL.
- **Cause:** The executing turn chose a better primitive than the one recorded in state.
- **Fix:** None needed; the join worked with no desktop-app launch ([ZOOM-05](#zoom-05-zooms-launcher-page-opened-the-desktop-app)), though it exposed the DOM difference in [ZOOM-11](#zoom-11-the-live-meeting-ui-was-in-the-top-document-not-the-iframe).
- **Lesson for the app:** Encode one canonical join primitive in code rather than in prose plans, and update stored plans whenever the method changes.
- **Status:** Resolved.

### AGENT-05: The recurring check-in prompt went stale

- **When:** From 20:05 (prompt written at 19:51:35).
- **Symptom:** The check-in cron prompt told each run to use `window.__sdcChat` and `__sdcChatPulled`, but from 20:05 the real capture was `__sdcMsgs`, and later `__sdcPull`.
- **Cause:** The prompt described helper internals, which changed after it was written.
- **Fix:** The agent adapted at each run.
- **Lesson for the app:** Scheduled jobs should call one stable, versioned entry point (for example `window.__sdc.checkin()`), not describe its internals.
- **Status:** Worked around.

### AGENT-06: The event monitor expired every 30 minutes

- **When:** 20:20:10, 20:50:15, 21:20:19 (first armed at 19:50:06).
- **Symptom:** `[Monitor expired after 30m with N events delivered. Re-arm it if you still need the watch.]`
- **Cause:** The Monitor on `watch.log` was started with a 30-minute timeout (`timeout_ms=1800000`).
- **Fix:** Re-armed by hand with the same command at 20:20:14, 20:50:18 and 21:20:23.
- **Lesson for the app:** A supervisor must keep the event stream alive for the whole session and alert if it lapses.
- **Status:** Worked around.

## Transcription

ID prefix `ASR`: local Whisper and OpenAI transcription.

### ASR-01: The plan included an obsolete LLM polish stage

- **When:** 17:44:10-17:47:24.
- **Symptom:** The user interrupted mid-research (17:47:11) and said the Gemini "polish" step was obsolete.
- **Cause:** The transcriber has a `--polish` Gemini mode (its config had `polish false` and a `gemini_model` set), which the agent was considering.
- **Fix:** Ran without `--polish`; the agent post-processed the transcript by hand.
- **Lesson for the app:** Confirm which pipeline stages are current before planning, and make optional stages explicit opt-ins.
- **Status:** Resolved.

### ASR-02: Transcription jobs were killed for low memory

- **When:** 21:36:12 (the third note says about 21:35; the second note's timestamp is used).
- **Symptom:** `Background command "Extract FLAC and transcribe with Whisper medium" was stopped because the system is running low on memory`; the large-v3 job got the same message, and no outputs were written.
- **Cause:** As judged by the agent: CPU large-v3 (about 10 GB RAM; it does not fit the 4 GB GPU) ran alongside GPU medium, Chrome and OBS, leaving 4.1 of 31.2 GB free on Windows (WSL: 15,993 MB total, 10,191 MB available). Claude Code's background-shell memory-pressure reaper killed both; `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` at startup disables it, and the harness says not to restart without user approval.
- **Fix:** Checked that no transcriber, whisper or ffmpeg processes were left in WSL (killing the Windows side does not always end them), closed the Zoom tab, asked the user (21:36:47), re-ran medium alone on the GPU from 21:56:57 (34m35.9s), and replaced large-v3 with an OpenAI pass after the user approved sending the audio off the machine.
- **Lesson for the app:** Budget RAM and VRAM per stage, run heavy model jobs one at a time, check for orphans on both sides of the WSL boundary, and get consent before restarting killed work or moving audio to a cloud service.
- **Status:** Worked around.

### ASR-03: The diarized cloud pilot cost more than the quote

- **When:** 21:57:00-21:59:55.
- **Symptom:** 5 minutes on `gpt-4o-transcribe-diarize` (`diarized_json`) used 14,069 tokens (`input_tokens 5186`: audio 4886, text 300; `output_tokens 8883`), about US$0.10 per 5 minutes or about US$2 for the meeting, against the "under US$1" quoted to the user.
- **Cause:** The verbose diarized format inflates output tokens, and published audio-input pricing was ambiguous (US$2.50/M versus an older US$6/M).
- **Fix:** Switched to plain `gpt-4o-transcribe` (`response_format=json`, 3-minute chunks, vocabulary prompt): audio in 54,000, text in 3,360 and out 13,427 tokens, about US$0.28-0.47. The agent told the user (about US$0.50 plus about US$0.10 for the pilot) and offered the diarized run for about US$2 more; speakers were attributed by hand from introductions and hand-overs.
- **Lesson for the app:** Pilot and price one chunk before a full cloud run, report a cost range when pricing is ambiguous, and re-confirm with the user when the pilot exceeds the quote.
- **Status:** Resolved, without automatic diarization.

### ASR-04: Every engine misheard proper nouns

- **When:** 22:32-22:35 (cross-check review, then clip re-checks at 22:35).
- **Symptom:** Whisper medium wrote "SIAMON University Malaysia" (Xiamen), "STC Hackathon" (SDC), "Replet", "Run pod" and "from 25th to 23rd October". The third note lists errors across both passes without attributing each one: Iversiti or iVersity (AIverseCity), Replet, Run pod, Salman or Siaman (Xiamen) and Sabang (Sepang); a speaker's initials were also heard as a first name.
- **Cause:** Sponsor, venue and product names lie outside the models' vocabulary, and the local Whisper command passed no vocabulary prompt.
- **Fix:** A second pass with `gpt-4o-transcribe` and a vocabulary prompt listing proper nouns, a side-by-side file per 3-minute window (`xcheck.md`), and at 22:35 16 uncertain spots cut into 20-80 s clips and re-checked with `gpt-4o-transcribe` and `whisper-1`. Remaining doubts were written as `_(as heard: "...")_`.
- **Lesson for the app:** Give every ASR pass the event's vocabulary (sponsors, venue, products, taken from the announcement, portal and slides), cross-check two engines window by window, and re-check disputed spots as short clips.
- **Status:** Resolved for this transcript.

### ASR-05: ASR hallucinated on silence and unclear audio

- **When:** 22:32-22:35 (cross-check review); 23:16-23:18 (tutorial videos).
- **Symptom:** Whisper medium produced "you" every 30 s and "Thank you for watching!" over silence; `gpt-4o-transcribe` returned its prompt text verbatim for silent chunks; Whisper hallucinated a repeated line in an unclear stretch of a tutorial video.
- **Cause:** Both models emit text when there is no clear speech, and `gpt-4o-transcribe` echoes its prompt when there is none.
- **Fix:** Found in the side-by-side review; silent stretches became italic notes in the transcript, and the unclear video stretch (no burned-in captions there) was marked unclear.
- **Lesson for the app:** Run voice activity detection or skip silent windows before ASR, flag prompt echoes and repeated lines automatically, and never trust a single pass.
- **Status:** Worked around by hand; there is no VAD step.

### ASR-06: Each engine dropped different passages

- **When:** 22:32-22:35.
- **Symptom:** Whisper medium skipped the start of two tutorial videos and a 20-second rules passage; the OpenAI pass was cleaner but less granular.
- **Cause:** Unclear.
- **Fix:** The clip re-checks recovered the missing passages and the tutorial videos' start times; those paragraphs took their times from the clip re-check.
- **Lesson for the app:** Diff engines window by window to find gaps, and re-transcribe disputed spans as short clips.
- **Status:** Resolved.

### ASR-07: whisper-1 clip results were unreliable

- **When:** 22:35.
- **Symptom:** `whisper-1` (`verbose_json`) returned an empty transcript for one clip, and its segment timestamps drifted by a few seconds.
- **Cause:** Unclear.
- **Fix:** Used it as one input among several; transcript times were later checked against the local medium segments ([WRITE-03](#write-03-hand-written-transcript-timestamps-were-off-by-seconds)).
- **Lesson for the app:** Anchor timestamps to one trusted local pass and treat cloud segment times as approximate.
- **Status:** Worked around.

## Write-up

ID prefix `WRITE`: turning transcripts, slides and chat into the Markdown deliverables.

### WRITE-01: Sources contradicted each other

- **When:** 21:26-23:21.
- **Symptom:** Slides 47 and 49 conflict ("31 Oct: Physical hackathon @ XMUM" versus "Final ... Live on 1 Nov @ XMUM"); three spoken dates still disagreed across ASR passes; spoken facts contradicted slides and documents (dates, deadlines, rooms); and the participant handbook on Drive had 7 contradictions with other official documents.
- **Cause:** The organisers' own sources disagree with each other.
- **Fix:** Kept both slide values and flagged an open question; recorded spoken dates as heard alongside the slide value; at 22:47 added the official handbook's online-mentorship window (19-25 Oct, from the repo's `docs/sources/sdchack.my/`) as context for an unclear spoken date; wrote a "Conflicts between sources" section in the Drive README and verified each claimed conflict against the source text.
- **Lesson for the app:** Never resolve contradictions silently: record what was said as heard, cite the authoritative source next to it, and collect every conflict in one section for the user.
- **Status:** Open; the conflicts are documented, not resolved.

### WRITE-02: The contents generator picked up headings inside a code fence

- **When:** 22:42.
- **Symptom:** The generated contents list in `slides.md` had 3 extra entries, taken from a README shown in a fenced code block on slide 42.
- **Cause:** The generator matched every heading line, including those inside fences.
- **Fix:** Matched only `## Slide NN:` headings.
- **Lesson for the app:** Strip fenced code before parsing headings, and check generated contents against the expected heading count.
- **Status:** Resolved.

### WRITE-03: Hand-written transcript timestamps were off by seconds

- **When:** 22:45-22:46.
- **Symptom:** 12 paragraphs of the hand-written `transcript.md` were 4-14 s off.
- **Cause:** Their times had been estimated inside long Whisper segments.
- **Fix:** A script fuzzy-matched the first 7 words of every paragraph against medium segments within ±90 s, and the 12 were corrected; low-score matches were passages medium had missed, whose times came from the clip re-check.
- **Lesson for the app:** Verify every timestamp in a hand-edited transcript against segment timings automatically.
- **Status:** Resolved.

### WRITE-04: A summary misreported an organiser's answer

- **When:** Not timestamped in the notes (recorded with the 22:02 portal results).
- **Symptom:** The organisers' chat answer "pitching session 5 to 7 minutes", given to "how long is the pitching session? and are there dress codes?", was described in the agent's own summary as the pitch video length.
- **Cause:** Unclear.
- **Fix:** None recorded; the second note flags the error.
- **Lesson for the app:** Keep every summarised answer attached to its question and a citation so a reviewer can check it.
- **Status:** Open; no correction is recorded.

## Publishing

ID prefix `PUB`: copying deliverables into the Git repo, commit hooks and pushing.

### PUB-01: The requested folder name differed from the precedent

- **When:** 18:32:05-18:37:00.
- **Symptom:** The user asked for `~/CS/sdc-hack/docs/source/`, but the precedent repo used `docs/sources/opening-briefing/`.
- **Cause:** The user's wording differed from the existing layout.
- **Fix:** Asked; the user chose to match the precedent repo and push straight to `main` without a PR.
- **Lesson for the app:** Derive the target layout from existing precedent and confirm any difference from what the user typed before writing.
- **Status:** Resolved.

### PUB-02: Prettier rewrote files at commit time

- **When:** 22:48, 23:21.
- **Symptom:** At 22:48 the Prettier check reformatted 2 files (table alignment, nested list indent from 4 to 2 spaces, one blank line); at 23:21 it reformatted a README embedded in a code block in the Drive docs (table alignment, `*` to `_`).
- **Cause:** The repo enforces Prettier formatting, which also reformats Markdown embedded in code blocks.
- **Fix:** Copied the formatted files back so the Downloads and repo copies stay identical, and changed "verbatim" to "with its wording unchanged" for the embedded README. The third note suggests a `text` fence as an alternative.
- **Lesson for the app:** Run the target repo's formatter on deliverables before the final copy and before calling any quoted text verbatim, and fence quoted Markdown as `text`.
- **Status:** Worked around.

### PUB-03: The pre-commit hook failed under Node 16

- **When:** 22:48:40.
- **Symptom:** The husky pre-commit hook failed in lint-staged with `TypeError: util.styleText is not a function`.
- **Cause:** Non-interactive WSL shells resolved `node` to `/usr/bin/node` v16 instead of nvm's Node v24.
- **Fix:** Prefixed `PATH` with nvm's Node v24 for the commit, leaving the hook unchanged; pushed `3bb70d2 docs: add opening briefing sources` at 22:49:00.
- **Lesson for the app:** Pin toolchain paths explicitly in non-interactive shells, and never bypass hooks.
- **Status:** Worked around.

### PUB-04: Files were committed with the executable bit

- **When:** 22:49:00-22:49:21.
- **Symptom:** The committed files had mode 100755.
- **Cause:** They were copied from `/mnt/c`, where drvfs reports the exec bit.
- **Fix:** Follow-up commit `d651e50 docs: drop exec bit from opening briefing` at 22:49:21 (chmod 644; no force-push).
- **Lesson for the app:** Normalise file modes (chmod 644) before `git add` when copying from Windows mounts, and check the staged diff for mode changes.
- **Status:** Resolved.

## Post-event sources

ID prefix `SRC`: material gathered after the meeting: the hackathon portal and the organisers' Google Drive folder.

### SRC-01: Drive items would not open in the browser

- **When:** 22:02-22:03.
- **Symptom:** For the "Domain 1" item inside folder "1. Domain 1", `/file/d/<id>/view` redirected back to the folder, and `/drive/folders/<id>` returned `Error 404 (Not Found)!!1`.
- **Cause:** The third note's more specific account is used: Drive folder pages lazy-load in the browser, and opening a file id as a folder returns 404. The second note records the cause as unclear (an unusual item type).
- **Fix:** Stopped there, since opening the problem statement was out of scope at that point, and saved a scrubbed portal capture (`portal_problem_statements.txt`, without bank details or teammates' emails). The folder was scraped later without the browser ([SRC-02](#src-02-the-drive-connector-could-not-list-a-link-shared-folder)).
- **Lesson for the app:** Do not scrape Drive through its interactive UI; list and download through endpoints that return plain data, and treat unknown item types as manual follow-ups.
- **Status:** Worked around.

### SRC-02: The Drive connector could not list a link-shared folder

- **When:** 23:01-23:03.
- **Symptom:** The Google Drive MCP connector read files and metadata by id, but `search_files` with `parentId` returned nothing for a link-shared folder that is not in the user's Drive.
- **Cause:** The folder is link-shared and not in the user's Drive, and the connector's search returned nothing for it.
- **Fix:** At 23:02 listed the tree from `https://drive.google.com/embeddedfolderview?id=<folder>`, which returns plain HTML for a link-shared folder, parsing it recursively for file ids; at 23:03 downloaded 15 files (about 1 GB) with `https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t`, which handles the large-file confirm page. Sizes matched the Drive metadata.
- **Lesson for the app:** Support link-shared Drive folders through the embedded folder view and the usercontent download endpoint, and verify every download's size against metadata.
- **Status:** Worked around.

### SRC-03: Text extraction from Canva PDFs was garbled

- **When:** 23:05-23:09.
- **Symptom:** PyMuPDF text from the Canva-exported PDFs (8-65 pages) doubled words and broke tables.
- **Cause:** Unclear.
- **Fix:** Rendered every page to a 90 dpi PNG alongside the per-page text, and had agents read and verify against the page images.
- **Lesson for the app:** For designed PDFs, read rendered page images and use extracted text only as a cross-check.
- **Status:** Worked around.

### SRC-04: A sample-repo zip carried someone's git history

- **When:** 23:05-23:09.
- **Symptom:** The sample-repo zip contained a full `.git` directory (someone's history) and `__MACOSX` junk.
- **Cause:** The organisers' archive included them.
- **Fix:** Extracted only the working-tree files.
- **Lesson for the app:** Strip VCS metadata and OS junk from imported archives by default, and never publish another person's history.
- **Status:** Resolved.

### SRC-05: Scene detection found almost no frames in a screen recording

- **When:** 23:08.
- **Symptom:** ffmpeg `select=gt(scene,0.12)` found only 2 frames in a screen-recorded tutorial.
- **Cause:** Unclear beyond the video being a screen recording.
- **Fix:** Sampled at fixed intervals (every 5-7 s), deduplicated by frame difference, and built contact sheets with time labels.
- **Lesson for the app:** For screen recordings, sample at fixed intervals and deduplicate by pixel difference instead of relying on scene detection.
- **Status:** Worked around.

### SRC-06: A tutorial video had no narration

- **When:** 23:16-23:18.
- **Symptom:** Whisper output for the Summary Submission video was empty.
- **Cause:** The video has no narration.
- **Fix:** Sampled it at 1 fps, kept frames whose mean pixel difference exceeded 6, and read the burned-in captions from contact sheets.
- **Lesson for the app:** Probe each video for speech before ASR, and fall back to reading captions from deduplicated frames when there is none.
- **Status:** Resolved.

## Shell and environment

ID prefix `ENV`: Windows, PowerShell, Git Bash, WSL and Python tooling.

### ENV-01: A SessionStart hook path was mangled by bash

- **When:** 17:36:20.
- **Symptom:** `/usr/bin/bash: line 1: C:UsersUser.claudehooksgraphify-refresh.cmd: command not found`.
- **Cause:** A Windows path with backslashes was executed by bash, which ate the backslashes.
- **Fix:** None; the error did not block the session.
- **Lesson for the app:** Pass Windows paths to bash with forward slashes or quoting.
- **Status:** Open.

### ENV-02: WSL's distro listing printed UTF-16 text

- **When:** 17:43:53.
- **Symptom:** `wsl.exe -l -v` output could not be read as plain text in bash.
- **Cause:** `wsl.exe` writes this listing as UTF-16LE.
- **Fix:** Piped it through `iconv -f utf-16le`.
- **Lesson for the app:** Normalise the encoding of Windows CLI output in wrappers.
- **Status:** Worked around.

### ENV-03: Sleep or lock could have broken the capture

- **When:** 17:57 (changed); 22:50-22:51 (restored).
- **Symptom:** AC standby and AC display-off were both 300 min (0x4650), the screensaver flag was on with no timeout, and a lock screen would break window capture.
- **Cause:** The PC's power settings allowed standby during a long unattended session.
- **Fix:** `powercfg /change standby-timeout-ac 0` (verified 0x00000000) with the old value recorded; display-off left at 300 min; the user asked to keep the PC plugged in, awake and unlocked. Standby was restored to 300 at 22:50-22:51 from PowerShell ([ENV-11](#env-11-git-bash-mangled-a-windows-command-switch)).
- **Lesson for the app:** Disable standby (and consider display-off and lock) for the session, record the original values, and restore and verify them afterwards.
- **Status:** Resolved.

### ENV-04: Hidden-process logs had mojibake

- **When:** 18:16:22.
- **Symptom:** `Connectingâ€¦` in the `kill_zoom_join.py` log.
- **Cause:** Redirected stdout was encoded as cp1252 and read as UTF-8.
- **Fix:** None recorded.
- **Lesson for the app:** Force UTF-8 for child-process output (`PYTHONIOENCODING=utf-8` or reconfigure stdout).
- **Status:** Open.

### ENV-05: Start-Process split a quoted argument

- **When:** 18:27:21.
- **Symptom:** `watch.py: error: unrecognized arguments: Chrome` and `Stop-Process : Cannot find a process with the process identifier 32860.`
- **Cause:** An `-ArgumentList` array element "Google Chrome" was split at the space, and the process exited before `Stop-Process` ran.
- **Fix:** Passed one string with escaped quotes (``"`"$sp\watch.py`" --title `"Google Chrome`" ..."``) and checked `$p.HasExited` before killing; the rerun at 18:27:54 worked.
- **Lesson for the app:** Launch helpers with an explicit argument vector or one fully quoted string, and guard every kill against an already-exited process.
- **Status:** Resolved.

### ENV-06: Pillow warned about a deprecated call

- **When:** 18:27:54.
- **Symptom:** `DeprecationWarning: Image.Image.getdata is deprecated and will be removed in Pillow 14 (2027-10-15). Use get_flattened_data instead.`
- **Cause:** The watcher's dHash code uses `Image.getdata`.
- **Fix:** None; the warning is not fatal.
- **Lesson for the app:** Pin dependency versions and fix deprecations before they become failures.
- **Status:** Open.

### ENV-07: Successful commands reported non-zero exit codes

- **When:** 18:32:30, 21:28:15.
- **Symptom:** A WSL inspection command reported `Exit code 1` despite good output; the crop run reported `Exit code 255` although all 91 lines printed and the output was complete.
- **Cause:** `grep` returns 1 when nothing matches; per the agent, `| Select-Object -First 91 | Out-String` ended the PowerShell pipeline early, which aborted the native process.
- **Fix:** Checked the outputs and artefacts instead of the exit code.
- **Lesson for the app:** Judge success by the artefacts, normalise exit codes in wrappers, and never truncate native output with `Select-Object -First`.
- **Status:** Worked around.

### ENV-08: PowerShell appends were fragile with quotes and non-ASCII text

- **When:** 20:05-21:06:44.
- **Symptom:** Appending chat rows through a PowerShell here-string piped to `Add-Content -Encoding utf8`, and through `[pscustomobject] | ConvertTo-Json -Compress | Add-Content`, worked but broke easily on quotes and non-ASCII text; reading the file later needed `encoding='utf-8-sig'`.
- **Cause:** Shell quoting of captured text; the BOM probably came from PowerShell 5.1 `Add-Content -Encoding utf8` creating the file (inferred in the notes).
- **Fix:** Wrote rows with the Write tool to `chat_batch.tsv`, then appended them as JSONL with Python (`ensure_ascii=False`).
- **Lesson for the app:** Never pass captured text through shell quoting; write it with a real encoder and read it back with BOM tolerance.
- **Status:** Worked around.

### ENV-09: Each helper script ran as two processes

- **When:** 21:25:34-21:25:37.
- **Symptom:** Stopping the helpers killed `47100` and `46980` for `watch.py`, and `31396` and `16360` for `keeper.py`.
- **Cause:** On Windows the venv `python.exe` is a launcher that spawns the base interpreter as a child.
- **Fix:** Killed by command line through `Win32_Process`.
- **Lesson for the app:** Track helpers by command line or launch the base interpreter directly, and stop every process a helper owns.
- **Status:** Worked around.

### ENV-10: Inline Python failed through two layers of shell quoting

- **When:** 22:32:23-22:32:34.
- **Symptom:** `SyntaxError: unexpected character after line continuation character`.
- **Cause:** Backslash-escaped quotes inside an f-string expression, which Python before 3.12 rejects (WSL has Python 3.10), made worse by nested quoting through `wsl.exe bash -lc` and a heredoc.
- **Fix:** Wrote `xcheck.py` to a file and ran `python3 xcheck.py <out.md>`.
- **Lesson for the app:** Never inline non-trivial code through two shells; write a script file and run it.
- **Status:** Resolved.

### ENV-11: Git Bash mangled a Windows command switch

- **When:** 22:50-22:51.
- **Symptom:** `powercfg /change standby-timeout-ac 300` failed from Git Bash with "Invalid Parameters".
- **Cause:** MSYS converts `/change` into a path.
- **Fix:** Ran the command from PowerShell (`MSYS_NO_PATHCONV=1` is the alternative).
- **Lesson for the app:** Run Windows CLIs from PowerShell, or disable MSYS path conversion when calling them from Git Bash.
- **Status:** Resolved.

## Safety and consent incidents

ID prefix `SAFE`: incidents that touched the user's apps, data, permissions, secrets or consent.

### SAFE-01: A lasting browser permission was granted mid-run

- **When:** 18:08:06-18:08:35.
- **Symptom:** Chrome's "Open Zoom Meetings?" prompt offered `Always allow zoom.us to open links of this type in the associated app`. The agent deliberately left it unticked, but the user clicked the prompt and ticked it.
- **Cause:** The flow needed a browser-level dialog ([BRW-03](#brw-03-chromes-protocol-prompt-never-appeared-for-a-background-tab)), and the user answered it first ([DESK-04](#desk-04-the-user-and-the-agent-raced-for-the-same-dialog)).
- **Fix:** None for the permission; its side effect, desktop-app launches from every `/j/` page ([ZOOM-05](#zoom-05-zooms-launcher-page-opened-the-desktop-app)), was avoided by using the web-client URL. The restore steps in the notes do not mention reverting it.
- **Lesson for the app:** Never grant lasting browser permissions, record every permission change made during a run by anyone, and offer to revert them at restore.
- **Status:** Open.

### SAFE-02: OS-level keystrokes went to the user's WhatsApp

- **When:** 18:09:29-18:10:11.
- **Symptom:** `desk.py` sent Ctrl+A and "Team T010NG" after the Zoom name dialog had already closed; the next screenshot showed WhatsApp in front. Enter was never pressed.
- **Cause:** Nothing checked that `GetForegroundWindow()` was the target immediately before typing; the dialog had disappeared (probably closed by the user), and alt-tap plus `SetForegroundWindow` does not guarantee focus.
- **Fix:** The agent stopped, told the user to check WhatsApp for unsent "Team T010NG" text, and banned OS-level keyboard and mouse input while the user is present; all later input went through the extension (page-scoped), UIA patterns or Win32 messages that need no focus.
- **Lesson for the app:** Never synthesise OS-level input on a shared desktop; if it is unavoidable, verify the foreground window and the target immediately before each keystroke and abort otherwise, and disclose any misfire at once.
- **Status:** Resolved.

### SAFE-03: Chrome was force-restarted without asking

- **When:** 18:22:05-18:22:57.
- **Symptom:** To fix the black frames in [OBS-04](#obs-04-obs-recorded-black-frames-while-chrome-was-covered) the agent closed Chrome, force-stopped its remaining processes, relaunched it with a flag and closed `Restore pages?`, all without asking the user.
- **Cause:** The fix needed a relaunch with `--disable-features=CalculateNativeWinOcclusion`.
- **Fix:** None needed: Chrome held only the agent's window (`Zoom - Google Chrome`), since the user browses in Opera.
- **Lesson for the app:** Ask before restarting or killing any app the user might be using, and launch the capture browser with its required flags from the start so no mid-session restart is needed.
- **Status:** Resolved; no harm recorded.

### SAFE-04: The meeting passcode leaked into tool output and agent state

- **When:** 19:34:39 (work_state); 19:47:08-19:47:14 (`find` output).
- **Symptom:** The extension's `find` on the Discord tab returned the meeting link with the full passcode, although `javascript_tool` redacts query strings ([BRW-01](#brw-01-the-extension-redacted-or-blocked-script-results)); the agent's work_state stored the link (passcode included) and the meeting ID, and its cron prompt also carried the meeting ID.
- **Cause:** Filtering differs between extension tools, and the agent kept secrets in plain state.
- **Fix:** None recorded beyond reducing other reads to host and path.
- **Lesson for the app:** Treat meeting passcodes as secrets: keep them in a secret store, pass them by reference, and redact them from logs, tool output, prompts and persisted state.
- **Status:** Open.

### SAFE-05: Consent notices were acknowledged on the user's behalf

- **When:** 19:48:58, about 20:05, 21:25:20.
- **Symptom:** Zoom showed "This meeting is being transcribed", a notice when the host started cloud recording, and an end-of-meeting dialog, each waiting for a click.
- **Cause:** Zoom shows these notices to participants and waits for acknowledgement.
- **Fix:** At 18:13:35 the user pre-approved accepting Zoom's guest terms and acknowledging recording notices. Check-ins clicked only visible buttons matching `/^(OK|Got it)$/` and never mute, unmute, start video or leave. The 21:25 click was logged only as a count, so which dialog it closed is inferred.
- **Lesson for the app:** Get explicit consent up front for each class of notice, auto-acknowledge only an allowlist, and log the text of every notice clicked and when.
- **Status:** Resolved.

## Open problems

Problems still unsolved, then problems that were only worked around; both lists are inputs for the app's requirements.

Unsolved:

- [DESK-01](#desk-01-chrome-meeting-window-minimised-during-capture): why Chrome kept being minimised is unknown, and the 6.5-minute video gap is unfilled.
- [CAP-03](#cap-03-the-watcher-missed-black-frames-and-the-gap-was-misdated): the watcher still has no black- or uniform-frame check.
- [CAP-04](#cap-04-the-watcher-did-not-detect-the-meeting-end): there is no automatic meeting-end detection; the end was found at a check-in and the recording stopped by hand.
- [CAP-06](#cap-06-slide-text-was-covered-in-the-shared-screen): text covered on six slides is still missing.
- [WRITE-01](#write-01-sources-contradicted-each-other): contradictions between slides, speech and documents are listed, not resolved.
- [WRITE-04](#write-04-a-summary-misreported-an-organisers-answer): no correction of the misreported pitching-session answer is recorded.
- [SAFE-01](#safe-01-a-lasting-browser-permission-was-granted-mid-run): Chrome's Always-allow permission for zoom.us links is not recorded as reverted.
- [SAFE-04](#safe-04-the-meeting-passcode-leaked-into-tool-output-and-agent-state): passcodes and meeting IDs sat in plain tool output and agent state with no secret handling.
- [ENV-01](#env-01-a-sessionstart-hook-path-was-mangled-by-bash): the SessionStart hook path is still mangled by bash.
- [ENV-04](#env-04-hidden-process-logs-had-mojibake): child-process logs still come out as cp1252.
- [ENV-06](#env-06-pillow-warned-about-a-deprecated-call): the Pillow deprecation is unfixed.

Only worked around:

- [DESK-03](#desk-03-uia-tree-walks-failed-with-com-errors): UIA walks still fail on some apps; failures are isolated, not fixed.
- [DESK-06](#desk-06-selecting-a-chrome-tab-through-uia-activated-chrome): UIA tab selection still activates Chrome; focus is restored afterwards.
- [BRW-01](#brw-01-the-extension-redacted-or-blocked-script-results): the extension still redacts results; scripts return minimal fields.
- [BRW-03](#brw-03-chromes-protocol-prompt-never-appeared-for-a-background-tab): browser-level dialogs still need their tab in front; the flow now avoids them.
- [BRW-06](#brw-06-chrome-showed-a-notification-permission-bubble): notification bubbles are closed, not prevented.
- [BRW-07](#brw-07-chrome-would-not-exit-gracefully): Chrome still needs a force-kill to exit.
- [BRW-08](#brw-08-the-extensions-tab-group-and-tab-ids-were-lost): lost tab groups are re-created, not kept.
- [BRW-09](#brw-09-closing-a-tab-through-uia-failed): tabs cannot be closed through UIA.
- [BRW-12](#brw-12-script-results-were-cut-at-1000-characters): script results are still cut at 1000 characters; reads are paged.
- [ZOOM-03](#zoom-03-the-zoom-desktop-guest-name-dialog-could-not-be-automated): the desktop guest dialog stays unautomatable; the web client is used instead.
- [ZOOM-04](#zoom-04-the-meeting-tab-drifted-to-a-zoom-marketing-page): why the tab drifted to a marketing page is unknown.
- [ZOOM-06](#zoom-06-pre-join-controls-were-missing-from-the-accessibility-tree): pre-join controls are clicked by coordinates.
- [ZOOM-10](#zoom-10-fullscreen-did-not-work-from-a-background-window): fullscreen does not work; the capture is cropped instead.
- [ZOOM-12](#zoom-12-view-options-menu-items-had-no-aria-roles): View Options cannot be driven through the DOM.
- [OBS-06](#obs-06-obs-in-the-tray-was-slow-to-exit-and-lost-the-collection-switch): OBS does not persist a collection switch before a tray exit; `global.ini` is patched by hand.
- [CAP-02](#cap-02-automation-overlays-were-burned-into-the-recording): the extension's overlays are hidden with injected CSS that must be re-asserted.
- [CAP-05](#cap-05-raw-keyframes-needed-manual-curation): keyframes need manual curation.
- [CHAT-02](#chat-02-the-virtualised-chat-list-hid-new-messages): the virtualised chat list needs pinning and sweeps.
- [CHAT-04](#chat-04-chat-records-were-duplicated-and-fuzzy): chat deduplication is heuristic and can merge genuine repeats.
- [AGENT-01](#agent-01-large-tool-outputs-were-saved-to-files): large tool outputs land in files.
- [AGENT-02](#agent-02-the-harness-moved-a-shell-call-to-the-background): the harness may background a call without warning.
- [AGENT-05](#agent-05-the-recurring-check-in-prompt-went-stale): scheduled prompts still describe helper internals.
- [AGENT-06](#agent-06-the-event-monitor-expired-every-30-minutes): the event monitor must be re-armed every 30 minutes.
- [ASR-02](#asr-02-transcription-jobs-were-killed-for-low-memory): heavy ASR jobs are serialised by hand; there is no memory budgeting.
- [ASR-05](#asr-05-asr-hallucinated-on-silence-and-unclear-audio): hallucinations and prompt echoes were removed by hand; there is no VAD step.
- [ASR-07](#asr-07-whisper-1-clip-results-were-unreliable): cloud clip timestamps drift.
- [PUB-02](#pub-02-prettier-rewrote-files-at-commit-time): Prettier rewrites deliverables after they are written.
- [PUB-03](#pub-03-the-pre-commit-hook-failed-under-node-16): non-interactive WSL shells still resolve Node 16; `PATH` is patched per commit.
- [SRC-01](#src-01-drive-items-would-not-open-in-the-browser): Drive's browser UI is unusable for scraping.
- [SRC-02](#src-02-the-drive-connector-could-not-list-a-link-shared-folder): link-shared Drive folders need the embedded folder view.
- [SRC-03](#src-03-text-extraction-from-canva-pdfs-was-garbled): Canva PDF text is unusable; pages are read as images.
- [SRC-05](#src-05-scene-detection-found-almost-no-frames-in-a-screen-recording): scene detection is replaced by fixed-interval sampling.
- [ENV-02](#env-02-wsls-distro-listing-printed-utf-16-text): `wsl.exe` output needs re-encoding.
- [ENV-07](#env-07-successful-commands-reported-non-zero-exit-codes): exit codes are unreliable; artefacts are checked instead.
- [ENV-08](#env-08-powershell-appends-were-fragile-with-quotes-and-non-ascii-text): captured text bypasses shell quoting through files.
- [ENV-09](#env-09-each-helper-script-ran-as-two-processes): helpers are stopped by command line because each runs as two processes.
