# Techniques

The configuration, commands and code patterns that worked in the session, stage by stage. Longer code lives in [reference-scripts](../reference-scripts/README.md); this page gives the essentials and the reasons behind them.

Contents:

1.  [OBS Studio through obs-websocket](#obs-studio-through-obs-websocket)
    1.  [Isolated profile and scene collection](#isolated-profile-and-scene-collection)
    1.  [Sources, crop and transform](#sources-crop-and-transform)
    1.  [Requests used](#requests-used)
    1.  [Verifying the capture](#verifying-the-capture)
1.  [Chrome as the capture target](#chrome-as-the-capture-target)
1.  [Zoom](#zoom)
    1.  [Joining as a guest in the web client](#joining-as-a-guest-in-the-web-client)
    1.  [Web client DOM](#web-client-dom)
    1.  [Desktop client settings through UI Automation](#desktop-client-settings-through-ui-automation)
1.  [Driving pages through the browser extension](#driving-pages-through-the-browser-extension)
1.  [Windows desktop control without stealing focus](#windows-desktop-control-without-stealing-focus)
1.  [Link discovery, scheduling and state](#link-discovery-scheduling-and-state)
1.  [Watcher, keeper and end detection](#watcher-keeper-and-end-detection)
1.  [Chat capture](#chat-capture)
1.  [Slides: cropping, curation and transcription](#slides-cropping-curation-and-transcription)
1.  [Transcription](#transcription)
    1.  [Audio extraction](#audio-extraction)
    1.  [Local Whisper](#local-whisper)
    1.  [OpenAI chunked cross-check](#openai-chunked-cross-check)
    1.  [Clip re-checks](#clip-re-checks)
    1.  [Merging into the final transcript](#merging-into-the-final-transcript)
1.  [Write-up format: the three-file set](#write-up-format-the-three-file-set)
1.  [Publishing to the repository](#publishing-to-the-repository)
1.  [Post-event sources](#post-event-sources)
    1.  [Logged-in portal](#logged-in-portal)
    1.  [Link-shared Google Drive folder](#link-shared-google-drive-folder)
    1.  [PDFs, zips and videos](#pdfs-zips-and-videos)
1.  [Restore and cleanup](#restore-and-cleanup)

## OBS Studio through obs-websocket

### Isolated profile and scene collection

- Clone the user's profile folder (`%APPDATA%\obs-studio\basic\profiles\Untitled` to `...\sdc-hack`) while OBS is closed, then edit `basic.ini`: `[General] Name=sdc-hack`, `[SimpleOutput] RecFormat2=mkv`, `RecQuality=HQ`. MKV survives a crash; MP4 doesn't.
- Enable the websocket by editing `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` (`server_enabled: true`, keep the existing password) after backing it up. Clients read the password from that file at run time and never print it.
- Launch without focus: `obs64.exe --profile sdc-hack --collection sdc-hack --minimize-to-tray --disable-shutdown-check`, with the working directory set to `bin\64bit` (OBS fails to find its data otherwise).
- After creating or switching a scene collection, wait about 3 seconds and reconnect the websocket client.

### Sources, crop and transform

- **Video**: `window_capture` with `{"method": 2, "cursor": false, "client_area": true, "priority": 2, "window": "<title>:Chrome_WidgetWin_1:chrome.exe"}`. Method 2 is Windows Graphics Capture; priority 2 matches the title first, then any window of the same executable, which survives title changes.
- **Audio**: `wasapi_process_output_capture` (application audio) bound to the same window string. Only Chrome's audio is recorded, so the user's microphone and other apps stay out; the user must not mute Chrome (headphones are fine) and should browse in another browser.
- **No global sources**: the new collection has no Desktop Audio or Mic/Aux.
- **Transform**: bounds 1920x1080, `OBS_BOUNDS_SCALE_INNER`; crop the browser's tab strip and toolbar with `cropTop` (180 for a 1920x1020 client area, 182 for 1902x1011). Recompute after any window-size change from `GetSceneItemTransform`'s `sourceWidth`/`sourceHeight`, then check a frame.
- **Binding**: window and app-audio sources can only bind once the target window exists. Re-bind with `SetInputSettings` after the meeting tab is open and its title is known.

### Requests used

`GetVersion`, `GetProfileList`, `GetSceneCollectionList`, `CreateSceneCollection`, `SetCurrentSceneCollection`, `SetCurrentProfile`, `GetCurrentProgramScene`, `GetInputList`, `CreateInput`, `SetInputSettings`, `GetInputSettings`, `SetInputMute`, `GetInputPropertiesListPropertyItems` (property `window`, to list `title:class:exe` choices), `GetSceneItemId`, `SetSceneItemTransform`, `GetSceneItemTransform`, `GetSourceScreenshot`, `StartRecord`, `StopRecord`, `GetRecordStatus` (`output_active`, `output_timecode`, `output_bytes`).

```python
import base64, obsws_python as obs
cl = obs.ReqClient(host="localhost", port=4455, password=pw, timeout=15)
r = cl.get_source_screenshot("Scene", "png", 1920, 1080, -1)
png = base64.b64decode(r.image_data.split(",", 1)[1])
```

### Verifying the capture

- **Video**: grab a frame and check its mean brightness (black frames are about 0; the live meeting was about 90).
- **Audio**: measure the growing MKV while it records: `ffmpeg -i <latest.mkv> -map 0:a -af volumedetect -f null -` (mean about -21 dB during the meeting). Don't trust Zoom's Audio button label; it reflects the microphone, not playback.
- **Rehearsal**: a 12-second recording of `zoom.us/test` checked with `ffprobe` (h264 1920x1080, AAC 48 kHz) and a Whisper run.

## Chrome as the capture target

- **Keep rendering when covered**: launch Chrome with `--disable-features=CalculateNativeWinOcclusion`. Without it, Chrome stops painting a window that another window fully covers and OBS records black. Verify the flag on the browser process: `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ? { $_.CommandLine -notmatch '--type=' }`.
- **Minimised is different**: the flag doesn't help when the window is minimised. Restore it without activation (see the keeper below).
- **Placement**: put the window on the monitor the user isn't using, at a fixed rectangle, at the bottom of the z-order, so the user's windows cover it while it still renders.
- **Restart sequence** (to add the flag): post `WM_CLOSE` to titled Chrome windows, wait up to 20 seconds, force-stop leftovers, relaunch with the flag, close the "Restore pages?" bubble through UI Automation, restore focus to the saved window.
- **Bubble windows**: Chrome shows permission and restore prompts as separate top-level `Chrome_WidgetWin_1` windows titled like `app.zoom.us wants to` or `Restore pages?`. Dismiss them with UI Automation `ButtonControl 'Close'` and `InvokePattern`, never Allow or Block. The "Open Zoom Meetings?" protocol prompt only renders for the active tab of the window.
- **Tab names** carry decorations ("Audio playing", "Permission requested, press F6 to respond", memory usage), so match them by substring.

## Zoom

### Joining as a guest in the web client

1.  Take the posted link `https://<sub>.zoom.us/j/<meeting-id>?pwd=<pwd>` and change `/j/` to `/wc/join/`: `https://<sub>.zoom.us/wc/join/<meeting-id>?pwd=<pwd>`. It redirects to `app.zoom.us/wc/<meeting-id>/join?...` ("Zoom meeting on web") and never fires the desktop app. The `/j/` page fires the `zoommtg://` protocol, which opens Zoom desktop once the user has ticked "Always allow".
2.  Click "Continue without microphone and camera"; Zoom asks twice (camera and microphone, then microphone alone). These controls aren't in the accessibility tree, so click by coordinates taken from a fresh screenshot of the same viewport.
3.  Type the display name, then verify it from the DOM (`input.value`), not from a downscaled screenshot.
4.  Click Join (this accepts Zoom's guest terms; ask the user first). Acknowledge recording and transcription notices with OK only if pre-approved.
5.  Verify devices are off: the browser shows blocked markers and Zoom's audio test shows "Unrecognized microphone".

For rehearsal, `https://zoom.us/test` starts a test meeting.

### Web client DOM

- **Root**: when joined through `/j/` then "Join from browser", the in-meeting UI is in a same-origin `iframe#webclient`; when joined through `/wc/join/`, it's in the top document. Resolve at run time: `const f = document.getElementById('webclient'); const d = (f && f.contentDocument) || document;`.
- **Buttons by `aria-label`**: `open the chat panel`, `open the participants list pane,[N] particpants` (Zoom's typo), `audio` / `More audio controls`, `Video` / `More video controls`, `View`, `Share`, `React`, `More meeting control ` (trailing space), `Leave`. Leaving takes `Leave` then a button whose text matches `/leave meeting/i`.
- **Chat**: `.chat-container__chat-list` contains `.chat-item-container` items with `.chat-item__sender`, `.chat-item__receiver`, `.new-chat-item__chat-info-time-stamp` (minute resolution) and `.new-chat-message__text-box`. Grouped consecutive messages omit sender and time; carry them forward. The list is virtualised.
- **Notices**: buttons with text `OK` or `Got it`; click only these, only when visible, and log each.
- **No semantic menus**: the View Options menu has no ARIA roles; fall back to a screenshot.
- **Body text** exposes the meeting title, participant count and your own display name.
- The in-page helpers are in `reference-scripts/browser/`: [zoom-root.js](../reference-scripts/browser/zoom-root.js), [zoom-checkin.js](../reference-scripts/browser/zoom-checkin.js), [zoom-chat-capture.js](../reference-scripts/browser/zoom-chat-capture.js), [zoom-verify-inputs.js](../reference-scripts/browser/zoom-verify-inputs.js), [zoom-hide-agent-overlays.js](../reference-scripts/browser/zoom-hide-agent-overlays.js) and [zoom-leave.js](../reference-scripts/browser/zoom-leave.js).

### Desktop client settings through UI Automation

Zoom desktop 7.1.9 exposes its main windows to UI Automation but not the guest name dialog (`zWaitingMeetingIDWndClass`), so the desktop client can't join unattended without real keystrokes. Its settings can be set without focus:

- Invoke `ButtonControl 'Settings'` on the home window; select `ListItemControl 'Meetings & webinars'`.
- Toggle (and verify `ToggleState`): `'Show video preview first '` off; `'Keep my camera off '`, `'Keep my microphone muted '`, `'Automatically connect to computer audio '` on. The names end with a space.
- Close desktop join dialogs that a launcher page opens by posting `WM_CLOSE` in a loop (`kill_zoom_join.py`); minimise the home window with `ShowWindow(hwnd, SW_SHOWMINNOACTIVE)`.
- Identify Zoom's windows by `Zoom.exe` process id, not by class-name guesses.

## Driving pages through the browser extension

- The extension acts on a tab group it owns. Re-query tabs (`tabs_context_mcp`) at the start of every scheduled job; tab ids die when Chrome restarts and the group can disappear.
- **Output limits**: `javascript_tool` results are cut at 1,000 characters (`[TRUNCATED]`), and values that look like cookies, query strings or tokens come back as `[BLOCKED: ...]`. Return small structured values, reduce URLs to `host + pathname`, page long data with a cursor that advances only past what was returned, and re-read by index when something is lost. The `find` tool is not filtered and can expose passcodes.
- **Overlays**: the extension draws a glow border and an "active" pill into the page, which OBS records. Hide them with an injected style (`#claude-agent-glow-border, #claude-static-indicator-container { display: none !important; }`, [zoom-hide-agent-overlays.js](../reference-scripts/browser/zoom-hide-agent-overlays.js)) and re-add it at each check-in; don't close the pill, which may release the tab.
- **Coordinates**: clicks use the screenshot's viewport frame (for example 1522x666 CSS pixels). Compute element centres with `getBoundingClientRect` rather than reading them off a screenshot, and never reuse coordinates from another frame (such as an OBS capture).
- **Background tabs**: screenshots of a minimised window time out (`CDP ... Page.captureScreenshot timed out after 30000ms`); restore the window first.

## Windows desktop control without stealing focus

- **DPI**: call `SetProcessDpiAwareness(2)` before any coordinate work.
- **Find windows by process**: `EnumWindows` + `GetWindowThreadProcessId` + `QueryFullProcessImageNameW` ([wins.py](../reference-scripts/desktop/wins.py)). A minimised window reports the rectangle `(-32000,-32000,...)`.
- **Move without activating** ([place.py](../reference-scripts/desktop/place.py)):

```python
wp.showCmd = 4  # SW_SHOWNOACTIVATE
wp.rcNormalPosition = RECT(x, y, x + w, y + h)
user32.SetWindowPlacement(hwnd, byref(wp))
user32.SetWindowPos(hwnd, 0, x, y, w, h, 0x0010 | 0x0004)      # SWP_NOACTIVATE | SWP_NOZORDER
user32.SetWindowPos(hwnd, 1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # HWND_BOTTOM
```

- **Focus discipline**: save `GetForegroundWindow()` before any step, restore exactly that window with `SwitchToThisWindow(saved, True)` if it changed, and log "foreground unchanged" per step.
- **UI Automation**: filter top-level windows by target process ids, set a 2 to 3 second search timeout, and wrap each walk in `try/except COMError` (other Chromium and Electron apps raise `-2147220991`). Selecting a Chrome tab through `SelectionItemPattern.Select()` activates the window, so restore focus afterwards ([chrome_tab.py](../reference-scripts/desktop/chrome_tab.py)).
- **Never** send OS-level keystrokes or mouse events while the user is at the PC ([desk.py](../reference-scripts/desktop/desk.py) was retired after an incident).
- **Background helpers**: start with `Start-Process python.exe -ArgumentList "<one quoted string>" -WindowStyle Hidden -RedirectStandardOutput <log>`; an array argument splits values with spaces. A venv's `python.exe` spawns the base interpreter as a child, so stop helpers by command line, not by the launcher's pid.

## Link discovery, scheduling and state

- **Find the link**: read the newest messages of the logged-in Discord channel with page JavaScript, returning time, text, Zoom-link count and meeting ids only ([discord-latest-messages.js](../reference-scripts/browser/discord-latest-messages.js)).
- **Poll**: a session cron every 5 minutes from 18:02 (`2-59/5 18-19 19 10 *`) with a self-contained prompt; once found, delete the poll and schedule a one-shot join (`47 19 19 10 *`). The link arrived at 19:32 for an 8 PM start.
- **Live check-ins**: a cron every 10 minutes during the meeting (`4-59/10 20-21 19 10 *`) running the check-in probe, chat pull, frame review, Discord check and keeper check. Prompts should call stable helpers, not describe their internals, because the helpers evolve.
- **Event stream**: a 30-minute Monitor on `tail -F watch.log | grep SLIDES|ALERT|ENDED|ERROR|HEARTBEAT`, re-armed when it expires.
- **Durable state**: a claude-mem `work_state` list holding the goal, permissions, setup facts, join plan, file paths, process ids, restore list and numbered tasks. Scheduled prompts and the post-compaction agent read it.

## Watcher, keeper and end detection

- **watch.py** ([capture/watch.py](../reference-scripts/capture/watch.py)), every 2 seconds:
  - Read `GetRecordStatus`, check whether a Chrome window with the meeting title exists, grab a 1920x1080 frame.
  - **Keyframe rule**: on a 128x72 greyscale thumbnail of the left 74% of the frame (excluding the chat panel), keep a frame when it has settled (mean difference from the previous sample at most 2.0) and changed (at least 7.0 from the last kept frame), and its 256-bit dHash differs from every kept frame by more than 12 bits.
  - Save `NNN_HHMMSS_recHHMMSS.png`, plus `latest.jpg` every 30 seconds.
  - Log `SLIDES` (batched every 3 minutes), `HEARTBEAT` (10 minutes), `ALERT` (window gone or recording inactive), `ENDED` (window gone 60 seconds after `--stop-after`, or `--hard-stop`; stops recording), `ERROR` (reconnects).
- **keeper.py** ([capture/keeper.py](../reference-scripts/capture/keeper.py)), every second: if the meeting window is minimised, restore it with `SW_SHOWNOACTIVATE` to its fixed rectangle, push it to `HWND_BOTTOM`, and log an `ALERT` with "focus unchanged". Start it with the watcher, not after a gap.
- **End detection that would have worked**: the window title doesn't change when the host ends a web-client meeting. Use in-page signals instead: the "meeting has been ended" dialog text, the Leave button disappearing, the participant count freezing, or a frozen frame plus silence for N seconds, checked every few seconds.
- **Black-frame alarm** (missing in the session): alert when frame brightness is near zero or the auto-crop returns the full search region.

## Chat capture

The final design ([zoom-chat-capture.js](../reference-scripts/browser/zoom-chat-capture.js)):

1.  A `MutationObserver` plus a 3-second timer parse `.chat-item-container` items into `{seen, time, sender, to, text}`, de-duplicated by element id or `sender|time|text`.
2.  `window.__sdcScroll` keeps the list scrolled to the bottom every 1.5 seconds, because Zoom only renders visible items.
3.  A sweep scrolls the list top to bottom in half-screen steps with 300 to 350 ms pauses so every item renders once; run it periodically and before the meeting can end (it recovered 10 messages).
4.  `window.__sdcPull(max)` returns tab-separated lines up to `max` characters, with URLs reduced to `<host/path>`, and advances its cursor only past the lines returned. The agent saved each page to a file before pulling the next.
5.  Pages were written with the Write tool to a TSV, then appended to JSONL with Python, avoiding PowerShell's quoting and encoding problems.
6.  At write-up, de-duplicate on `(sender, time, text[:200])` (104 to 99) and review by hand.

## Slides: cropping, curation and transcription

- **Contact sheets**: 12 keyframes per sheet, 480x270 thumbnails labelled with file names ([capture/sheet.py](../reference-scripts/capture/sheet.py)); the agent reviews them visually.
- **Auto-crop** ([capture/crop.py](../reference-scripts/capture/crop.py)): within the region below Zoom's "You are viewing" bar and left of the chat panel (`0,290` to `1410,962`), keep the span of rows and columns where at least 4% of sampled pixels are brighter than 40. Most crops came out at 1118x634; an all-black frame returns the whole region, which doubles as a black-frame detector.
- **Curation**: drop the pre-show loop, transitions, near-duplicates, partial frames, the black frame and post-share frames; map kept frames to slide numbers and titles in a TSV; export WebP at quality 90, method 6.
- **Text**: four parallel subagents, 16 to 17 slides each, with a strict output shape (`## Slide NN: Title`, image line, text) and rules: transcribe faithfully, ignore Zoom UI, mark `[covered]` and `[illegible]`, never invent, describe app screenshots in one italic line, never transcribe other people's usernames or messages. Concatenate and validate the heading sequence, image paths and whitespace.
- **Contents list**: generate anchors with GitHub's slug rule, and match only `## Slide NN:` headings (a README inside a fenced block once added stray headings).

## Transcription

### Audio extraction

```bash
ffmpeg -hide_banner -loglevel error -y -i "<recording>.mkv" -map 0:a -ac 1 -ar 48000 -c:a flac <name>.flac
```

### Local Whisper

```bash
cd ~/CS/whisper-transcriber && uv run transcriber <name>.flac -m medium -l en -f txt,srt,json
```

- 34.6 minutes for 96 minutes of audio on a 4 GB RTX 3050 Ti when run alone. Run one model at a time; `large-v3` doesn't fit 4 GB of VRAM, and running it on the CPU alongside other jobs got both jobs killed.
- Expect hallucinations on silence ("you", "Thank you for watching!"); drop them or use voice-activity detection.

### OpenAI chunked cross-check

- Cut the audio into 3-minute 16 kHz mono 64 kbps MP3 chunks; POST each to `/v1/audio/transcriptions` with `model=gpt-4o-transcribe`, `language=en`, `response_format=json`, and a `prompt` listing proper nouns (organisations, sponsors, product and place names). Skip chunks already done, so the script can resume ([transcription/run.sh](../reference-scripts/transcription/run.sh)).
- Read the key from the user's `.env` inside a subshell and print only its length.
- Price a single chunk first: `gpt-4o-transcribe-diarize` with `diarized_json` cost about US$0.10 per 5 minutes, about four times the plain model.
- Silent chunks come back as the prompt text; discard output that equals the prompt.

### Clip re-checks

For each uncertain spot (names, dates, passages one pass dropped), cut a 20 to 80 second clip and send it to `gpt-4o-transcribe` for text and to `whisper-1` with `response_format=verbose_json` and `timestamp_granularities[]=segment` for timestamps ([transcription/clips.sh](../reference-scripts/transcription/clips.sh)). `whisper-1` sometimes returns nothing and its timestamps drift a few seconds.

### Merging into the final transcript

- Build a side-by-side file per 3-minute window: local paragraphs with timestamps against the cloud text ([transcription/xcheck.py](../reference-scripts/transcription/xcheck.py)).
- Write the transcript by hand from it: speakers from introductions and hand-overs, proper nouns from the slides, uncertain words as `_(as heard: "...")_`, silent stretches as italic notes, times from recording start.
- Verify every paragraph's timestamp by fuzzy-matching its first seven words against the local segments within 90 seconds ([transcription/check_ts.py](../reference-scripts/transcription/check_ts.py)); 12 of about 110 paragraphs were 4 to 14 seconds off.
- Where a spoken fact contradicts the slides or documents, keep it as heard and cite the authoritative source.

## Write-up format: the three-file set

Taken from an earlier briefing in the user's other repo:

- `transcript.md`: H1, intro (event, date, time, attendance), contents, `## Speakers` (name, role, time span), `## Messages` with `**[HH:MM:SS] Speaker:** text` paragraphs.
- `slides.md`: H1, intro, contents, then `## Slide NN: Title`, `![Slide NN: Title](slides/NN.webp)` and the slide text, with tables only for tabular content.
- `chat.md`: H1, intro (sources of answers), contents, `## Messages` with `**[h:mm PM] Sender:** text` and, under each question, `- **Answer:**` citing transcript times and slide numbers. Thread replies follow their parent; invite links are removed.
- Repo style: single H1, short intro, "Contents:" list with lazy numbering, sentence-case headings, no hard wraps, no trailing whitespace.

## Publishing to the repository

```bash
git pull --ff-only
cp -r <deliverables> docs/sources/<name>/ && chmod 644 docs/sources/<name>/**/*   # drop the /mnt/c exec bit
export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$HOME/.bun/bin:$PATH        # hooks need Node 24 and bun
bun install && bunx prettier --write docs/sources/<name>/*.md
git add docs/sources/<name> && git commit -m "docs: add <name> sources" && git push origin main
```

- Copy Prettier's output back to the user's folder so both copies match.
- Check links and anchors with a script before committing.
- Fix mistakes with a follow-up commit, never a force-push.

## Post-event sources

### Logged-in portal

`get_page_text` for the content plus a JavaScript link list reduced to `host + pathname` ([links-host-path.js](../reference-scripts/browser/links-host-path.js)); exclude payment details and other people's emails before saving.

### Link-shared Google Drive folder

- The Drive connector reads files by id but can't list a link-shared folder that isn't in the user's Drive.
- **List**: `https://drive.google.com/embeddedfolderview?id=<folder-id>` returns plain HTML with each entry's link and title; recurse into subfolders ([sources/drive_ls.py](../reference-scripts/sources/drive_ls.py)).
- **Download**: `https://drive.usercontent.google.com/download?id=<file-id>&export=download&confirm=t` skips the large-file confirmation page ([sources/drive_get.py](../reference-scripts/sources/drive_get.py)). Compare sizes with the connector's metadata; an HTML error page can masquerade as the file.
- Put downloads in their own empty folder and process them as data.

### PDFs, zips and videos

- **PDFs** (Canva exports): extract text per page and render each page to PNG with PyMuPDF ([sources/pdf_dump.py](../reference-scripts/sources/pdf_dump.py)); text extraction doubles words and scrambles tables, so agents read the page images to transcribe.
- **Comparing with existing copies**: normalise and diff in order ([sources/mddiff.py](../reference-scripts/sources/mddiff.py)) and as word bags ([sources/bagdiff.py](../reference-scripts/sources/bagdiff.py)) before adding a duplicate.
- **Zips**: extract the working tree only; skip `.git` (it held someone's history) and `__MACOSX`; never run the code.
- **Videos**: `ffprobe` for length and audio; Whisper for narration; fixed-interval frames (every 5 to 7 seconds) for screen recordings, since scene-change detection found only 2 frames in one; for videos without narration, sample once a second, keep frames whose mean difference exceeds 6, and read the captions from labelled contact sheets ([capture/grid.py](../reference-scripts/capture/grid.py)).

## Restore and cleanup

- Run Windows commands with `/switches` from PowerShell; Git Bash rewrites `/change` into a path (`Invalid Parameters`).
- `powercfg /change standby-timeout-ac <original minutes>`.
- OBS: `SetCurrentProfile` and `SetCurrentSceneCollection` back to the originals through the websocket, close OBS, then check `global.ini` (`Profile`, `ProfileDir`, `SceneCollection`, `SceneCollectionFile`) and patch any key that didn't persist; restore the websocket config from its backup.
- OBS minimised to the tray takes several seconds to exit after `taskkill` without `/f`.
- Chrome with no windows may keep running in the background; end its browser process tree only after confirming it has no windows.
- Delete scratch data after the user confirms the results are safe elsewhere; keep the scripts and logs needed for documentation.
