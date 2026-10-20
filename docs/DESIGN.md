# TolongMeeting design

The screens and flows of TolongMeeting: the website's pages, the companion app, the pings, the summary file and the states every screen must handle. What each screen is for comes from the [PRD](PRD.md), and the audience and register come from [PRODUCT.md](PRODUCT.md#platforms). Layout and content are specified here; the visual system is pending the Figma gate (see [visual system](#visual-system)). It does not decide how anything is built; that is the [TRD](TRD.md).

Contents:

1.  [Website pages](#website-pages)
    1.  [Home](#home)
    1.  [Timetable and entry form](#timetable-and-entry-form)
    1.  [Meeting page](#meeting-page)
    1.  [Accounts and remote sign-in](#accounts-and-remote-sign-in)
    1.  [My details](#my-details)
    1.  [Notification settings](#notification-settings)
    1.  [AI keys](#ai-keys)
    1.  [Connections](#connections)
    1.  [Admin](#admin)
1.  [Companion app](#companion-app)
    1.  [Tray](#tray)
    1.  [Desktop notifications](#desktop-notifications)
    1.  [Summary files](#summary-files)
    1.  [Pairing](#pairing)
1.  [Pings](#pings)
    1.  [Priorities](#priorities)
    1.  [Buttons](#buttons)
    1.  [Titles and copy rules](#titles-and-copy-rules)
1.  [Summary file format](#summary-file-format)
    1.  [Format rules](#format-rules)
    1.  [Lecture template](#lecture-template)
    1.  [Work-meeting template](#work-meeting-template)
1.  [States to design for](#states-to-design-for)
1.  [Visual system](#visual-system)

## Website pages

All pages are behind sign-in with GitHub ([WEB-1](PRD.md#website-and-accounts)). A page shows only the signed-in member's own data.

### Home

- Upcoming sessions.
- Any session in progress, with its state (see [state machines](TRD.md#state-machines)).
- Recent summaries.
- Account warnings.
- A notice 3 days before a meeting is deleted, with a link to that meeting page.

### Timetable and entry form

Create, edit and pause entries. Fields:

- name;
- type (lecture or work meeting);
- repeat rule (one-off or weekly days);
- start and expected end time, in the member's time zone;
- identity (which sets where it runs);
- link source: a fixed link, a chat to watch, or "I'll paste it". A chat is identified by its URL (Discord channel, Teams chat) or exact name (WhatsApp);
- trusted senders: the lecturer's display names in the meeting and the watched chat (lectures only);
- transcription mode, live or native. Work meetings default to native and show a notice to check the employer allows cloud AI processing (decision 45);
- per-entry form details (for example course code, section, lecturer) and optional extra attendance keywords.

Saving an entry that overlaps another entry for the same identity warns about the clash straight away ([SCH-4](PRD.md#scheduling-and-attending)).

### Meeting page

- the summary on top;
- the attendance record: each form's time seen, source, trust reason, fields filled, screenshots and result;
- the transcript, with timestamps linked to a video player;
- slides, chat and the event log;
- export buttons and "delete now".

While the meeting is in progress, the page also offers "Make the bot leave" and "Take over" ([SCH-7](PRD.md#scheduling-and-attending)).

### Accounts and remote sign-in

The member's identities, such as "University" and "Work", each with its own kept browser profile.

- **Settings per identity**: the run location (decision 39) and a Zoom display name for guest joins.
- **Sign-in**: opens the remote view of the identity's browser (behaviour in [WEB-5](PRD.md#website-and-accounts)). It shows only the desk, with a "Done" button.
- **Status**: each account's last-verified time.

A "Sign in again" button on a ping opens this page's sign-in view for the identity that needs it.

### My details

The saved values the form handler may use:

- full name as registered;
- student ID;
- university email;
- programme;
- any custom pairs.

Each value has optional label variants (for example "Matric No.", "No. Matrik"). The page also holds the names the member answers to, for mention alerts.

### Notification settings

How to subscribe to the member's ntfy topic on phone and desktop, and a test button.

### AI keys

- The member's DashScope key (Singapore region) with an optional Workspace ID for the recommended workspace endpoint, an optional ModelScope key, and a test button.
- **Region**: keys are tied to a region, so the page says which to use.
- **Data use**: the page states Alibaba's data-use terms (see [security and privacy](TRD.md#security-and-privacy)).
- **Required key**: the page explains that sessions needing cloud AI can't be scheduled without a working key (see [WEB-7](PRD.md#website-and-accounts)).

### Connections

Google, GitHub and Notion, for exports.

### Admin

Add and remove members. Admins don't see members' data in the app.

## Companion app

A small background program on the member's PC, Windows first, with a tray icon and no main window. The behaviour is in [companion app](PRD.md#companion-app) in the PRD; the exact menu and wording are planned in [plan 03](plans/03-companion-and-native.md).

### Tray

The tray menu holds, in this order: a disabled status line (`Connected`, `Offline` or `Not paired`), `Open summaries folder`, `Settings` and `Quit TolongMeeting`.

### Desktop notifications

Every ping the member receives also appears as a native desktop notification. Clicking a summary notification opens the file in the default app. Nothing opens on its own, and the app never takes focus while the member works.

### Summary files

Each summary is saved as a Markdown file named as in [SUM-7](PRD.md#summaries), in a folder the member can open from the tray (default `Documents\Meeting summaries`).

### Pairing

The member creates a one-time pairing code on the website's Devices page and enters it, with the website address, in the companion's pairing window. The same page lists paired PCs and revokes one. A revoked PC shows a notification, "This PC was removed from your account. Click to pair it again."

## Pings

Pings are the app's voice between visits to the website. They arrive on the phone and as desktop notifications, so each must make sense on a lock screen.

### Priorities

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

### Buttons

- **Buttons**: "Open form", "Open meeting page", "Sign in again", "Make the bot leave" and "Take over".

- "Open form" is on a ping about a form the member must submit or check by hand.
- "Open meeting page" and "Take over" are on a name-mention ping ([MENT-2](PRD.md#name-mentions)).
- "Sign in again" is on a ping about an expired login or an expired form session ([SCH-3](PRD.md#scheduling-and-attending), [FORM-5](PRD.md#attendance-forms)).
- "Make the bot leave" is available from a ping while a meeting is in progress (decision 33; [SCH-7](PRD.md#scheduling-and-attending)).

### Titles and copy rules

- A title names the event, then the entry: `Joined: <entry>`, `Form to submit: <entry>`, `Form seen, not submitted: <entry>`, `Alert: <entry>` and `Summary ready: <entry>`. The exact copy is in the `packages/notify` ping builders.
- The message says what happened and what the member can do, in one or two short sentences.
- A ping about a form that wasn't submitted gives the reason and the link. A ping about a question the bot couldn't answer gives the question text.
- A form-submitted ping gives the time and a link to the screenshots on the meeting page.
- Meeting passcodes are never put in ping text.
- Form screenshots are viewed on the authenticated meeting page rather than attached, and the summary file isn't attached ([NTF-3 and NTF-4](PRD.md#notifications)). The summary ping carries the summary text and links to the meeting page.

## Summary file format

The summary is the product's main output. It is sent as a ping and saved by the companion app (see [SUM-1](PRD.md#summaries)).

### Format rules

- The first line after the title is the next action ("Do next").
- Deadlines and times are exact.
- At most 5 items per section, most urgent first, with the rest under "More deadlines".
- There's no preamble or recap.
- Empty sections are left out.
- Owners are named only as they were spoken; there is no speaker identification in the first version.
- The file is Markdown, named as in [SUM-7](PRD.md#summaries).

### Lecture template

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

### Work-meeting template

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

## States to design for

Every screen has to handle these states, in plain words and with one clear next action.

| State                        | The screen must say                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty                        | No entries, meetings or summaries yet. One button to add the first entry, and a prompt for the missing AI key or identity first                       |
| Loading                      | What is loading (the remote sign-in view, the transcript, the recording), so a wait never looks like a failure                                        |
| Error                        | What failed, why, and the next action, for example a rejected AI key (401, 402 or 429) with the one-click re-run on the meeting page                  |
| Sign-in needed               | Which account (meeting platform, chat source or form provider), when it was last verified, and a "Sign in again" button that opens the remote view    |
| Waiting for your PC          | Native mode: the transcript is waiting for the member's PC. One normal-priority ping was sent                                                         |
| Capacity clash               | Two server workers are already running, or two entries for one identity overlap. Switch the identity to the PC, or move an entry                      |
| No link                      | No meeting link by the start time. Paste one now; the worker keeps watching for 30 minutes after the start                                            |
| Form seen, not submitted     | Why (untrusted source, not an attendance form, a quiz, or an unmatched required question), the link and, for an unmatched question, the question text |
| Deletion warning             | This meeting is deleted in 3 days. Export it now or leave it                                                                                          |
| Worker restarting or dropped | The bot dropped out and is rejoining, or has stopped. The member can take over                                                                        |

## Visual system

Pending the Figma gate. Colours, type, spacing and components are not decided, and this page does not invent them. The requester approves a design system and mockups in Figma before any visual tokens are written here or UI code is built. The inputs to that step are the screens above, the [audience and register](PRODUCT.md#platforms) and the [states to design for](#states-to-design-for).
