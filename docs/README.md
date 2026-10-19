# TolongMeeting docs

The documentation for TolongMeeting, an internal TolongLabs app. It attends online lectures and work meetings as the member, catches and submits attendance forms, and delivers ADHD-friendly summaries. It contains the record of the manual run that inspired it (an AI agent attending the SDC Hackathon 2026 opening ceremony on Zoom, 19 October 2026), the research, the design and the build plans. Nothing has been built yet.

Contents:

1.  [Status](#status)
1.  [Layout](#layout)
1.  [How to use these docs](#how-to-use-these-docs)
1.  [Conventions](#conventions)
1.  [Related material](#related-material)
1.  [Questions the brainstorm started from](#questions-the-brainstorm-started-from)

## Status

- **Session record**: complete. Everything in it is fact from the 19 October 2026 session: what was done, what failed, how it was fixed and what came out.
- **Research**: complete as of 20 October 2026. It covers open-source meeting bots, platform constraints and AI providers, plus three specialist reviews of the design.
- **Design**: revision 2, approved by the requester and revised after expert review: [TolongMeeting design](app-design/2026-10-20-meeting-bot-design.md).
- **Plans**: a roadmap, shared architecture contracts and one implementation plan per milestone, in [plans](plans/README.md). Implementation hasn't started; the spikes in plan 00 come first.

## Layout

```text
docs/
├── README.md                          this index
├── app-design/
│   └── 2026-10-20-meeting-bot-design.md   the design: goals, decisions, components, state machines, build order
├── plans/
│   ├── README.md                      roadmap, exit criteria, how to execute
│   ├── architecture.md                binding repository layout, types and interfaces
│   └── 00-spikes.md … 08-run-locations.md   one plan per milestone
├── research/
│   ├── README.md                      index
│   ├── open-source-meeting-bots.md    Attendee, Vexa, joinly, screenappai and others
│   ├── platform-constraints.md        Zoom, Teams, Meet rules; forms; QR decoders
│   ├── ai-providers.md                DashScope and ModelScope models, prices, speech recognition
│   └── expert-reviews/                three specialist reviews and their triage
├── session-record/
│   ├── overview.md                    summary, timeline, ten lessons
│   ├── workflow.md                    stage by stage: goal, inputs, steps, outputs, checks
│   ├── techniques.md                  configuration, commands and code patterns
│   ├── problems-and-fixes.md          every failure: symptom, cause, fix, design rule
│   ├── decisions-and-guardrails.md    user instructions, permissions, safety rules, incidents
│   ├── environment.md                 machine, software, accounts, conventions
│   ├── outcomes.md                    deliverables, numbers, costs, open items
│   └── runbook.md                     how an agent should do the job by hand, with gates
└── reference-scripts/
    ├── README.md                      what each script does, how it was used, its limits
    ├── desktop/                       window enumeration, placement, UI Automation, Chrome tabs
    ├── capture/                       OBS setup, watcher, keeper, cropping, contact sheets
    ├── browser/                       JavaScript injected into Zoom and Discord pages
    ├── transcription/                 cloud ASR runs, clip re-checks, cross-check, timestamp checks
    ├── write-up/                      slides builder
    └── sources/                       Google Drive listing and download, PDF dump, diffs
```

## How to use these docs

- **People**: start with the [design](app-design/2026-10-20-meeting-bot-design.md)'s summary and decisions. For the story behind it, read the session [overview](session-record/overview.md).
- **Agents building the app**: read the [design](app-design/2026-10-20-meeting-bot-design.md), [architecture and contracts](plans/architecture.md) and the [roadmap](plans/README.md), then execute plans in order with the superpowers `subagent-driven-development` or `executing-plans` skill. Read [problems and fixes](session-record/problems-and-fixes.md) and the [expert reviews](research/expert-reviews/README.md) before touching the meeting worker.
- **Agents repeating the job by hand** with Claude Code and the claude-in-chrome extension: follow the [runbook](session-record/runbook.md) and use [techniques](session-record/techniques.md) and the [reference scripts](reference-scripts/README.md).
- **Code reuse**: the reference scripts are session-grade (Windows-only, hard-coded layouts and thresholds); each one's README entry says what it assumes and what to generalise.

## Conventions

- **Times**: Malaysia time (UTC+8) unless stated. In the session record, `rec HH:MM:SS` is time from the start of that session's recording (19:49:12 on 19 October 2026).
- **Redactions**: meeting ids and passcodes appear as `<meeting-id>` and `<pwd>`. Secrets, other people's personal data and participants' names are left out. The team name "Team T010NG" and organisers' public roles are kept.
- **Links**: relative throughout.
- **Style**: follows TolongLabs' Markdown style. That means one H1, a short intro, a contents list, sentence-case headings and no hard wraps.

## Related material

- **Session deliverables**: in `TolongLabs/sdc-hack` on `main`, under `docs/sources/opening-briefing/` (commits `3bb70d2` and `d651e50`) and `docs/sources/participant-drive/` (commit `60cce3f`).
- **Raw Whisper output** of the session's meeting: kept in the requester's local whisper-transcriber project. The recording and its audio were deleted after publishing.
- **Session transcript**: the Claude Code session log the record was mined from, kept by Claude Code on the requester's PC.

## Questions the brainstorm started from

The [design's decisions table](app-design/2026-10-20-meeting-bot-design.md#decisions) records how each was settled:

1.  **Where it runs**: a local desktop agent on the user's PC, a cloud meeting bot that joins as a participant, or both.
2.  **Platforms**: Zoom only, or also Microsoft Teams and Google Meet; Windows only, or macOS and Linux.
3.  **Autonomy**: fully unattended, or with approvals at set points (join, terms, forms, paid APIs, publishing).
4.  **Outputs**: a fixed format and destination, or configurable templates and destinations.
5.  **Form factor**: a Claude Code skill or plugin built from the runbook, a standalone app, or a service.
6.  **Consent and privacy**: recording other people's meetings, capturing chat and names, retention, and how recording notices are handled.
