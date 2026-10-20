# Build plans

The step-by-step plans for building TolongMeeting, one per milestone of the [PRD's milestones](../PRD.md#milestones). Every plan builds against the shared [architecture and contracts](../TRD.md). Nothing has been built yet; one person builds it, with no deadline.

Contents:

1.  [Roadmap](#roadmap)
1.  [Exit criteria](#exit-criteria)
1.  [How to execute a plan](#how-to-execute-a-plan)
1.  [When the spikes change things](#when-the-spikes-change-things)

## Roadmap

| #   | Plan                                                           | Delivers                                                                                                                                                 | Depends on | Effort (weeks) |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| 00  | [Spikes](00-spikes.md)                                         | Eight throwaway experiments and their reports; pinned versions; run-location defaults                                                                    | Nothing    | 1.5 to 2       |
| 01a | [Recorder and pings](01a-recorder-and-pings.md)                | Monorepo, worker image, Zoom adapter, recording, frames, chat, QR and form-link pings, live transcription, pipeline and lecture summary, from a job file | 00         | 1.5 to 2       |
| 01b | [Form submission](01b-form-submission.md)                      | Automatic Google Forms and Microsoft Forms submission with the form state machine                                                                        | 01a        | 2 to 3         |
| 01c | [Website and scheduler](01c-website-and-scheduler.md)          | Website, database, identities, remote sign-in, scheduler, control channel, retention, Compose deployment                                                 | 01b        | 3 to 4         |
| 02  | [Link watchers](02-link-watchers.md)                           | WhatsApp Web and Discord watchers                                                                                                                        | 01c        | 2 to 3         |
| 03  | [Companion app and native mode](03-companion-and-native.md)    | Electron companion app, desktop notifications, summary files, native transcription                                                                       | 01c        | 2.5 to 3.5     |
| 04  | [Teams](04-teams.md)                                           | Teams adapter and Teams chat watcher                                                                                                                     | 02         | 2.5 to 3.5     |
| 05  | [Google Meet](05-meet.md)                                      | Meet adapter                                                                                                                                             | 01c        | 2 to 3         |
| 06  | [Work meetings and mentions](06-work-meetings-and-mentions.md) | Work-meeting template, name-mention alerts, take-over                                                                                                    | 01c        | 1              |
| 07  | [Exports](07-exports.md)                                       | Downloads, GitHub, Google Docs, Notion                                                                                                                   | 01c        | 2.5 to 3.5     |
| 08  | [Run locations](08-run-locations.md)                           | Local mode through the companion app, and the home route through a Tailscale exit node                                                                   | 03         | 2 to 3         |

The effort figures come from the expert review and total about 26 to 37 person-weeks. Plans 02 to 08 depend only on 01c and can be reordered by need, except where the table says otherwise.

## Exit criteria

A milestone is done when its plan's tasks pass and the matching [acceptance tests](../PRD.md#acceptance-tests) pass on real meetings:

- **00**: every spike has a `REPORT.md` with measurements and a recommendation, and the design is updated where a spike changed a decision.
- **01a**: a real Zoom test lecture is attended from a job file. The member gets the "joined" ping, a ping for each trusted form link within 30 seconds, and the summary within 10 minutes of the end. The recording contains only the stage.
- **01b**: the form fixture, unsafe-form and expired-session acceptance tests pass.
- **01c**: a member signs in, adds an identity and an entry, signs in to accounts through the remote view, and the scheduler runs the occurrence unattended. The crash, isolation and retention tests pass.
- **02 to 08**: the plan's own final task lists the acceptance tests it must pass.

## How to execute a plan

1.  Read the design and [architecture and contracts](../TRD.md) first, then the plan.
1.  Execute the plan with the superpowers `subagent-driven-development` skill (a fresh implementer and a fresh reviewer per task), or `executing-plans` (one session, one review at the end).
1.  Tick the checkboxes in the plan as tasks land, so the plan doubles as a progress record.
1.  If reality disagrees with a plan, for example a selector or an API response, fix the plan in the same commit as the code.

## When the spikes change things

Plan 00 runs first because its results can change later plans:

- **Spike 1, sign-in from the server**: decides whether plan 08 moves up to follow 01c.
- **Spike 2, browser in the container**: fixes the Chrome flags and pinned versions that 01a's worker image uses.
- **Spike 3, QR decoding**: decides between zxing-cpp, OpenCV WeChat or both.
- **Spike 5, speech recognition**: may replace the live speech model.
- **Spike 6, resources**: sets the concurrency cap.
- **Spike 7, profile persistence**: decides whether WhatsApp watching is allowed from the server in plan 02.
- **Spike 8, ntfy attachments**: decides whether summary files are attached to pings.

Each plan names the spike outputs it reads.
