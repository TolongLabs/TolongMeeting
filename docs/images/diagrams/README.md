# Diagrams

The diagrams for the TolongMeeting docs, made with Archify and exported as transparent-background SVGs. Each SVG follows the reader's colour scheme: dark by default, light under `prefers-color-scheme: light`. Embed one with plain Markdown, for example `![System architecture](images/diagrams/system-architecture.svg)` from a page in `docs/`, or `../images/diagrams/...` from a page in `docs/trd/`.

Contents:

1.  [Diagram list](#diagram-list)
1.  [Regenerating the diagrams](#regenerating-the-diagrams)
1.  [Notes for embedding](#notes-for-embedding)

## Diagram list

| File                                                                 | Shows                                                                                                                                                                     | Embed in                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [system-architecture.svg](system-architecture.svg)                   | The TolongLabs server, the member's PC, the home exit node and the outside services, with the main connections between them                                               | [docs/TRD.md](../../TRD.md), "Architecture overview"                                                                                                     |
| [meeting-worker.svg](meeting-worker.svg)                             | The inside of one worker container: stage and desk, `tm-worker`, the PulseAudio sink, ffmpeg, the frame loop, live ASR, the occurrence directory and the control client   | [docs/trd/meeting-worker.md](../../trd/meeting-worker.md), "Meeting worker"                                                                              |
| [lecture-sequence.svg](lecture-sequence.svg)                         | How a lecture goes from T-60 to the summary ping, as messages between the scheduler, the worker, the outside sites, the pipeline and the member                           | [docs/PRD.md](../../PRD.md), "How a lecture goes"                                                                                                        |
| [occurrence-lifecycle-start.svg](occurrence-lifecycle-start.svg)     | Meeting occurrence states from `scheduled` to `joining`, with the skipped, waiting, `no_link` and `failed` exits                                                          | [docs/TRD.md](../../TRD.md), "State machines" (first of three occurrence diagrams)                                                                       |
| [occurrence-lifecycle-meeting.svg](occurrence-lifecycle-meeting.svg) | Meeting occurrence states from `joining` to `leaving`, with `in_lobby`, `denied`, `restarting`, `left_by_member` and `failed`                                             | [docs/TRD.md](../../TRD.md), "State machines" (second of three)                                                                                          |
| [occurrence-lifecycle-after.svg](occurrence-lifecycle-after.svg)     | Meeting occurrence states from `leaving` to `deleted`, with `waiting_for_pc` and `failed`                                                                                 | [docs/TRD.md](../../TRD.md), "State machines" (third of three)                                                                                           |
| [form-lifecycle-start.svg](form-lifecycle-start.svg)                 | Attendance form states from `detected` to `inspecting`, with `untrusted`, `awaiting_signin`, `not_attendance` and `quiz`                                                  | [docs/TRD.md](../../TRD.md), "State machines" (first of two form diagrams)                                                                               |
| [form-lifecycle-submit.svg](form-lifecycle-submit.svg)               | Attendance form states from `inspecting` to `submitted`, with `needs_member`, `already_answered` and `failed`                                                             | [docs/TRD.md](../../TRD.md), "State machines" (second of two form diagrams)                                                                              |
| [form-dataflow.svg](form-dataflow.svg)                               | How a form link travels from QR frames, meeting chat or watched chat through resolve, domain filter, duplicate key, trust and attendance checks to a submission or a ping | [docs/PRD.md](../../PRD.md), "Attendance forms" (or the "Detection" part of docs/trd/attendance-forms.md)                                                |
| [control-sequence.svg](control-sequence.svg)                         | The control channel: the 5 s heartbeat and reply, a member command, crash recovery after 30 s of silence, and the companion relay in local mode                           | [docs/trd/scheduler-and-control.md](../../trd/scheduler-and-control.md), "Control channel"                                                               |
| [run-locations.svg](run-locations.svg)                               | What runs where for `server`, `server_via_home` and `local`, and where each browser profile lives                                                                         | [docs/trd/notifications-and-companion.md](../../trd/notifications-and-companion.md), "Run locations" (also [docs/PRD.md](../../PRD.md), "Run locations") |

The occurrence and form state machines are split because an Archify lifecycle diagram holds at most four lanes of five columns. Together the five diagrams cover every state in `OccurrenceState` and `FormState`, and each links to the next with a grey "previous diagram" or "next diagram" state.

## Regenerating the diagrams

Each diagram is a JSON candidate in `src/<name>.<type>.json`, committed. The Archify working files (HTML viewer, receipts, browser evidence) go to `.archify/<name>/` in the repository root, which is git-ignored.

1.  Run every gate and export every SVG: `bun run diagrams --finalize`. It runs `archify finalize` on each candidate (showcase quality), then opens the finalized HTML in Chromium, clicks the viewer's SVG export and saves `<name>.svg` here.
1.  Export one or two diagrams only: `bun run diagrams --finalize system-architecture run-locations`.
1.  Re-export without finalizing again: `bun run diagrams` (it needs the HTML from step 1 in `.archify/`).

The Archify CLI is read from `~/.claude/skills/archify/bin/archify.mjs`; set `ARCHIFY_CLI` to use another copy. Playwright is a root dev dependency pinned to 1.64.1, the `PLAYWRIGHT_VERSION` in `docker/worker/versions.env`; keep the two in step. The script reuses the browsers cached in `~/.cache/ms-playwright`.

The export script makes each SVG transparent by rewriting two style rules, `rect.c-bg-rect` (the theme background) and `.c-grid` (the grid). It fails loudly if either rule is missing.

## Notes for embedding

- **Size**: each SVG is 150 to 190 KiB because it embeds its fonts, so it renders the same everywhere.
- **No legend**: the legends are hidden. The colours are explained by the labels, and a legend sits directly on the page, where it can't stay readable on both a light and a dark page.
- **Cards**: the HTML viewers carry explanatory cards that the SVG export leaves out. Put any explanation in the page text.
- **Colour scheme**: the SVG follows the browser's colour scheme, not the Markdown host's theme. If the two differ, the text on nodes and labels stays readable, but the muted lane, stage and segment headings are faint, and the stage headings of `form-dataflow.svg` disappear when its light version sits on a dark page.
