# Runbook

A step-by-step playbook for an agent (Claude Code with the claude-in-chrome extension on Windows) to attend, record and write up an online meeting for a user, distilled from this session with its fixes applied. Each phase ends with a gate: don't move on until it passes. Recipes are in [techniques](techniques.md), scripts in [reference-scripts](../reference-scripts/README.md).

Contents:

1.  [Before you start](#before-you-start)
1.  [Phase 1: intake](#phase-1-intake)
1.  [Phase 2: prepare the machine](#phase-2-prepare-the-machine)
1.  [Phase 3: rehearse](#phase-3-rehearse)
1.  [Phase 4: wait for the link](#phase-4-wait-for-the-link)
1.  [Phase 5: join and start capture](#phase-5-join-and-start-capture)
1.  [Phase 6: monitor](#phase-6-monitor)
1.  [Phase 7: end](#phase-7-end)
1.  [Phase 8: process](#phase-8-process)
1.  [Phase 9: write up and publish](#phase-9-write-up-and-publish)
1.  [Phase 10: restore and clean up](#phase-10-restore-and-clean-up)
1.  [Never do](#never-do)

## Before you start

- Assume the user keeps using the PC. No OS-level keyboard or mouse input, ever; use page JavaScript, the extension's page-scoped clicks, UI Automation patterns, or window messages that don't need focus.
- Keep durable state (a `work_state` list) from the first minute: goal, permissions, setup facts, ids, paths, process ids, restore list, tasks. Scheduled prompts and post-compaction turns depend on it.
- Never print secrets (meeting passcodes, API keys, websocket passwords); read them from files at run time.

## Phase 1: intake

1.  Collect: meeting platform and time, where the link will appear, display name, guest or signed in, whether an attendance form may need filling (and from which source, excluding payment data), output format and destination folders, repository and branch policy, transcription engine and model.
2.  Ask once, up front, for the session's consent items: accept the platform's guest terms, acknowledge recording and transcription notices, record the meeting, use stored logins read-only, push results, use a paid API (with a cost estimate).
3.  Inventory read-only: monitors and DPI, free RAM and VRAM, OBS version and profiles, websocket config, ffmpeg, Whisper models, browser and extension, power settings.
4.  Find precedents for the output format in the user's files.

**Gate**: written plan acknowledged by the user; consent items recorded in durable state.

## Phase 2: prepare the machine

1.  Record the original values of everything you'll change (restore list).
2.  Disable AC standby; tell the user to keep the PC plugged in and unlocked.
3.  With OBS closed: clone the profile (MKV, high quality); back up and enable the websocket config.
4.  Create an isolated scene collection: window capture (Windows Graphics Capture, client area, priority 2) and application-audio capture, no global audio.
5.  Make sure the capture browser was launched with `--disable-features=CalculateNativeWinOcclusion`; if not, ask before restarting it. Place its window on the monitor the user isn't using, at the bottom of the z-order, without activating it.
6.  Start OBS minimised to the tray with the isolated profile and collection.

**Gate**: websocket answers `GetVersion`; the isolated profile and collection are current; the user's foreground window never changed.

## Phase 3: rehearse

1.  Start the dialog closer if a desktop meeting app might pop up.
2.  Join the platform's test meeting in the web client (Zoom: `https://zoom.us/test`), devices off, display name set.
3.  Bind OBS sources to the meeting window; set the crop; grab a frame and check its brightness.
4.  Record 10 to 15 seconds; check it with `ffprobe` and `volumedetect`; transcribe it.
5.  Cover the browser window with another window and confirm frames still render.
6.  Open the chat panel and confirm the chat parser sees the list; note where the DOM lives (top document or iframe).
7.  Smoke-test the watcher and the keeper.
8.  Leave the test meeting.

**Gate**: non-black frames while covered, audible audio, devices verified off, chat parser works.

## Phase 4: wait for the link

1.  Schedule a poll (every 5 minutes) that reads the link source and returns only times, snippets, link counts and meeting ids.
2.  On success: delete the poll, store the meeting id and the web-client join URL in durable state, schedule the join for about 12 minutes before the start.
3.  Escalate if nothing appears 20 minutes before the start: check other channels and email, then tell the user.

**Gate**: link in hand, join scheduled.

## Phase 5: join and start capture

1.  Re-query browser tabs; never trust old tab ids.
2.  Restore the browser window if minimised (without activation).
3.  Navigate the meeting tab to the web-client join URL (Zoom: `/wc/join/<id>?pwd=<pwd>`).
4.  Continue without microphone and camera until the prompt stops appearing; type the name; read it back from the DOM; click Join.
5.  Acknowledge only pre-approved notices (`OK`, `Got it`), and log them.
6.  Bind OBS sources to the meeting window title; start recording; confirm `output_active`.
7.  Measure the live recording's audio level; grab a frame and check brightness.
8.  Hide the agent's own page overlays; dismiss browser permission bubbles with Close.
9.  Install the chat capture (parser, keep-at-bottom, pull) and open the chat panel.
10. Start the watcher, the keeper, an event Monitor on the watcher log, and a check-in cron every 10 minutes.
11. Save everything to durable state; report to the user.

**Gate**: recording active, audio level above about -40 dB, frame brightness normal, devices off, chat parser counting.

## Phase 6: monitor

At every check-in:

1.  Run the check-in probe: notices, overlays, title, participant count, audio and video labels (must stay off), chat pull until nothing is pending (save each page before pulling the next).
2.  Look at the latest frame; check for black frames and the keeper's alerts.
3.  Check the link source for updates (forms, link changes).
4.  Re-arm any expired Monitor.
5.  Sweep the chat list top to bottom every 20 to 30 minutes and before the scheduled end.
6.  If an attendance form appears and filling it was authorised, fill it from the approved source only, never with payment data; otherwise tell the user.

**Gate per check-in**: still in the meeting, recording growing, no unacknowledged alert.

## Phase 7: end

1.  Detect the end from in-page signals (end dialog, Leave button gone, frozen participant count, frozen frame plus silence), not the window title.
2.  Sweep and pull the chat one last time.
3.  Stop recording; note the end time and file path.
4.  Stop the watcher and keeper (both processes of each), the Monitor and the check-in cron.
5.  Don't click Leave unless the user approved it; close the tab only after the meeting has ended.

**Gate**: recording saved, chat count final, helpers stopped.

## Phase 8: process

1.  Extract FLAC (48 kHz mono) from the recording.
2.  Run one heavy transcription job at a time. Primary: local Whisper on the GPU if it fits. Cross-check: a cloud model in 3-minute chunks with a vocabulary prompt, after pricing one chunk and confirming with the user.
3.  If the harness kills a job, check for orphaned processes, then ask the user before restarting.
4.  Build the side-by-side file; queue uncertain names, dates and missing passages for clip re-checks.
5.  Build contact sheets; pin any video gaps from frame names; auto-crop; curate slides; export WebP; transcribe slide text with parallel subagents and validate.
6.  De-duplicate the chat; order it; remove invite links and other people's personal data.

**Gate**: two transcript passes compared, slides validated, chat de-duplicated.

## Phase 9: write up and publish

1.  Write the transcript by hand from the side-by-side file: speakers, proper nouns from the slides, as-heard markers, silent stretches noted.
2.  Verify every paragraph timestamp against the local segments; fix any more than 4 seconds off.
3.  Write the chat with an answer under each question, citing transcript times and slide numbers; verify every citation.
4.  Build the slides file with a generated contents list (only real slide headings).
5.  Lint: one H1, no trailing whitespace, every link and anchor resolves.
6.  Copy into the repository, normalise file modes, run the formatter, copy the formatted files back to the user's folder, commit with the repository's message rules (hooks may need a newer Node on the PATH), push to the agreed branch.

**Gate**: hooks pass; remote shows the commit; local and repo copies are identical.

## Phase 10: restore and clean up

1.  Replay the restore list: power setting, OBS profile and collection (verify `global.ini`), websocket config from backup, browser windows and tabs the agent opened.
2.  Run Windows commands with `/switches` from PowerShell, not Git Bash.
3.  List what's left with sizes; delete only what the user confirms and only what is safely published.
4.  Close the durable state list.

**Gate**: every restore item verified; the user knows what's left on disk.

## Never do

- Send OS-level keystrokes or mouse clicks while the user may be at the PC.
- Activate, maximise or move windows onto the user's screen.
- Grant camera, microphone, notification or "always open" permissions, or tick "remember" boxes.
- Click mute, unmute, start video, share or leave during a meeting without approval.
- Enter payment, bank or identity data anywhere.
- Print or commit secrets; paste passcodes into chat or docs.
- Restart jobs the harness killed without asking.
- Force-push, or delete files the user hasn't confirmed.
