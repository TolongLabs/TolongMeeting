# Workflow

The end-to-end workflow as it was carried out on 19 October 2026, one stage at a time: what each stage had to achieve, what went in and came out, how it was done, how it was checked, and what an app would need to generalise. Exact commands and code are in [techniques](techniques.md); failures are catalogued in [problems and fixes](problems-and-fixes.md).

Contents:

1.  [Pipeline at a glance](#pipeline-at-a-glance)
1.  [Stage 0: intake and planning](#stage-0-intake-and-planning)
1.  [Stage 1: environment preparation](#stage-1-environment-preparation)
1.  [Stage 2: link discovery](#stage-2-link-discovery)
1.  [Stage 3: rehearsal](#stage-3-rehearsal)
1.  [Stage 4: join](#stage-4-join)
1.  [Stage 5: in-meeting setup](#stage-5-in-meeting-setup)
1.  [Stage 6: live monitoring](#stage-6-live-monitoring)
1.  [Stage 7: end of meeting](#stage-7-end-of-meeting)
1.  [Stage 8: slides](#stage-8-slides)
1.  [Stage 9: chat](#stage-9-chat)
1.  [Stage 10: transcription](#stage-10-transcription)
1.  [Stage 11: write-up](#stage-11-write-up)
1.  [Stage 12: publishing](#stage-12-publishing)
1.  [Stage 13: post-event sources](#stage-13-post-event-sources)
1.  [Stage 14: restore and cleanup](#stage-14-restore-and-cleanup)
1.  [Stage 15: documentation](#stage-15-documentation)

## Pipeline at a glance

```text
 intake ─► prepare ─► find link ─► rehearse ─► join ─► record + watch ─► end ─┐
 (plan,     (OBS,      (poll        (test       (web    (OBS, keyframes,       │
 consent)   Zoom,      Discord)     meeting)    client)  chat, keeper,         │
            power)                                       check-ins)            │
 ┌────────────────────────────────────────────────────────────────────────────┘
 └► slides (crop, curate, agents) ─┐
    chat (dedupe)                  ├─► write-up (transcript, slides, chat) ─► publish (repo)
    audio ─► ASR (local + cloud) ──┘                                            │
 post-event sources (portal, Drive: PDFs, zip, videos) ─────────────────────────┤
 restore settings ─► cleanup ─► document ◄──────────────────────────────────────┘
```

Times below are Malaysia time (UTC+8). The meeting was scheduled for 8 to 10 PM and ran 8:00 to 9:16 PM.

## Stage 0: intake and planning

- **Goal**: understand the request, the user's existing tools and precedents, and agree a plan before anything changes on the machine.
- **When**: 17:43 to 17:55.
- **Inputs**: the organiser's announcement (pasted), the user's request, their machine.
- **What was done**:
  1.  Inventoried the machine read-only: app paths and versions, OBS profiles and websocket config, power settings, monitors, WSL distributions, GPU, ffmpeg, the transcriber's config and cached models.
  2.  Found precedents: the user's transcript style repo and, better, a three-file write-up of an earlier hackathon briefing in another repo.
  3.  Posted a plan (separate OBS profile, MKV, websocket control; join muted with camera off; disable sleep; rehearse; poll for the link from 7 PM; watcher for slides and the end; FLAC to Whisper medium; hand-written write-up) with four questions: where the link will appear, display name, attendance form, write-up format.
  4.  Folded in the user's answers and two corrections (the Gemini polish step is obsolete; research a CLI tool the user had seen).
  5.  Created a durable task list with 14 items.
- **Output**: an agreed plan, answers, a task list in durable state.
- **Generalise**: an intake form (meeting, link source, display name, outputs, destinations, consent items) plus automatic environment discovery.

## Stage 1: environment preparation

- **Goal**: make recording, control and transcription work unattended without touching the user's own setup.
- **When**: 17:57 to 18:03, OBS relaunched at 19:29.
- **What was done**:
  1.  Disabled AC standby (recording the original value to restore).
  2.  Cloned the OBS profile into an isolated one (MKV, high quality, NVENC), enabled obs-websocket after backing up its config, created a separate scene collection with a window-capture source and an application-audio source and no global audio.
  3.  Built a Python venv with `obsws-python`, `pillow` and `uiautomation`, and helper scripts for window listing, placement, UI Automation and OBS control.
  4.  Set Zoom desktop's join behaviour (camera off, mic muted, no preview, auto audio) through UI Automation.
  5.  Researched HKUDS/CLI-Anything at the user's request; rejected it (its Zoom harness manages meetings you host through the REST API; its OBS harness edits scene files offline; neither controls a live client).
- **Verification**: settings re-read after each change; OBS window title and websocket responses confirmed the profile and collection.
- **Generalise**: a setup step that creates an isolated recorder profile, checks GPU and RAM, and records a restore list. See [OBS and recording problems](problems-and-fixes.md#obs-and-recording).

## Stage 2: link discovery

- **Goal**: catch the meeting link as soon as it's posted and join on time.
- **When**: 18:28 to 19:34 (link posted at 19:32 for an 8 PM start).
- **What was done**: a session cron every 5 minutes ran page JavaScript on the logged-in Discord channel tab, returning only message times, text snippets, Zoom-link counts and meeting ids. When the link appeared, the poll was deleted and a one-shot join was scheduled for 19:47; the plan had a fallback to other channels and email at 19:40.
- **Output**: the meeting id and passcode (kept out of chat output as far as the tools allowed).
- **Generalise**: link sources as plugins (Discord, email, calendar, web page), a deadline-driven escalation, and secret handling for passcodes.

## Stage 3: rehearsal

- **Goal**: prove the whole capture chain on Zoom's test meeting before the real one.
- **When**: 18:03 to 18:28, three attempts.
- **Attempt 1, Zoom desktop (failed)**: the join page needed its tab to be active before Chrome would show the "Open Zoom Meetings?" prompt; the desktop guest name dialog exposes no UI Automation tree; the keyboard fallback sent keystrokes into the user's WhatsApp. The agent stopped, told the user, and banned OS-level input.
- **Attempt 2, web client (partly worked)**: `zoom.us/test` then "Join from browser"; continued without microphone and camera (twice), typed the name, joined. OBS recorded a 12-second clip; ffprobe and Whisper confirmed audio and video. Then OBS frames went black whenever the user's terminal covered Chrome.
- **Attempt 3, web client with Chrome relaunched** with `--disable-features=CalculateNativeWinOcclusion`, placed on the left monitor at the bottom of the z-order: frames rendered while covered; crop set to remove the browser chrome; chat panel opened; meeting left by JavaScript.
- **Also built**: the watcher (smoke-tested), the dialog closer for desktop-app pop-ups.
- **Output**: a proven join recipe, capture settings, DOM facts, and user instructions (keep the PC on and unlocked, don't touch the Chrome window, browse in Opera, use headphones rather than muting Chrome).
- **Generalise**: a built-in "test meeting" self-check that verifies video, audio, devices off and rendering while covered. See [Zoom problems](problems-and-fixes.md#zoom) and [desktop problems](problems-and-fixes.md#desktop-and-window-management).

## Stage 4: join

- **Goal**: be in the meeting as the agreed guest with devices off, before it starts.
- **When**: 19:47 to 19:48:58.
- **What was done**: a dialog closer ran in the background; the meeting tab navigated straight to the web-client join URL (`/wc/join/<meeting-id>?pwd=<pwd>`), which never launches the desktop app; "Continue without microphone and camera" twice; name typed and verified from the DOM; Join clicked; the transcription notice acknowledged (pre-approved). Chrome had been minimised just before and was restored without focus.
- **Verification**: 103 participants listed, own name present, microphone and camera blocked.
- **Generalise**: a platform adapter with `join(url, name)` and `assertDevicesOff()`.

## Stage 5: in-meeting setup

- **Goal**: start recording and every monitor within a minute of joining.
- **When**: 19:49 to 19:52.
- **What was done**:
  1.  Bound both OBS sources to the meeting window's title and started recording (19:49:12).
  2.  Discovered the web-client DOM was in the top document this time (not the iframe seen in rehearsal) and switched to a root resolver.
  3.  Measured the growing MKV's audio level (mean -20.7 dB) instead of trusting the Audio button label.
  4.  Closed Zoom's device banner and any Chrome permission bubble; hid the extension's overlays, which were being recorded.
  5.  Started the watcher (keyframes, events), a Monitor on its log, a 10-minute check-in cron, and a first chat observer.
  6.  Saved the setup to durable state and reported to the user.
- **Generalise**: one "session start" transaction with a health check that fails loudly.

## Stage 6: live monitoring

- **Goal**: keep the recording, slides and chat complete for the whole meeting without disturbing the user.
- **When**: 19:52 to 21:20.
- **What was done**:
  - **Keyframes**: 84 saved during the meeting, reported in 3-minute batches.
  - **Chat**: replaced the noisy text-snapshot observer with a structured parser at 20:05; at 21:05 found the list scrolled up and messages missing, and the tool output truncated at 1,000 characters; added keep-at-bottom, a full sweep and a paging pull; swept again at 21:19 before the meeting could end. 104 lines saved.
  - **Check-ins** every 10 minutes (9 in all): acknowledged allowlisted notices (the host started cloud recording at about 20:05), re-hid overlays, checked participants (peaking at about 635) and that audio and video stayed off, pulled chat, viewed the latest frame, checked Discord, checked the Chrome window.
  - **Interruption**: the Chrome window was found minimised at the 20:15 check-in, with black video since 20:09:35; `keeper.py` was written and started at 20:15:57 and restored the window within a second at 20:28:55.
  - **User check-in** at 20:12 answered with the recording status.
  - **No attendance form** appeared, so none was filled.
- **Generalise**: run the keeper, a black-frame alarm and the chat sweep from the start; a supervisor that keeps event streams alive; check-ins that call stable helpers. See [capture](problems-and-fixes.md#watcher-and-capture-quality) and [chat](problems-and-fixes.md#chat-capture) problems.

## Stage 7: end of meeting

- **Goal**: stop recording promptly when the meeting ends and keep everything captured.
- **When**: the host ended the meeting at about 21:16:34; recording stopped at 21:25:36.
- **What was done**: the watcher didn't notice (it watched the window title, which didn't change). At the 21:25 check-in the agent saw the ended state in the latest frame and an end notice, stopped OBS (1:36:23 recorded), stopped the watcher and keeper (two processes each), the Monitor and the check-in cron, and recorded the final counts.
- **Generalise**: detect the end from in-page signals within seconds; stop recording, then run the chat sweep and the post-processing chain automatically.

## Stage 8: slides

- **Goal**: one clean image and full text for every distinct slide.
- **When**: 21:26 to 21:35.
- **What was done**: contact sheets of all 91 keyframes reviewed; the video gap pinned to 20:09:35 to 20:16:00 from frame names; frames auto-cropped to the shared screen; 65 curated into a slide map and exported as WebP; four subagents transcribed the slide text in parallel; parts concatenated and validated.
- **Generalise**: automatic de-duplication and transition filtering, with a human-reviewable contact sheet; parallel vision transcription with a strict schema.

## Stage 9: chat

- **Goal**: every message once, in order, with answers.
- **What was done**: de-duplicated 104 lines to 99; ordered by Zoom time with thread replies after their parents; invite links removed; an answer written under each question from the organisers' live answers, chat replies, slides and handbook, with citations.
- **Generalise**: capture message ids where the platform has them; keep the raw log; link each question to the transcript moment that answers it.

## Stage 10: transcription

- **Goal**: an accurate, timestamped transcript with correct names.
- **When**: 21:26 to 22:37.
- **What was done**:
  1.  Extracted 48 kHz mono FLAC from the MKV.
  2.  Started Whisper medium on the GPU and large-v3 on the CPU at once; the harness killed both under memory pressure. Asked the user rather than restarting.
  3.  On the user's suggestion, compared cloud ASR options; with their approval used their OpenAI key. Priced a diarized pilot (too expensive), then ran `gpt-4o-transcribe` in 30 chunks with a vocabulary prompt, in parallel with Whisper medium alone on the GPU.
  4.  Built a side-by-side file per 3-minute window and reviewed it; re-transcribed 16 uncertain clips with two OpenAI models.
- **Output**: two complete raw transcripts and targeted corrections.
- **Generalise**: a pluggable ASR layer with cost estimates, memory budgeting, vocabulary from slides and invitations, and a disagreement finder that queues clips for re-checks. See [transcription problems](problems-and-fixes.md#transcription).

## Stage 11: write-up

- **Goal**: the three-file set in the precedent's format.
- **When**: 22:33 to 22:48 (after the cross-check review that started at 22:32).
- **What was done**: wrote `transcript.md` by hand (speakers, proper nouns, as-heard markers, notes for silent stretches); verified every paragraph timestamp against the local segments and corrected 12; wrote `chat.md` with cited answers and checked every citation exists; built `slides.md` with a generated contents list; linted for one H1, trailing whitespace and broken references.
- **Generalise**: templates per output format, automated citation and anchor checks, and a list of facts that contradict the documents.

## Stage 12: publishing

- **Goal**: the same files in the team repository on `main`.
- **When**: 22:48 to 22:49.
- **What was done**: copied into `docs/sources/opening-briefing/`, installed dependencies, ran Prettier and copied its output back to the Downloads folder, committed (the hook first failed under Node 16; retried with Node 24 on the PATH), pushed, then fixed an executable bit inherited from the Windows drive with a second commit.
- **Generalise**: a publisher with per-repo rules (path, commit format, formatter, branch policy) and a dry run. See [publishing problems](problems-and-fixes.md#publishing).

## Stage 13: post-event sources

- **Goal**: capture what the organisers published after the meeting.
- **When**: 22:02 (portal) and 23:01 to 23:21 (Drive).
- **What was done**:
  1.  A one-shot cron at 22:02 re-created the lost browser tab group, read the team portal (team domain, Drive link, mentor booking), and saved a scrubbed copy.
  2.  On request, listed the organisers' link-shared Drive folder through its public embed view, downloaded 15 files through the public download endpoint, rendered PDFs to text and images, extracted the sample repo without its `.git`, transcribed tutorial videos (and read captions from frames for the one without narration), and had four subagents write Markdown. Found the official handbook and terms identical to existing copies, and seven contradictions in the new participant handbook.
  3.  Published eight documents to `docs/sources/participant-drive/`.
- **Generalise**: source connectors (portal, Drive, Discord) with redaction rules and duplicate detection. See [source problems](problems-and-fixes.md#post-event-sources).

## Stage 14: restore and cleanup

- **Goal**: leave the machine as it was, minus what the user agreed to delete.
- **What was done**: sleep timeout restored; OBS switched back to its original profile and collection, closed, and `global.ini` patched where the switch hadn't persisted; websocket config restored from backup; browser tabs closed; Chrome shut down on request (it was running windowless in the background); scratch data, raw frames, cloud chunks, the recording and its FLAC deleted after the user confirmed.
- **Generalise**: a restore list built during setup and replayed even after failures; deletion only of artefacts confirmed published.

## Stage 15: documentation

- **Goal**: this record.
- **What was done**: two subagents mined the session transcript (54 MB of JSON lines, mostly screenshots) for a timeline, problems, code and decisions; another packaged the scripts; the main agent wrote the post-compaction notes and the documents in this folder.
