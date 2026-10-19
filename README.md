# TolongMeeting

An internal TolongLabs app that attends online lectures and work meetings as the member, on Zoom, Microsoft Teams and Google Meet. It catches and submits attendance forms, and delivers an ADHD-friendly summary with full details on a small website. This repository holds the research, the product, requirements, technical and screen documents, and the build plans; implementation hasn't started.

Contents:

1.  [Start here](#start-here)
1.  [Status](#status)
1.  [What it does](#what-it-does)

## Start here

- [Docs index](docs/README.md): what's in this repository and how to read it.
- [Product](docs/PRODUCT.md): the problem, users, principles and terminology (a draft awaiting confirmation).
- [PRD](docs/PRD.md): goals, decisions, requirements, acceptance tests and milestones (revision 2).
- [TRD](docs/TRD.md): architecture, components, security and the binding contracts every plan builds against.
- [Design](docs/DESIGN.md): screens, pings, the summary format and the states to design for.
- [Build plans](docs/plans/README.md): the roadmap and one plan per milestone, built against the [TRD](docs/TRD.md).
- [Research](docs/research/README.md): open-source meeting bots, platform constraints, AI providers and three expert reviews.
- [Session record](docs/session-record/overview.md): the manual run on 19 October 2026 that the app automates.

## Status

- **Design**: revision 2, approved and revised after expert review (20 October 2026).
- **Plans**: written for every milestone, from the spikes (plan 00) to run locations (plan 08), about 26 to 37 person-weeks in total.
- **Code**: none yet. The first step is [plan 00, the spikes](docs/plans/00-spikes.md), whose results can reorder the rest.

## What it does

1.  The member enters their timetable and signs in once to their accounts through a browser the app keeps for them.
1.  Before each session, a private browser in a container watches the member's chosen chat for the meeting link and joins as the member, with microphone and camera off.
1.  During the meeting it records, transcribes, reads the chat and scans the shared screen for QR codes. It submits trusted attendance forms with the member's saved details and pings them with proof.
1.  Afterwards it sends a short summary file, and keeps the transcript, slides and chat on the website for 30 days, with exports to Google Docs, GitHub and Notion.
