# TolongMeeting design

The design for TolongMeeting, an internal TolongLabs app. It attends online lectures and work meetings as the member, catches and submits attendance forms, and delivers a short summary, with full details on a small website. It generalises the agent session of 19 October 2026 described in the [session record](../session-record/overview.md). This is revision 2, written on 20 October 2026 after a brainstorm with the requester and a review by three specialists ([expert reviews](../research/expert-reviews/README.md)). It marks which decisions are the requester's and which are the designer's calls.

Contents:

1.  [Summary](#summary)
1.  [Why it exists](#why-it-exists)
1.  [Who it's for](#who-its-for)
1.  [Goals](#goals)
1.  [Non-goals](#non-goals)
1.  [Anti-goals](#anti-goals)
1.  [Decisions](#decisions)
1.  [How a lecture goes](#how-a-lecture-goes)
1.  [Components](#components)
    1.  [Website](#website)
    1.  [Scheduler](#scheduler)
    1.  [Control channel](#control-channel)
    1.  [Meeting worker](#meeting-worker)
    1.  [Platform adapters](#platform-adapters)
    1.  [Link watchers](#link-watchers)
    1.  [Attendance form handler](#attendance-form-handler)
    1.  [Name-mention alerts](#name-mention-alerts)
    1.  [Transcription](#transcription)
    1.  [Post-processing and summaries](#post-processing-and-summaries)
    1.  [Notifications](#notifications)
    1.  [Companion app](#companion-app)
    1.  [Run locations](#run-locations)
    1.  [Exports](#exports)
1.  [State machines](#state-machines)
1.  [Data and storage](#data-and-storage)
1.  [Security and privacy](#security-and-privacy)
1.  [Platform realities](#platform-realities)
1.  [Lessons carried over from the session](#lessons-carried-over-from-the-session)
1.  [Tech stack](#tech-stack)
1.  [Deployment and cost](#deployment-and-cost)
1.  [Build order](#build-order)
1.  [Early spikes](#early-spikes)
1.  [Acceptance tests](#acceptance-tests)
1.  [Changes after expert review](#changes-after-expert-review)
1.  [Left to the builder](#left-to-the-builder)
1.  [Sources](#sources)

## Summary

A member enters their timetable on a small website. They sign in once to their meeting, university and chat accounts through a browser the app keeps for them, one per identity (for example "University" and "Work"). Before each session the app starts a private browser in a container, watches the member's chosen chats for the meeting link, and joins the meeting as the member, with microphone and camera off.

During the meeting it records only the meeting window, transcribes the audio, reads the chat, and scans the shared screen for QR codes. When a trusted attendance form appears, it fills in the member's saved details, ticks the attendance confirmation, and submits, then pings the member with proof. Afterwards it sends a short summary file in an ADHD-friendly format and keeps the transcript, slides, chat and attendance record on the website for 30 days, where the member can export them.

## Why it exists

- **Lectures**: a TolongLabs member studies part time for a master's degree, and lectures sometimes clash with work. Lecturers post attendance forms at random moments. The form arrives as a QR code on the shared screen or a link in chat, on Google Forms or Microsoft Forms, and stays open for about 5 minutes. Forms usually require the student's university sign-in; otherwise they ask for name and student ID. Attendance is never taken through in-meeting polls.
- **Work meetings**: the member usually can't attend and needs a quick transcript and summary.
- **Timing**: no deadline; one person builds it.
- **Origin**: on 19 October 2026 a Claude Code agent attended a Zoom briefing for another member, recorded and wrote it up, but needed close supervision and hit many problems on a shared desktop. This app makes the job repeatable without an agent in the loop. The [problems and fixes](../session-record/problems-and-fixes.md) catalogue and the [expert reviews](../research/expert-reviews/README.md) are required reading for the builder.

## Who it's for

- TolongLabs members only, as an internal tool (requester's decision). Expect a handful of members, each with a few sessions a week.
- An admin adds members; there is no public sign-up, billing or multi-organisation support (designer's call).
- Each member sees only their own timetable, identities, meetings and files through the website and API.

## Goals

1.  Attend scheduled lectures and work meetings as the member, signed in to the member's own accounts, with microphone and camera off for the whole session.
1.  Catch every attendance form shown as a QR code on screen or posted as a link by a trusted sender. Submit it with the member's saved details well inside the 5-minute window; the target is under 2 minutes from first appearance.
1.  When a form can't be submitted safely, ping the member with the link within 30 seconds of seeing it.
1.  Deliver a short summary file within 10 minutes of the meeting ending (live transcription mode), written to the i-have-adhd rules, with every announced deadline present.
1.  Keep the transcript, slides, chat, attendance record and recording on a website for 30 days. Let the member export them to Google Docs, GitHub, Notion and file downloads.
1.  Offer two transcription modes per timetable entry: live (a cloud model during the meeting) and native (the member's local Whisper after the meeting).
1.  Run primarily on a TolongLabs server, with local mode on the member's own PC as an option per identity.

## Non-goals

- Speaking, typing in chat, reacting, raising a hand, or otherwise taking part in a meeting. The app listens and watches only.
- Answering for the member when called on. It pings them instead.
- Answering in-meeting polls.
- Using official bot routes (Zoom Meeting SDK bots, Teams Graph media bots, the Google Meet Media API) or joining as a separate notetaker identity.
- Working out meeting times from chat messages; the timetable is the only schedule.
- Joining meetings that aren't in the timetable, or breakout rooms.
- Automatic exports; exporting happens when the member asks.
- Speaker labels in transcripts (not in the first version).
- A mobile app; ntfy covers phones.
- Filling forms with anything beyond saved details and attendance confirmations, solving CAPTCHAs, or handling payments.
- Public availability, billing, or support for other organisations.

## Anti-goals

The requester wasn't sure, so these are the designer's calls. Each would make the app a failure even if everything technically worked:

1.  Submitting a wrong or made-up answer on an attendance form. That is worse than missing it. Ticking attendance confirmations and "Present" options on a trusted attendance form doesn't count as made up; the requester decided the bot does this (decision 36).
1.  Missing a form silently, so that the member only learns later that they were marked absent.
1.  Getting the member's accounts locked or banned, through suspicious university sign-ins or WhatsApp or Discord enforcement. The app backs off rather than retrying logins.
1.  Doing anything visible in a meeting: unmuting, starting video, typing, reacting. Joining and leaving are the only visible actions.
1.  A long or vague summary. If the member has to open the transcript to find a deadline, the summary failed.
1.  One member's sessions, recordings or notes reaching another member through the app. A person with root access to the server can technically read everything; the app doesn't pretend otherwise (see [security and privacy](#security-and-privacy)).

## Decisions

"Requester" means the person in the brainstorm. "Accepted" means the designer proposed it and the requester approved it in a playback. "Designer" means the designer's own call; these are open to change.

| #   | Decision                                                                                                                                             | Made by   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Primarily a cloud bot; a local mode on the member's PC is optional                                                                                   | Requester |
| 2   | Two uses: lectures (attendance forms matter) and work meetings (transcript and summary)                                                              | Requester |
| 3   | The bot submits attendance forms for the member                                                                                                      | Requester |
| 4   | The member is responsible for whether their programme allows this                                                                                    | Accepted  |
| 5   | Ping the member at the moment of submission, with a screenshot of what was sent                                                                      | Accepted  |
| 6   | If it can't submit (expired login, unexpected question), ping the member with the link instead                                                       | Accepted  |
| 7   | Two transcription modes: live with a third-party cloud model; native with the member's whisper-transcriber on their own PC                           | Requester |
| 8   | Platforms: Zoom, Microsoft Teams and Google Meet                                                                                                     | Requester |
| 9   | Self-host and build it in-house rather than paying for a meeting-bot service                                                                         | Requester |
| 10  | Join as the member through their own signed-in accounts, not as a separate bot                                                                       | Requester |
| 11  | The member signs in once through a browser the app keeps; the app never stores passwords                                                             | Accepted  |
| 12  | Ping the member when their name is spoken (live mode)                                                                                                | Accepted  |
| 13  | Internal tool for TolongLabs only                                                                                                                    | Requester |
| 14  | Links come from manual input or from chosen WhatsApp, Discord and Teams chats, watched through their web apps                                        | Requester |
| 15  | The member enters a timetable; the bot never infers times                                                                                            | Requester |
| 16  | Timings: watch from T-60, join T-10 to T-5, hard stop at end + 30 minutes                                                                            | Accepted  |
| 17  | Notifications through ntfy and desktop notifications                                                                                                 | Requester |
| 18  | Self-hosted ntfy with authentication, one private topic per member                                                                                   | Designer  |
| 19  | Summary first, as a text file opened in the member's default app, in i-have-adhd format; details on demand                                           | Requester |
| 20  | A small website for details; export options to Google Docs, GitHub, Notion and others                                                                | Requester |
| 21  | Exports are on demand; Markdown and PDF downloads are always available                                                                               | Designer  |
| 22  | All technical choices (stack, hosting, AI services)                                                                                                  | Designer  |
| 23  | Platform order: Zoom, then Teams, then Meet                                                                                                          | Designer  |
| 24  | Anti-goals                                                                                                                                           | Designer  |
| 25  | Several sign-in identities per member (for example University, Work), one browser profile each; entries pick one                                     | Designer  |
| 26  | Auto-submit only forms that look like attendance forms; quizzes and other forms get a ping                                                           | Designer  |
| 27  | Attendance is never taken through in-meeting polls, so polls are ignored                                                                             | Requester |
| 28  | Zoom falls back to a guest join with a set display name when the identity has no Zoom account                                                        | Designer  |
| 29  | In work meetings the member usually isn't present; the bot joining as them is fine                                                                   | Requester |
| 30  | University accounts may be Microsoft or Google; both form providers are needed from the start                                                        | Requester |
| 31  | AI for summaries, slides and forms uses the member's own ModelScope or DashScope key, with cheap but strong models                                   | Requester |
| 32  | No deadline; one builder                                                                                                                             | Requester |
| 33  | The member can tell the bot to leave a meeting, or take over from it, from the website or a ping button                                              | Designer  |
| 34  | Live transcription also runs on the member's DashScope key, so one key covers all cloud AI                                                           | Designer  |
| 35  | Default models: `qwen3.7-plus`, `qwen3-vl-plus`, the cheapest current flash model, `qwen3-asr-flash-realtime`; ModelScope as an alternative for text | Designer  |
| 36  | On a trusted attendance form, the bot ticks attendance confirmations and "Present" options                                                           | Requester |
| 37  | Everything on the server is deleted after 30 days; names in saved chat are kept as they are                                                          | Requester |
| 38  | Server of 8 vCPUs and 16 GB, running at most 2 meetings at once                                                                                      | Designer  |
| 39  | Where an identity runs (server, server through the member's home connection, or the member's PC) is set per identity, not per entry                  | Designer  |
| 40  | Only forms from trusted sources are auto-submitted (QR on the shared screen, links from the host or named lecturer, or university-restricted forms)  | Designer  |
| 41  | The browser screen is split: the meeting window is recorded; forms, chat watchers and sign-in sit on an unrecorded side                              | Designer  |
| 42  | Live transcript timestamps come from audio stream offsets; names are corrected from slides afterwards                                                | Designer  |
| 43  | The companion app is built with Electron                                                                                                             | Designer  |
| 44  | Milestone 1 is split into 1A (record, ping forms, summary), 1B (auto-submit) and 1C (website)                                                        | Designer  |
| 45  | Work-meeting entries default to native transcription and show an employer-permission notice                                                          | Designer  |

## How a lecture goes

Times relative to the scheduled start (T).

1.  **T-60**: the scheduler starts a meeting worker for the entry's identity, at the identity's run location. The worker restores the identity's browser profile and checks the accounts the entry needs are still signed in: the meeting platform and the chat source, plus the form provider for lectures. If one isn't, it pings the member at high priority with a "Sign in again" button (see [website](#website)).
1.  **T-60 to T-5**: if the entry's link comes from a chat, the worker opens that chat and first scans the last 24 hours for meeting links, then keeps watching; the newest link wins. A link pasted on the website always overrides watched links.
1.  **T-10 to T-5**: for lectures, the worker loads the form provider's page once to confirm the session still works there. It then joins as the member with microphone and camera off, connects meeting audio output, waits in any lobby, and confirms it's in. It pings "joined", with the participant count, at normal priority.
1.  **If no link by T**: it pings the member at high priority to paste one on the website, and keeps watching until 30 minutes after the start.
1.  **During the meeting**:
    - It records the meeting window and its sound, and streams audio to live transcription if that mode is chosen.
    - It saves a frame every 2 seconds and decodes any QR codes in it.
    - It reads and stores chat continuously, and keeps watching the link chat for form links.
    - In live mode, it watches the transcript for the member's name.
1.  **Form appears**: if the source is trusted and the form looks like an attendance form, the form handler opens it on the unrecorded side of the screen. It fills saved details, ticks attendance confirmations, submits, and pings with screenshots of the page. If anything is uncertain, it doesn't submit; it pings with the link instead.
1.  **End**: the worker detects the end from the page (see [platform adapters](#platform-adapters)) or stops at the scheduled end plus 30 minutes. It stops recording, uploads everything and checkpoints the browser profile. Chat was stored as it arrived, so nothing depends on reading it after the end.
1.  **After**: post-processing builds the transcript (live mode, or waits for the member's PC in native mode), then the slides, chat and summary. The summary goes out as a ping. The companion app saves the file and shows a desktop notification that opens it when clicked.

A work meeting follows the same steps without form detection, and with the work-meeting summary template.

## Components

### Website

Pages, all behind sign-in with GitHub. Membership of the TolongLabs organisation is checked at each sign-in and daily, through the `read:org` scope, and sessions end when someone leaves the organisation (designer's call).

- **Home**: upcoming sessions, any session in progress with its state (see [state machines](#state-machines)), recent summaries, account warnings, and a 3-day notice for meetings about to be deleted.
- **Timetable**: create, edit and pause entries. Fields:
  - name;
  - type (lecture or work meeting);
  - repeat rule (one-off or weekly days);
  - start and expected end time, in the member's time zone;
  - identity (which sets where it runs);
  - link source: a fixed link, a chat to watch, or "I'll paste it". A chat is identified by its URL (Discord channel, Teams chat) or exact name (WhatsApp);
  - trusted senders: the lecturer's display names in the meeting and the watched chat (lectures only);
  - transcription mode, live or native. Work meetings default to native and show a notice to check the employer allows cloud AI processing (decision 45);
  - per-entry form details (for example course code, section, lecturer) and optional extra attendance keywords.
- **Meeting page**:
  - the summary on top;
  - the attendance record: each form's time seen, source, trust reason, fields filled, screenshots and result;
  - the transcript, with timestamps linked to a video player;
  - slides, chat and the event log;
  - export buttons and "delete now".
- **Accounts**: the member's identities, such as "University" and "Work". Each has its own kept browser profile, because Zoom and Teams on the web hold one signed-in account per profile.
  - **Settings per identity**: the run location (decision 39) and a Zoom display name for guest joins.
  - **Sign-in**: a remote view of the identity's browser for signing in to Zoom, Microsoft, Google, WhatsApp Web (scan with phone), Discord and Teams. If a worker is running for that identity, the view attaches to that worker's unrecorded side and pauses its automation until the member presses "Done" (see [meeting worker](#meeting-worker)). Otherwise a short-lived sign-in container starts.
  - **Status**: each account's last-verified time.
- **My details**: the saved values the form handler may use:
  - full name as registered;
  - student ID;
  - university email;
  - programme;
  - any custom pairs.

  Each value has optional label variants (for example "Matric No.", "No. Matrik"). It also holds the names the member answers to, for mention alerts.

- **Notifications**: how to subscribe to the member's ntfy topic on phone and desktop, and a test button.
- **AI keys**: the member's DashScope key (Singapore region) with an optional Workspace ID for the recommended workspace endpoint, an optional ModelScope key, and a test button.
  - **Region**: keys are tied to a region, so the page says which to use.
  - **Data use**: the page states Alibaba's data-use terms (see [security and privacy](#security-and-privacy)).
  - **Required key**: sessions needing cloud AI can't be scheduled without a working key; native-mode entries still need one for summaries.
- **Connections**: Google, GitHub and Notion for exports.
- **Admin**: add and remove members. Admins don't see members' data in the app.

### Scheduler

- Expands timetable entries into meeting occurrences 14 days ahead and enqueues a worker start at T-60 (designer's call).
- Runs jobs from a Postgres-backed queue so restarts don't lose them.
- **Identity lock**: never runs two workers for the same identity at once, because a Chrome profile can't be open twice. If two entries for one identity overlap, the earlier start wins and the member is pinged about the clash when the entry is saved and again at T-60.
- **Server capacity**: at most 2 server workers at once (decision 38). If a third would start, the member is pinged at high priority at T-60, with the option to switch that identity to their PC.
- **Health**: watches each worker's heartbeat (see [control channel](#control-channel)). No heartbeat for 30 seconds counts as a crash. It restarts the worker and rejoins, up to 3 times per occurrence, pinging the member each time. The restarted worker reuses the identity's working copy, which survives on the host volume and holds the freshest session state; it falls back to the latest checkpoint only if the working copy is damaged or missing (Chrome refuses to open it).
- **Retention**: deletes each occurrence's data 30 days after the meeting (decision 37), after a normal-priority ping 3 days before (designer's call).

### Control channel

- Each worker sends a heartbeat to the server every 5 seconds over HTTPS, with its state, recording status, participant count and pending events.
- The reply carries commands: `leave_now` (the member pressed "Make the bot leave"), `take_over` (leave, then the member's ping opens the meeting link), `pause_for_signin`, `resume_after_signin`, and `stop`.
- In local mode, the companion app relays the same heartbeat and commands, so the member's home network never needs to accept incoming connections.
- Events (joined, form seen, form submitted, alert, error) are stored in Postgres as they arrive, so a restarted worker knows which forms were already handled.

### Meeting worker

One container per meeting occurrence, Linux, no GPU, started with `--shm-size=2g`.

- **Screen**: one virtual X display (Xvfb) of 3840x1080 with a simple window manager (openbox) and fixed window placement.
  - **Stage**: the left half (1920x1080) holds only the meeting, in a Chrome app-mode window (`--app=<url>`) with no tabs or toolbar. Only the stage is recorded, scanned for QR codes and used for slides.
  - **Desk**: the right half holds a second Chrome window with the chat-watcher tabs and any form tabs. The remote sign-in view shows only the desk, so credentials and forms are never recorded.
  - The two halves never overlap, so neither window is hidden and throttled.
- **Chrome**: full Chrome (not headless), pinned version, launched by Playwright with a persistent profile. Settings to verify in [spike 2](#early-spikes):
  - drop Playwright's `--enable-automation`;
  - add `--disable-blink-features=AutomationControlled`, `--autoplay-policy=no-user-gesture-required`, `--password-store=basic`, and the software rendering flags Chrome needs without a GPU (for example `--use-gl=angle --use-angle=swiftshader`);
  - add `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`;
  - deny camera and microphone permission;
  - make a muted null audio source the default input, so no real or loopback device is ever offered as a microphone.

  A managed Chrome policy blocks `file://`, `chrome://` and `javascript:` URLs, developer tools and downloads.

- **Audio**: PulseAudio with one sink. Only the meeting window's audio may reach it; desk tabs are muted (the method is verified in spike 2).
- **Profile storage**:
  - **Working copy**: the identity's profile is decrypted into a working directory on an encrypted host volume, mounted only into this worker. It isn't held in memory, so a crash doesn't lose rotated session cookies or WhatsApp Web's encryption state.
  - **Checkpoints**: every 5 minutes and right after a sign-in, the worker writes an encrypted checkpoint of the profile, leaving out caches (`Cache`, `Code Cache`, `GPUCache`, `Service Worker/CacheStorage`, `Crashpad`).
  - **Before every launch**: remove `SingletonLock`, `SingletonSocket` and `SingletonCookie`, and keep the hostname and `/etc/machine-id` fixed per identity.
- **Recording**: ffmpeg records the stage (x11grab region) and the sink into 5-minute Matroska segments named by attempt (`attempt_<N>_seg_<NNN>.mkv`), at 1920x1080, 15 frames per second, H.264 with a fast preset, AAC audio, and wall-clock timestamps. Segments are remuxed and joined at the end; gaps between attempts are recorded in the event log, so transcript times stay aligned with wall-clock time.
- **Frames**: every 2 seconds a full-resolution frame of the stage goes to the QR detector and the slide keyframe selector (the session's watcher rules; see [techniques](../session-record/techniques.md#watcher-keeper-and-end-detection)).
- **Health alerts**:
  - black frames for 10 seconds;
  - a frozen frame together with silence for 5 minutes while participants are present (a frozen slide alone is normal);
  - leaving the meeting unexpectedly. It rejoins once automatically after an unexpected drop.
- **Controls**: the worker never clicks microphone, camera, chat input, reactions, share or record controls. Notices are acknowledged only through an allowlist of button texts per platform (for example `OK`, `Got it`), and each click is logged.
- **Sign-in pause**: on `pause_for_signin`, the worker stops all automation on the desk, keeps recording the stage, and hands the desk to the member's remote view. It resumes on `resume_after_signin` or after 15 minutes idle, then checkpoints the profile.
- **Outputs**: recording segments, kept frames, chat (stored as it arrives), event log, form records and live transcript, all written incrementally to a host-mounted directory. A crash loses at most a few seconds.

### Platform adapters

One module per platform behind a common interface, so the platform order doesn't change the rest. Selectors live in a JSON map per platform, loaded at start, so a UI change can be fixed without rebuilding. The interface (designer's sketch):

- `normaliseLink(url)`: turn a pasted link into the web-client join URL.
- `join(page, identity)`: get through the pre-join screens with devices off, signed in (or as a guest on Zoom when the identity has no Zoom account). Recognise a sign-in or MFA challenge as its own result, distinct from a lobby. Return when in the meeting or in a lobby.
- `connectOutputAudio(page)`: make sure meeting audio plays (for example Zoom's "Join Audio by Computer" without a microphone), verified by the sink's level.
- `ensureLayout(page)`: keep the shared screen as large as possible on the stage, with the chat readable.
- `waitUntilAdmitted(page)`: returns `admitted`, `lobby_expired` (knock again, up to 2 times) or `lobby_denied` (stop and ping). Waits until the scheduled end plus 30 minutes at most.
- `assertDevicesOff(page)`: read the controls' labels and fail loudly if either device is on.
- `readChat(page, cursor)`: return new messages since the cursor (sender, time, text, links), handling virtualised lists. It is called continuously, with full sweeps every 10 minutes.
- `sharedScreenRegion(page)`: the rectangle of the shared screen, from the video element's position first and a brightness crop as the fallback.
- `participantCount(page)`: read without closing the chat panel.
- `meetingState(page)`: one of in meeting, lobby, ended, removed, breakout prompt or unknown, using page signals such as end dialogs or the Leave button disappearing. A breakout prompt is never accepted; it triggers a ping.
- `dismissNotices(page)`: the allowlist.
- `leave(page)`: leave the meeting, used only at the end, on `leave_now` or on `take_over`.

Platform notes:

- **Zoom (first)**:
  - Rewrite `/j/<id>?pwd=` to `/wc/join/<id>?pwd=`, which never launches the desktop app.
  - Pre-join asks twice to continue without microphone and camera.
  - The in-meeting DOM can be in the top document or in `iframe#webclient`, so resolve it at run time.
  - Controls are found by `aria-label`, and chat by the classes in [techniques](../session-record/techniques.md#web-client-dom).
  - If the identity has no Zoom account, or a signed-in join fails because the account is busy in another meeting, join as a guest with the identity's display name.
- **Teams (second)**: the Teams web client signed in as the member, joining with audio and video off. The lobby depends on the organiser's policy. Joining sets the member's presence to "In a call".
- **Google Meet (third)**: meet.google.com signed in as the member. Turn microphone and camera off on the pre-join screen, then "Join now", or "Ask to join" if the member isn't trusted by the meeting's organisation.
- **Failures**: every adapter step has a timeout. On failure the adapter saves a screenshot and the page's accessibility tree, and pings the member.
- **Upkeep**: Chrome and Playwright versions are pinned in the worker image. A monthly smoke test joins each platform's test meeting and fails loudly if a selector is missing.

### Link watchers

They run as tabs in the desk window from T-60 until the meeting ends, kept open rather than reloaded. Each watches only the chat named in the timetable entry.

- **WhatsApp Web**: the member links it once as a device from the Accounts page; the worker reads the chosen chat's latest messages. WhatsApp's linked-device state must survive restores, so [spike 7](#early-spikes) tests it. If WhatsApp shows warnings or drops the link when used from the server, WhatsApp watching is limited to identities that run at home (designer's call).
- **Discord**: a server channel, group DM or DM, read on discord.com in the member's session.
- **Teams chat**: a chat or group chat in the Teams web client. Built with the Teams adapter.
- **Manual**: the member pastes a link on the website at any time; it overrides watched links.
- **Behaviour**: read-only.
  - At start, read the last 24 hours of the chat, then poll the visible messages every 25 to 45 seconds before the meeting and every 12 to 25 seconds during it, at random intervals.
  - Extract meeting links before the meeting, and form links with their sender during it.
  - Never send, react or mark-as-read beyond what opening the chat does.
- **Risk**: Discord and WhatsApp forbid automating personal accounts. Read-only watching reduces but doesn't remove the risk of a ban (anti-goal 3). The website says so when a member picks these sources.

### Attendance form handler

Lectures only.

- **Detection**: QR codes from stage frames, links in the meeting chat, and links in the watched chat during the meeting.
  - **Unwrapping**: unwrap known link wrappers (Microsoft Safe Links, Google redirect links). Follow up to 5 HTTP redirects with no cookies and no scripts, 5 seconds at most, to find the final URL.
  - **Domains**: only final URLs on Google Forms (`docs.google.com/forms`, `forms.gle`) or Microsoft Forms (`forms.office.com`, `forms.microsoft.com`) count. Anything else is logged and ignored.
  - **Duplicates**: the same form URL is handled once per meeting.
- **QR decoding**: decode the full stage frame and, if known, the upscaled shared-screen region with both zxing-cpp and OpenCV's WeChat detector (compared in [spike 3](#early-spikes)). Accept a code only after it decodes in 2 consecutive frames.
- **Trust (decision 40)**: the form must come from a trusted source. Otherwise the member gets a "form seen, not submitted" ping at high priority with the link and the reason. The trusted sources are:
  - a QR code on the shared screen;
  - a link posted by the meeting host, a co-host or one of the entry's trusted senders;
  - a form that requires sign-in to the member's university organisation (shown on the form page).
- **Is it an attendance form?**: the title, description or questions must contain attendance terms in English or Malay (for example attendance, kehadiran, hadir, register, sign-in sheet), or a keyword set on the timetable entry. A form in quiz mode (showing points or marks) is never submitted. Any other form is logged and pinged at normal priority as "form seen, not submitted".
- **Opening**: open the URL in a new tab of the desk window, so the member's university session applies. If a sign-in or MFA page appears, the session has expired. The handler doesn't try to sign in; it pings the member with the link and a "Sign in again" button (high priority). After the member signs in, it tries once more if the form is still open.
- **Filling** (one page at a time, through "Next" until "Submit"):
  1.  Read every question on the page: label, type, options and whether it's required.
  1.  Match each question to a saved detail. Saved details include derived values: the session's date and start time, and the entry's course code, section and lecturer. Exact label variants match first. Otherwise all remaining labels on the page go to the form-matching model in one batched call. The call sends only the question labels and options (each cut to 120 characters, never the form description), asks for JSON in a fixed schema with thinking turned off, and allows 5 seconds. Only high-confidence matches count.
  1.  **Attendance confirmations (decision 36)**: on a trusted attendance form, tick a required checkbox, or choose a required radio option, whose text confirms attendance or presence (for example "Present", "Hadir", "I confirm I am attending this class").
  1.  Fill matched fields only. Leave optional unmatched questions blank and leave "send me a copy" unticked.
  1.  If any required question is still unmatched (a free-text reflection, a quiz or content question, an unfamiliar choice), don't submit. Ping the member with the link and the question text.
  1.  Choice questions other than attendance confirmations are answered only when one option exactly equals a saved value, such as a section number.
- **Submitting**: screenshot the filled page (the page only, no address bar), submit, wait for the confirmation page, and screenshot it. Ping the member at high priority with the time and a link to the screenshots. Record everything on the meeting page. If the form says it was already answered, record that and ping at normal priority.
- **Speed**: the target is submission within 2 minutes of first sight. Any fallback ping goes out within 30 seconds.
- **Never**: invent answers, answer quiz or content questions, solve CAPTCHAs, or submit the same form twice.

### Name-mention alerts

Live transcription mode only.

- The member lists the names they answer to on My details (for example full name, short name, student ID).
- When one appears in the live transcript, ping the member at high priority with the last 30 seconds of transcript. The ping has buttons for "Open meeting page" and "Take over". "Take over" makes the bot leave first, because Zoom disconnects one session when the same account joins the same meeting twice; then it opens the meeting link.
- This is information only; the bot never responds in the meeting.

### Transcription

- **Live mode**: stream the meeting audio (16 kHz mono PCM) to DashScope's real-time speech recognition, `qwen3-asr-flash-realtime`, over its WebSocket API on the Singapore endpoint, with the member's own key. It supports English and Malay.
  - **Timestamps**: the expert review reports that this model returns no timestamps, accepts no vocabulary, and ends sessions at 120 minutes. The worker therefore timestamps each result by the stream offset of the audio it covers.
  - **Long meetings**: it reconnects during a pause before 110 minutes, with 5 seconds of overlapping audio, and removes duplicate text.
  - **Names**: corrected afterwards from slide text and the timetable entry.
  - **Swapping models**: [spike 5](#early-spikes) checks whether a streaming model with native timestamps and vocabulary support is available on DashScope; if so, it replaces this one behind the same interface.
- **Native mode**: after the meeting, 48 kHz mono FLAC is extracted wherever the recording is: on the server, or on the member's PC in local mode. For server runs, the companion app downloads the FLAC. It runs the member's configured whisper-transcriber command (default model `medium`, one job at a time) and uploads the text, subtitles and segment JSON. If the PC is off, the meeting page shows "waiting for your PC" and the member gets one normal-priority ping. The FLAC is deleted once the transcript is uploaded.
- **Key problems**: if the member's key is rejected or out of quota (401, 402 or 429), all artefacts are kept, the member is pinged, and the meeting page offers a one-click re-run.
- **Hallucinations**: drop segments that are only "you", "Thank you for watching" or a prompt echoed back, which were all seen in the session.
- **Proper nouns**: correct names using slide text and the timetable entry as the source of truth. Mark uncertain words as heard rather than guessing.

### Post-processing and summaries

- **Slides**: keyframes are de-duplicated (the session's dHash rule) and cropped to the shared-screen region. Transition and partial frames are dropped, and slide text is read with the vision model. Output is numbered slides with images and text.
- **Chat**: de-duplicate, order by time, keep thread replies after their parent, and remove invite links. Names are kept as they are (decision 37).
- **Transcript**: paragraphs with `[HH:MM:SS]` timestamps from the recording start, and notes for silent stretches and recording gaps.
- **Summary**, in two steps (designer's call):
  1.  **Inventory**: extract an uncapped JSON list of every deadline, task, announcement and link from transcript, slides and chat. Sources rank slide text first, then the lecturer's chat messages, then speech. Conflicts are recorded as both values (for example "slide says 1 Nov; heard as 31 Oct").
  1.  **Render**: write the Markdown summary from the inventory with the template for the entry's type, following the i-have-adhd rules:
      - the first line after the title is the next action ("Do next");
      - deadlines and times are exact;
      - at most 5 items per section, most urgent first, with the rest under "More deadlines";
      - there's no preamble or recap.
- **Summary file**: Markdown, named `YYYY-MM-DD HHmm <entry name>.md`, the same name in exports.

Lecture template:

```text
<Entry name>, <session label> (<weekday> <date>, <start> to <end>)

Do next: <single most urgent action, with its deadline>

Attendance: <submitted at HH:MM (provider) ✓ | not seen | needs you: <link>>

To do
1. <task> (due <exact date and time>)

What was covered
1. <point>

Announcements
1. <changes to dates, rooms, assessments>

More deadlines
1. <task> (due <exact date and time>)

Details: <meeting page link>
```

Work-meeting template:

```text
<Entry name> (<weekday> <date>, <start> to <end>)

Do next: <the member's most urgent action>

Decisions
1. <decision>

Action items
1. <owner>: <task> (due <date>)

What was discussed
1. <point>

Open questions
1. <question>

Details: <meeting page link>
```

Empty sections are left out. Owners are named only as they were spoken; there is no speaker identification in the first version.

### Notifications

- Self-hosted ntfy with authentication. Each member has one private topic and their own access token; public ntfy.sh is never used.
- **High priority**:
  - form submitted;
  - form needs you, or an untrusted form seen but not submitted;
  - name mentioned;
  - login expired;
  - no link by start time;
  - capacity clash;
  - worker failed, or dropped from the meeting.
- **Normal priority**:
  - joined;
  - a form seen but not submitted because it isn't an attendance form, or is a quiz;
  - meeting ended and summary ready (summary file attached);
  - waiting for your PC (native mode);
  - export finished;
  - deletion in 3 days.
- **Buttons**: "Open form", "Open meeting page", "Sign in again", "Make the bot leave" and "Take over".
- **Contents**: meeting passcodes are never put in ping text. Form screenshots are viewed on the authenticated meeting page rather than attached.
- **Attachments**: the summary file is attached only if ntfy attachments can be made to require authentication and expire within 3 hours (checked in spike 8); otherwise the ping links to the meeting page and the companion app fetches the file.

### Companion app

A small background program with a tray icon on the member's PC, built with Electron (decision 43). Windows first.

- **Notifications**: subscribes to the member's ntfy topic and shows native desktop notifications.
- **Summary files**: saves them to a folder (default `Documents\Meeting summaries`) and opens a file in the default app when its notification is clicked. It never opens anything on its own, so it doesn't take focus while the member works.
- **Native mode**: runs transcription jobs (see [transcription](#transcription)).
- **Local mode**: runs meeting workers for identities set to run on this PC, and relays their control channel (see [run locations](#run-locations)).
- **Staying awake**: keeps the PC awake during local meetings and native jobs by asking the operating system to stay awake while they run, without changing power settings.
- **Security**:
  - **Device token**: it signs in to the website once with a device token the member can revoke. The token only allows the companion endpoints: jobs for this member, audio downloads, artefact uploads, and the saved details and AI key for an active local job. It can't reach browser profiles, remote views or export tokens.
  - **Local secrets**: the device token and the local profile key are kept in Windows' protected storage (Electron `safeStorage`, which uses DPAPI). The profile key is passed to the worker through a short-lived file, never as an environment variable.
- **Transport**: HTTPS polling plus a server-sent event stream for commands.

### Run locations

Each identity runs in one of three places (decision 39). The [spike 1](#early-spikes) results decide the default for a member's university and work identities.

- **Server**: the default. The worker runs on the TolongLabs server in Singapore.
- **Server through home**: the worker runs on the server, but its internet traffic leaves through the member's home connection over a Tailscale exit node on a device at home. Sign-ins then come from the member's usual address, but the home device must be on during meetings.
- **My PC (local mode)**: the companion app runs the same worker container through Docker Desktop. Nothing appears on the member's desktop, and no keyboard or mouse input is involved.
  - **Profile**: the identity's browser profile lives only on the PC, encrypted, and is never uploaded. The member signs in through the companion app's local remote view.
  - **Native mode**: FLAC is extracted on the PC, and only artefacts and transcripts are uploaded.
  - **PC off**: if the PC is asleep or off at T-60, the member gets a high-priority ping straight away.
  - **Memory**: Docker Desktop on Windows needs about 4 GB set aside for a worker, plus more if whisper-transcriber runs at the same time; the companion app checks this before the first local run.

### Exports

From the meeting page, on demand:

- **Download**: a Markdown zip (the session's three-file set plus the summary: the summary file, `transcript.md`, `slides.md` with `slides/NN.webp`, and `chat.md`) and a PDF.
- **Google Docs**: one document per meeting, through Google sign-in with only the `drive.file` scope. The app creates a "TolongMeeting Exports" folder by default, or the member picks a folder with the Google Picker. TolongLabs owns the Google OAuth client and publishes it "In production", so refresh tokens don't expire after 7 days.
- **GitHub**: commit the three-file set and summary to a repository, folder and branch the member configures, using a fine-grained token limited to that repository.
- **Notion**: one page per meeting under a parent page or database the member shares with the TolongLabs Notion integration.
- Each export target is a module behind one interface, so more can be added later. Results and errors are shown on the meeting page and pinged.

## State machines

Meeting occurrence (stored in Postgres; every transition is an event):

```text
scheduled -> starting -> verifying_accounts -> watching_for_link -> joining -> in_lobby -> in_meeting -> leaving -> uploading -> transcribing -> post_processing -> completed

Side exits:
  verifying_accounts  -> waiting_for_signin -> verifying_accounts      (member signs in)
  watching_for_link   -> no_link                                       (30 minutes after start)
  in_lobby            -> denied | in_lobby (knock again, at most 2)
  any running state   -> restarting -> previous state                  (up to 3 times)
  any running state   -> left_by_member                                (leave_now or take_over)
  starting            -> skipped_capacity | skipped_identity_clash | skipped_pc_offline
  transcribing        -> waiting_for_pc                                (native mode)
  any state           -> failed                                        (with reason)
completed | failed | ... -> deleted                                    (30 days after the meeting)
```

Attendance form:

```text
detected -> resolving -> checking_trust -> opening -> inspecting -> filling -> submitting -> submitted

Side exits:
  checking_trust -> untrusted                         (ping)
  inspecting     -> not_attendance | quiz             (ping)
  opening        -> awaiting_signin -> opening        (member signs in; once)
  filling        -> needs_member                      (unmatched required question; ping)
  submitting     -> already_answered                  (ping)
  any            -> failed                            (ping)
```

## Data and storage

Main records (designer's sketch):

- **Member**: GitHub identity, display name, time zone, ntfy topic, role.
- **Identity**: a member's named sign-in identity (for example University, Work), its run location and Zoom guest display name.
- **Browser profile**: one per identity; latest encrypted checkpoint, last-verified time per account, and where it lives.
- **Details**: saved form values with label variants, and names for mention alerts.
- **Timetable entry**: the fields in [website](#website).
- **Meeting occurrence**: entry, scheduled and actual times, state, worker attempts, transcription mode, and the link used. Passcodes are removed from the stored link once the meeting ends.
- **Artefacts**: recording, frames, slides, transcript, chat and summary, as files on disk referenced by path.
- **Form record**: URL, source, sender, trust reason, times, state, fields filled (names only in logs), screenshots, result.
- **Event**: timestamped log per occurrence (joined, notice dismissed, form seen, alert, error, deletion).
- **Connection**: export target tokens, encrypted.

Retention (decision 37): everything belonging to a meeting occurrence is deleted from the server 30 days after the meeting. That covers the recording, frames, slides, transcript, chat, summary, form records and screenshots. Native-mode FLAC files are deleted as soon as the transcript is uploaded. Members can delete any meeting earlier, and get a 3-day warning before automatic deletion. Summary files already saved on the member's PC and exports are the member's own copies.

## Security and privacy

- **Browser profiles** are the most sensitive data: they hold live sessions for university, work, WhatsApp and Discord accounts.
  - **Encryption**: each identity's checkpoints are encrypted with AES-256-GCM under a key derived from the server master key and the identity's id (HKDF).
  - **Master key**: kept in a Docker secret file outside the database and the repository.
  - **Working copies**: live only on an encrypted host volume, mounted only into that identity's worker.
- **Honesty about admins**: isolation between members is enforced by the app, the API and the identity lock. A person with root access to the server can read everything, so only trusted maintainers get server access (anti-goal 6).
- **Starting containers**: the scheduler talks to Docker through a restricted socket proxy that allows only creating, starting, stopping and inspecting worker containers from the fixed worker image with fixed mounts. It blocks `exec`, archive downloads, privileged mode and other images.
- **Network**: worker containers may reach the public internet (HTTPS, and the UDP and TCP ports WebRTC media needs) and the app's own API. They are blocked from private address ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local and cloud metadata addresses (`169.254.0.0/16`, `fe80::/10`) and other containers. A domain allowlist isn't used, because university sign-in, link redirects and media relays reach unpredictable hosts.
- **Remote view**: noVNC reaches the desk side of a worker only, through Caddy with `forward_auth` against the website, for the owning member. It closes after 15 minutes idle. The managed Chrome policy blocks local files, developer tools and downloads.
- **Secrets**: export tokens, ntfy tokens and members' AI keys are encrypted at rest and never logged.
- **Logs**: logs and events redact meeting passcodes, tokens and form field values; only field names are logged, and values show on the member's own meeting page. No personal data or secrets go in URL query strings, except where a platform's own meeting link requires a passcode.
- **Form text is untrusted**: the form-matching model only sees question labels and options, cut to 120 characters, and must answer in a fixed JSON schema. Form descriptions never reach a model.
- **Cloud AI**: transcripts, slides and form questions go to Alibaba Cloud on the member's key. Alibaba's policy (updated 1 October 2026) keeps prompts and responses for up to 30 days and doesn't use business inputs for training without consent. The AI keys page states this.
- **Recording others**: the app records meetings the member attends and keeps other participants' names and messages for 30 days. Whether recording and automated attendance are allowed is the member's responsibility (decision 4), and the website states this when an entry is created. Work-meeting entries default to native transcription and ask the member to check their employer allows cloud AI processing (decision 45). The expert review raised Malaysia's Personal Data Protection Act; TolongLabs should get proper advice before offering this beyond its own members.
- **Signing in**: the app never automates a login form and never stores a password. When a session expires, it asks the member to sign in again.

## Platform realities

From research and expert review on 20 October 2026; verify before relying on them. Details: [platform constraints](../research/platform-constraints.md).

- **Zoom**: since March 2026, Meeting SDK apps that join other accounts' meetings need Zoom-issued authorisation tokens and app review. This design avoids that by using the web client signed in as the member.
  - **One meeting per account**: a signed-in account can't usually be in two meetings at once, and joining the same meeting from a second device disconnects one session. That's why the Zoom adapter has a guest fallback and pings have a "Take over" button.
  - **Guest joins**: joining through the web client as a guest worked on 19 October 2026.
- **Teams**: from about the end of October 2026, Teams detects and labels external meeting-assistant bots in the lobby, with organiser approval required. A signed-in member joining from a browser isn't expected to be labelled, but this is unverified (spike 2).
- **Google Meet**: the Meet Media API no longer accepts new registrations. Guests can land in a review queue that defaults to deny, while signed-in members of the host's organisation can join directly. Meet blocks browsers that report automation, hence the Chrome settings above.
- **University and work sign-in policies**: institutions may limit how long web sessions last on unmanaged devices, re-check sessions when the address changes, or require managed devices. Reusing a session from a data centre while the member is active elsewhere can look like impossible travel. Spike 1 measures this, and the run locations give two ways round it.
- **Chat apps**: Discord and WhatsApp terms forbid automating personal accounts; see [link watchers](#link-watchers).
- **Borrowed code**: joinly and screenappai/meeting-bot are MIT-licensed and fine to borrow join flows from, with attribution. Attendee uses the Elastic License 2.0; read it for ideas only. Details: [open-source meeting bots](../research/open-source-meeting-bots.md).

## Lessons carried over from the session

Requirements that come straight from the [problems and fixes](../session-record/problems-and-fixes.md) catalogue:

- Never synthesise keyboard or mouse input on a member's desktop; the worker runs on its own virtual screen ([SAFE-02](../session-record/problems-and-fixes.md#safe-02-os-level-keystrokes-went-to-the-users-whatsapp), [DESK-02](../session-record/problems-and-fixes.md#desk-02-restoring-chrome-stole-focus-and-covered-the-users-work)).
- Alert on black frames from the first seconds, and never let the recorded window be covered or hidden ([DESK-01](../session-record/problems-and-fixes.md#desk-01-chrome-meeting-window-minimised-during-capture), [OBS-04](../session-record/problems-and-fixes.md#obs-04-obs-recorded-black-frames-while-chrome-was-covered), [CAP-03](../session-record/problems-and-fixes.md#cap-03-the-watcher-missed-black-frames-and-the-gap-was-misdated)).
- Join through the web-client URL, never the launcher page ([ZOOM-05](../session-record/problems-and-fixes.md#zoom-05-zooms-launcher-page-opened-the-desktop-app)).
- Detect the meeting end from page signals, checked every few seconds ([CAP-04](../session-record/problems-and-fixes.md#cap-04-the-watcher-did-not-detect-the-meeting-end)).
- Treat chat as a virtualised list: keep it at the bottom, sweep it periodically, store it as it arrives, and advance cursors only after a durable write ([CHAT-02](../session-record/problems-and-fixes.md#chat-02-the-virtualised-chat-list-hid-new-messages), [CHAT-03](../session-record/problems-and-fixes.md#chat-03-the-pull-cursor-skipped-messages-that-were-never-saved)).
- Re-resolve browser tabs by purpose on every step; never hold tab handles across restarts ([BRW-08](../session-record/problems-and-fixes.md#brw-08-the-extensions-tab-group-and-tab-ids-were-lost)).
- Run one heavy transcription job at a time, and budget memory per worker ([ASR-02](../session-record/problems-and-fixes.md#asr-02-transcription-jobs-were-killed-for-low-memory)).
- Correct names from slides and other authoritative sources ([ASR-04](../session-record/problems-and-fixes.md#asr-04-every-engine-misheard-proper-nouns)).
- Record into crash-safe Matroska segments, and write every capture incrementally.

## Tech stack

All designer's calls.

- **Language**: TypeScript throughout, one repository with Bun workspaces (Bun is the requester's default package manager and runner).
- **Website and API**: Next.js, run with Bun. GitHub sign-in restricted to the TolongLabs organisation.
- **Reverse proxy**: Caddy, for HTTPS, the website, ntfy, and the noVNC WebSockets (through `forward_auth`, because Next.js route handlers don't proxy WebSockets on their own).
- **Database and queue**: Postgres, with a Postgres-backed job queue (for example pg-boss), so there's no Redis.
- **Meeting worker**:
  - **Browser**: Playwright driving pinned full Chrome, run on Node 24 inside the container, because Playwright officially supports Node.
  - **Display and audio**: Xvfb, openbox, PulseAudio.
  - **Capture**: ffmpeg for recording and frames.
  - **QR decoding**: zxing-cpp (WebAssembly build) and OpenCV's WeChat detector, compared in [spike 3](#early-spikes).
  - **Remote view**: x11vnc clipped to the desk half, served by noVNC.
- **Docker access**: a restricted Docker socket proxy (for example `tecnativa/docker-socket-proxy` with only the needed endpoints).
- **Notifications**: self-hosted ntfy.
- **Cloud AI (bring your own key)**: each member's own DashScope key, Singapore region, through the OpenAI-compatible endpoint (`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, or the workspace endpoint `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` when a Workspace ID is given). One client takes a configurable base URL and a model ID per task, with thinking mode off unless a task's tests show it's needed. Defaults as of 20 October 2026 (re-check at build time; details in [AI providers](../research/ai-providers.md)):
  - **Summaries**: `qwen3.7-plus`.
  - **Slide reading**: `qwen3-vl-plus`.
  - **Form-label matching**: the cheapest current flash model (`qwen-flash`, or `qwen3.7-flash` if it's cheaper and as fast at build time).
  - **Live speech recognition**: `qwen3-asr-flash-realtime`, over WebSocket rather than the OpenAI-compatible endpoint.
- **ModelScope**: an alternative provider for text tasks, with its own model-ID mapping, for members who prefer it. Its free quota is unclear and has no service guarantee, and access may need mainland China identity checks. It is never used for live speech recognition, and never as the only route for form matching.
- **Companion app**: Electron, for a reliable tray icon, click-to-open notifications with a registered app ID on Windows, child processes and `safeStorage`.
- **Deployment**: Docker Compose on one server.

## Deployment and cost

- **Server**: one virtual machine in Singapore with 8 vCPUs, 16 GB of memory and 200 GB of disk, running at most 2 meetings at once (decision 38).
  - **Per worker**: the expert review estimates 2.5 to 3.5 vCPUs and 3.5 to 4.5 GB, because Chrome renders video in software without a GPU. [Spike 6](#early-spikes) measures the real figure, and the concurrency cap is set from it.
  - **Cost**: about US$45 to 80 a month.
- **Cloud AI**: paid by each member on their own DashScope key. Estimates from Alibaba's Singapore price list of 19 October 2026 (check the console; the English and Chinese pages disagree on speech pricing):
  - live speech recognition: about US$0.32 per meeting hour;
  - a lecture summary: about US$0.02;
  - slide reading: about US$0.05 for 60 slides;
  - form matching: a fraction of a cent.

  A 2-hour lecture comes to roughly US$0.70; native mode removes the speech cost.

- **Native mode**: free per minute; uses the member's GPU.
- **Backups**: nightly Postgres dump and encrypted profile checkpoints to off-server storage, kept for 7 days so deleted meetings don't linger (designer's call).
- **HTTPS**: a TolongLabs subdomain through Caddy.

## Build order

Each milestone is usable on its own. Effort is in person-weeks for one builder, from the expert review's estimates; the total is about 26 to 37 weeks.

1.  **Early spikes** (1.5 to 2 weeks): see [below](#early-spikes). Their results can reorder what follows.
1.  **Milestone 1A, recorder and pings** (1.5 to 2 weeks):
    - a seeded profile and a configuration file instead of a website;
    - the Zoom adapter, stage and desk screen, recording, chat and frames;
    - QR and chat form detection with trust checks, pinging the member with the form link for a one-tap manual submission;
    - live transcription, slides and the lecture summary, through ntfy.
1.  **Milestone 1B, automatic submission** (2 to 3 weeks): the form handler for Google Forms and Microsoft Forms, including multi-page forms, attendance confirmations and the form state machine.
1.  **Milestone 1C, website** (3 to 4 weeks):
    - sign-in, timetable, identities and the remote sign-in view;
    - My details, AI keys and the meeting page;
    - retention;
    - the scheduler, with the control channel and the occurrence state machine.
1.  **Link watchers** (2 to 3 weeks): WhatsApp Web and Discord.
1.  **Companion app and native mode** (2.5 to 3.5 weeks).
1.  **Teams adapter and Teams chat watcher** (2.5 to 3.5 weeks).
1.  **Google Meet adapter** (2 to 3 weeks).
1.  **Work-meeting template and name-mention alerts with take-over** (1 week).
1.  **Exports** (2.5 to 3.5 weeks): downloads, then GitHub, Google Docs and Notion.
1.  **Run locations beyond the server** (2 to 3 weeks): local mode and the home route. These move to right after milestone 1C if spike 1 shows university sign-ins fail from the server.

## Early spikes

Throwaway checks before milestone 1A, because each could change the design:

1.  **Sign-in from the server**: sign in to the member's university Microsoft and Google accounts, and their work account, in a worker on the Singapore server.
    - Reopen the profile a day and a week later.
    - Join a meeting and open an organisation-restricted form while the member is actively using the same accounts in Malaysia.
    - Check whether the work tenant demands a managed device for Teams.

    Repeat through a Tailscale exit node at home. The results set each identity's default run location.

1.  **Browser in the container**: signed-in joins, audio heard, chat read and end detected on Zoom, Teams and Meet, in Xvfb on the server. This also covers:
    - the Chrome flags, the policy and the stage and desk layout;
    - muting desk tabs;
    - whether Teams labels a signed-in browser as a bot.
1.  **QR decoding**: share slides with QR codes of different sizes from another account, with the chat panel open. Measure decode rate and time with zxing-cpp and OpenCV WeChat on 1080p stage frames.
1.  **Forms**: use a two-page Google Form and a two-page Microsoft Form restricted to an organisation, with:
    - name and ID questions;
    - an attendance confirmation;
    - radio, checkbox and dropdown questions;
    - a required free-text question.

    The handler must fill the first ones and refuse the free text. Also test "already responded", an expired login, an untrusted sender, and a Safe Links-wrapped link.

1.  **Speech recognition**: a 15-minute recording of a Malaysian lecture mixing English and Malay through `qwen3-asr-flash-realtime`. Check accuracy, stream-offset timestamps and reconnection, and look for a streaming model with native timestamps and vocabulary support.
1.  **Resources**: CPU, memory and disk per worker over 2 hours, with chat watchers open.
1.  **Profile persistence**: archive, encrypt and restore a profile signed in to Google, Microsoft, Zoom, Discord and WhatsApp Web across 3 fresh containers over 24 hours, including one forced crash. Check that cookies survive (`--password-store=basic`, fixed machine ID) and that WhatsApp stays linked.
1.  **ntfy attachments**: whether attachments can require authentication and expire within 3 hours.

## Acceptance tests

- **Form fixture**: a test meeting hosted from a TolongLabs account shares a slide with a QR code to a test Google Form at a random time, and later the host posts a Microsoft Form link in chat. Both forms include an attendance confirmation. Both are submitted within 2 minutes with correct details and the confirmation ticked, and both pings arrive.
- **Unsafe form**: these aren't submitted, and the right ping arrives within 30 seconds:
  - a form with an unmatched required question;
  - a quiz-mode form;
  - a non-attendance form that only asks for name and ID;
  - an attendance-looking form posted in chat by an untrusted participant.
- **Expired session**: a profile with the form provider signed out leads to a "sign in again" ping and no submission attempt. After the member signs in through the desk view, the form is submitted if it's still open, and the recording never shows the sign-in.
- **Silence in the meeting**: across a 90-minute test meeting, the bot never unmutes, starts video, types, reacts or shares. The platform's own participant view confirms devices off throughout.
- **End**: when the host ends the meeting, recording stops within 60 seconds and the summary arrives within 10 minutes (live mode).
- **Summary quality**: for 3 recorded test lectures with known deadlines (including one with 7 deadlines and one where speech and slide disagree), every deadline appears with the slide's date, and the line after the title is an action.
- **Isolation**: a second member's session can't reach the first member's meetings, profiles, files or ntfy topic through the website or API.
- **Crash**: killing the worker mid-meeting leads to a rejoin within 2 minutes using the working copy of the profile, a recording with at most a short recorded gap, no repeat form submission, and a ping.
- **Take over**: pressing "Take over" makes the bot leave before the member's link opens.
- **Retention**: a meeting older than 30 days is gone from disk, database and backups older than 7 days, and its 3-day warning was sent.

**Test accounts** (designer's call): TolongLabs' own test accounts weren't confirmed. Build organisation-restricted test forms with the member's own university account, since students can usually create forms limited to their university. Host test meetings from free accounts, keeping Zoom tests under its 40-minute free limit. Run the 90-minute test on Google Meet, Teams, or a university-licensed Zoom account.

## Changes after expert review

Three specialists reviewed revision 1: a meeting-bot infrastructure engineer, an identity and security specialist (who worked without web access), and a systems architect. All three judged it feasible with changes. Each finding and what this revision does about it are listed in the [expert review triage](../research/expert-reviews/README.md). The biggest changes:

- **Placement**: run locations per identity and an expanded sign-in spike.
- **Profiles**: profile storage that survives crashes, plus checkpoints.
- **Screen**: the stage and desk split, so forms, chat watchers and sign-in are never recorded and sign-in works during a meeting.
- **Browser**: Chrome launch settings that avoid automation blocks.
- **Size**: a larger server with a concurrency cap.
- **Forms**: trusted form sources, link unwrapping and isolation of form text from the model.
- **Security**: a network deny-list instead of an allowlist, and a restricted Docker socket.
- **Transcription**: timestamps from stream offsets and reconnection.
- **Summaries**: two-step generation with source priority and an overflow section.
- **Process**: explicit state machines and a control channel.
- **Companion app**: Electron instead of a Bun-compiled executable.
- **Build order**: milestone 1 split into three slices with effort estimates.

## Left to the builder

- Code structure, module boundaries, and test framework.
- UI design of the website and companion app.
- Exact selectors and flows per platform, within the adapter interface.
- Thresholds not fixed above, within the targets.
- The keyframe and crop algorithms, starting from the session's [techniques](../session-record/techniques.md#slides-cropping-curation-and-transcription).
- Prompts for summaries, slide reading and form-label matching, within the templates and rules above.
- Libraries for queues, encryption and Electron packaging.
- Anything else not decided here; record notable choices in the repository's docs.

## Sources

- [Session record](../session-record/overview.md): the 19 October 2026 run, its [workflow](../session-record/workflow.md), [techniques](../session-record/techniques.md), [problems and fixes](../session-record/problems-and-fixes.md) and [runbook](../session-record/runbook.md).
- [Reference scripts](../reference-scripts/README.md), including the in-page JavaScript for Zoom chat capture and end detection.
- Research of 20 October 2026:
  - [open-source meeting bots](../research/open-source-meeting-bots.md);
  - [platform constraints](../research/platform-constraints.md);
  - [AI providers](../research/ai-providers.md);
  - [expert reviews](../research/expert-reviews/README.md).
