# Architecture and contracts

The code-level decisions every TolongMeeting plan shares: repository layout, tooling, shared types, interfaces between packages, on-disk data layout and environment variables. Each milestone plan builds against this page, so names here are binding; a plan that needs to change one updates this page in the same commit. It implements the [TolongMeeting design](../app-design/2026-10-20-meeting-bot-design.md), revision 2.

Contents:

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
- **Workspace setup**: copied from `TolongLabs/sdp-hack`: `AGENTS.md` (with `CLAUDE.md` and `GEMINI.md` linking to it), `docs/agents/`, `docs/references/`, the skills in `.agents/skills/` and `.claude/skills/`, `.claude/settings.json`, `.codex/hooks.json`, husky hooks, CI and the Graphify graph in `graphify-out/graph.json`. [Project conventions](../references/project-conventions.md) apply to every plan.
- **Language**: TypeScript strict everywhere; `bun run typecheck` runs `tsc` at the root (scripts and tests) and then each package's `tsc` (its `src`).
- **Validation**: zod for every config file, API body and JSON produced by a model.
- **Tests**: `bun test`, in `packages/<package>/test/*.test.ts` and the root `test/` and `e2e/`. Following the project conventions, tests prove behaviour through each package's public entry points the way its callers use it (the worker against fixture pages, the pipeline CLI against an occurrence directory, the website and scheduler against a real Postgres), not private helpers. The behaviour cases each plan lists (state machines, trust rules, link unwrapping, summary rendering, schedulers) are kept, exercised through those entry points.
- **Browser integration tests**: Playwright Test on Node 24, in `packages/worker/test/`, against static HTML fixtures in `packages/worker/test/fixtures/` that imitate each platform's DOM and the two form providers. Run with `bunx playwright test -c packages/worker/playwright.config.ts`.
- **Formatting**: Prettier, `bun run lint` to check and `bun run lint:fix` to fix, with husky and lint-staged on commit, as in other TolongLabs repositories. A change is done when `bun run lint` passes.
- **Commits**: conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), header at most 50 characters, one task per commit or less.
- **Secrets**: never committed, never logged, never in URL query strings of the app's own API. `.env.example` lists names only.
- **Pinned versions**: Chrome, Playwright, ffmpeg and Node versions for the worker image live in `docker/worker/versions.env`, set by spike 2 and changed only together with a passing smoke test.

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

`OccurrenceTrigger` and `FormTrigger` are string unions defined by milestone 1A (form) and 1C (occurrence), following the transitions in the design's [state machines](../app-design/2026-10-20-meeting-bot-design.md#state-machines).

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

| Module                                     | Entry point                                                                                                                                   | Milestone                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `src/display/screen.ts`                    | `startScreen(): Promise<Screen>` (Xvfb 3840x1080, openbox, stage and desk rectangles)                                                         | 1A                                                  |
| `src/chrome/launch.ts`                     | `launchBrowser(profileDir: string, screen: Screen): Promise<{ context: BrowserContext; stage: Page; desk: Page }>`                            | 1A                                                  |
| `src/profile/profile.ts`                   | `prepareProfile(dir: string, identityId: string): Promise<void>`, `checkpointProfile(dir: string, out: string, key: Buffer): Promise<string>` | 1A                                                  |
| `src/recorder/recorder.ts`                 | `startRecorder(screen: Screen, outDir: string, attempt: number): Promise<Recorder>`                                                           | 1A                                                  |
| `src/frames/frames.ts`                     | `startFrameLoop(screen: Screen, onFrame: (f: Frame) => Promise<void>, intervalMs = 2000): Stopper`                                            | 1A                                                  |
| `src/qr/qr.ts`                             | `decodeQr(png: Buffer, region: Rect                                                                                                           | null): Promise<string[]>`                           | 1A             |
| `src/forms/links.ts`                       | `resolveFormLink(c: FormCandidate): Promise<ResolvedForm                                                                                      | null>`                                              | 1A             |
| `src/forms/trust.ts`                       | `checkTrust(f: ResolvedForm, trustedSenders: string[]): { trusted: boolean; reason: TrustReason                                               | null }` (pre-open)                                  | 1A             |
| `src/forms/handler.ts`                     | `handleForm(f: ResolvedForm, ctx: FormContext): Promise<FormRecord>`                                                                          | 1B                                                  |
| `src/asr/live.ts`                          | `startLiveAsr(audio: AudioSource, ai: AiConfig, out: string): Promise<LiveAsr>`                                                               | 1A                                                  |
| `src/control/heartbeat.ts`                 | `startHeartbeat(cfg: JobConfig, getStatus: () => Heartbeat): Stopper` (no-op when `control` is null)                                          | 1C                                                  |
| `src/watchers/{whatsapp,discord,teams}.ts` | `startWatcher(desk: Page, src: LinkSource, onLink: (c: FormCandidate                                                                          | { meetingUrl: string }) => void): Promise<Stopper>` | 2 (Teams in 4) |
| `src/run.ts`                               | `runOccurrence(cfg: JobConfig): Promise<OccurrenceOutcome>`, the worker's main sequence                                                       | 1A                                                  |

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
  timeoutMs: number
): Promise<T>
export async function chatText(cfg: AiConfig, model: string, messages: ChatTurn[], timeoutMs: number): Promise<string>
export function openAsrStream(cfg: AiConfig): AsrStream // send(pcm16le: Buffer), onResult(cb), close()
export class AiKeyError extends Error {
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
forms/<formId>/record.json            FormRecord (milestone 1B), or the pinged candidate (1A)
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

| Variable                                                 | Used by                     | Meaning                                                             |
| -------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `TM_DATA_ROOT`                                           | worker, pipeline, scheduler | root of occurrence directories                                      |
| `TM_PROFILE_ROOT`                                        | worker, scheduler           | root of identity profiles (encrypted volume)                        |
| `TM_MASTER_KEY_FILE`                                     | worker, scheduler, web      | path to the Docker secret holding the 32-byte master key (base64)   |
| `TM_SELECTORS_DIR`                                       | worker                      | directory of selector maps (default `/app/config/selectors`)        |
| `TM_PUBLIC_URL`                                          | web, scheduler, pipeline    | the website's base URL, for links in pings                          |
| `DATABASE_URL`                                           | web, scheduler, pipeline    | Postgres connection string                                          |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ORG` | web                         | sign-in and organisation check                                      |
| `DOCKER_PROXY_URL`                                       | scheduler                   | restricted Docker socket proxy, e.g. `http://docker-proxy:2375`     |
| `NTFY_URL`, `NTFY_ADMIN_TOKEN`                           | web                         | ntfy base URL and the token used to create member topics and tokens |

## Plan conventions

- **Files**: plans live in `docs/plans/`, named `NN-<slug>.md` in build order (see the [roadmap](README.md)).
- **Format**: each plan follows the writing-plans format: a header with Goal, Architecture, Tech Stack, Spec, Global Constraints and Review Focus, then tasks with Files, Interfaces and checkbox steps (failing test, run, implement, run, commit).
- **Execution**: plans are executed with the superpowers `subagent-driven-development` or `executing-plans` skills.
- **Order**: a plan never assumes code from a later milestone. When a later plan changes an earlier interface, it says so in its Interfaces block and updates this page.

## Contract additions and reconciliation

The milestone plans were written in parallel against this page. Each marks the shared names it introduces as "adds to contracts" in its Interfaces blocks. This section collects them and settles where plans used different names for the same thing. Where this section and a plan disagree, this section wins; fix the plan when executing it.

### Additions by plan

- **All plans**: packages are named `@tm/core`, `@tm/ai`, `@tm/notify`, `@tm/worker`, `@tm/pipeline`, `@tm/scheduler`, `@tm/web`, `@tm/companion` and `@tm/exports`. `AiConfig` and `NtfyConfig` are declared in `@tm/core` and re-exported by `@tm/ai` and `@tm/notify`.
- **00 spikes**:
  - the `docker/worker/versions.env` keys `NODE_VERSION`, `CHROME_VERSION`, `PLAYWRIGHT_VERSION` and `FFMPEG_VERSION`;
  - `spikes/DECISIONS.md` and its decision keys (`runLocation.*`, `chrome.*`, `qr.*`, `forms.*`, `asr.*`, `worker.*`, `profile.*`, `watchers.*`, `ntfy.*`);
  - extra managed Chrome policies (no password saving, no browser sign-in or sync, no capture devices).
- **01a recorder and pings**:
  - core: `parseJob`, `IllegalTransition`, `formatOffset`, `localParts`, `ChatMessage.replyTo`, `JobConfig.identity.formProviders`;
  - ai and notify: `ChatTurn`, `AiError`, `AiTimeoutError`, `AsrResult`, `AsrStream.onError`, `dropOverlap`, `PingError`, `AlertKind` and the ping builders;
  - worker: `Screen`, `Stopper`, `Frame`, `Recorder`, `AudioSource`, `LiveAsr`, `OccurrenceOutcome`, `RunDeps`, `launchGuestStage`, `restoreProfile`, `startCheckpoints`, `deriveProfileKey`, `joinRecording`, `startChatCapture`, `createFormPinger`, `checkFormProviders`, `LinkResolveError`, `normaliseFormUrl`;
  - pipeline: `Slide`, `InventorySchema`, `summaryFileName`;
  - data: `recording/attempts.json`, `outcome.json`, `errors/`.
- **01b form submission**:
  - core: `FormRecord`, `FilledField`, `StopReason`, `FormRecordSchema`, `newFormRecord`, `canonicalFormUrl`, `formIdFor`, `TERMINAL_FORM_STATES`, `isTerminalFormState`, `applyFormTrigger`, `JobConfig.identity.organisation`;
  - worker: `FormContext`, `FormContextBase`, `makeFormContextBase`, `FormLinks`, `startFormDispatcher`, `onFormCandidate`;
  - selector maps: `config/selectors/google-forms.json` and `microsoft-forms.json`;
  - data: `forms/<formId>/filled_<N>.png`; the detail keys `university_email`, `programme`, `session_date` and `session_start`;
  - pipeline: `attendanceLine`.
- **01c website and scheduler**:
  - core: `control.ts` (`ACCOUNT_KIND`, heartbeat and sign-in types, `SpecEnv`), `secrets.ts` (`deriveKey`, `memberKey`, `sealColumn`, `openColumn`), `stripPasscode`, `RepeatRule`, `expandEntry`, `findClashes`, `formatWhen`, `formatDay`;
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
