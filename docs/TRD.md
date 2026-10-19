# TolongMeeting TRD

The technical design of TolongMeeting and the code-level decisions every plan shares: architecture, components, state machines, security, platform realities, repository layout, tooling, shared types, interfaces between packages, on-disk data layout and environment variables. Each milestone plan builds against this page, so the names from [repository layout](#repository-layout) onwards are binding; a plan that needs to change one updates this page in the same commit. It implements the [PRD](PRD.md), revision 2 of the approved design, for the product in [PRODUCT.md](PRODUCT.md), and the screens are in the [design](DESIGN.md). Component deep-dives are in [`docs/trd/`](#components).

Contents:

1.  [Architecture overview](#architecture-overview)
1.  [Components](#components)
1.  [Tech stack](#tech-stack)
1.  [State machines](#state-machines)
1.  [Data and storage](#data-and-storage)
1.  [Security and privacy](#security-and-privacy)
1.  [Platform realities](#platform-realities)
1.  [Lessons carried over from the session](#lessons-carried-over-from-the-session)
1.  [Deployment and cost](#deployment-and-cost)
1.  [Testing approach](#testing-approach)
1.  [Early spikes](#early-spikes)
1.  [Repository layout](#repository-layout)
1.  [Tooling and conventions](#tooling-and-conventions)
1.  [Runtime processes](#runtime-processes)
1.  [Core types](#core-types)
1.  [Worker interfaces](#worker-interfaces)
1.  [AI, notification and pipeline interfaces](#ai-notification-and-pipeline-interfaces)
1.  [Data directory layout](#data-directory-layout)
1.  [Database](#database)
1.  [Environment variables](#environment-variables)
1.  [Plan conventions](#plan-conventions)
1.  [Contract additions and reconciliation](#contract-additions-and-reconciliation)
    1.  [Additions by plan](#additions-by-plan)
    1.  [Changed shapes](#changed-shapes)
    1.  [Name reconciliation](#name-reconciliation)
    1.  [Known follow-ups](#known-follow-ups)

## Architecture overview

TolongMeeting is one TypeScript repository deployed with Docker Compose on one server. The member's browser reaches a Caddy reverse proxy, which serves the Next.js website and API, the self-hosted ntfy server and, for the signed-in owner only, the remote view of a worker's desk. Postgres holds the data and the job queue. The scheduler turns timetable entries into occurrences and starts one worker container per occurrence through a restricted Docker socket proxy. The worker attends the meeting, records and watches it, and sends heartbeats to the server; the reply carries the member's commands. When the worker exits, the pipeline builds the transcript, slides, chat and summary, and the member is pinged. On the member's PC, the Electron companion app shows notifications, saves summaries, runs native transcription and, for identities set to run locally, runs the same worker container.

| Process               | What it does                                                           | Where                                      |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `tm-web`              | Website and API                                                        | Server, behind Caddy                       |
| `tm-scheduler`        | Expands timetables, runs the queue, launches workers, deletes old data | Server                                     |
| `tm-worker`           | Attends one meeting occurrence                                         | Server, or the member's PC through Docker  |
| `tm-pipeline`         | Builds the transcript, slides, chat and summary after the worker exits | Server, or the member's PC for native mode |
| `tm-companion`        | Notifications, summary files, native transcription, local mode         | The member's PC                            |
| ntfy, Caddy, Postgres | Pings, HTTPS and WebSocket proxy, data and queue                       | Server                                     |

The packages, milestones and entry points behind these processes are in [runtime processes](#runtime-processes) and [repository layout](#repository-layout).

## Components

Each component has a deep-dive under `docs/trd/`. The binding names, types and interfaces stay on this page, from [repository layout](#repository-layout) onwards.

| Component                     | Technical design                                                                    | Requirements                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Website and API               | [Website and API](trd/website-and-api.md)                                           | [Website and accounts](PRD.md#website-and-accounts)         |
| Scheduler                     | [Scheduler](trd/scheduler-and-control.md#scheduler)                                 | [Scheduling and attending](PRD.md#scheduling-and-attending) |
| Control channel               | [Control channel](trd/scheduler-and-control.md#control-channel)                     | [Scheduling and attending](PRD.md#scheduling-and-attending) |
| Meeting worker                | [Meeting worker](trd/meeting-worker.md#meeting-worker)                              | [Scheduling and attending](PRD.md#scheduling-and-attending) |
| Platform adapters             | [Platform adapters](trd/meeting-worker.md#platform-adapters)                        | [Scheduling and attending](PRD.md#scheduling-and-attending) |
| Link watchers                 | [Link watchers](trd/link-watchers.md)                                               | [Link watching](PRD.md#link-watching)                       |
| Attendance form handler       | [Attendance form handler](trd/attendance-forms.md)                                  | [Attendance forms](PRD.md#attendance-forms)                 |
| Name-mention detection        | [Name-mention detection](trd/transcription-and-summaries.md#name-mention-detection) | [Name mentions](PRD.md#name-mentions)                       |
| Transcription                 | [Transcription](trd/transcription-and-summaries.md#transcription)                   | [Transcription](PRD.md#transcription)                       |
| Post-processing and summaries | [Post-processing](trd/transcription-and-summaries.md#post-processing)               | [Summaries](PRD.md#summaries)                               |
| Notifications                 | [Notifications](trd/notifications-and-companion.md#notifications)                   | [Notifications](PRD.md#notifications)                       |
| Companion app                 | [Companion app](trd/notifications-and-companion.md#companion-app)                   | [Companion app](PRD.md#companion-app)                       |
| Run locations                 | [Run locations](trd/notifications-and-companion.md#run-locations)                   | [Run locations](PRD.md#run-locations)                       |
| Exports                       | [Exports](trd/exports.md)                                                           | [Exports](PRD.md#exports)                                   |

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
  - **QR decoding**: zxing-cpp (WebAssembly build) and OpenCV's WeChat detector, compared in [spike 3](#early-spikes). Ruling (supersedes the spike's rule result `qr.decoder=wechat`): `decodeQr` returns the union of three stages, with no first-hit stop: zxing on the full stage frame, zxing on the 2x Lanczos-upscaled shared-screen region (when a region is known), and WeChat on the full frame. WeChat's region pass is dropped, since it added nothing in the spike. WeChat runs in one long-lived Python process per worker (`src/qr/wechat_bridge.py`, newline-delimited JSON on stdin and stdout). There is no zxing-only fallback: if the bridge cannot start or dies, `decodeQr` throws `WechatBridgeError` and the caller (the frame loop, plan 01a Task 18) decides; the next call starts a fresh bridge.
  - **Remote view**: x11vnc clipped to the desk half, served by noVNC.
- **Docker access**: a restricted Docker socket proxy (for example `tecnativa/docker-socket-proxy` with only the needed endpoints).
- **Notifications**: self-hosted ntfy.
- **Cloud AI (bring your own key)**: each member's own DashScope key, Singapore region, through the OpenAI-compatible endpoint (`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, or the workspace endpoint `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` when a Workspace ID is given). One client takes a configurable base URL and a model ID per task, with thinking mode off unless a task's tests show it's needed. Defaults as of 20 October 2026 (re-check at build time; details in [AI providers](research/ai-providers.md)):
  - **Summaries**: `qwen3.7-plus`.
  - **Slide reading**: `qwen3-vl-plus`.
  - **Form-label matching**: the cheapest current flash model (`qwen-flash`, or `qwen3.7-flash` if it's cheaper and as fast at build time).
  - **Live speech recognition**: `qwen3-asr-flash-realtime`, over WebSocket rather than the OpenAI-compatible endpoint.
- **ModelScope**: an alternative provider for text tasks, with its own model-ID mapping, for members who prefer it. Its free quota is unclear and has no service guarantee, and access may need mainland China identity checks. It is never used for live speech recognition, and never as the only route for form matching.
- **Companion app**: Electron, for a reliable tray icon, click-to-open notifications with a registered app ID on Windows, child processes and `safeStorage`.
- **Deployment**: Docker Compose on one server.

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

The names are the `OccurrenceState` and `FormState` types in [core types](#core-types).

## Data and storage

Main records (designer's sketch). The binding tables are in [database](#database), and the files on disk are in [data directory layout](#data-directory-layout).

- **Member**: GitHub identity, display name, time zone, ntfy topic, role.
- **Identity**: a member's named sign-in identity (for example University, Work), its run location and Zoom guest display name.
- **Browser profile**: one per identity; latest encrypted checkpoint, last-verified time per account, and where it lives.
- **Details**: saved form values with label variants, and names for mention alerts.
- **Timetable entry**: the fields in the [entry form](DESIGN.md#timetable-and-entry-form).
- **Meeting occurrence**: entry, scheduled and actual times, state, worker attempts, transcription mode, and the link used. Passcodes are removed from the stored link once the meeting ends.
- **Artefacts**: recording, frames, slides, transcript, chat and summary, as files on disk referenced by path.
- **Form record**: URL, source, sender, trust reason, times, state, fields filled (names only in logs), screenshots, result.
- **Event**: timestamped log per occurrence (joined, notice dismissed, form seen, alert, error, deletion).
- **Connection**: export target tokens, encrypted.

Retention is a requirement; see [retention](PRD.md#retention).

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
- **Signing in**: the app never automates a login form and never stores a password. When a session expires, it asks the member to sign in again.

The recording-others and consent rules are requirements; see [privacy and consent](PRD.md#privacy-and-consent).

## Platform realities

From research and expert review on 20 October 2026; verify before relying on them. Details: [platform constraints](research/platform-constraints.md).

- **Zoom**: since March 2026, Meeting SDK apps that join other accounts' meetings need Zoom-issued authorisation tokens and app review. This design avoids that by using the web client signed in as the member.
  - **One meeting per account**: a signed-in account can't usually be in two meetings at once, and joining the same meeting from a second device disconnects one session. That's why the Zoom adapter has a guest fallback and pings have a "Take over" button.
  - **Guest joins**: joining through the web client as a guest worked on 19 October 2026.
- **Teams**: from about the end of October 2026, Teams detects and labels external meeting-assistant bots in the lobby, with organiser approval required. A signed-in member joining from a browser isn't expected to be labelled, but this is unverified (spike 2).
- **Google Meet**: the Meet Media API no longer accepts new registrations. Guests can land in a review queue that defaults to deny, while signed-in members of the host's organisation can join directly. Meet blocks browsers that report automation, hence the Chrome settings above.
- **University and work sign-in policies**: institutions may limit how long web sessions last on unmanaged devices, re-check sessions when the address changes, or require managed devices. Reusing a session from a data centre while the member is active elsewhere can look like impossible travel. Spike 1 measures this, and the run locations give two ways round it.
- **Chat apps**: Discord and WhatsApp terms forbid automating personal accounts; see [link watchers](trd/link-watchers.md).
- **Borrowed code**: joinly and screenappai/meeting-bot are MIT-licensed and fine to borrow join flows from, with attribution. Attendee uses the Elastic License 2.0; read it for ideas only. Details: [open-source meeting bots](research/open-source-meeting-bots.md).

## Lessons carried over from the session

Requirements that come straight from the [problems and fixes](session-record/problems-and-fixes.md) catalogue:

- Never synthesise keyboard or mouse input on a member's desktop; the worker runs on its own virtual screen ([SAFE-02](session-record/problems-and-fixes.md#safe-02-os-level-keystrokes-went-to-the-users-whatsapp), [DESK-02](session-record/problems-and-fixes.md#desk-02-restoring-chrome-stole-focus-and-covered-the-users-work)).
- Alert on black frames from the first seconds, and never let the recorded window be covered or hidden ([DESK-01](session-record/problems-and-fixes.md#desk-01-chrome-meeting-window-minimised-during-capture), [OBS-04](session-record/problems-and-fixes.md#obs-04-obs-recorded-black-frames-while-chrome-was-covered), [CAP-03](session-record/problems-and-fixes.md#cap-03-the-watcher-missed-black-frames-and-the-gap-was-misdated)).
- Join through the web-client URL, never the launcher page ([ZOOM-05](session-record/problems-and-fixes.md#zoom-05-zooms-launcher-page-opened-the-desktop-app)).
- Detect the meeting end from page signals, checked every few seconds ([CAP-04](session-record/problems-and-fixes.md#cap-04-the-watcher-did-not-detect-the-meeting-end)).
- Treat chat as a virtualised list: keep it at the bottom, sweep it periodically, store it as it arrives, and advance cursors only after a durable write ([CHAT-02](session-record/problems-and-fixes.md#chat-02-the-virtualised-chat-list-hid-new-messages), [CHAT-03](session-record/problems-and-fixes.md#chat-03-the-pull-cursor-skipped-messages-that-were-never-saved)).
- Re-resolve browser tabs by purpose on every step; never hold tab handles across restarts ([BRW-08](session-record/problems-and-fixes.md#brw-08-the-extensions-tab-group-and-tab-ids-were-lost)).
- Run one heavy transcription job at a time, and budget memory per worker ([ASR-02](session-record/problems-and-fixes.md#asr-02-transcription-jobs-were-killed-for-low-memory)).
- Correct names from slides and other authoritative sources ([ASR-04](session-record/problems-and-fixes.md#asr-04-every-engine-misheard-proper-nouns)).
- Record into crash-safe Matroska segments, and write every capture incrementally.

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

## Testing approach

Acceptance tests run on real meetings and are listed in the [PRD](PRD.md#acceptance-tests). The code is tested as [tooling and conventions](#tooling-and-conventions) describes: end-to-end and integration tests through each package's public entry points, and Playwright against static fixtures of each platform's pages for the worker. The monthly smoke test in [platform adapters](trd/meeting-worker.md#platform-adapters) joins each platform's test meeting.

**Test accounts** (designer's call): TolongLabs' own test accounts weren't confirmed. Build organisation-restricted test forms with the member's own university account, since students can usually create forms limited to their university. Host test meetings from free accounts, keeping Zoom tests under its 40-minute free limit. Run the 90-minute test on Google Meet, Teams, or a university-licensed Zoom account.

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

## Repository layout

```text
TolongMeeting/
├── package.json              Bun workspaces root ("workspaces": ["packages/*"]); scripts: lint, lint:fix, test, typecheck, graph
├── bun.lock
├── tsconfig.json             strict, ES2023, moduleResolution "bundler"; packages extend it
├── .prettierrc.json          TolongLabs default (printWidth 120, single quotes, no semicolons)
├── commitlint.config.mjs     conventional commits, header 50 characters at most
├── .env.example              every variable in "Environment variables", no values
├── config/
│   └── selectors/            zoom.json, teams.json, meet.json (adapter selector maps)
├── docker/
│   ├── worker/               Dockerfile, entrypoint.sh, openbox/rc.xml, chrome-policy.json, pulse/default.pa, versions.env
│   ├── compose.yaml          caddy, web, scheduler, pipeline, postgres, ntfy, docker-proxy (milestone 1C)
│   └── caddy/Caddyfile
├── packages/
│   ├── core/                 shared types, config schemas (zod), state machines, time helpers. No I/O.
│   ├── ai/                   OpenAI-compatible chat client, DashScope real-time ASR client
│   ├── notify/               ntfy client
│   ├── worker/               the meeting worker (runs on Node 24 in the worker image)
│   ├── pipeline/             post-processing: transcript, slides, chat, summary
│   ├── scheduler/            occurrence expansion, job queue, container launcher, retention (1C)
│   ├── web/                  Next.js website and API (1C)
│   ├── companion/            Electron companion app (milestone 3)
│   └── exports/              export targets (milestone 7)
├── spikes/                   throwaway spike code, one folder per spike, each with REPORT.md
└── docs/                     this documentation
```

## Tooling and conventions

- **Runtimes**: Bun 1.x for everything except the worker. The worker runs on Node 24, because Playwright officially supports Node; it is still written in TypeScript and built with `bun build --target=node`.
- **Workspace setup**: copied from `TolongLabs/sdp-hack`: `AGENTS.md` (with `CLAUDE.md` and `GEMINI.md` linking to it), `docs/agents/`, `docs/references/`, the skills in `.agents/skills/` and `.claude/skills/`, `.claude/settings.json`, `.codex/hooks.json`, husky hooks, CI and the Graphify graph in `graphify-out/graph.json`. [Project conventions](references/project-conventions.md) apply to every plan.
- **Language**: TypeScript strict everywhere; `bun run typecheck` runs `tsc` at the root (scripts and tests) and then each package's `tsc` (its `src`).
- **Validation**: zod for every config file, API body and JSON produced by a model.
- **Tests**: `bun test`, in `packages/<package>/test/*.test.ts` and the root `test/` and `e2e/`. Following the project conventions, tests prove behaviour through each package's public entry points the way its callers use it (the worker against fixture pages, the pipeline CLI against an occurrence directory, the website and scheduler against a real Postgres), not private helpers. The behaviour cases each plan lists (state machines, trust rules, link unwrapping, summary rendering, schedulers) are kept, exercised through those entry points.
- **Browser integration tests**: Playwright Test on Node 24, in `packages/worker/test/`, against static HTML fixtures in `packages/worker/test/fixtures/` that imitate each platform's DOM and the two form providers. Run with `bunx playwright test -c packages/worker/playwright.config.ts`.
- **Formatting**: Prettier, `bun run lint` to check and `bun run lint:fix` to fix, with husky and lint-staged on commit, as in other TolongLabs repositories. A change is done when `bun run lint` passes.
- **Commits**: conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), header at most 50 characters, one task per commit or less.
- **Secrets**: never committed, never logged, never in URL query strings of the app's own API. `.env.example` lists names only.
- **Pinned versions**: Chrome, Playwright, ffmpeg, Node and Bun versions for the worker image live in `docker/worker/versions.env`, set by spike 2 and changed only together with a passing smoke test. `scripts/build-worker-image.sh` passes every key (`NODE_VERSION`, `CHROME_VERSION`, `PLAYWRIGHT_VERSION`, `FFMPEG_VERSION`, `BUN_VERSION`) as a build argument of the same name and tags the image both `tm-worker:dev` and `tolongmeeting/worker:current`.

## Runtime processes

| Process        | Package              | Milestone | Runs                                                                                                   |
| -------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `tm-worker`    | `packages/worker`    | 1A        | One container per meeting occurrence, from the worker image                                            |
| `tm-pipeline`  | `packages/pipeline`  | 1A        | After the worker exits: a CLI in 1A, a pg-boss job consumer in 1C                                      |
| `tm-web`       | `packages/web`       | 1C        | Next.js website and API, behind Caddy                                                                  |
| `tm-scheduler` | `packages/scheduler` | 1C        | Expands timetables, runs the queue, launches workers through the Docker socket proxy, deletes old data |
| `tm-companion` | `packages/companion` | 3         | Electron app on the member's PC                                                                        |

In milestone 1A there is no server: `bun run tm-worker -- --job job.json` inside the worker image runs one meeting from a job file, then `bun run tm-pipeline -- --job job.json` post-processes it.

## Core types

`packages/core/src/types.ts`. These names are used by every plan.

```ts
export type Platform = 'zoom' | 'teams' | 'meet'
export type EntryType = 'lecture' | 'work'
export type TranscriptionMode = 'live' | 'native'
export type RunLocation = 'server' | 'server_via_home' | 'local'
export type SenderRole = 'host' | 'co_host' | 'participant' | 'unknown'

export type OccurrenceState =
  | 'scheduled'
  | 'starting'
  | 'verifying_accounts'
  | 'waiting_for_signin'
  | 'watching_for_link'
  | 'no_link'
  | 'joining'
  | 'in_lobby'
  | 'denied'
  | 'in_meeting'
  | 'restarting'
  | 'left_by_member'
  | 'leaving'
  | 'uploading'
  | 'transcribing'
  | 'waiting_for_pc'
  | 'post_processing'
  | 'completed'
  | 'skipped_capacity'
  | 'skipped_identity_clash'
  | 'skipped_pc_offline'
  | 'failed'
  | 'deleted'

export type FormState =
  | 'detected'
  | 'resolving'
  | 'checking_trust'
  | 'untrusted'
  | 'opening'
  | 'awaiting_signin'
  | 'inspecting'
  | 'not_attendance'
  | 'quiz'
  | 'filling'
  | 'needs_member'
  | 'submitting'
  | 'submitted'
  | 'already_answered'
  | 'failed'

export type FormSource = 'qr' | 'meeting_chat' | 'watched_chat'
export type FormProvider = 'google' | 'microsoft'
export type TrustReason = 'qr_on_screen' | 'host' | 'co_host' | 'trusted_sender' | 'org_restricted'

export interface ChatMessage {
  key: string // platform message id, else `${sender}|${time}|${text.slice(0, 200)}`
  sender: string
  senderRole: SenderRole
  time: string // as displayed by the platform
  seenAt: string // ISO 8601, when the worker read it
  text: string
  links: string[] // absolute URLs found in the message
}

export interface FormCandidate {
  url: string
  source: FormSource
  sender: string | null
  senderRole: SenderRole | null
  seenAt: string
}

export interface ResolvedForm extends FormCandidate {
  finalUrl: string
  provider: FormProvider
}

export interface SavedDetail {
  key: string // e.g. "full_name", "student_id", or a custom key
  value: string
  labels: string[] // label variants, e.g. ["Matric No.", "No. Matrik"]
}

export type EventType =
  | 'state'
  | 'joined'
  | 'notice_dismissed'
  | 'form'
  | 'alert'
  | 'error'
  | 'keyframe'
  | 'recording_gap'
  | 'mention'
  | 'deletion'

export interface MeetingEvent {
  occurrenceId: string
  attempt: number // 1-based worker attempt
  at: string // ISO 8601
  type: EventType
  data: Record<string, unknown>
}

export type ControlCommand = 'leave_now' | 'take_over' | 'pause_for_signin' | 'resume_after_signin' | 'stop'

export interface Heartbeat {
  occurrenceId: string
  attempt: number
  state: OccurrenceState
  recording: boolean
  participants: number | null
  events: MeetingEvent[] // events since the last acknowledged heartbeat
}

export interface HeartbeatReply {
  ackedEvents: number // how many of the sent events were stored
  commands: ControlCommand[]
}
```

Job configuration, `packages/core/src/job.ts`, validated with zod (`JobConfigSchema`). In 1A it is a hand-written file; from 1C the scheduler writes it into the worker container.

```ts
export type LinkSource =
  | { kind: 'fixed'; url: string }
  | { kind: 'chat'; app: 'whatsapp' | 'discord' | 'teams'; chat: string } // URL or exact chat name
  | { kind: 'paste' }

export interface JobConfig {
  occurrenceId: string
  attempt: number
  entry: {
    name: string
    type: EntryType
    start: string // ISO 8601 with offset
    end: string
    timeZone: string // IANA, e.g. "Asia/Kuala_Lumpur"
    link: LinkSource
    trustedSenders: string[]
    transcription: TranscriptionMode
    formDetails: Record<string, string> // per-entry: course_code, section, lecturer
    attendanceKeywords: string[]
  }
  identity: { id: string; name: string; zoomGuestName: string }
  member: {
    id: string
    displayName: string
    mentionNames: string[]
    details: SavedDetail[]
  }
  ai: AiConfig
  ntfy: NtfyConfig
  dataDir: string // the occurrence's directory, see "Data directory layout"
  profileDir: string // decrypted working copy of the identity's profile
  control: { url: string; token: string } | null // null in 1A
}
```

State machines, `packages/core/src/occurrence-machine.ts` and `packages/core/src/form-machine.ts`, export pure transition functions:

```ts
export function nextOccurrenceState(from: OccurrenceState, event: OccurrenceTrigger): OccurrenceState // throws IllegalTransition
export function nextFormState(from: FormState, event: FormTrigger): FormState // throws IllegalTransition
```

`OccurrenceTrigger` and `FormTrigger` are string unions defined by milestone 1A (form) and 1C (occurrence), following the transitions in the design's [state machines](#state-machines).

## Worker interfaces

`packages/worker/src/adapters/types.ts`:

```ts
import type { Page } from 'playwright'

export type MeetingState = 'in_meeting' | 'lobby' | 'ended' | 'removed' | 'breakout_prompt' | 'unknown'
export type AdmissionResult = 'admitted' | 'lobby_expired' | 'lobby_denied'
export type JoinResult =
  | { kind: 'in_meeting' }
  | { kind: 'lobby' }
  | { kind: 'signin_required'; host: string }
  | { kind: 'account_busy' }
  | { kind: 'failed'; reason: string }
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface ChatCursor {
  seenKeys: string[]
}

export interface PlatformAdapter {
  readonly platform: Platform
  normaliseLink(url: string): string | null // null if not this platform's link
  join(page: Page, opts: { guestName: string | null }): Promise<JoinResult>
  connectOutputAudio(page: Page): Promise<void>
  ensureLayout(page: Page): Promise<void>
  waitUntilAdmitted(page: Page, deadline: Date): Promise<AdmissionResult>
  assertDevicesOff(page: Page): Promise<void> // throws DevicesOnError
  readChat(page: Page, cursor: ChatCursor): Promise<{ messages: ChatMessage[]; cursor: ChatCursor }>
  sweepChat(page: Page): Promise<ChatMessage[]>
  sharedScreenRegion(page: Page): Promise<Rect | null> // in stage coordinates
  participantCount(page: Page): Promise<number | null>
  meetingState(page: Page): Promise<MeetingState>
  dismissNotices(page: Page): Promise<string[]> // texts of buttons clicked
  leave(page: Page): Promise<void>
}

export function adapterFor(url: string): PlatformAdapter | null // packages/worker/src/adapters/index.ts
```

Other worker modules and their entry points (each plan that creates one owns its tests):

| Module                                     | Entry point                                                                                                                                                                                                                                                                                                                                         | Milestone                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `src/display/screen.ts`                    | `startScreen(): Promise<Screen>` (Xvfb 3840x1080, openbox, stage and desk rectangles)                                                                                                                                                                                                                                                               | 1A                                                  |
| `src/chrome/launch.ts`                     | `launchBrowser(profileDir: string, screen: Screen): Promise<{ context: BrowserContext; stage: Page; desk: Page }>`                                                                                                                                                                                                                                  | 1A                                                  |
| `src/profile/profile.ts`                   | `prepareProfile(dir: string, identityId: string, host?: HostInfo): Promise<void>`, `checkpointProfile(dir: string, out: string, key: Buffer, now?: () => Date): Promise<string>`, `restoreProfile(file: string, dir: string, key: Buffer): Promise<void>`, `startCheckpoints(dir: string, out: string, key: Buffer, intervalMs = 300_000): Stopper` | 1A                                                  |
| `src/profile/keys.ts`                      | `deriveProfileKey(masterKey: Buffer, identityId: string): Buffer` (HKDF-SHA256, salt `tolongmeeting/v1`), `readMasterKey(file: string): Promise<Buffer>`, `machineIdFor`, `hostnameFor`                                                                                                                                                             | 1A                                                  |
| `src/recorder/recorder.ts`                 | `startRecorder(screen: Screen, outDir: string, attempt: number): Promise<Recorder>`                                                                                                                                                                                                                                                                 | 1A                                                  |
| `src/frames/frames.ts`                     | `startFrameLoop(screen: Screen, onFrame: (f: Frame) => Promise<void>, intervalMs = 2000): Stopper`                                                                                                                                                                                                                                                  | 1A                                                  |
| `src/qr/qr.ts`                             | `decodeQr(png: Buffer, region: Rect                                                                                                                                                                                                                                                                                                                 | null): Promise<string[]>`                           | 1A             |
| `src/forms/links.ts`                       | `resolveFormLink(c: FormCandidate, opts?: ResolveOptions): Promise<ResolvedForm                                                                                                                                                                                                                                                                     | null>`                                              | 1A             |
| `src/forms/trust.ts`                       | `checkTrust(f: ResolvedForm, trustedSenders: string[]): { trusted: boolean; reason: TrustReason                                                                                                                                                                                                                                                     | null }` (pre-open)                                  | 1A             |
| `src/forms/pinger.ts`                      | `createFormPinger(deps: FormPingerDeps): FormPinger`, `FormPinger.offer(c: FormCandidate)`, `FormPinger.idle()`                                                                                                                                                                                                                                     | 1A                                                  |
| `src/forms/provider-check.ts`              | `checkFormProviders(desk: Page, providers: FormProvider[], opts?: { urls? }): Promise<FormProvider[]>` (signed-out providers)                                                                                                                                                                                                                       | 1A                                                  |
| `src/forms/handler.ts`                     | `handleForm(f: ResolvedForm, ctx: FormContext): Promise<FormRecord>`                                                                                                                                                                                                                                                                                | 1B                                                  |
| `src/asr/live.ts`                          | `startLiveAsr(audio: AudioSource, ai: AiConfig, out: string): Promise<LiveAsr>`                                                                                                                                                                                                                                                                     | 1A                                                  |
| `src/control/heartbeat.ts`                 | `startHeartbeat(cfg: JobConfig, getStatus: () => Heartbeat): Stopper` (no-op when `control` is null)                                                                                                                                                                                                                                                | 1C                                                  |
| `src/watchers/{whatsapp,discord,teams}.ts` | `startWatcher(desk: Page, src: LinkSource, onLink: (c: FormCandidate                                                                                                                                                                                                                                                                                | { meetingUrl: string }) => void): Promise<Stopper>` | 2 (Teams in 4) |
| `src/run.ts`                               | `runOccurrence(cfg: JobConfig): Promise<OccurrenceOutcome>`, the worker's main sequence                                                                                                                                                                                                                                                             | 1A                                                  |

## AI, notification and pipeline interfaces

`packages/ai`:

```ts
export interface AiConfig {
  baseUrl: string // OpenAI-compatible base URL
  apiKey: string
  asrUrl: string // DashScope real-time WebSocket URL
  models: { summary: string; vision: string; formMatch: string; asr: string }
}
export async function chatJson<T>(
  cfg: AiConfig,
  model: string,
  messages: ChatTurn[],
  schema: z.ZodType<T>,
  timeoutMs: number,
  opts?: ChatOptions
): Promise<T>
export async function chatText(
  cfg: AiConfig,
  model: string,
  messages: ChatTurn[],
  timeoutMs: number,
  opts?: ChatOptions
): Promise<string>
export function openAsrStream(cfg: AiConfig): AsrStream // send(pcm16le: Buffer), onResult(cb), close()
export class AiKeyError extends AiError {
  status: 401 | 402 | 429
}
```

All chat calls send `enable_thinking: false` unless a caller passes `thinking: true`.

`packages/notify`:

```ts
export interface NtfyConfig {
  url: string
  topic: string
  token: string
}
export interface PingAction {
  label: string
  url: string
} // ntfy "view" actions
export interface Ping {
  title: string
  message: string
  priority: 'high' | 'default'
  actions?: PingAction[]
  attachPath?: string
}
export async function sendPing(cfg: NtfyConfig, ping: Ping): Promise<void>
```

`packages/pipeline`:

```ts
export interface PipelineResult {
  summaryPath: string
  transcriptPath: string
  slidesPath: string
  chatPath: string
}
export async function runPipeline(cfg: JobConfig): Promise<PipelineResult>
```

## Data directory layout

Each occurrence owns one directory, `$TM_DATA_ROOT/occurrences/<occurrenceId>/`:

```text
recording/attempt_<N>_seg_<NNN>.mkv   5-minute Matroska segments
recording/meeting.mkv                 joined at the end
frames/<NNNN>_<HHMMSS>.png            kept keyframes (stage only)
chat.jsonl                            one ChatMessage per line, appended as read
events.jsonl                          one MeetingEvent per line
forms/<formId>/record.json            FormRecord (milestone 1B), or FormPingRecord (1A)
forms/<formId>/filled.png             page-only screenshots
forms/<formId>/confirmation.png
transcript/live.jsonl                 { startMs, endMs, text } per result, recording-relative
transcript/native/                    whisper-transcriber outputs (milestone 3)
audio.flac                            native mode only; deleted after the transcript upload
slides/slides.json, slides/NN.webp
out/transcript.md, out/slides.md, out/chat.md, out/<YYYY-MM-DD HHmm Entry name>.md
```

Browser profiles live outside occurrences, at `$TM_PROFILE_ROOT/<identityId>/work/` (decrypted working copy on the encrypted volume) and `$TM_PROFILE_ROOT/<identityId>/checkpoints/<timestamp>.tar.enc`.

## Database

Milestone 1C. Postgres with Drizzle ORM and drizzle-kit migrations in `packages/web/db/` (shared by `web`, `scheduler` and `pipeline` through `packages/web/db/index.ts`'s exported schema). The tables are:

- `members`, `identities`, `profiles`;
- `details`, `mention_names`;
- `timetable_entries`, `occurrences`, `events`;
- `forms`, `artefacts`;
- `ai_keys`, `connections`, `device_tokens`.

pg-boss uses its own schema in the same database. Plan 1C defines the columns.

## Environment variables

| Variable                                                 | Used by                     | Meaning                                                                            |
| -------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `TM_DATA_ROOT`                                           | worker, pipeline, scheduler | root of occurrence directories                                                     |
| `TM_PROFILE_ROOT`                                        | worker, scheduler           | root of identity profiles (encrypted volume)                                       |
| `TM_MASTER_KEY_FILE`                                     | worker, scheduler, web      | path to the Docker secret holding the 32-byte master key (base64)                  |
| `TM_SELECTORS_DIR`                                       | worker                      | directory of selector maps (default `/app/config/selectors`)                       |
| `TM_WECHAT_MODELS_DIR`                                   | worker                      | directory with the four WeChat QR model files (required)                           |
| `TM_WECHAT_PYTHON`                                       | worker                      | Python with `opencv-contrib-python-headless` for the QR bridge (default `python3`) |
| `TM_IN_IMAGE`                                            | worker                      | `1` inside the worker image; gates the image-only tests                            |
| `TM_PUBLIC_URL`                                          | web, scheduler, pipeline    | the website's base URL, for links in pings                                         |
| `DATABASE_URL`                                           | web, scheduler, pipeline    | Postgres connection string                                                         |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ORG` | web                         | sign-in and organisation check                                                     |
| `DOCKER_PROXY_URL`                                       | scheduler                   | restricted Docker socket proxy, e.g. `http://docker-proxy:2375`                    |
| `NTFY_URL`, `NTFY_ADMIN_TOKEN`                           | web                         | ntfy base URL and the token used to create member topics and tokens                |

## Plan conventions

- **Files**: plans live in `docs/plans/`, named `NN-<slug>.md` in build order (see the [roadmap](plans/README.md)).
- **Format**: each plan follows the writing-plans format: a header with Goal, Architecture, Tech Stack, Spec, Global Constraints and Review Focus, then tasks with Files, Interfaces and checkbox steps (failing test, run, implement, run, commit).
- **Execution**: plans are executed with the superpowers `subagent-driven-development` or `executing-plans` skills.
- **Order**: a plan never assumes code from a later milestone. When a later plan changes an earlier interface, it says so in its Interfaces block and updates this page.

## Contract additions and reconciliation

The milestone plans were written in parallel against this page. Each marks the shared names it introduces as "adds to contracts" in its Interfaces blocks. This section collects them and settles where plans used different names for the same thing. Where this section and a plan disagree, this section wins; fix the plan when executing it.

### Additions by plan

- **All plans**: packages are named `@tm/core`, `@tm/ai`, `@tm/notify`, `@tm/worker`, `@tm/pipeline`, `@tm/scheduler`, `@tm/web`, `@tm/companion` and `@tm/exports`. `AiConfig` and `NtfyConfig` are declared in `@tm/core` and re-exported by `@tm/ai` and `@tm/notify`.
- **00 spikes**:
  - the `docker/worker/versions.env` keys `NODE_VERSION`, `CHROME_VERSION`, `PLAYWRIGHT_VERSION`, `FFMPEG_VERSION` and `BUN_VERSION`;
  - `spikes/DECISIONS.md` and its decision keys (`runLocation.*`, `chrome.*`, `qr.*`, `forms.*`, `asr.*`, `worker.*`, `profile.*`, `watchers.*`, `ntfy.*`);
  - extra managed Chrome policies (no password saving, no browser sign-in or sync, no capture devices).
- **01a recorder and pings**:
  - core: `parseJob`, `JobError`, `IllegalTransition`, `formatOffset`, `localParts`, `ChatMessage.replyTo`, `JobConfig.identity.formProviders`;
  - ai and notify: `ChatTurn`, `AiError`, `AiTimeoutError`, `AsrResult`, `AsrStream.onError`, `dropOverlap`, `PingError`, `AlertKind` and the ping builders;
  - worker: `Screen`, `Stopper`, `Frame`, `Recorder`, `AudioSource`, `LiveAsr`, `OccurrenceOutcome`, `RunDeps`, `launchGuestStage`, `restoreProfile`, `startCheckpoints`, `deriveProfileKey`, `joinRecording`, `startChatCapture`, `createFormPinger`, `FormPinger`, `FormPingerDeps`, `FormPingRecord`, `checkFormProviders`, `ResolveOptions`, `LinkResolveError`, `extractLinks`, `unwrapLink`, `formProviderOf`, `normaliseFormUrl`, `QrConfirmer`, `closeQr`, `WechatBridgeError`, `qrFrame` (test helper), `adapterFor`, `zoomAdapter`, `DevicesOnError`, `loadSelectors`, `ZoomSelectorsSchema`, `zoomRoot`, `ZOOM_TIMEOUTS`;
  - pipeline: `Slide`, `InventorySchema`, `summaryFileName`, `LiveLine`, `Gap`, `TranscriptBlock`, `isHallucination`, `paragraphs`, `correctNames`, `buildTranscript`, `orderChat`, `stripInviteLinks`, `buildChat`;
  - data: `recording/attempts.json`, `outcome.json`, `errors/`.
  - image: `tm-worker:dev` and `tolongmeeting/worker:current` (the same build), the entrypoint modes `selfcheck`, `test`, `unit`, `seed --job` and `--job`, PulseAudio `tm_sink` and the muted `tm_mic`, `docker/worker/run-job.sh <job.json> [seed]`, and the `BUN_VERSION` build argument and `TM_IN_IMAGE` variable.
- **01b form submission**:
  - core: `FormRecord`, `FilledField`, `StopReason`, `FormRecordSchema`, `newFormRecord`, `canonicalFormUrl`, `formIdFor`, `TERMINAL_FORM_STATES`, `isTerminalFormState`, `applyFormTrigger`, `OrgConfig`, `JobConfig.identity.organisation`, and the test fixtures `sampleForm`, `sampleRecord` (import `@tm/core/testing`; not in the index);
  - worker: `FormContext`, `FormContextBase`, `makeFormContextBase`, `FormLinks`, `startFormDispatcher`, `onFormCandidate`;
  - selector maps: `config/selectors/google-forms.json` and `microsoft-forms.json`;
  - data: `forms/<formId>/filled_<N>.png`; the detail keys `university_email`, `programme`, `session_date` and `session_start`;
  - pipeline: `attendanceLine`.
- **01c website and scheduler**:
  - core: `control.ts` (`ACCOUNT_KINDS` and type `AccountKind`, heartbeat and sign-in types, `SpecEnv`), `secrets.ts` (`deriveKey`, `memberKey`; `sealColumn` and `openColumn` live in `packages/web/db/secrets.ts`), `stripPasscode`, `RepeatRule`, `expandEntry`, `findClashes`, `formatWhen`, `formatDay`;
  - shared: `QUEUES`, `Queue` and `bossQueue` (`packages/web/db/queues.ts`); `pings` (`packages/notify/src/messages.ts`); `Notifier` and `memberNotifier` (`packages/web/db/notifier.ts`); `WORKER_IMAGE`;
  - tables: `signin_sessions` and the Better Auth `auth_*` tables;
  - environment: `TM_PROFILE_KEY_FILE`, `TM_BACKUP_REMOTE`, `RCLONE_CONFIG`, `POSTGRES_PASSWORD`;
  - data: `recording/meeting.mp4`, a remux of `meeting.mkv` for the website's player.
- **02 link watchers**:
  - core: `normaliseDiscordChannelUrl`, `WatchGate` and its gate functions, `SpecEnv.watchGate`, `StateEventData.link`;
  - worker: `ChatSourceReader`, `runChatWatcher`, `WatcherEnv`, the watcher errors and readers, `watcherFor`, `waitForMeetingLink`;
  - selector maps `whatsapp.json` and `discord.json`, four pings, `link-notices.ts` and `EntryDeps.gate`;
  - environment: `TM_WHATSAPP_FROM_SERVER` and `TM_DISCORD_FROM_SERVER`, set from spike 7.
- **03 companion and native**:
  - `packages/core/src/companion.ts` (job, event and pairing types, `WhisperJsonSchema`, `shortDate`, `shortTime`, timing constants, `LocalRunPayload`, `PreflightReport`);
  - tables `device_pairings`, `companion_jobs` and `companion_events`;
  - the trigger `pc_claimed`; the queues `native-job-check` and `profile-delete`; `Ping.tags` with the `tm_summary` tag; the `/api/companion/*` routes;
  - `TM_DATA_ROOT` for web; `TM_WORKER_IMAGE_REF`.
- **04 Teams and 05 Meet**:
  - selector maps `teams.json` and `meet.json` with `TeamsSelectorsSchema` and `MeetSelectorsSchema`;
  - adapters `teamsAdapter`, `meetAdapter`, `TEAMS_TIMEOUTS`, `MEET_TIMEOUTS`, and `teamsChatReader`;
  - core `normaliseTeamsChatUrl`;
  - `AlertKind` values `teams_signin` and `meet_signin`, and new copy for `breakout`;
  - `runOccurrence` calls `ensureLayout` on its 10-second refresh;
  - the monthly smoke test (`SmokeEntry`, `SMOKE_ENTRIES`, `runSmokeEntry`, `zoomSmoke`, `teamsSmoke`, `meetSmoke`, `tm-worker --smoke`, `run-job.sh smoke`, `smoke.crontab`), built by whichever of plans 04 and 05 lands first;
  - website: `TEAMS_PRESENCE_NOTE`, `showsTeamsPresenceNote`, `TeamsPresenceNote`, and Teams entries in `CHAT_FIELD_COPY` and `chatAppOptions`.
- **06 work meetings and mentions**:
  - summary: `normaliseName`, `WorkInventorySchema`, `renderWorkSummary`, a widened `chooseDue`;
  - mentions: the mention matcher and watcher, `LiveAsrOptions.onResult`, `pings.nameMentioned`;
  - leave and take-over: `leaveMeeting`, `Heartbeat.linkUsed`, `StateEventData.command`, the leave and take-over `siteLinks`, `takeOver`, and their pages and state route.
- **07 exports**:
  - `packages/exports` with `ExportTarget` and its types;
  - the `tm-exports` process and the Compose service `exports`;
  - `connections` columns and an `exports` table; files `exports/<exportId>.zip` and `.pdf` in the occurrence directory;
  - environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID`, `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`.
- **08 run locations**:
  - the tables `home_exit_nodes` and `identities.local_device_id`;
  - the queues `local-claim-check`, `local-start-check` and `home-route-recheck`;
  - `profileKeyOnce`;
  - environment: `TM_TAILSCALE_CLIENT_ID`, `TM_TAILSCALE_CLIENT_SECRET`, `TM_TAILSCALE_TAILNET`, `TAILSCALE_VERSION`.

### Changed shapes

- **`Stopper`** is `interface Stopper { stop(): Promise<void> }` (plan 01a). Plans that call a stopper as a function (plan 02) call `stopper.stop()` instead.
- **`FormTrigger`**: plan 01a defines the 1A subset, routing manual-only pings through `manual_only` (`checking_trust` to `needs_member`) rather than a new state. Plan 01b replaces it with the full union for every state in the design.
- **`HeartbeatReply`** gains `link` (plan 01c: a link the member pasted on the website); **`Heartbeat`** gains `linkUsed` (plan 06). `startHeartbeat` gains an `onReply` callback (plan 01c).
- **`JobConfig.identity`** gains `formProviders` (plan 01a) and `organisation: { name, emailDomain } | null` (plan 01b).
- **Recordings**: `recording/meeting.mkv` is the joined master; `recording/meeting.mp4` is a remux for browser playback (plan 01c).

### Name reconciliation

Later plans used placeholder names for things plan 01c defines. Use the 01c names:

| Placeholder in plans 03, 07, 08                                                  | Use (plan 01c)                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `memberNtfy`, `memberNtfyConfig`                                                 | `memberNotifier(db, master, ntfyUrl)` returning `Notifier`, then `notifier.notify(memberId, ping)` |
| `enqueuePipeline(occurrenceId)`                                                  | `queue.send(QUEUES.pipeline, { occurrenceId })`                                                    |
| `scheduleJob(name, data, at)`                                                    | `queue.send(name, data, { startAfter: at })`                                                       |
| `meetingUrl(occurrenceId)`                                                       | `${TM_PUBLIC_URL}/meetings/<occurrenceId>` (route `packages/web/app/meetings/[id]/page.tsx`)       |
| `pingRestart`, `pingWorkerFailed`                                                | `pings.workerRestarted`, `pings.workerFailed`                                                      |
| `buildJobConfig`, `launchWorker`                                                 | `launchOccurrence` and `startAttempt` (with `buildEntrySnapshot` and `writeJobFiles`)              |
| `allowCreate`                                                                    | the Docker socket proxy allowlist in plan 01c's deployment task                                    |
| `requireMember`, `handleHeartbeat`, `applyTrigger`, `createTestDb`, `seedMember` | unchanged; defined by plan 01c                                                                     |
| `db`, `Db` (plan 07)                                                             | `getDb()` and `Db` from `packages/web/db`                                                          |

### Known follow-ups

- **ModelScope for text tasks**: members can store a ModelScope key (plan 01c), but `AiConfig` holds one text provider, so routing summaries and slide reading to ModelScope isn't planned yet. Add a small task after milestone 1C: a per-member text-provider choice that builds `AiConfig.baseUrl`, `apiKey` and the model IDs from ModelScope's mapping, while speech recognition stays on DashScope.
- **The 90-minute silence test** needs a licensed Zoom account or another platform; plan 01a notes it may move to milestone 1C.
- **Selectors**: every selector value in plans 01a, 04 and 05 is unverified until the plan's acceptance task corrects it against real meetings.
