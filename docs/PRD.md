# TolongMeeting PRD

What TolongMeeting must do, and how we know each part works: goals, decisions, scenarios, requirements, acceptance tests and milestones. The product definition is in [PRODUCT.md](PRODUCT.md), the technical design and binding code contracts are in the [TRD](TRD.md), and the screens are in the [design](DESIGN.md). This is revision 2 of the approved design, written on 20 October 2026 after a brainstorm with the requester and a review by three specialists ([expert reviews](research/expert-reviews/README.md)), and split into these four documents on 20 October 2026. It marks which decisions are the requester's and which are the designer's calls.

Contents:

1.  [Goals](#goals)
1.  [Non-goals](#non-goals)
1.  [Anti-goals](#anti-goals)
1.  [Decisions](#decisions)
1.  [Scenarios](#scenarios)
    1.  [How a lecture goes](#how-a-lecture-goes)
    1.  [A work meeting](#a-work-meeting)
1.  [Requirements](#requirements)
    1.  [Website and accounts](#website-and-accounts)
    1.  [Scheduling and attending](#scheduling-and-attending)
    1.  [Link watching](#link-watching)
    1.  [Attendance forms](#attendance-forms)
    1.  [Name mentions](#name-mentions)
    1.  [Transcription](#transcription)
    1.  [Summaries](#summaries)
    1.  [Notifications](#notifications)
    1.  [Companion app](#companion-app)
    1.  [Run locations](#run-locations)
    1.  [Exports](#exports)
    1.  [Non-functional requirements](#non-functional-requirements)
1.  [Acceptance tests](#acceptance-tests)
1.  [Milestones](#milestones)
1.  [Risks](#risks)
1.  [Changes after expert review](#changes-after-expert-review)
1.  [Open questions](#open-questions)
1.  [Left to the builder](#left-to-the-builder)

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
1.  One member's sessions, recordings or notes reaching another member through the app. A person with root access to the server can technically read everything; the app doesn't pretend otherwise (see [security and privacy](TRD.md#security-and-privacy)).

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

## Scenarios

### How a lecture goes

Times relative to the scheduled start (T).

1.  **T-60**: the scheduler starts a meeting worker for the entry's identity, at the identity's run location. The worker restores the identity's browser profile and checks the accounts the entry needs are still signed in: the meeting platform and the chat source, plus the form provider for lectures. If one isn't, it pings the member at high priority with a "Sign in again" button (see [website](DESIGN.md#website-pages)).
1.  **T-60 to T-5**: if the entry's link comes from a chat, the worker opens that chat and first scans the last 24 hours for meeting links, then keeps watching; the newest link wins. A link pasted on the website always overrides watched links.
1.  **T-10 to T-5**: for lectures, the worker loads the form provider's page once to confirm the session still works there. It then joins as the member with microphone and camera off, connects meeting audio output, waits in any lobby, and confirms it's in. It pings "joined", with the participant count, at normal priority.
1.  **If no link by T**: it pings the member at high priority to paste one on the website, and keeps watching until 30 minutes after the start.
1.  **During the meeting**:
    - It records the meeting window and its sound, and streams audio to live transcription if that mode is chosen.
    - It saves a frame every 2 seconds and decodes any QR codes in it.
    - It reads and stores chat continuously, and keeps watching the link chat for form links.
    - In live mode, it watches the transcript for the member's name.
1.  **Form appears**: if the source is trusted and the form looks like an attendance form, the form handler opens it on the unrecorded side of the screen. It fills saved details, ticks attendance confirmations, submits, and pings with screenshots of the page. If anything is uncertain, it doesn't submit; it pings with the link instead.
1.  **End**: the worker detects the end from the page (see [platform adapters](trd/meeting-worker.md#platform-adapters)) or stops at the scheduled end plus 30 minutes. It stops recording, uploads everything and checkpoints the browser profile. Chat was stored as it arrived, so nothing depends on reading it after the end.
1.  **After**: post-processing builds the transcript (live mode, or waits for the member's PC in native mode), then the slides, chat and summary. The summary goes out as a ping. The companion app saves the file and shows a desktop notification that opens it when clicked.

### A work meeting

A work meeting follows the same steps without form detection, and with the work-meeting summary template. The member usually isn't present and the bot joining as them is fine (decision 29). The entry defaults to native transcription and shows the employer-permission notice (decision 45).

## Requirements

Each requirement has an ID so plans and tests can cite it. Detail on how a requirement is met is in the [TRD](TRD.md#components); what the member sees is in the [design](DESIGN.md).

### Website and accounts

- **WEB-1 Sign-in and organisation check.** All pages are behind GitHub sign-in. Membership of the TolongLabs organisation is checked at each sign-in and daily, through the `read:org` scope, and sessions end when someone leaves the organisation (designer's call).
- **WEB-2 Pages.** The website has the pages in [website pages](DESIGN.md#website-pages): home, timetable, meeting page, accounts, my details, notifications, AI keys, connections and admin.
- **WEB-3 Timetable entries.** Members create, edit and pause entries with the fields in the [entry form](DESIGN.md#timetable-and-entry-form). Times are in the member's time zone. Work-meeting entries default to native transcription and show a notice to check the employer allows cloud AI processing (decision 45). The website states the member's responsibility for recording and automated attendance when an entry is created (decision 4).
- **WEB-4 Identities.** A member has several sign-in identities, such as "University" and "Work", each with its own kept browser profile, because Zoom and Teams on the web hold one signed-in account per profile. Each identity has a run location (decision 39) and a Zoom display name for guest joins.
- **WEB-5 Remote sign-in.** The member signs in to Zoom, Microsoft, Google, WhatsApp Web (scan with phone), Discord and Teams through a remote view of the identity's browser. If a worker is running for that identity, the view attaches to that worker's unrecorded desk and pauses its automation until the member presses "Done". Otherwise a short-lived sign-in container starts. The app never stores a password. Each account shows its last-verified time.
- **WEB-6 Saved details.** The member keeps the values the form handler may use (full name as registered, student ID, university email, programme and any custom pairs), each with optional label variants, and the names they answer to for mention alerts.
- **WEB-7 AI keys.** The member stores a DashScope key (Singapore region) with an optional Workspace ID, and an optional ModelScope key, with a test button. The page says which region to use and states Alibaba's data-use terms (see [security and privacy](TRD.md#security-and-privacy)). Sessions needing cloud AI can't be scheduled without a working key; native-mode entries still need one for summaries.
- **WEB-8 Notification setup.** The member sees how to subscribe to their ntfy topic on phone and desktop, and has a test button.
- **WEB-9 Connections.** The member connects Google, GitHub and Notion for exports.
- **WEB-10 Admin.** Admins add and remove members. Admins don't see members' data in the app.
- **WEB-11 Meeting page and deletion.** Every occurrence has a meeting page (contents in the [design](DESIGN.md#meeting-page)). The member can export from it and use "delete now".

### Scheduling and attending

- **SCH-1 Occurrences.** The scheduler expands timetable entries into meeting occurrences 14 days ahead and starts a worker for each at T-60 (designer's call).
- **SCH-2 Timings.** Watch from T-60, join T-10 to T-5, hard stop at the scheduled end plus 30 minutes (decision 16).
- **SCH-3 Account check.** At T-60 the worker checks that the accounts the entry needs are still signed in: the meeting platform, the chat source, and the form provider for lectures. If one isn't, the member gets a high-priority ping with a "Sign in again" button.
- **SCH-4 Identity lock.** Two workers never run for the same identity at once. If two entries for one identity overlap, the earlier start wins, and the member is pinged about the clash when the entry is saved and again at T-60.
- **SCH-5 Server capacity.** At most 2 server workers run at once (decision 38). If a third would start, the member is pinged at high priority at T-60, with the option to switch that identity to their PC.
- **SCH-6 Crash recovery.** A crashed worker is restarted and rejoins, up to 3 times per occurrence, and the member is pinged each time. The worker rejoins once automatically after an unexpected drop from the meeting.
- **SCH-7 Member commands.** The member can tell the bot to leave a meeting, or take over from it (the bot leaves, then the member's ping opens the meeting link), from the website or a ping button (decision 33).
- **ATT-1 Joining.** The worker joins as the member through the platform's web client, signed in with the member's own account, with microphone and camera off for the whole session. It waits in any lobby until the scheduled end plus 30 minutes at most, and stops and pings if the host denies entry. On Zoom, it falls back to a guest join with the identity's display name when the identity has no Zoom account (decision 28).
- **ATT-2 Nothing visible.** Joining and leaving are the only visible actions. The bot never unmutes, starts video, types, reacts, raises a hand or shares, and never accepts a breakout room.
- **ATT-3 Recording.** Only the meeting window is recorded. Forms, chat watchers and sign-in sit on an unrecorded side of the screen (decision 41).
- **ATT-4 End.** The worker detects the end of the meeting from the page, or stops at the scheduled end plus 30 minutes. Chat is stored as it arrives, so nothing depends on reading it after the end.
- **ATT-5 Health pings.** The member is pinged when recording looks broken or the bot drops from the meeting (thresholds in the [meeting worker](trd/meeting-worker.md#meeting-worker)).
- **ATT-6 Polls.** In-meeting polls are ignored (decision 27).

### Link watching

- **LINK-1 Sources.** A meeting link comes from a fixed link, from a chosen WhatsApp, Discord or Teams chat watched through its web app, or from the member pasting it on the website (decision 14). A link pasted on the website always overrides watched links.
- **LINK-2 Scan and watch.** If the entry's link comes from a chat, the worker opens that chat from T-60 and first scans the last 24 hours for meeting links, then keeps watching until the meeting ends. The newest link wins. Each watcher reads only the chat named in the entry.
- **LINK-3 Read-only.** Watchers never send, react or mark-as-read beyond what opening the chat does.
- **LINK-4 No link.** If there is no link by the start time, the member gets a high-priority ping to paste one, and the worker keeps watching until 30 minutes after the start.
- **LINK-5 Form links.** During a meeting the worker keeps watching the link chat for attendance-form links, with the sender.
- **LINK-6 Ban risk.** Discord and WhatsApp forbid automating personal accounts. Read-only watching reduces but doesn't remove the risk of a ban (anti-goal 3). The website says so when a member picks these sources. If WhatsApp shows warnings or drops the link when used from the server, WhatsApp watching is limited to identities that run at home (designer's call; see [spike 7](TRD.md#early-spikes)).

### Attendance forms

Lectures only.

- **FORM-1 Detection.** The app detects forms from QR codes on the shared screen, links in the meeting chat, and links in the watched chat during the meeting.
- **FORM-2 Providers.** Only final URLs on Google Forms (`docs.google.com/forms`, `forms.gle`) or Microsoft Forms (`forms.office.com`, `forms.microsoft.com`) count. Anything else is logged and ignored. The same form URL is handled once per meeting.
- **FORM-3 Trust (decision 40).** The form must come from a trusted source. Otherwise the member gets a "form seen, not submitted" ping at high priority with the link and the reason. The trusted sources are:
  - a QR code on the shared screen;
  - a link posted by the meeting host, a co-host or one of the entry's trusted senders;
  - a form that requires sign-in to the member's university organisation (shown on the form page).
- **FORM-4 Is it an attendance form?** The title, description or questions must contain attendance terms in English or Malay (for example attendance, kehadiran, hadir, register, sign-in sheet), or a keyword set on the timetable entry. A form in quiz mode (showing points or marks) is never submitted. Any other form is logged and pinged at normal priority as "form seen, not submitted".
- **FORM-5 Expired session.** If a sign-in or MFA page appears, the session has expired. The handler doesn't try to sign in; it pings the member with the link and a "Sign in again" button (high priority). After the member signs in, it tries once more if the form is still open.
- **FORM-6 Filling.** The handler fills one page at a time, through "Next" until "Submit":
  1.  It matches each question to a saved detail. Saved details include derived values: the session's date and start time, and the entry's course code, section and lecturer.
  1.  **Attendance confirmations (decision 36)**: on a trusted attendance form, it ticks a required checkbox, or chooses a required radio option, whose text confirms attendance or presence (for example "Present", "Hadir", "I confirm I am attending this class").
  1.  It fills matched fields only. It leaves optional unmatched questions blank and leaves "send me a copy" unticked.
  1.  If any required question is still unmatched (a free-text reflection, a quiz or content question, an unfamiliar choice), it doesn't submit. It pings the member with the link and the question text.
  1.  It answers choice questions other than attendance confirmations only when one option exactly equals a saved value, such as a section number.
- **FORM-7 Proof.** The handler screenshots the filled page (the page only, no address bar), submits, waits for the confirmation page and screenshots it. It pings the member at high priority with the time and a link to the screenshots, and records everything on the meeting page. If the form says it was already answered, it records that and pings at normal priority.
- **FORM-8 Speed.** Submission and fallback pings meet goals 2 and 3.
- **FORM-9 Never.** The handler never invents answers, answers quiz or content questions, solves CAPTCHAs, or submits the same form twice.

### Name mentions

Live transcription mode only.

- **MENT-1 Names.** The member lists the names they answer to on My details (for example full name, short name, student ID).
- **MENT-2 Ping.** When one appears in the live transcript, the member is pinged at high priority with the last 30 seconds of transcript and buttons for "Open meeting page" and "Take over". "Take over" makes the bot leave first, because Zoom disconnects one session when the same account joins the same meeting twice; then it opens the meeting link.
- **MENT-3 Information only.** The bot never responds in the meeting.

### Transcription

- **TRN-1 Two modes.** Each timetable entry has a mode: live (a cloud model during the meeting) or native (the member's local Whisper after the meeting) (decision 7). Live transcription runs on the member's DashScope key (decision 34) and supports English and Malay.
- **TRN-2 Native mode.** After the meeting the member's PC transcribes the audio with their configured whisper-transcriber command. If the PC is off, the meeting page shows "waiting for your PC" and the member gets one normal-priority ping. The audio file is deleted once the transcript is uploaded.
- **TRN-3 Key problems.** If the member's key is rejected or out of quota (401, 402 or 429), all artefacts are kept, the member is pinged, and the meeting page offers a one-click re-run.
- **TRN-4 Hallucinations.** Segments that are only "you", "Thank you for watching" or a prompt echoed back are dropped. All three were seen in the session.
- **TRN-5 Proper nouns.** Names are corrected using slide text and the timetable entry as the source of truth. Uncertain words are marked as heard rather than guessed.

### Summaries

- **SUM-1 Delivery.** After the meeting, post-processing builds the transcript (live mode, or after the member's PC finishes in native mode), then the slides, chat and summary. The summary goes out as a ping. The companion app saves the file and shows a desktop notification that opens it when clicked.
- **SUM-2 Completeness and sources.** Every announced deadline, task, announcement and link is in the summary. Where sources disagree, slide text ranks first, then the lecturer's chat messages, then speech, and the conflict is recorded as both values (for example "slide says 1 Nov; heard as 31 Oct").
- **SUM-3 Format.** The summary follows the i-have-adhd rules and the templates in the [summary file format](DESIGN.md#summary-file-format).
- **SUM-4 Slides.** The slides are numbered, with images and text. Transition and partial frames are dropped.
- **SUM-5 Chat.** The saved chat is de-duplicated and ordered by time, keeps thread replies after their parent, and has invite links removed. Names are kept as they are (decision 37).
- **SUM-6 Transcript.** The transcript is paragraphs with `[HH:MM:SS]` timestamps from the recording start, with notes for silent stretches and recording gaps.
- **SUM-7 File name.** The summary file is Markdown, named `YYYY-MM-DD HHmm <entry name>.md`, with the same name in exports.

### Notifications

- **NTF-1 Private topic.** Notifications use self-hosted ntfy with authentication. Each member has one private topic and their own access token; public ntfy.sh is never used (decision 18).
- **NTF-2 Events.** The app pings the events in [pings](DESIGN.md#pings), at the priorities listed there, with the buttons listed there.
- **NTF-3 Contents.** Meeting passcodes are never put in ping text. Form screenshots are viewed on the authenticated meeting page rather than attached.
- **NTF-4 No attachments.** The summary file isn't attached to pings. The ping links to the meeting page, and the companion app fetches the file ([why](trd/notifications-and-companion.md#notifications)).
- **NTF-5 Desktop notifications.** Desktop notifications come from the companion app (decision 17).

### Companion app

- **APP-1 Tray app.** A small background program with a tray icon on the member's PC, built with Electron (decision 43). Windows first.
- **APP-2 Notifications and files.** It subscribes to the member's ntfy topic and shows native desktop notifications. It saves summary files to a folder (default `Documents\Meeting summaries`) and opens a file in the default app when its notification is clicked. It never opens anything on its own, so it doesn't take focus while the member works.
- **APP-3 Native mode.** It runs transcription jobs (see [transcription](#transcription)).
- **APP-4 Local mode.** It runs meeting workers for identities set to run on this PC (see [run locations](#run-locations)).
- **APP-5 Staying awake.** It keeps the PC awake during local meetings and native jobs by asking the operating system to stay awake while they run, without changing power settings.
- **APP-6 Revocable access.** It signs in to the website once with a device token the member can revoke.

### Run locations

- **LOC-1 Three places.** Each identity runs in one of three places, set per identity and not per entry (decision 39). The [spike 1](TRD.md#early-spikes) results decide the default for a member's university and work identities.
- **LOC-2 Server.** The default. The worker runs on the TolongLabs server in Singapore.
- **LOC-3 Server through home.** The worker runs on the server, but its internet traffic leaves through the member's home connection. Sign-ins then come from the member's usual address, but the home device must be on during meetings.
- **LOC-4 My PC (local mode).** The companion app runs the same worker on the member's PC. Nothing appears on the member's desktop, and no keyboard or mouse input is involved. The identity's browser profile lives only on the PC and is never uploaded. In native mode, only artefacts and transcripts are uploaded.
- **LOC-5 PC off.** If the PC is asleep or off at T-60, the member gets a high-priority ping straight away.

### Exports

- **EXP-1 On demand.** Exports happen when the member asks, from the meeting page. They are never automatic. Markdown and PDF downloads are always available (decision 21).
- **EXP-2 Download.** A Markdown zip (the session's three-file set plus the summary: the summary file, `transcript.md`, `slides.md` with `slides/NN.webp`, and `chat.md`) and a PDF.
- **EXP-3 Google Docs.** One document per meeting. The app creates a "TolongMeeting Exports" folder by default, or the member picks a folder.
- **EXP-4 GitHub.** The three-file set and summary are committed to a repository, folder and branch the member configures.
- **EXP-5 Notion.** One page per meeting under a parent page or database the member shares with the TolongLabs Notion integration.
- **EXP-6 Results.** Results and errors are shown on the meeting page and pinged. More targets can be added later.

### Non-functional requirements

#### Timings

The timing targets are: the join window and hard stop in SCH-2, form speed and the summary deadline in [goals](#goals) 2 to 4, and the end, crash and retention timings in the [acceptance tests](#acceptance-tests). The worker, heartbeat and reconnection timings that implement them are in the [TRD](TRD.md#components).

#### Retention

Everything belonging to a meeting occurrence is deleted from the server 30 days after the meeting (decision 37). That covers the recording, frames, slides, transcript, chat, summary, form records and screenshots. Native-mode FLAC files are deleted as soon as the transcript is uploaded. Members can delete any meeting earlier, and get a 3-day warning before automatic deletion. The warning is a normal-priority ping (designer's call). Summary files already saved on the member's PC and exports are the member's own copies.

#### Isolation

Each member sees only their own timetable, identities, meetings and files through the website and API. One member's session can't reach another member's meetings, profiles, files or ntfy topic. The limit of this isolation is stated in anti-goal 6, and [security and privacy](TRD.md#security-and-privacy) says how it is enforced.

#### Privacy and consent

The app records meetings the member attends and keeps other participants' names and messages for 30 days. Whether recording and automated attendance are allowed is the member's responsibility (decision 4), and the website states this when an entry is created. Work-meeting entries default to native transcription and ask the member to check their employer allows cloud AI processing (decision 45). The expert review raised Malaysia's Personal Data Protection Act; TolongLabs should get proper advice before offering this beyond its own members.

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

## Milestones

Each milestone is usable on its own. Effort is in person-weeks for one builder, from the expert review's estimates; the total is about 26 to 37 weeks.

1.  **Early spikes** (1.5 to 2 weeks): see [below](TRD.md#early-spikes). Their results can reorder what follows.
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

## Risks

Each risk is handled in the section named in the last column.

| Risk                                                                                        | Response                                                                                                    | Where                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| University or work sign-ins fail from a data-centre address, or look like impossible travel | Measure first; offer the home route and the member's PC as run locations                                    | [Spike 1](TRD.md#early-spikes), [run locations](#run-locations)                |
| The member's accounts are locked or banned                                                  | The app never automates a login, backs off rather than retrying, and watches chats read-only                | [Anti-goal 3](#anti-goals), [link watching](#link-watching)                    |
| A wrong answer is submitted on an attendance form                                           | Trusted sources only, attendance-form test, no made-up answers, form text isolated from the model           | [Attendance forms](#attendance-forms), [security](TRD.md#security-and-privacy) |
| Platforms block or label automated browsers (Teams bot labelling is unverified)             | Chrome launch settings that avoid automation blocks, joining as a signed-in member, a monthly smoke test    | [Platform realities](TRD.md#platform-realities)                                |
| Worker resource use is higher than estimated                                                | Measure it, and set the concurrency cap from the result                                                     | [Deployment and cost](TRD.md#deployment-and-cost), spike 6                     |
| The live speech model has no timestamps, no vocabulary support and a session limit          | Timestamp from stream offsets, reconnect before the limit, look for a better model                          | [Transcription](trd/transcription-and-summaries.md#transcription), spike 5     |
| A crash loses a session's state or repeats a form submission                                | Working copy and checkpoints of the profile, events stored as they arrive, the crash acceptance test        | [Scheduling](#scheduling-and-attending), [acceptance tests](#acceptance-tests) |
| Recording others breaches privacy law or an employer's rules                                | The member is responsible, notices on entry creation, 30-day retention, proper advice before wider use      | [Privacy and consent](#privacy-and-consent)                                    |
| ModelScope's free quota is unclear and access may need mainland China identity checks       | It is an alternative for text tasks only, never for live speech recognition or the only form-matching route | [Tech stack](TRD.md#tech-stack)                                                |
| One builder, no deadline, so the build is long                                              | Each milestone is usable on its own, and the spikes can reorder the rest                                    | [Milestones](#milestones)                                                      |

## Changes after expert review

Three specialists reviewed revision 1: a meeting-bot infrastructure engineer, an identity and security specialist (who worked without web access), and a systems architect. All three judged it feasible with changes. Each finding and what this revision does about it are listed in the [expert review triage](research/expert-reviews/README.md). The biggest changes:

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

## Open questions

- **Run-location defaults**: set by the results of [spike 1](TRD.md#early-spikes) for each member's university and work identities.
- **WhatsApp from the server**: allowed only if [spike 7](TRD.md#early-spikes) shows the linked-device state survives and WhatsApp raises no warnings.
- **Live speech model**: [spike 5](TRD.md#early-spikes) checks whether a streaming model with native timestamps and vocabulary support is available on DashScope.
- **Concurrency cap**: set from [spike 6](TRD.md#early-spikes)'s per-worker measurement.
- **Teams bot labelling**: whether Teams labels a signed-in browser as a bot is unverified ([spike 2](TRD.md#early-spikes)).
- **Test accounts**: TolongLabs' own test accounts weren't confirmed; see the [testing approach](TRD.md#testing-approach).
- **Legal advice**: proper advice on Malaysia's Personal Data Protection Act before offering the app beyond TolongLabs.
- **ModelScope for text tasks**: routing summaries and slide reading to ModelScope isn't planned yet; see [known follow-ups](TRD.md#known-follow-ups).

## Left to the builder

- Code structure, module boundaries, and test framework.
- UI design of the website and companion app.
- Exact selectors and flows per platform, within the adapter interface.
- Thresholds not fixed above, within the targets.
- The keyframe and crop algorithms, starting from the session's [techniques](session-record/techniques.md#slides-cropping-curation-and-transcription).
- Prompts for summaries, slide reading and form-label matching, within the templates and rules above.
- Libraries for queues, encryption and Electron packaging.
- Anything else not decided here; record notable choices in the repository's docs.
