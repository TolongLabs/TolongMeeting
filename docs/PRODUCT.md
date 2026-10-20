# TolongMeeting product definition

What TolongMeeting is, who it is for and why it exists, in plain terms. It is also the brief for anyone designing its screens. The [PRD](PRD.md) says what the app must do and how we know it works, the [TRD](TRD.md) says how it is built, and the [design](DESIGN.md) says what the member sees. This page is a draft awaiting the requester's confirmation. It restates decisions already made in the [PRD's decisions table](PRD.md#decisions) in product terms and adds nothing new.

Contents:

1.  [Product in one sentence](#product-in-one-sentence)
1.  [Problem](#problem)
1.  [Users and jobs](#users-and-jobs)
1.  [How it works: the core loop](#how-it-works-the-core-loop)
1.  [Product principles](#product-principles)
1.  [Capabilities at a glance](#capabilities-at-a-glance)
1.  [AI layer at a glance](#ai-layer-at-a-glance)
1.  [Platforms](#platforms)
1.  [Success measures](#success-measures)
1.  [Constraints](#constraints)
1.  [Terminology](#terminology)
1.  [Open decisions](#open-decisions)
1.  [See also](#see-also)

## Product in one sentence

TolongMeeting is an internal TolongLabs app that attends online lectures and work meetings as the member, catches and submits attendance forms, and sends a short summary, with the full details on a small website.

## Problem

- **Lectures**: a TolongLabs member studies part time for a master's degree, and lectures sometimes clash with work. Lecturers post attendance forms at random moments. The form arrives as a QR code on the shared screen or a link in chat, on Google Forms or Microsoft Forms, and stays open for about 5 minutes. Forms usually require the student's university sign-in; otherwise they ask for name and student ID. Attendance is never taken through in-meeting polls.
- **Work meetings**: the member usually can't attend and needs a quick transcript and summary.
- **Origin**: on 19 October 2026 a Claude Code agent attended a Zoom briefing for another member, recorded and wrote it up, but needed close supervision and hit many problems on a shared desktop. This app makes the job repeatable without an agent in the loop. The [session record](session-record/overview.md) tells the story. The [problems and fixes](session-record/problems-and-fixes.md) catalogue and the [expert reviews](research/expert-reviews/README.md) are required reading for the builder.

A missed form means an absence on the member's record. A missed work meeting means catching up from nothing. Doing both by hand means watching a screen for hours.

## Users and jobs

- **Member** (the user): a TolongLabs member. Expect a handful of members, each with a few sessions a week. This is an internal tool for members only (decision 13), so there is no public sign-up, billing or support for other organisations.
  - **Lecture job**: "Make sure I'm counted present, and tell me what I must do next."
  - **Work-meeting job**: "Tell me what was decided and what I owe, without watching the recording."
  - **Control job**: "Let me step in, sign in again or make the bot leave, from wherever I am."
- **Admin**: a TolongLabs maintainer who adds and removes members. Admins don't see members' data in the app.
- **Builder**: one person, with no deadline (decision 32). They are an audience for the docs, not a user of the app.

Each member sees only their own timetable, identities, meetings and files.

## How it works: the core loop

1.  **Set up once**: the member enters a timetable and signs in to their meeting, university and chat accounts through a browser the app keeps for them, one per identity (for example "University" and "Work").
1.  **Before the session**: the app starts a private browser in a container, watches the member's chosen chat for the meeting link, and joins as the member with microphone and camera off.
1.  **During the session**: it records only the meeting window, transcribes the audio, reads the chat and scans the shared screen for QR codes. When a trusted attendance form appears, it fills in the member's saved details, ticks the attendance confirmation, submits, and pings the member with proof. When it can't submit safely, it pings the member with the link instead.
1.  **Afterwards**: it sends a short summary file in an ADHD-friendly format, and keeps the transcript, slides, chat and attendance record on the website, where the member can export them.

The [PRD's scenarios](PRD.md#scenarios) walk through a lecture and a work meeting minute by minute.

## Product principles

1.  **Never submit a wrong answer.** A missing form can be recovered by hand; a made-up answer can't. When unsure, ping the member with the link (anti-goal 1).
1.  **Never fail silently.** The member must hear about every form seen, every sign-in that expired and every worker that failed, before it costs them (anti-goal 2).
1.  **Protect the member's accounts.** The app never stores a password and never automates a login form. It backs off rather than retrying logins (anti-goal 3).
1.  **Be invisible in the meeting.** Joining and leaving are the only visible actions. The app listens and watches only (anti-goal 4).
1.  **Summary first, details on demand.** The first line is the next action. If the member has to open the transcript to find a deadline, the summary failed (anti-goal 5).
1.  **Members are isolated.** One member's sessions, recordings and notes never reach another member through the app. The app is honest that a person with root access to the server can read everything (anti-goal 6).
1.  **The member is in charge.** The member decides where their identity runs, can make the bot leave or take over, and can delete a meeting at any time.

The full wording of the anti-goals is in the [PRD](PRD.md#anti-goals).

## Capabilities at a glance

| Capability       | One line                                                                                           | Requirements                                                |
| ---------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Website          | Timetable, identities, saved details, meeting pages, settings                                      | [Website and accounts](PRD.md#website-and-accounts)         |
| Scheduling       | Turns the timetable into meeting occurrences and starts a worker for each                          | [Scheduling and attending](PRD.md#scheduling-and-attending) |
| Link watching    | Finds the meeting link and form links in the member's chosen chats                                 | [Link watching](PRD.md#link-watching)                       |
| Attendance forms | Detects, vets, fills and submits attendance forms on Google Forms and Microsoft Forms              | [Attendance forms](PRD.md#attendance-forms)                 |
| Name mentions    | Pings the member when their name is spoken (live mode)                                             | [Name mentions](PRD.md#name-mentions)                       |
| Transcription    | Live with a cloud model, or native with the member's local Whisper                                 | [Transcription](PRD.md#transcription)                       |
| Summaries        | A short file in i-have-adhd format, one template for lectures and one for work meetings            | [Summaries](PRD.md#summaries)                               |
| Notifications    | Pings through a private ntfy topic and desktop notifications                                       | [Notifications](PRD.md#notifications)                       |
| Companion app    | A tray app on the member's PC for notifications, summary files, native mode and local mode         | [Companion app](PRD.md#companion-app)                       |
| Run locations    | Each identity runs on the server, on the server through the member's home connection, or on the PC | [Run locations](PRD.md#run-locations)                       |
| Exports          | Downloads, Google Docs, GitHub and Notion, on demand                                               | [Exports](PRD.md#exports)                                   |

## AI layer at a glance

- **Whose key**: each member brings their own Alibaba Cloud DashScope key, with an optional ModelScope key for text tasks (decisions 31 and 34). One key covers all cloud AI.
- **Where AI is used**: four tasks.
  - **Summaries**: turn transcript, slides and chat into the summary.
  - **Slide reading**: read the text on shared slides.
  - **Form-label matching**: match form questions to the member's saved details.
  - **Live speech recognition**: transcribe the meeting while it happens.
- **Where AI is not used**: it never decides to submit a form (trust and attendance rules decide), never answers in a meeting, and never sees a form's description. Form text is treated as untrusted.
- **Local alternative**: native mode runs the member's own Whisper after the meeting instead of cloud speech recognition.

Models, prompts' limits and costs are in the [TRD](TRD.md#tech-stack) and [deployment and cost](TRD.md#deployment-and-cost).

## Platforms

- **Meeting platforms**: Zoom, Microsoft Teams and Google Meet, in that build order (decisions 8 and 23). The app joins through each platform's web client, signed in as the member.
- **Form providers**: Google Forms and Microsoft Forms, both from the start (decision 30), because a university account may be Microsoft or Google.
- **Chat sources for links**: WhatsApp Web, Discord and Teams chat, read through their web apps (decision 14), plus a link pasted on the website.
- **Website**: a web app for the member, behind GitHub sign-in restricted to the TolongLabs organisation.
- **Companion app**: Windows first, built with Electron (decision 43). There is no mobile app; ntfy covers phones.
- **Notifications**: self-hosted ntfy on phone and desktop.

Audience and register for design work: members of a tech organisation, studying part time and working, who open the app while their attention is on a lecture or a job. The summary is written for readers with ADHD, so the tone is calm, short and exact. See [design](DESIGN.md).

## Success measures

The targets and thresholds are in the [PRD goals](PRD.md#goals) and [acceptance tests](PRD.md#acceptance-tests). The product works when:

- Every attendance form shown in a lecture is either submitted correctly or reaches the member as a ping in time to submit by hand.
- No form is ever submitted with a wrong or invented answer.
- The member's accounts are never locked or banned because of the app.
- The member can act on a summary without opening the transcript, and every announced deadline is in it.
- Nothing visible happens in a meeting except joining and leaving.
- No member can see another member's data.
- Everything is gone from the server when the retention period ends.

## Constraints

- **Team and time**: one builder, no deadline (decision 32). Plans are in [roadmap order](plans/README.md).
- **Internal only**: TolongLabs members; no billing or multi-organisation support.
- **Requester's choices that bound the design**: build in-house rather than pay for a meeting-bot service (decision 9); join as the member through their own accounts, not as a separate bot (decision 10); the member enters the timetable and the app never infers times (decision 15).
- **Platform rules**: Zoom, Teams and Meet restrict official bots, and Discord and WhatsApp forbid automating personal accounts; the design works within these. See [platform realities](TRD.md#platform-realities).
- **Privacy and consent**: the member is responsible for whether their programme and employer allow recording and automated attendance (decision 4). See the [privacy requirements](PRD.md#privacy-and-consent).
- **Cost**: the server is shared by TolongLabs; cloud AI is paid by each member on their own key. See [deployment and cost](TRD.md#deployment-and-cost).

## Terminology

- **Member**: a TolongLabs person who uses the app. Each has their own timetable, identities and files.
- **Admin**: a member who can add and remove members.
- **Identity**: a named sign-in set of a member, for example "University" or "Work". Each has its own kept browser profile and its own run location, because Zoom and Teams on the web hold one signed-in account per profile.
- **Timetable entry** (entry): a lecture or work meeting the member wants attended, with a repeat rule, an identity, a link source and a transcription mode.
- **Occurrence**: one dated session of an entry. A worker runs once per occurrence.
- **Link source**: where the meeting link comes from: a fixed link, a chat to watch, or "I'll paste it".
- **Trusted sender**: a lecturer's display name the member lists on an entry. A form link from one of them, from the host or from a co-host counts as trusted.
- **Trusted source**: where an attendance form may come from to be auto-submitted: a QR code on the shared screen, a link from the host, a co-host or a trusted sender, or a form restricted to the member's university organisation.
- **Attendance form**: a Google or Microsoft form that confirms presence. Quizzes and other forms are not attendance forms.
- **Attendance confirmation**: a required tick or "Present" option on a trusted attendance form. The bot ticks these (decision 36).
- **Stage**: the left half of the worker's virtual screen. It holds only the meeting and is the only part recorded.
- **Desk**: the right half. It holds chat watchers, form tabs and the sign-in view, and is never recorded.
- **Worker**: the container that attends one meeting occurrence.
- **Run location**: where an identity's worker runs: the server, the server through the member's home connection, or the member's PC.
- **Live mode**: transcription by a cloud model during the meeting.
- **Native mode**: transcription by the member's local Whisper after the meeting.
- **Ping**: a notification sent through ntfy, with a title, a priority and optional buttons.
- **Summary**: the short file delivered after a meeting, in i-have-adhd format.
- **Take over**: the bot leaves the meeting so the member can join as themselves.
- **Companion app**: the tray app on the member's PC.
- **Meeting page**: the website page that holds one meeting's summary, attendance record, transcript, slides, chat and exports.

Technical terms (working copy, checkpoint, segment, heartbeat) are in the [TRD](TRD.md).

## Open decisions

- **Run location defaults**: which of server, home route or PC suits a member's university and work identities depends on the sign-in spike's results. See [early spikes](TRD.md#early-spikes).
- **Test accounts**: TolongLabs' own test accounts weren't confirmed. The [testing approach](TRD.md#testing-approach) says how the builder works around this.
- **Legal advice**: the expert review raised Malaysia's Personal Data Protection Act. TolongLabs should get proper advice before offering the app beyond its own members. See [privacy and consent](PRD.md#privacy-and-consent).
- **This page**: it is a draft. The requester's confirmation of the principles, audience and success measures is outstanding.

The PRD keeps the list of [open questions](PRD.md#open-questions) about requirements.

## See also

- [PRD](PRD.md): requirements, decisions, acceptance tests and milestones.
- [TRD](TRD.md): architecture, contracts and technical design.
- [Design](DESIGN.md): screens, pings, summary format and states.
- [Build plans](plans/README.md): the roadmap and one plan per milestone.
- [Research](research/README.md): open-source meeting bots, platform constraints, AI providers and three expert reviews.
- [Session record](session-record/overview.md): the manual run that the app automates, with its [workflow](session-record/workflow.md), [techniques](session-record/techniques.md), [problems and fixes](session-record/problems-and-fixes.md) and [runbook](session-record/runbook.md).
- [Reference scripts](reference-scripts/README.md): the in-page JavaScript for Zoom chat capture and end detection.
