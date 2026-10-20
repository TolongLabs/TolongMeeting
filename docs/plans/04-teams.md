# Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attend Microsoft Teams meetings through the Teams web client signed in as the member, behind the same `PlatformAdapter` contract as Zoom, and watch a Teams chat for meeting and form links.

**Architecture:** A `teamsAdapter` in `packages/worker/src/adapters/teams/` implements every `PlatformAdapter` method from the architecture page. It reads selectors and text signals from `config/selectors/teams.json` through plan 01a's `loadSelectors`, enforces its own step timeouts as 01a's Zoom adapter does (01a's `runOccurrence` captures the failures), and keeps per-page state (join time, sender roles, layout) in a `WeakMap<Page, ...>`. One in-page message parser serves both the meeting chat and the Teams chat watcher in `packages/worker/src/watchers/teams.ts`, which plugs into plan 02's watcher loop. Behaviour is tested against one configurable imitation of the Teams web client in `packages/worker/test/fixtures/teams/`; what only real meetings can prove sits in the final acceptance task.

**Tech Stack:** TypeScript (strict), Playwright on Node 24 driving the pinned Chrome, Playwright Test, `bun test`, zod, Next.js (the Teams chat option and presence note).

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Contract additions](#contract-additions)
1.  [Tasks](#tasks)
    1.  [Task 1: Teams selector map](#task-1-teams-selector-map)
    1.  [Task 2: Link normalisation](#task-2-link-normalisation)
    1.  [Task 3: Pre-join and join](#task-3-pre-join-and-join)
    1.  [Task 4: Admission and meeting state](#task-4-admission-and-meeting-state)
    1.  [Task 5: Devices, notices, audio output and leave](#task-5-devices-notices-audio-output-and-leave)
    1.  [Task 6: Meeting chat with sender roles](#task-6-meeting-chat-with-sender-roles)
    1.  [Task 7: Layout, participant count and shared screen](#task-7-layout-participant-count-and-shared-screen)
    1.  [Task 8: Adapter assembly, registration and run changes](#task-8-adapter-assembly-registration-and-run-changes)
    1.  [Task 9: Teams chat link watcher](#task-9-teams-chat-link-watcher)
    1.  [Task 10: Teams on the website: chat option and presence note](#task-10-teams-on-the-website-chat-option-and-presence-note)
    1.  [Task 11: Monthly smoke test entry](#task-11-monthly-smoke-test-entry)
    1.  [Task 12: Milestone acceptance](#task-12-milestone-acceptance)

## Global Constraints

- Join as the member through the Teams web client with the identity's signed-in profile. Teams never joins as a guest (the guest fallback is Zoom's only, decision 28), so `join` ignores `opts.guestName` and never returns `account_busy`.
- Microphone and camera stay off for the whole session. A pre-join device toggle may be clicked only to turn a device off; in the meeting the worker never clicks microphone, camera, chat input, reactions, share or record controls.
- Joining and leaving are the only visible actions (anti-goal 4). Breakout prompts are never accepted and trigger a ping. The bot never admits anyone or ends the meeting, even when the member is the organiser.
- Notices are acknowledged only through the allowlist of button texts in `config/selectors/teams.json`, and each click is logged.
- `waitUntilAdmitted` waits until the scheduled end plus 30 minutes at most; `lobby_expired` allows at most 2 further knocks; `lobby_denied` stops and pings.
- Chat is read continuously, with full sweeps every 10 minutes, and a cursor advances only after a durable write (CHAT-03).
- Every adapter step has a timeout; on failure plan 01a's `runOccurrence` saves a screenshot and the page's accessibility tree, and the member is pinged.
- Selectors live in `config/selectors/teams.json`, loaded at start from `TM_SELECTORS_DIR` (default `/app/config/selectors`), so a UI change is fixed without rebuilding. The Teams fixtures mirror the map and change in the same commit.
- Link watchers run as desk tabs from T-60 until the meeting ends, kept open rather than reloaded, and watch only the chat named in the entry; a Teams chat is identified by its URL.
- Watchers read the last 24 hours at start, then poll every 25 to 45 seconds before the meeting and every 12 to 25 seconds during it, at random intervals. They extract meeting links before the meeting (the newest wins; a pasted link always overrides) and form links with their sender during it.
- Watchers are read-only: never send, react or mark as read beyond what opening the chat does.
- Meeting passcodes (the Teams `p` parameter) never appear in ping text or logs; plan 01c's `stripPasscode` already removes it.
- Joining sets the member's Teams presence to "In a call"; the website says so.
- A monthly smoke test joins each platform's test meeting and fails loudly if a selector is missing.

## Review Focus

1.  A recurring Teams meeting keeps one chat thread across occurrences, so the meeting chat still holds last week's messages, form links and "Meeting ended" notices. The bot should treat only messages from 60 minutes before it joined onwards as this meeting's chat, and never read chat text as an end signal (tests in Tasks 4 and 6).
1.  University tenants wrap links in Microsoft Safe Links, and members paste whatever their address bar shows (the launcher page, the `/_#/` or `/v2/` forms). Every one of these should join the same meeting (test in Task 2).
1.  An expired Teams session often lands on the anonymous pre-join screen with a name box rather than a Microsoft sign-in page. The member expects a "sign in again" ping, not a guest join under a typed name (test in Task 3).
1.  Lecturers often join after the bot. A form link posted by the organiser, who wasn't in the roster when the bot first read it, should still count as the host's (test in Task 6).
1.  Teams moves participants into breakout rooms automatically when the organiser chooses. The bot ends up in a room without accepting anything, and the member should be pinged exactly as for a prompt (test in Task 4).

## Contract additions

Names this plan adds to [architecture and contracts](../TRD.md), copied there in the commit of the task that creates them:

- **Selector map**: `config/selectors/teams.json` and `TeamsSelectorsSchema` (Task 1), in the layout of 01a's `zoom.json`.
- **Worker**: `teamsAdapter`, `TEAMS_TIMEOUTS` and the modules under `packages/worker/src/adapters/teams/` (Tasks 1 to 8); `teamsChatReader` (Task 9).
- **Run and pings** (Task 8): `AlertKind` gains `teams_signin`; new `breakout` copy; `runOccurrence` calls `ensureLayout` on its 10-second refresh, and pings `teams_signin` when a Teams join needs a sign-in.
- **Smoke test** (Task 11): `SmokeEntry`, `SMOKE_ENTRIES`, `runSmokeEntry`, `zoomSmoke`, `teamsSmoke`, `tm-worker --smoke --job <path>`, `run-job.sh <job> smoke` and `docker/worker/smoke.crontab`.
- **Core and website**: `normaliseTeamsChatUrl(url: string): string | null` in `packages/core/src/teams-link.ts`, used for Teams chats in plan 01c's `ChatLinkSchema` (Task 9); `TEAMS_PRESENCE_NOTE`, `showsTeamsPresenceNote`, the `teams` entries of `CHAT_FIELD_COPY` and `chatAppOptions` in plan 02's `packages/web/lib/link-notices.ts`, and `TeamsPresenceNote` (Task 10).

Names used from earlier plans:

- **Plan 01a**: `loadSelectors<T>(platform: Platform, schema: z.ZodType<T>): Promise<T>`, `ZoomSelectorsSchema` and `DevicesOnError { labels: string[] }` (Task 13, with `DevicesOnError` imported from `packages/worker/src/adapters/types.ts`); `unwrapLink` and `extractLinks` (Task 12); `startChatCapture` (Task 15), which writes chat to disk before adopting the cursor and sweeps every 10 minutes; `runOccurrence` (Task 18), which opens the normalised link with `stage.goto` before `join`, reloads and joins again after `lobby_expired` (at most 2 more times), pings `breakout` once per prompt, treats `unknown` for 30 seconds as a drop, logs each dismissed notice as a `notice_dismissed` event, and saves the screenshot and `ariaSnapshot()` under `errors/` when a step fails or times out; `alertPing` and `AlertKind` (Task 3); the Playwright `fixtures` project (Task 7), which must point `TM_SELECTORS_DIR` at the repository's `config/selectors`, as the Zoom specs also need.
- **Plan 01c**: `ChatLinkSchema` in `packages/web/lib/timetable.ts`; `stripPasscode` in `packages/core/src/passcode.ts`; the entry edit page `packages/web/app/timetable/[id]/page.tsx`; the Accounts page `packages/web/app/accounts/page.tsx` with `accountStatus` from `packages/web/lib/identities.ts`; the "Sign in again" ping action.
- **Plan 02**: `ChatSourceReader`, `runChatWatcher`, `WatcherSigninError`, `WatcherChatError` and `resetWatcherEnv` (Task 3), whose loop owns the 24-hour scan, the random poll intervals, the newest-link rule, the pasted-link override and form candidates; `serveWatcherFixtures` and `watchHarness` (Task 4); `watcherFor` (Task 6); the spike 2 rule for `latest()`; and the Teams refusal in `ChatLinkSchema` (Task 7), which Task 9 removes.

---

## Tasks

### Task 1: Teams selector map

**Files:**

- Create: `config/selectors/teams.json`
- Create: `packages/worker/src/adapters/teams/selectors.ts`
- Test: `packages/worker/src/adapters/teams/selectors.test.ts`

**Interfaces:**

- Consumes: `loadSelectors<T>(platform: Platform, schema: z.ZodType<T>): Promise<T>` from plan 01a (Task 13).
- Produces: `TeamsSelectorsSchema` (zod, strict at every level, the shape of `teams.json` below), `type TeamsSelectors = z.infer<typeof TeamsSelectorsSchema>` and `teamsSelectors(): Promise<TeamsSelectors>` (`loadSelectors('teams', TeamsSelectorsSchema)`) in `packages/worker/src/adapters/teams/selectors.ts`. The map follows 01a's `zoom.json` layout: `selectors` holds CSS selectors usable in `document.querySelectorAll`; `texts` holds regular expressions matched case-insensitively against visible text, with apostrophes written as `.` so straight and curly ones both match; `noticeAllowlist` holds exact button texts; `signInHosts` holds host names.

- [x] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teamsSelectors } from './selectors'

const shipped = join(import.meta.dir, '../../../../../config/selectors')

test('the shipped teams.json loads with every key the adapter reads', async () => {
  process.env.TM_SELECTORS_DIR = shipped
  const sel = await teamsSelectors()
  expect(sel.noticeAllowlist).toEqual(['Got it', 'OK', 'Dismiss'])
  expect(sel.selectors.hangupButton).toBe('#hangup-button')
  expect(sel.signInHosts).toContain('login.microsoftonline.com')
  expect(new RegExp(sel.texts.removed, 'i').test("You've been removed from this meeting")).toBe(true)
})

test('a missing key fails loudly and names the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'))
  cpSync(shipped, dir, { recursive: true })
  const map = JSON.parse(readFileSync(join(dir, 'teams.json'), 'utf8'))
  delete map.selectors.hangupButton
  writeFileSync(join(dir, 'teams.json'), JSON.stringify(map))
  process.env.TM_SELECTORS_DIR = dir
  await expect(teamsSelectors()).rejects.toThrow(/hangupButton/)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/worker/src/adapters/teams/selectors.test.ts`
Expected: FAIL, module `./selectors` not found.

- [x] **Step 3: Create `config/selectors/teams.json` and `teamsSelectors(): Promise<TeamsSelectors>`**

Starting values, mirrored by the fixtures and confirmed or corrected in Task 12:

```json
{
  "signInHosts": ["login.microsoftonline.com", "login.microsoft.com", "login.live.com", "account.live.com"],
  "selectors": {
    "launcherWebJoin": "[data-tid='joinOnWeb']",
    "prejoinJoinButton": "[data-tid='prejoin-join-button']",
    "prejoinNameInput": "[data-tid='prejoin-display-name-input']",
    "prejoinCameraToggle": "[data-tid='toggle-video']",
    "prejoinMicToggle": "[data-tid='toggle-mute']",
    "prejoinComputerAudio": "[data-tid='prejoin-audiosettings-computer-audio']",
    "lobbyScreen": "[data-tid='lobby-screen']",
    "hangupButton": "#hangup-button",
    "micButton": "#microphone-button",
    "micOff": "#microphone-button[data-state='mic-off']",
    "cameraButton": "#video-button",
    "cameraOff": "#video-button[data-state='call-video-off']",
    "moreButton": "#callingButtons-showMoreBtn",
    "incomingAudioOff": "[data-tid='incoming-audio-off-banner']",
    "chatButton": "#chat-button",
    "chatPane": "[data-tid='chat-pane']",
    "chatScroller": "[data-tid='message-pane-list-viewport']",
    "chatItem": "[data-tid='chat-pane-item']",
    "chatMessage": "[data-tid='chat-pane-message']",
    "chatAuthor": "[data-tid='message-author-name']",
    "chatTime": "time[datetime]",
    "chatBody": "[id^='content-']",
    "rosterButton": "#roster-button",
    "rosterPane": "[data-tid='roster-pane']",
    "rosterItem": "[data-tid^='participantsInCall-']",
    "viewButton": "#view-mode-button",
    "sharedScreen": "[data-stream-type='ScreenSharing'] video, [data-stream-type='ScreenSharing'] canvas",
    "noticeContainers": "[role='dialog'], [role='alertdialog'], [role='alert'], [role='status']",
    "breakoutRoomBanner": "[data-tid='breakout-room-banner']",
    "endScreen": "[data-tid='call-end-screen']"
  },
  "texts": {
    "deviceBlocked": "you can.t get there from here|AADSTS53000",
    "invalidLink": "this meeting link is invalid|we couldn.t find the meeting",
    "permissionContinue": "^continue without audio or video$",
    "lobby": "someone in the meeting should let you in soon|we.ll let people know you.re waiting",
    "lobbyDenied": "denied your request to join|you were denied access to the meeting",
    "lobbyExpired": "no one responded to your request to join",
    "hangupLeave": "^leave$",
    "incomingAudioOn": "^turn on incoming audio$",
    "focusOnContent": "^focus on content$",
    "breakoutPrompt": "join room|assigned you to a breakout room|you.ve been moved to",
    "ended": "the meeting has ended|you left the meeting",
    "removed": "removed you from the meeting|you.ve been removed from this meeting"
  },
  "noticeAllowlist": ["Got it", "OK", "Dismiss"]
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/worker/src/adapters/teams/selectors.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add config/selectors/teams.json packages/worker/src/adapters/teams/selectors.ts packages/worker/src/adapters/teams/selectors.test.ts
git commit -m "feat(worker): add teams selector map"
```

### Task 2: Link normalisation

**Files:**

- Create: `packages/core/src/teams-link.ts` (`normaliseTeamsLink`, `normaliseTeamsChatUrl`), `packages/core/src/meeting-link.ts` (`normaliseMeetingLink`); Task 8 adds the worker re-export `packages/worker/src/adapters/teams/link.ts`
- Test: `packages/core/test/teams-link.test.ts` (done in core per pre-flight TE1; Task 9 reuses `normaliseTeamsChatUrl` from it)

**Interfaces:**

- Consumes: `unwrapLink(url: string): string` from plan 01a (Task 12). Plan 01c's `stripPasscode(url: string): string` in `packages/core/src/passcode.ts` already removes the Teams `p` passcode where links are stored, and 01a's `redact` keeps only host and path of URLs in logs.
- Produces: `normaliseTeamsLink(url: string): string | null` in `packages/core/src/teams-link.ts`, which Task 8 exposes as `teamsAdapter.normaliseLink`.

- [x] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { normaliseTeamsLink } from './link'

const THREAD = '19%3Ameeting_TESTTHREAD%40thread.v2'
const CONTEXT = '%7B%22Tid%22%3A%22TENANT%22%2C%22Oid%22%3A%22ORGANISER%22%7D'
const JOIN = `https://teams.microsoft.com/l/meetup-join/${THREAD}/0?context=${CONTEXT}`
const lower = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_TESTTHREAD%40thread.v2/0?context=%7b%22Tid%22%3a%22TENANT%22%2c%22Oid%22%3a%22ORGANISER%22%7d`
const hashPath = `/l/meetup-join/${THREAD}/0?context=${CONTEXT}`

test.each([
  [JOIN, JOIN],
  [lower, JOIN],
  [`${JOIN}&anon=true&deeplinkId=TESTDEEPLINK`, JOIN],
  [`HTTPS://Teams.Microsoft.com/l/meetup-join/${THREAD}/0?context=${CONTEXT}`, JOIN],
  [`https://teams.microsoft.com/_#${hashPath}`, JOIN],
  [`https://teams.microsoft.com/v2/?meetingjoin=true#${hashPath}`, JOIN],
  [
    `https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(`/_#${hashPath}`)}&type=meetup-join&directDl=true`,
    JOIN
  ],
  [`https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(JOIN)}&data=TESTDATA&reserved=0`, JOIN],
  [
    'https://teams.microsoft.com/meet/1234567890123?p=TESTPASS',
    'https://teams.microsoft.com/meet/1234567890123?p=TESTPASS'
  ],
  [
    'https://teams.live.com/meet/9876543210987?p=TESTPASS&anon=true',
    'https://teams.live.com/meet/9876543210987?p=TESTPASS'
  ],
  ['https://teams.live.com/meet/9876543210987', 'https://teams.live.com/meet/9876543210987']
])('normalises %s', (input, expected) => {
  expect(normaliseTeamsLink(input)).toBe(expected)
})

test.each([
  'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
  'https://teams.microsoft.com/l/channel/19%3ATESTCHANNEL%40thread.tacv2/General',
  'https://teams.microsoft.com.evil.example/l/meetup-join/19%3Ameeting_X%40thread.v2/0',
  'https://teams.microsoft.com/meet/not-digits',
  'https://zoom.us/j/1234567890?pwd=TESTPASS',
  'not a url'
])('rejects %s', (input) => {
  expect(normaliseTeamsLink(input)).toBeNull()
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/teams-link.test.ts`
Expected: FAIL, module `../src` has no `normaliseTeamsLink`.

- [x] **Step 3: Implement `normaliseTeamsLink(url: string): string | null` in `packages/core/src/teams-link.ts`**

Rules, in order:

1.  Unwrap Safe Links and Google redirects with 01a's `unwrapLink`, then parse with `new URL`; a parse failure returns `null`.
1.  The lower-cased host must be exactly `teams.microsoft.com` or `teams.live.com`.
1.  `/dl/launcher/launcher.html` takes its `url` parameter, minus a leading `/_#`, as the path and query; a hash starting with `#/` (the `/_#/` and `/v2/?meetingjoin=true#/` forms) makes the part after `#` the path and query.
1.  `/l/meetup-join/<thread>/<n>` returns `https://<host>/l/meetup-join/<enc(dec(thread))>/<n>`, plus `?context=<enc(dec(context))>` when `context` is present, where `enc` is `encodeURIComponent` and `dec` is `decodeURIComponent`; every other parameter is dropped.
1.  `/meet/<digits>` returns `https://<host>/meet/<digits>`, plus `?p=<enc(dec(p))>` when `p` is present.
1.  Anything else, including `/l/chat/` and `/l/channel/` links, returns `null`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/teams-link.test.ts`
Expected: PASS (17 tests).

- [x] **Step 5: Commit**

```bash
git add packages/core/src/teams-link.ts packages/core/src/meeting-link.ts packages/core/test/teams-link.test.ts
git commit -m "feat(core): teams link rules"
```

### Task 3: Pre-join and join

**Files:**

- Create: `packages/worker/test/fixtures/teams/app.html`
- Create: `packages/worker/test/fixtures/teams/signin.html`
- Create: `packages/worker/test/teams/serve.ts`
- Create: `packages/worker/src/adapters/teams/page-state.ts`
- Create: `packages/worker/src/adapters/teams/text.ts`
- Create: `packages/worker/src/adapters/teams/join.ts`
- Test: `packages/worker/test/teams/join.spec.ts`

**Interfaces:**

- Consumes: `TeamsSelectors`, `teamsSelectors()` (Task 1); `JoinResult` from `packages/worker/src/adapters/types.ts`.
- Produces:
  - `interface TeamsPageState { joinedAt: number | null; roles: Map<string, SenderRole> | null; shareSeen: boolean }` and `teamsState(page: Page): TeamsPageState` (one `WeakMap` entry per page, created on first use) in `packages/worker/src/adapters/teams/page-state.ts`.
  - `teamsTextSignal(page: Page, sel: TeamsSelectors, pattern: string): Promise<boolean>` in `packages/worker/src/adapters/teams/text.ts`: true when the case-insensitive regular expression matches the page's visible text outside `chatPane` and `rosterPane`, so chat messages never count as signals.
  - `joinTeams(page: Page, sel: TeamsSelectors, timeoutMs = 90_000): Promise<JoinResult>` in `packages/worker/src/adapters/teams/join.ts`. It starts on the page the caller has already opened at the normalised link (01a's run sequence) and never navigates itself.
  - Test harness in `packages/worker/test/teams/serve.ts`: `type TeamsScene`, `interface TeamsFixtureConfig`, `serveTeams(page: Page, cfg: TeamsFixtureConfig): Promise<void>` (replaces earlier routes), `setTeamsScene(page: Page, scene: TeamsScene, patch?: Partial<TeamsFixtureConfig>): Promise<void>`, `teamsClicks(page: Page): Promise<string[]>`. Later tasks add fields to `TeamsFixtureConfig` and scenes to `app.html`.

- [x] **Step 1: Build the fixtures and harness**

`app.html` imitates the Teams web client as one page whose scene comes from `window.__cfg` (injected by `serveTeams`) and switches through `window.__scene(scene, patch)`. Every element uses the attribute values in `teams.json`. It must contain:

- `launcher`: a `[data-tid='joinOnWeb']` button "Continue on this browser" and a decoy "Join in the Teams app" button.
- `prejoin`: camera and microphone toggles (`role="switch"`, `aria-label` "Camera" and "Microphone", `aria-checked` from `cfg.camera` and `cfg.mic`), radio options "Computer audio" (`[data-tid='prejoin-audiosettings-computer-audio']`) and "Don't use audio" (checked one from `cfg.audio`), and a "Join now" button that switches to `cfg.afterJoin` (default `meeting`).
- `prejoin-anonymous`: the pre-join plus an empty `[data-tid='prejoin-display-name-input']`.
- `prejoin-permissions`: the pre-join under a `role="dialog"` with a "Continue without audio or video" button that closes it.
- `signin` and `device-blocked`: set `location.href` to `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`, with `?blocked=1` for `device-blocked`.
- `invalid`: the text "This meeting link is invalid".
- `lobby`: `[data-tid='lobby-screen']` with "Someone in the meeting should let you in soon".
- `meeting`: the toolbar `#hangup-button` (`aria-label` "Leave"), `#microphone-button` and `#video-button` (`data-state` from `cfg.mic` and `cfg.camera`: `mic-off` or `mic`, `call-video-off` or `call-video`), `#chat-button` ("Chat"), `#roster-button` ("People"), `#view-mode-button` ("View") and `#callingButtons-showMoreBtn` ("More").
- `blank`: an empty body.
- A click listener that pushes each clicked control's `aria-label`, else its trimmed text, to `window.__clicks`.

`signin.html` shows a Microsoft sign-in form (an `input[name='loginfmt']`), or, when the URL has `blocked=1`, the text "You can't get there from here" with "AADSTS53000". `serveTeams` routes `https://teams.microsoft.com/**` and `https://teams.live.com/**` to `app.html` with `<script>window.__cfg = ...</script>` prepended, and `https://login.microsoftonline.com/**` to `signin.html`.

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import { joinTeams } from '../../src/adapters/teams/join'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { serveTeams, teamsClicks } from './serve'

const JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0?context=%7B%22Tid%22%3A%22TENANT%22%7D'
const sel = await teamsSelectors()

test('continues on this browser, turns devices off, picks computer audio and joins', async ({ page }) => {
  await serveTeams(page, {
    scene: 'launcher',
    mic: 'on',
    camera: 'on',
    audio: 'none'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await teamsClicks(page)).toEqual([
    'Continue on this browser',
    'Camera',
    'Microphone',
    'Computer audio',
    'Join now'
  ])
})

test('passes the blocked-devices dialog without granting anything', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin-permissions',
    mic: 'off',
    camera: 'off',
    audio: 'computer'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await teamsClicks(page)).toEqual(['Continue without audio or video', 'Join now'])
})

test('reports the lobby', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin',
    mic: 'off',
    camera: 'off',
    audio: 'computer',
    afterJoin: 'lobby'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({ kind: 'lobby' })
})

test('an anonymous pre-join means the session expired: no guest join', async ({ page }) => {
  await serveTeams(page, {
    scene: 'prejoin-anonymous',
    mic: 'off',
    camera: 'off',
    audio: 'computer'
  })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'signin_required',
    host: 'teams.microsoft.com'
  })
  await expect(page.locator(sel.selectors.prejoinNameInput)).toHaveValue('')
  expect(await teamsClicks(page)).toEqual([])
})

test('a Microsoft sign-in page is signin_required on its host', async ({ page }) => {
  await serveTeams(page, { scene: 'signin' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'signin_required',
    host: 'login.microsoftonline.com'
  })
})

test('a managed-device block is a failure, not a sign-in', async ({ page }) => {
  await serveTeams(page, { scene: 'device-blocked' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'failed',
    reason: 'device_not_compliant'
  })
})

test('an invalid link fails', async ({ page }) => {
  await serveTeams(page, { scene: 'invalid' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel)).toEqual({
    kind: 'failed',
    reason: 'invalid_link'
  })
})

test('an unrecognised page times out', async ({ page }) => {
  await serveTeams(page, { scene: 'blank' })
  await page.goto(JOIN)
  expect(await joinTeams(page, sel, 3_000)).toEqual({
    kind: 'failed',
    reason: 'prejoin_timeout'
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/join.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/teams/join`.

- [x] **Step 4: Implement `teamsState`, `teamsTextSignal` and `joinTeams(page: Page, sel: TeamsSelectors, timeoutMs = 90_000): Promise<JoinResult>`**

Every 500 ms until `timeoutMs`, classify the page and act on the first rule that matches (text checks through `teamsTextSignal`):

1.  Page host in `signInHosts`: `texts.deviceBlocked` present gives `{ kind: 'failed', reason: 'device_not_compliant' }`, otherwise `{ kind: 'signin_required', host }`.
1.  `texts.invalidLink` present: `{ kind: 'failed', reason: 'invalid_link' }`.
1.  `launcherWebJoin` visible: click it (never any other launcher control).
1.  A visible button whose text matches `texts.permissionContinue`: click it.
1.  `prejoinNameInput` visible: `{ kind: 'signin_required', host: <page host> }`, without typing.
1.  `prejoinJoinButton` visible: click `prejoinCameraToggle` if it reads on, then `prejoinMicToggle` if it reads on (on means `aria-checked="true"`, or a checked input), then `prejoinComputerAudio` if it isn't checked; re-read both toggles and return `{ kind: 'failed', reason: 'device_toggle_stuck' }` if either still reads on; then click "Join now" once.
1.  `lobbyScreen` visible, or `texts.lobby`, `texts.lobbyDenied` or `texts.lobbyExpired` present: `{ kind: 'lobby' }`.
1.  `hangupButton` visible: set `teamsState(page).joinedAt = Date.now()` and return `{ kind: 'in_meeting' }`.

At the deadline return `{ kind: 'failed', reason: 'prejoin_timeout' }`.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/join.spec.ts`
Expected: PASS (8 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/teams packages/worker/test/teams packages/worker/src/adapters/teams/page-state.ts packages/worker/src/adapters/teams/text.ts packages/worker/src/adapters/teams/join.ts
git commit -m "feat(worker): join teams meetings with devices off"
```

### Task 4: Admission and meeting state

**Files:**

- Modify: `packages/worker/test/fixtures/teams/app.html`, `packages/worker/test/teams/serve.ts`
- Create: `packages/worker/src/adapters/teams/state.ts`
- Test: `packages/worker/test/teams/state.spec.ts`

**Interfaces:**

- Consumes: `TeamsSelectors` (Task 1); `teamsState`, `teamsTextSignal`, `serveTeams`, `setTeamsScene`, `teamsClicks` (Task 3); `MeetingState`, `AdmissionResult` from `packages/worker/src/adapters/types.ts`.
- Produces: `teamsMeetingState(page: Page, sel: TeamsSelectors): Promise<MeetingState>` and `waitTeamsAdmitted(page: Page, sel: TeamsSelectors, deadline: Date, pollMs = 2_000): Promise<AdmissionResult>` in `packages/worker/src/adapters/teams/state.ts`.

- [x] **Step 1: Extend the fixture**

Add scenes `lobby-denied` ("Someone in the meeting denied your request to join"), `lobby-expired` ("No one responded to your request to join"), `ended` (`[data-tid='call-end-screen']` with "The meeting has ended" and a "Rejoin" button), `left` (the end screen with "You left the meeting") and `removed` (the end screen with "Someone removed you from the meeting"). Add `TeamsFixtureConfig.breakout: 'none' | 'prompt' | 'moved'`: `prompt` adds a `role="dialog"` "The organiser assigned you to a breakout room" with "Join room" and "Dismiss" buttons; `moved` adds `[data-tid='breakout-room-banner']` "You've been moved to Room 1". Add `TeamsFixtureConfig.chatOpen: boolean` and `messages: FixtureMessage[]` (`{ id: string; sender: string; time: string; datetime: string; text: string; href?: string }`), rendered in `[data-tid='chat-pane']` as Teams renders them: `[data-tid='chat-pane-item']` holding `[data-tid='chat-pane-message'][data-mid]`, `[data-tid='message-author-name']` (left out when the previous item has the same sender), `time[datetime]` and `[id^='content-']`.

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import { teamsMeetingState, waitTeamsAdmitted } from '../../src/adapters/teams/state'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { serveTeams, setTeamsScene, teamsClicks } from './serve'

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()
const soon = (ms: number) => new Date(Date.now() + ms)

for (const [scene, state] of [
  ['lobby', 'lobby'],
  ['meeting', 'in_meeting'],
  ['ended', 'ended'],
  ['left', 'ended'],
  ['removed', 'removed'],
  ['blank', 'unknown']
] as const) {
  test(`scene ${scene} reads as ${state}`, async ({ page }) => {
    await serveTeams(page, { scene, mic: 'off', camera: 'off' })
    await page.goto(JOIN)
    expect(await teamsMeetingState(page, sel)).toBe(state)
  })
}

test('chat text from a recurring thread is never an end signal', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    chatOpen: true,
    messages: [
      {
        id: 'old1',
        sender: 'Lecturer',
        time: '26/10',
        datetime: '2026-10-26T11:00:00Z',
        text: 'The meeting has ended, see you next week'
      },
      {
        id: 'old2',
        sender: 'Student',
        time: '26/10',
        datetime: '2026-10-26T11:00:05Z',
        text: 'Someone removed you from the meeting?'
      }
    ]
  })
  await page.goto(JOIN)
  expect(await teamsMeetingState(page, sel)).toBe('in_meeting')
})

test('a breakout prompt and an automatic move both read as breakout_prompt, untouched', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    breakout: 'prompt'
  })
  await page.goto(JOIN)
  expect(await teamsMeetingState(page, sel)).toBe('breakout_prompt')
  await setTeamsScene(page, 'meeting', { breakout: 'moved' })
  expect(await teamsMeetingState(page, sel)).toBe('breakout_prompt')
  expect(await teamsClicks(page)).toEqual([])
})

test('admitted when the organiser lets the bot in', async ({ page }) => {
  await serveTeams(page, { scene: 'lobby', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  setTimeout(() => void setTeamsScene(page, 'meeting'), 3_000)
  expect(await waitTeamsAdmitted(page, sel, soon(20_000), 500)).toBe('admitted')
})

test('denied and expired lobbies', async ({ page }) => {
  await serveTeams(page, { scene: 'lobby-denied' })
  await page.goto(JOIN)
  expect(await waitTeamsAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_denied')
  await setTeamsScene(page, 'lobby-expired')
  expect(await waitTeamsAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_expired')
})

test('the deadline ends the wait as lobby_expired', async ({ page }) => {
  await serveTeams(page, { scene: 'lobby' })
  await page.goto(JOIN)
  const started = Date.now()
  expect(await waitTeamsAdmitted(page, sel, soon(2_000), 500)).toBe('lobby_expired')
  expect(Date.now() - started).toBeLessThan(3_500)
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/state.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/teams/state`.

- [x] **Step 4: Implement `teamsMeetingState` and `waitTeamsAdmitted` in `packages/worker/src/adapters/teams/state.ts`**

`teamsMeetingState` returns the first match, with every text check through `teamsTextSignal`: `texts.removed` → `removed`; `endScreen` visible or `texts.ended` → `ended`; `texts.breakoutPrompt` or `breakoutRoomBanner` visible → `breakout_prompt`; `lobbyScreen` visible or any lobby text → `lobby`; `hangupButton` visible → `in_meeting`; otherwise `unknown` (a missing Leave button without an end signal is left to 01a's drop handling, never read as an end). `waitTeamsAdmitted` polls every `pollMs`: `texts.lobbyDenied` → `lobby_denied`; `texts.lobbyExpired` → `lobby_expired`; `hangupButton` visible with no lobby signal → set `joinedAt` and return `admitted`; past `deadline` → `lobby_expired`.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/state.spec.ts test/teams/join.spec.ts`
Expected: PASS (11 state tests; the 8 join tests still pass on the extended fixture).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/teams packages/worker/test/teams packages/worker/src/adapters/teams/state.ts
git commit -m "feat(worker): read teams lobby and meeting state"
```

### Task 5: Devices, notices, audio output and leave

**Files:**

- Modify: `packages/worker/test/fixtures/teams/app.html`, `packages/worker/test/teams/serve.ts`
- Create: `packages/worker/src/adapters/teams/controls.ts`
- Test: `packages/worker/test/teams/controls.spec.ts`

**Interfaces:**

- Consumes: `TeamsSelectors` (Task 1); `serveTeams`, `teamsClicks` (Task 3); `teamsMeetingState` (Task 4, in the test); `DevicesOnError` from plan 01a.
- Produces, in `packages/worker/src/adapters/teams/controls.ts`:
  - `assertTeamsDevicesOff(page: Page, sel: TeamsSelectors): Promise<void>`, throwing `DevicesOnError` when `micOff` or `cameraOff` doesn't match a visible element, with `labels` holding the offending controls' `aria-label`s, or `microphone control not found` and `camera control not found` when a control is missing.
  - `dismissTeamsNotices(page: Page, sel: TeamsSelectors): Promise<string[]>`, returning the texts of the buttons clicked, in page order.
  - `connectTeamsOutputAudio(page: Page, sel: TeamsSelectors): Promise<void>`.
  - `leaveTeams(page: Page, sel: TeamsSelectors): Promise<void>`.

- [x] **Step 1: Extend the fixture**

Add `TeamsFixtureConfig.notices: { role: 'dialog' | 'alert' | 'status'; text: string; button: string }[]` (each rendered as a container with that role, its text and one button), `incomingAudioOff: boolean` (renders `[data-tid='incoming-audio-off-banner']`; "More" opens a `role="menu"` with "Turn on incoming audio", which clears the banner, plus "Turn off incoming video" and "Start recording" decoys) and `organiser: boolean` (clicking `#hangup-button` opens a `role="menu"` with "End meeting" and "Leave"; otherwise it switches to `left`). Give the chat pane a header button `aria-label="Close"`.

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import {
  assertTeamsDevicesOff,
  connectTeamsOutputAudio,
  dismissTeamsNotices,
  leaveTeams
} from '../../src/adapters/teams/controls'
import { teamsMeetingState } from '../../src/adapters/teams/state'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { DevicesOnError } from '../../src/adapters/types'
import { serveTeams, teamsClicks } from './serve'

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()

test('devices off passes; either device on, or a missing control, throws', async ({ page }) => {
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  await assertTeamsDevicesOff(page, sel)
  for (const patch of [{ mic: 'on' }, { camera: 'on' }] as const) {
    await serveTeams(page, {
      scene: 'meeting',
      mic: 'off',
      camera: 'off',
      ...patch
    })
    await page.goto(JOIN)
    await expect(assertTeamsDevicesOff(page, sel)).rejects.toBeInstanceOf(DevicesOnError)
  }
  await serveTeams(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(JOIN)
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.micButton)
  await expect(assertTeamsDevicesOff(page, sel)).rejects.toBeInstanceOf(DevicesOnError)
  expect(await teamsClicks(page)).toEqual([])
})

test('clicks only allowlisted buttons inside notices, never the breakout prompt', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    chatOpen: true,
    breakout: 'prompt',
    notices: [
      { role: 'status', text: 'Recording has started.', button: 'Dismiss' },
      { role: 'dialog', text: 'New ways to react', button: 'Got it' },
      {
        role: 'dialog',
        text: 'Consent is required to unmute',
        button: 'Confirm'
      },
      { role: 'alert', text: 'Waiting in the lobby: Visitor', button: 'Admit' }
    ]
  })
  await page.goto(JOIN)
  expect(await dismissTeamsNotices(page, sel)).toEqual(['Dismiss', 'Got it'])
  expect(await teamsClicks(page)).toEqual(['Dismiss', 'Got it'])
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
})

test('turns incoming audio back on and nothing else', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    incomingAudioOff: true
  })
  await page.goto(JOIN)
  await connectTeamsOutputAudio(page, sel)
  expect(await teamsClicks(page)).toEqual(['More', 'Turn on incoming audio'])
  await expect(page.locator(sel.selectors.incomingAudioOff)).toHaveCount(0)
  await expect(page.locator(sel.selectors.micOff)).toBeVisible()
})

test('leaves without ending the meeting, even as organiser', async ({ page }) => {
  await serveTeams(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    organiser: true
  })
  await page.goto(JOIN)
  await leaveTeams(page, sel)
  expect(await teamsClicks(page)).not.toContain('End meeting')
  expect(await teamsMeetingState(page, sel)).toBe('ended')
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/controls.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/teams/controls`.

- [x] **Step 4: Implement the four functions in `packages/worker/src/adapters/teams/controls.ts`**

- `dismissTeamsNotices`: for each visible `noticeContainers` element that isn't inside `chatPane` or `rosterPane` and whose text matches no `texts.breakoutPrompt`, click each visible button whose trimmed text or `aria-label` equals an entry of `noticeAllowlist` (case-insensitive).
- `connectTeamsOutputAudio`: only when `incomingAudioOff` is visible, click `moreButton`, then the menu item whose text matches `texts.incomingAudioOn`, and wait up to 5 seconds for the banner to go. It never touches device controls. The sink-level check after it is 01a's.
- `leaveTeams`: click `hangupButton`; if a `role="menu"` appears within 2 seconds, click the item whose text matches `texts.hangupLeave`; then wait up to 15 seconds for `endScreen`.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/controls.spec.ts`
Expected: PASS (4 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/teams packages/worker/test/teams packages/worker/src/adapters/teams/controls.ts
git commit -m "feat(worker): add teams devices, notices, leave"
```

### Task 6: Meeting chat with sender roles

**Files:**

- Modify: `packages/worker/test/fixtures/teams/app.html`, `packages/worker/test/teams/serve.ts`
- Create: `packages/worker/src/adapters/teams/chat-dom.ts`
- Create: `packages/worker/src/adapters/teams/roles.ts`
- Create: `packages/worker/src/adapters/teams/chat.ts`
- Test: `packages/worker/src/adapters/teams/chat.test.ts`, `packages/worker/test/teams/chat.spec.ts`

**Interfaces:**

- Consumes: `TeamsSelectors` (Task 1); `teamsState`, `serveTeams`, `teamsClicks` (Task 3); `ChatMessage`, `SenderRole` from `packages/core/src/types.ts`; `ChatCursor` from `packages/worker/src/adapters/types.ts`.
- Produces:
  - `interface RawTeamsMessage { id: string | null; sender: string; time: string; datetime: string | null; text: string; hrefs: string[] }` and `parseTeamsMessages(sel: TeamsSelectors): RawTeamsMessage[]` in `packages/worker/src/adapters/teams/chat-dom.ts`: a self-contained function (no imports, no closures) run through `page.evaluate(parseTeamsMessages, sel)` on the rendered `chatItem`s, carrying the sender forward to grouped items and skipping items without a `chatMessage` (system events). Task 9 reuses it.
  - `toTeamsChatMessages(raw: RawTeamsMessage[], ctx: { roles: Map<string, SenderRole> | null; cutoffMs: number | null; seenAt: string }): ChatMessage[]` in `packages/worker/src/adapters/teams/chat.ts`.
  - `roleFromTeamsLabel(label: string): SenderRole` and `readTeamsRoles(page: Page, sel: TeamsSelectors): Promise<Map<string, SenderRole>>` in `packages/worker/src/adapters/teams/roles.ts`.
  - `readTeamsChat(page: Page, sel: TeamsSelectors, cursor: ChatCursor): Promise<{ messages: ChatMessage[]; cursor: ChatCursor }>` and `sweepTeamsChat(page: Page, sel: TeamsSelectors): Promise<ChatMessage[]>` in `packages/worker/src/adapters/teams/chat.ts`.
  - `TEAMS_CHAT_HISTORY_MS = 60 * 60 * 1000` in `packages/worker/src/adapters/teams/chat.ts`.

- [x] **Step 1: Write the failing unit test**

```ts
import { expect, test } from 'bun:test'
import { toTeamsChatMessages } from './chat'
import { roleFromTeamsLabel } from './roles'

const joinedAt = Date.parse('2026-11-02T10:00:00Z')
const seenAt = '2026-11-02T10:06:30.000Z'

test('keeps this occurrence only, assigns roles and extracts links', () => {
  const out = toTeamsChatMessages(
    [
      {
        id: 'm1',
        sender: 'Lecturer',
        time: '26/10 10:05',
        datetime: '2026-10-26T10:05:00Z',
        text: 'Attendance https://forms.office.com/r/OLDFORM',
        hrefs: ['https://forms.office.com/r/OLDFORM']
      },
      {
        id: 'm2',
        sender: 'Lecturer',
        time: '10:05',
        datetime: '2026-11-02T10:05:00Z',
        text: 'Attendance form',
        hrefs: ['https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fforms.office.com%2Fr%2FNEWFORM']
      },
      {
        id: 'm3',
        sender: 'Student',
        time: '10:06',
        datetime: '2026-11-02T10:06:00Z',
        text: 'mirror: https://forms.gle/TESTFORM.',
        hrefs: []
      },
      {
        id: null,
        sender: 'Visitor',
        time: '10:06',
        datetime: null,
        text: 'hello',
        hrefs: []
      }
    ],
    {
      roles: new Map([
        ['lecturer', 'host'],
        ['student', 'participant']
      ]),
      cutoffMs: joinedAt - 3_600_000,
      seenAt
    }
  )
  expect(out.map((m) => m.key)).toEqual(['m2', 'm3', 'Visitor|10:06|hello'])
  expect(out[0]).toEqual({
    key: 'm2',
    sender: 'Lecturer',
    senderRole: 'host',
    time: '10:05',
    seenAt,
    text: 'Attendance form',
    links: ['https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fforms.office.com%2Fr%2FNEWFORM'],
    replyTo: null
  })
  expect(out[1].links).toEqual(['https://forms.gle/TESTFORM'])
  expect(out[2].senderRole).toBe('unknown')
})

test.each([
  ['Organizer', 'host'],
  ['Organiser', 'host'],
  ['Co-organizer', 'co_host'],
  ['Presenter', 'participant'],
  ['Attendee', 'participant'],
  ['', 'participant']
] as const)('roster label %s is %s', (label, role) => {
  expect(roleFromTeamsLabel(label)).toBe(role)
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test packages/worker/src/adapters/teams/chat.test.ts`
Expected: FAIL, module `./chat` not found.

- [x] **Step 3: Implement `toTeamsChatMessages` and `roleFromTeamsLabel`**

`toTeamsChatMessages` drops messages whose `datetime` is earlier than `cutoffMs` (messages without a `datetime` are kept), sets `key` to `id` or `${sender}|${time}|${text.slice(0, 200)}`, looks up `senderRole` by the trimmed lower-cased sender (`unknown` when absent or when `roles` is null), and sets `links` to the `http`/`https` `hrefs` followed by 01a's `extractLinks(text)`, de-duplicated in order; `replyTo` is always `null`, because Teams meeting chat quotes replies inline instead of threading them. `roleFromTeamsLabel` returns `co_host` when the label matches `/co-?organi[sz]er/i`, `host` when it matches `/organi[sz]er/i`, otherwise `participant`.

- [x] **Step 4: Run it to verify it passes**

Run: `bun test packages/worker/src/adapters/teams/chat.test.ts`
Expected: PASS (7 tests).

- [x] **Step 5: Extend the fixture**

Make the chat list virtualised like Teams: messages are 60 px tall inside `[data-tid='message-pane-list-viewport']`, and only the items within the visible window plus 2 on each side are in the DOM. Add `TeamsFixtureConfig.chatScroll: 'top' | 'bottom'` (start position, default `bottom`; the list stays where it is when messages arrive), `roster: { name: string; role?: string }[]` (rendered in `[data-tid='roster-pane']` as `[data-tid^='participantsInCall-']` items whose first text line is the name and second line the role), and `window.__addMessage(m)` and `window.__addRoster(p)`. Clicking `#roster-button` replaces the chat pane with the roster pane; clicking `#chat-button` brings the chat pane back with its full history, as Teams does.

- [x] **Step 6: Write the failing browser test**

```ts
import { expect, test } from '@playwright/test'
import { readTeamsChat, sweepTeamsChat } from '../../src/adapters/teams/chat'
import { teamsState } from '../../src/adapters/teams/page-state'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { serveTeams, teamsClicks } from './serve'

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const msgs = (n: number, from = 'Student') =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    sender: from,
    time: '10:00',
    datetime: ago(n - i),
    text: `message ${i}`
  }))
const base = {
  scene: 'meeting',
  mic: 'off',
  camera: 'off',
  chatOpen: true,
  roster: [{ name: 'Student' }]
} as const

test('returns new messages once, then nothing', async ({ page }) => {
  await serveTeams(page, { ...base, messages: msgs(5) })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const first = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(first.messages.map((m) => m.key)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  expect((await readTeamsChat(page, sel, first.cursor)).messages).toEqual([])
})

test('scrolls a list left scrolled up back to the bottom, and the sweep recovers everything', async ({ page }) => {
  await serveTeams(page, { ...base, messages: msgs(50), chatScroll: 'top' })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  expect((await readTeamsChat(page, sel, { seenKeys: [] })).messages.at(-1)?.key).toBe('m49')
  expect((await sweepTeamsChat(page, sel)).length).toBe(50)
})

test('last week messages of a recurring meeting are not this meeting', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    messages: [
      {
        id: 'old',
        sender: 'Student',
        time: '26/10',
        datetime: ago(7 * 24 * 60),
        text: 'https://forms.office.com/r/OLDFORM'
      },
      {
        id: 'new',
        sender: 'Student',
        time: '10:00',
        datetime: ago(1),
        text: 'hi'
      }
    ]
  })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  expect((await readTeamsChat(page, sel, { seenKeys: [] })).messages.map((m) => m.key)).toEqual(['new'])
})

test('an organiser who joined late is recognised as host when they post a link', async ({ page }) => {
  await serveTeams(page, { ...base, messages: msgs(1) })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const first = await readTeamsChat(page, sel, { seenKeys: [] })
  await page.evaluate(() => {
    ;(window as any).__addRoster({ name: 'Lecturer', role: 'Organizer' })
    ;(window as any).__addMessage({
      id: 'f1',
      sender: 'Lecturer',
      time: '10:05',
      datetime: new Date().toISOString(),
      text: 'Attendance',
      href: 'https://forms.office.com/r/TESTFORM'
    })
  })
  const next = await readTeamsChat(page, sel, first.cursor)
  expect(next.messages).toHaveLength(1)
  expect(next.messages[0]).toMatchObject({
    sender: 'Lecturer',
    senderRole: 'host',
    links: ['https://forms.office.com/r/TESTFORM']
  })
  expect(await teamsClicks(page)).toEqual(['People', 'Chat'])
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
})

test('a sender still missing from the roster is unknown, after one roster read', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    messages: [
      {
        id: 'x1',
        sender: 'Ghost',
        time: '10:01',
        datetime: ago(1),
        text: 'https://forms.gle/TESTFORM'
      }
    ]
  })
  await page.goto(JOIN)
  teamsState(page).joinedAt = Date.now()
  const { messages } = await readTeamsChat(page, sel, { seenKeys: [] })
  expect(messages[0].senderRole).toBe('unknown')
  expect(await teamsClicks(page)).toEqual(['People', 'Chat'])
})
```

- [x] **Step 7: Run it to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/chat.spec.ts`
Expected: FAIL, `readTeamsChat` is not exported from `../../src/adapters/teams/chat`.

- [x] **Step 8: Implement `parseTeamsMessages`, `readTeamsRoles`, `readTeamsChat` and `sweepTeamsChat`**

- `readTeamsRoles`: click `rosterButton`, wait for `rosterPane`, map each `rosterItem`'s first text line (trimmed, lower-cased) to `roleFromTeamsLabel` of its remaining lines, click `chatButton`, wait for `chatPane`, store the map in `teamsState(page).roles` and return it.
- `readTeamsChat`: if `chatPane` isn't visible, return no messages and the cursor unchanged (Task 7's `ensureTeamsLayout` reopens it). Otherwise set `chatScroller.scrollTop` to its `scrollHeight`, parse, and keep messages whose key isn't in `cursor.seenKeys`. The cutoff is `(joinedAt ?? the first call's time) - TEAMS_CHAT_HISTORY_MS`; set `joinedAt` on the first call when it is null. If any kept message has links and a sender absent from the role map (or the map is null), call `readTeamsRoles` once, re-parse and map again. Return the messages and a cursor with their keys appended; the caller adopts the cursor only after writing the messages (CHAT-03).
- `sweepTeamsChat`: call `readTeamsRoles` first, then scroll `chatScroller` from the top to the bottom in steps of `max(200, clientHeight / 2)` px with a random 300 to 350 ms pause, parsing at each step, and return the union by key, ordered as the list orders it, after the same cutoff.

- [x] **Step 9: Run it to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/chat.spec.ts`
Expected: PASS (5 tests).

- [x] **Step 10: Commit**

```bash
git add packages/worker/test/fixtures/teams packages/worker/test/teams packages/worker/src/adapters/teams/chat-dom.ts packages/worker/src/adapters/teams/roles.ts packages/worker/src/adapters/teams/chat.ts packages/worker/src/adapters/teams/chat.test.ts
git commit -m "feat(worker): read teams meeting chat with roles"
```

### Task 7: Layout, participant count and shared screen

**Files:**

- Modify: `packages/worker/test/fixtures/teams/app.html`, `packages/worker/test/teams/serve.ts`
- Create: `packages/worker/src/adapters/teams/layout.ts`
- Test: `packages/worker/test/teams/layout.spec.ts`

**Interfaces:**

- Consumes: `TeamsSelectors` (Task 1); `teamsState`, `serveTeams`, `setTeamsScene`, `teamsClicks` (Task 3); `Rect` from `packages/worker/src/adapters/types.ts`.
- Produces, in `packages/worker/src/adapters/teams/layout.ts`: `teamsParticipantCount(page: Page, sel: TeamsSelectors): Promise<number | null>`, `ensureTeamsLayout(page: Page, sel: TeamsSelectors): Promise<void>`, `teamsSharedScreenRegion(page: Page, sel: TeamsSelectors): Promise<Rect | null>`.

- [x] **Step 1: Extend the fixture**

Add `TeamsFixtureConfig.peopleCount: number | null` (the `#roster-button` shows it as a badge, and its `aria-label` becomes "People, <n> participants") and `share: { box: Rect; width: number; height: number } | null`, rendered as `<div data-stream-type="ScreenSharing"><canvas width=<width> height=<height> style="object-fit: contain"></canvas></div>` placed at `box`. Clicking `#view-mode-button` opens a `role="menu"` with `menuitemradio` items "Gallery", "Large gallery", "Together mode" and "Focus on content".

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import { ensureTeamsLayout, teamsParticipantCount, teamsSharedScreenRegion } from '../../src/adapters/teams/layout'
import { teamsSelectors } from '../../src/adapters/teams/selectors'
import { serveTeams, setTeamsScene, teamsClicks } from './serve'

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const sel = await teamsSelectors()
const base = { scene: 'meeting', mic: 'off', camera: 'off' } as const

test.use({ viewport: { width: 1920, height: 1080 } })

test('reads the participant count without touching the chat panel', async ({ page }) => {
  await serveTeams(page, { ...base, chatOpen: true, peopleCount: 34 })
  await page.goto(JOIN)
  expect(await teamsParticipantCount(page, sel)).toBe(34)
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
  expect(await teamsClicks(page)).toEqual([])
  await setTeamsScene(page, 'meeting', { peopleCount: null })
  expect(await teamsParticipantCount(page, sel)).toBeNull()
})

test('opens chat, then focuses on content once per share', async ({ page }) => {
  await serveTeams(page, { ...base, chatOpen: false, share: null })
  await page.goto(JOIN)
  await ensureTeamsLayout(page, sel)
  await setTeamsScene(page, 'meeting', {
    share: {
      box: { x: 0, y: 48, width: 1440, height: 900 },
      width: 1440,
      height: 1080
    }
  })
  await ensureTeamsLayout(page, sel)
  await ensureTeamsLayout(page, sel)
  expect(await teamsClicks(page)).toEqual(['Chat', 'View', 'Focus on content'])
  await expect(page.locator(sel.selectors.chatPane)).toBeVisible()
})

test('the shared-screen region is the picture inside the letterbox', async ({ page }) => {
  await serveTeams(page, {
    ...base,
    share: {
      box: { x: 0, y: 48, width: 1440, height: 900 },
      width: 1440,
      height: 1080
    }
  })
  await page.goto(JOIN)
  expect(await teamsSharedScreenRegion(page, sel)).toEqual({
    x: 120,
    y: 48,
    width: 1200,
    height: 900
  })
  await setTeamsScene(page, 'meeting', { share: null })
  expect(await teamsSharedScreenRegion(page, sel)).toBeNull()
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/layout.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/teams/layout`.

- [x] **Step 4: Implement the three functions in `packages/worker/src/adapters/teams/layout.ts`**

- `teamsParticipantCount`: the first integer in `rosterButton`'s text, else in its `aria-label`, else `null`; it never clicks.
- `ensureTeamsLayout`: click `chatButton` when `chatPane` isn't visible; when `sharedScreen` is visible and `teamsState(page).shareSeen` is false, click `viewButton`, then the menu item whose text matches `texts.focusOnContent`, and set `shareSeen`; reset `shareSeen` when no share is visible. It clicks nothing else.
- `teamsSharedScreenRegion`: the first visible `sharedScreen` element's box, shrunk to the picture inside it by its intrinsic size (`videoWidth`/`videoHeight` for a video, `width`/`height` for a canvas, contain-fit and centred), rounded to whole pixels, in page coordinates, which are stage coordinates as in 01a's Zoom adapter; `null` when no share is visible, so 01a falls back to its brightness crop.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/teams/layout.spec.ts`
Expected: PASS (3 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/teams packages/worker/test/teams packages/worker/src/adapters/teams/layout.ts
git commit -m "feat(worker): keep teams share large and chat open"
```

### Task 8: Adapter assembly, registration and run changes

**Files:**

- Create: `packages/worker/src/adapters/teams/index.ts`
- Modify: `packages/worker/src/adapters/index.ts`, plan 01a's `packages/worker/src/run.ts` and `packages/notify/src/messages.ts`
- Test: `packages/worker/src/adapters/teams/index.test.ts`, `packages/worker/test/teams/adapter.spec.ts`, `packages/worker/src/run.test.ts`, `packages/notify/src/messages.test.ts`

**Interfaces:**

- Consumes: everything Tasks 1 to 7 produce; `PlatformAdapter` from `packages/worker/src/adapters/types.ts`; from plan 01a, `runOccurrence` and its test helper `fakeDeps` (Task 18), `alertPing` and `AlertKind` (Task 3).
- Produces: `teamsAdapter: PlatformAdapter` (with `platform: 'teams'`) and `TEAMS_TIMEOUTS` in `packages/worker/src/adapters/teams/index.ts`; `adapterFor(url)` returns `teamsAdapter` for any URL `normaliseTeamsLink` accepts.
- Produces (adds to contracts): `AlertKind` gains `teams_signin`; the `breakout` alert copy changes (below); `runOccurrence` calls `adapter.ensureLayout` on its 10-second refresh as well as after joining, and pings `teams_signin` instead of `zoom_signin` when a Teams `join` returns `signin_required`.

- [x] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'
import { adapterFor } from '../index'

test('adapterFor picks teams for teams meeting links only', () => {
  expect(adapterFor('https://teams.live.com/meet/9876543210987?p=TESTPASS')?.platform).toBe('teams')
  expect(adapterFor('https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations')).toBeNull()
  expect(adapterFor('https://us02web.zoom.us/j/1234567890?pwd=TESTPASS')?.platform).toBe('zoom')
})
```

```ts
import { expect, test } from '@playwright/test'
import { teamsAdapter } from '../../src/adapters/teams'
import { serveTeams } from './serve'

test('a step that runs past its timeout rejects, naming the step', async ({ page }) => {
  await serveTeams(page, { scene: 'blank' })
  await page.goto('https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0')
  await expect(teamsAdapter.leave(page)).rejects.toThrow('teams leave timed out after 20000 ms')
})
```

```ts
// packages/notify/src/messages.test.ts
test('teams sign-in and breakout copy', () => {
  expect(alertPing('Data Mining', 'teams_signin').message).toBe(
    "Teams asked to sign in, so the bot couldn't join. Sign in to Teams again for this identity."
  )
  expect(alertPing('Data Mining', 'breakout').message).toBe(
    "The meeting opened breakout rooms. The bot never joins one itself, but the organiser's settings may have moved it into one."
  )
})
```

```ts
// packages/worker/src/run.test.ts, with 01a's fakeDeps (give its scripted adapter a platform and a join result if it has no such options yet)
test('a Teams sign-in request pings teams_signin', async () => {
  const d = fakeDeps({
    platform: 'teams',
    join: { kind: 'signin_required', host: 'login.microsoftonline.com' }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'failed',
    reason: 'signin_required'
  })
  expect(d.alerts).toEqual(['teams_signin'])
})

test('the layout is kept on every refresh, not only after joining', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'in_meeting', 'in_meeting', 'ended']
  })
  await runOccurrence(lectureCfg, d)
  expect(d.calls.filter((c) => c === 'ensureLayout').length).toBeGreaterThan(1)
})
```

- [x] **Step 2: Run them to verify they fail**

Run: `bun test packages/worker/src/adapters/teams/index.test.ts packages/worker/src/run.test.ts packages/notify/src/messages.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts test/teams/adapter.spec.ts`
Expected: FAIL: `adapterFor` returns `null` for the Teams link; `teams_signin` is not an `AlertKind`; `ensureLayout` is called once; `../../src/adapters/teams` not found.

- [x] **Step 3: Implement `teamsAdapter`, register it and change the run**

Each method loads `teamsSelectors()` once (on first use) and delegates: `normaliseLink` → `normaliseTeamsLink`; `join` → `joinTeams`; `connectOutputAudio` → `connectTeamsOutputAudio`; `ensureLayout` → `ensureTeamsLayout`; `waitUntilAdmitted` → `waitTeamsAdmitted`; `assertDevicesOff` → `assertTeamsDevicesOff`; `readChat` → `readTeamsChat`; `sweepChat` → `sweepTeamsChat`; `sharedScreenRegion` → `teamsSharedScreenRegion`; `participantCount` → `teamsParticipantCount`; `meetingState` → `teamsMeetingState`; `dismissNotices` → `dismissTeamsNotices`; `leave` → `leaveTeams`. Like 01a's Zoom adapter, it enforces its own timeouts: every method except `normaliseLink` and `waitUntilAdmitted` (bounded by its deadline) races its step against these limits and rejects with `Error('teams <method> timed out after <ms> ms')`; `runOccurrence` then saves the screenshot and `ariaSnapshot()` under `errors/` and pings, as it does for Zoom.

```ts
export const TEAMS_TIMEOUTS = {
  join: 100_000,
  connectOutputAudio: 15_000,
  ensureLayout: 15_000,
  assertDevicesOff: 5_000,
  readChat: 20_000,
  sweepChat: 120_000,
  sharedScreenRegion: 5_000,
  participantCount: 5_000,
  meetingState: 5_000,
  dismissNotices: 5_000,
  leave: 20_000
} as const
```

`adapterFor` tries the Zoom adapter, then `teamsAdapter`, and returns the first whose `normaliseLink` isn't null. In `run.ts`, step 5 pings `teams_signin` (with plan 01c's "Sign in again" action, as for `zoom_signin`) when the adapter's platform is `teams`, and step 8 calls `ensureLayout` with each 10-second refresh of `sharedScreenRegion` and `participantCount` (harmless for Zoom, whose `ensureLayout` only reopens a closed chat). In `messages.ts`, add `teams_signin` with the copy in the test, and replace the `breakout` copy with the one in the test, because Teams can move participants into a room without asking.

- [x] **Step 4: Run them to verify they pass**

Run: the commands of Step 2
Expected: PASS, including 01a's existing `run.test.ts` and `messages.test.ts` cases.

- [x] **Step 5: Run the whole worker suite and the type check**

Run: `bun test packages/worker packages/notify` then `bunx playwright test -c packages/worker/playwright.config.ts` then `bun run typecheck`
Expected: all pass; `tsc` reports no errors.

- [x] **Step 6: Commit**

```bash
git add packages/worker/src/adapters packages/worker/src/run.ts packages/worker/src/run.test.ts packages/notify/src packages/worker/test/teams/adapter.spec.ts docs/TRD.md
git commit -m "feat(worker): register the teams adapter"
```

### Task 9: Teams chat link watcher

**Files:**

- Test: `packages/core/test/teams-link.test.ts` (done in Task 2: `normaliseTeamsChatUrl` lives in `core/src/teams-link.ts`, so there is no `teams-chat.ts`)
- Modify: `packages/web/lib/timetable.ts` (01c's `ChatLinkSchema`: Teams chats by link, stored normalised; plan 02's Teams refusal removed), `packages/web/test/timetable.test.ts` (plan 02's "Teams waits for plan 04" case)
- Create: `packages/worker/test/fixtures/teams/chat.html`
- Modify: plan 02's `packages/worker/test/watchers/serve.ts` (a `teams` fixture)
- Create: `packages/worker/src/watchers/teams.ts`
- Modify: plan 02's `packages/worker/src/watchers/index.ts` and `packages/worker/src/watchers/index.test.ts` (`watcherFor('teams')`)
- Test: `packages/worker/test/watchers/teams.spec.ts`

**Split:** Task 9a (web side: Steps 1 to 4 for `timetable.ts`, `FixedLinkSchema` and `maskedLink` via core `normaliseMeetingLink`) is done; Task 9b (the watcher: Steps 5 to 10) comes later. Any website UI for the Teams chat field is Task 10 and stays behind the Figma gate.

**Interfaces:**

- Consumes: `TeamsSelectors`, `teamsSelectors()` (Task 1); `parseTeamsMessages`, `toTeamsChatMessages`, `FixtureMessage` (Tasks 4 and 6); `teamsClicks` (Task 3); `adapterFor` with Teams registered (Task 8), which is how plan 02's loop recognises Teams meeting links; `LinkSource`, `FormCandidate`, `ChatMessage` from `@tm/core`; from plan 02, `ChatSourceReader`, `runChatWatcher`, `WatcherSigninError`, `WatcherChatError`, `resetWatcherEnv` (Task 3), `serveWatcherFixtures` and `watchHarness` (Task 4), `watcherFor` (Task 6) and its Teams refusal in `ChatLinkSchema` (Task 7).
- Produces:
  - `normaliseTeamsChatUrl(url: string): string | null` in `packages/core/src/teams-link.ts` (adds to contracts): `https://<host>/l/chat/<enc(dec(thread))>/conversations` for a chat or group-chat link on `teams.microsoft.com` or `teams.live.com`, unwrapping one Safe Links level; `null` for anything else.
  - `teamsChatReader(chatUrl: string, sel: TeamsSelectors): ChatSourceReader` and `startWatcher(desk: Page, src: LinkSource, onLink: (c: FormCandidate | { meetingUrl: string }) => void): Promise<Stopper>` in `packages/worker/src/watchers/teams.ts`; `watcherFor('teams')` returns this `startWatcher`.
  - `TeamsChatFixture { chatUrl: string; launcher?: boolean; loginRequired?: boolean; scroll?: 'top' | 'bottom'; messages: FixtureMessage[] }`, accepted as `serveWatcherFixtures(context, { teams })`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// packages/core/src/teams-chat.test.ts
import { expect, test } from 'bun:test'
import { normaliseTeamsChatUrl } from './teams-chat'

const CHAT = 'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'

test.each([
  [CHAT, CHAT],
  [`${CHAT}?context=%7B%22contextType%22%3A%22chat%22%7D`, CHAT],
  ['https://teams.microsoft.com/l/chat/19%3aTESTCHAT%40thread.v2/conversations', CHAT],
  [`https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(CHAT)}&data=TESTDATA`, CHAT],
  [
    'https://teams.live.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations',
    'https://teams.live.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'
  ]
])('normalises %s', (input, expected) => {
  expect(normaliseTeamsChatUrl(input)).toBe(expected)
})

test.each([
  'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0',
  'https://teams.microsoft.com/l/channel/19%3ATESTCHANNEL%40thread.tacv2/General',
  'MSc class group',
  'https://discord.com/channels/1/2'
])('rejects %s', (input) => {
  expect(normaliseTeamsChatUrl(input)).toBeNull()
})
```

In `packages/web/lib/timetable.test.ts`, replace plan 02's Teams refusal assertion with:

```ts
test('a Teams chat must be given by its link, and is stored normalised', () => {
  const chat = 'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'
  const byName = EntryInputSchema.safeParse({
    ...base,
    identityId: ID,
    link: { kind: 'chat', app: 'teams', chat: 'MSc class group' }
  })
  expect(byName.error?.issues[0].message).toBe(
    "Paste the chat's link from Teams (open the chat, then More options, then Copy link)."
  )
  expect(
    EntryInputSchema.parse({
      ...base,
      identityId: ID,
      link: { kind: 'chat', app: 'teams', chat: `${chat}?context=x` }
    }).link
  ).toEqual({ kind: 'chat', app: 'teams', chat })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/core/test/teams-link.test.ts packages/web/test/timetable.test.ts`
Expected: FAIL, module `./teams-chat` not found, and the Teams entry is still refused with "Watching a Teams chat arrives with Teams support."

- [ ] **Step 3: Implement `normaliseTeamsChatUrl` and accept Teams chats**

Unwrap one Safe Links level by its `url` parameter (core can't import the worker's `unwrapLink`), then parse and canonicalise as `normaliseTeamsLink` does (Task 2), accepting only `/l/chat/<thread>/conversations`. In `ChatLinkSchema`, the `app: 'teams'` case transforms `chat` through `normaliseTeamsChatUrl` and fails with the message in the test when that returns `null`; remove plan 02's Teams refusal. WhatsApp and Discord are untouched, and `chatWatchAllowed` already allows Teams everywhere.

- [ ] **Step 4: Run them to verify they pass**

Run: `bun test packages/core/test/teams-link.test.ts packages/web/test/timetable.test.ts`
Expected: PASS (9 new core cases; the timetable tests, with the replaced Teams case).

- [x] **Step 5: Build the chat fixture**

`chat.html` imitates a Teams chat page at a `/l/chat/` URL, using the meeting chat's item markup (Task 4) inside `[data-tid='message-pane-list-viewport']`. With `launcher` it first shows the launcher from `app.html`. It renders the newest 20 messages and, each time the list is scrolled to the top, loads the next 20 older ones after 500 ms, as Teams does; `window.__addMessage(m)` appends one. It has a compose box `[data-tid='ckeditor']` (`contenteditable`), a "Send" button and a "React" button on every message; focusing or typing in the compose box, or clicking "Send" or "React", sets `window.__touched = true`. In `serveWatcherFixtures`, `teams` routes `chatUrl` to `chat.html` (or, with `loginRequired`, a 302 to `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`, served by Task 3's `signin.html`).

- [x] **Step 6: Write the failing browser tests**

```ts
// packages/worker/test/watchers/teams.spec.ts
// test.use({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' }); beforeEach: resetWatcherEnv(). ago(h) is an ISO time h hours before now.
const CHAT = 'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'
const MEETING =
  'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0?context=%7B%22Tid%22%3A%22TENANT%22%7D'
const filler = Array.from({ length: 40 }, (_, i) => ({
  id: `w${i}`,
  sender: 'Classmate',
  time: '',
  datetime: ago(22 - i * 0.45),
  text: `note ${i}`
}))
const messages = [
  {
    id: 'old',
    sender: 'Rep',
    time: '',
    datetime: ago(30),
    text: 'Last week',
    href: 'https://teams.live.com/meet/9876543210987?p=TESTPASS'
  },
  ...filler,
  {
    id: 'a',
    sender: 'Rep',
    time: '',
    datetime: ago(3),
    text: 'Zoom today',
    href: 'https://example.zoom.us/j/00000000001?pwd=PASSCODE'
  },
  {
    id: 'b',
    sender: 'Rep',
    time: '',
    datetime: ago(1),
    text: 'Moved to Teams',
    href: MEETING
  }
]

test('the 24-hour scan goes through the launcher and reports only the newest meeting link, read-only', async ({
  context,
  page
}) => {
  await serveWatcherFixtures(context, {
    teams: { chatUrl: CHAT, launcher: true, messages }
  })
  const h = watchHarness()
  const stop = await startWatcher(page, { kind: 'chat', app: 'teams', chat: CHAT }, h.onLink)
  await h.polls(2)
  await stop()
  expect(h.meeting).toEqual([{ meetingUrl: MEETING }])
  expect(h.forms).toEqual([])
  expect(await teamsClicks(page)).toEqual(['Continue on this browser'])
  expect(await page.evaluate(() => (window as any).__touched ?? false)).toBe(false)
})

test('during the meeting form links come with their sender', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    teams: { chatUrl: CHAT, messages, scroll: 'top' }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'teams', chat: CHAT }, h.onLink)
  h.set({
    phase: () => 'during',
    formsSince: () => new Date(Date.now() - 600_000)
  })
  await page.evaluate(
    (t) =>
      (window as any).__addMessage({
        id: 'f',
        sender: 'Lecturer',
        time: '',
        datetime: t,
        text: 'Attendance',
        href: 'https://forms.office.com/r/TESTFORM'
      }),
    new Date().toISOString()
  )
  await h.polls(1)
  expect(h.forms.map((c) => [c.url, c.source, c.sender])).toEqual([
    ['https://forms.office.com/r/TESTFORM', 'watched_chat', 'Lecturer']
  ])
})

test('history reaches back 24 hours through lazily loaded batches', async ({ context, page }) => {
  const hourly = Array.from({ length: 70 }, (_, i) => ({
    id: `h${i}`,
    sender: 'Classmate',
    time: '',
    datetime: ago(70.5 - i),
    text: `note ${i}`
  }))
  await serveWatcherFixtures(context, {
    teams: { chatUrl: CHAT, messages: hourly }
  })
  const reader = teamsChatReader(CHAT, await teamsSelectors())
  await reader.open(page)
  expect((await reader.history(page, new Date(Date.now() - 24 * 3_600_000))).map((m) => m.key)).toEqual(
    hourly.slice(47).map((m) => m.id)
  )
})

test('a signed-out profile rejects the start with the sign-in host', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    teams: { chatUrl: CHAT, messages, loginRequired: true }
  })
  const e = await startWatcher(page, { kind: 'chat', app: 'teams', chat: CHAT }, () => {}).catch((x) => x)
  expect([e instanceof WatcherSigninError, e.host]).toEqual([true, 'login.microsoftonline.com'])
})
```

In plan 02's `packages/worker/src/watchers/index.test.ts`, the Teams line becomes `expect(watcherFor('teams')).toBe(teams.startWatcher);`.

- [x] **Step 7: Run them to verify they fail**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/watchers/teams.spec.ts` and `bun test packages/worker/src/watchers/index.test.ts`
Expected: FAIL, cannot resolve `../../src/watchers/teams`; `watcherFor('teams')` is still `null`.

- [x] **Step 8: Implement `teamsChatReader` and `startWatcher`, and register the watcher**

Like plan 02's Discord reader, it reads in one `page.evaluate` per read and never clicks or types, except the launcher's "Continue on this browser":

- `open(desk)`: go to `chatUrl` unless the desk is already there; click `launcherWebJoin` if it appears; wait up to 60 seconds for `chatScroller`. A host in `signInHosts` throws `WatcherSigninError(host)`; no list within 60 seconds throws `WatcherChatError('not_loaded')`.
- `history(desk, since)`: scroll `chatScroller` up in steps of `max(200, clientHeight / 2)` px with a random 300 to 350 ms pause, parsing with `parseTeamsMessages` at each step, until the oldest parsed `datetime` is before `since`, or the list is at the top and no older items appear within 2 seconds, or 300 steps pass; scroll back to the bottom; return `toTeamsChatMessages(all, { roles: null, cutoffMs: since.getTime(), seenAt })`, de-duplicated by key, oldest first.
- `latest(desk)`: a sign-in host throws `WatcherSigninError(host)`; a missing `chatScroller` throws `WatcherChatError('lost')`; otherwise follow plan 02's spike 2 rule (`desk.bringToFront()` first when background tabs don't stay live), scroll `chatScroller` to the bottom, parse and map with `cutoffMs: null`.
- `startWatcher` accepts only `{ kind: 'chat', app: 'teams' }` (else a `TypeError`), normalises `chat` with `normaliseTeamsChatUrl` (null throws `WatcherChatError('not_found')`) and returns `runChatWatcher(desk, teamsChatReader(url, await teamsSelectors()), onLink)`. The 24-hour scan, poll intervals, newest-link rule, pasted-link override and form candidates are plan 02's loop, unchanged.
- `watcherFor('teams')` returns this `startWatcher`.

- [x] **Step 9: Run them to verify they pass**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/watchers/teams.spec.ts` and `bun test packages/worker/src/watchers/index.test.ts`
Expected: PASS (4 browser tests; the `watcherFor` test).

- [x] **Step 10: Commit**

```bash
git add packages/web/lib/timetable.ts packages/web/test/timetable.test.ts packages/worker/test/fixtures/teams/chat.html packages/worker/test/watchers packages/worker/src/watchers docs/TRD.md
git commit -m "feat(worker): watch a teams chat for links"
```

### Task 10: Teams on the website: chat option and presence note

**Files:**

- Modify: plan 02's `packages/web/lib/link-notices.ts` and `packages/web/lib/link-notices.test.ts`
- Create: `packages/web/app/timetable/teams-presence-note.tsx`
- Test: `packages/web/app/timetable/teams-presence-note.test.tsx`
- Modify: the entry edit page `packages/web/app/timetable/[id]/page.tsx` (plans 01c and 02) and the Accounts page `packages/web/app/accounts/page.tsx` (plan 01c)

**Interfaces:**

- Consumes: `LinkSource` from `@tm/core`; `ChatApp`, `WatchGate` (plan 02, Task 1); `CHAT_FIELD_COPY`, `chatAppOptions`, `BanRiskNotice` (plan 02, Task 7); `accountStatus` rows (kind `teams`, label `Teams`) from plan 01c's `packages/web/lib/identities.ts`.
- Produces (adds to contracts): in `packages/web/lib/link-notices.ts`, `TEAMS_PRESENCE_NOTE: string` and `showsTeamsPresenceNote(link: LinkSource): boolean`; `CHAT_FIELD_COPY` keyed by every `ChatApp`, with a `teams` entry; `chatAppOptions` returning a `teams` option (its `app` typed `ChatApp`); `TeamsPresenceNote(): JSX.Element` in `packages/web/app/timetable/teams-presence-note.tsx`.

- [x] **Step 1: Write the failing tests**

```ts
// added to packages/web/lib/link-notices.test.ts
test.each([
  [
    {
      kind: 'fixed',
      url: 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
    },
    true
  ],
  [
    {
      kind: 'fixed',
      url: 'https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.live.com%2Fmeet%2F9876543210987'
    },
    true
  ],
  [
    {
      kind: 'chat',
      app: 'teams',
      chat: 'https://teams.microsoft.com/l/chat/19%3ATESTCHAT%40thread.v2/conversations'
    },
    true
  ],
  [{ kind: 'fixed', url: 'https://example.zoom.us/j/00000000000' }, false],
  [
    {
      kind: 'chat',
      app: 'discord',
      chat: 'https://discord.com/channels/123456789012345678/234567890123456789'
    },
    false
  ],
  [{ kind: 'paste' }, false]
] as const)('presence note for %o is %s', (link, shown) => {
  expect(showsTeamsPresenceNote(link)).toBe(shown)
})

test('Teams is offered as a chat app everywhere, with its own field copy', () => {
  const gate = { whatsapp: 'none', discord: 'home_only' } as const
  expect(chatAppOptions('server', gate).find((o) => o.app === 'teams')).toEqual({
    app: 'teams',
    enabled: true,
    note: null
  })
  expect(CHAT_FIELD_COPY.teams).toEqual({
    label: 'Teams chat link',
    placeholder: 'https://teams.microsoft.com/l/chat/...',
    hint: 'Open the chat in Teams, choose More options, then Copy link, and paste it here.'
  })
  expect(TEAMS_PRESENCE_NOTE).toBe(
    'While the bot is in a Teams meeting for you, your Teams presence shows "In a call", and your own Teams apps may show the call as running on another device.'
  )
})
```

```tsx
// packages/web/app/timetable/teams-presence-note.test.tsx
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TEAMS_PRESENCE_NOTE } from '../../lib/link-notices'
import { TeamsPresenceNote } from './teams-presence-note'

test('renders the presence note as a note', () => {
  expect(renderToStaticMarkup(<TeamsPresenceNote />)).toBe(
    `<p role="note">${TEAMS_PRESENCE_NOTE.replaceAll('"', '&quot;')}</p>`
  )
})
```

- [ ] **Step 2: Run them to verify they fail**

  Not done: the lib code was written before this run, so no failing run was captured.

Run: `bun test packages/web/lib/link-notices.test.ts packages/web/app/timetable/teams-presence-note.test.tsx`
Expected: FAIL, `showsTeamsPresenceNote` is not exported and `./teams-presence-note` is not found.

- [x] **Step 3: Implement the copy, the option and the note, and show them**

  Lib part done (`link-notices.ts`: `TEAMS_PRESENCE_NOTE`, `showsTeamsPresenceNote` via core `normaliseTeamsLink`, `CHAT_FIELD_COPY` keyed by `ChatApp`, Teams option). Plan 02's existing `chatAppOptions` expectations now include the Teams option. **Deferred (Figma gate):** `packages/web/app/timetable/teams-presence-note.tsx` and its `.test.tsx`, and showing the note and the Teams field on `app/timetable/[id]/page.tsx` and `app/accounts/page.tsx`. No page exists yet (see preflight section 4).

`showsTeamsPresenceNote` is true for a `fixed` link whose `decodeURIComponent`-decoded URL contains `teams.microsoft.com` or `teams.live.com`, and for a `chat` source with `app: 'teams'`. `chatAppOptions` appends `{ app: 'teams', enabled: true, note: null }`, because Teams watching isn't gated (plan 02's `chatWatchAllowed`). `TeamsPresenceNote` mirrors `BanRiskNotice`. On the entry edit page, the Teams chat option uses `CHAT_FIELD_COPY.teams`, and `<TeamsPresenceNote />` shows under the link source whenever `showsTeamsPresenceNote` holds for the link being edited; the ban-risk notice stays off for Teams. On the Accounts page, the note shows in every identity's `Teams` status row.

- [x] **Step 4: Run them to verify they pass**

  Lib part: `link-notices.test.ts` and `timetable.test.ts` pass (38 tests), web `tsc` clean. The `.tsx` test is deferred with Step 3.

Run: `bun test packages/web/lib/link-notices.test.ts packages/web/app/timetable/teams-presence-note.test.tsx` then `bun run typecheck`
Expected: PASS (the 8 new tests and plan 02's existing ones); `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/link-notices.ts packages/web/lib/link-notices.test.ts packages/web/app/timetable packages/web/app/accounts docs/TRD.md
git commit -m "feat(web): offer teams chats and presence note"
```

### Task 11: Monthly smoke test entry

No earlier plan builds the design's monthly smoke test, so this task builds its runner with entries for Zoom and Teams. If plan 05 has already landed, the runner, the CLI mode, the crontab and the Zoom entry exist; only add the Teams entry and its tests.

**Files:**

- Create (unless plan 05 created them): `packages/worker/src/smoke/entries.ts`, `packages/worker/src/smoke/run.ts`, `packages/worker/src/smoke/zoom.ts`, `docker/worker/smoke.crontab`
- Create: `packages/worker/src/smoke/teams.ts`
- Modify: plan 01a's `packages/worker/src/cli.ts` (a `--smoke` mode) and `docker/worker/run-job.sh` (a `smoke` mode)
- Test: `packages/worker/src/smoke/entries.test.ts`, `packages/worker/test/teams/smoke.spec.ts`

**Interfaces:**

- Consumes: `TeamsSelectorsSchema`, `teamsSelectors()` (Task 1); `teamsAdapter` and `adapterFor` (Task 8); `serveTeams` (Task 3); from plan 01a, `loadSelectors` and `ZoomSelectorsSchema` (Task 13), the `--seed` mode of `cli.ts` and `run-job.sh` (Task 18), `alertPing` (Task 3).
- Produces (adds to contracts), in `packages/worker/src/smoke/`:
  - `interface SmokeEntry { platform: Platform; selectors(): Promise<{ selectors: Record<string, string> }>; checkpoints: { inMeeting: string[]; afterLayout: string[]; afterSweep: string[]; afterLeave: string[] } }` and `SMOKE_ENTRIES: SmokeEntry[]` in `entries.ts`; `zoomSmoke` in `zoom.ts`; `teamsSmoke` in `teams.ts`.
  - `runSmokeEntry(page: Page, entry: SmokeEntry, url: string): Promise<{ missing: string[] }>` in `run.ts`.
  - CLI `tm-worker --smoke --job <path>` and `run-job.sh <job> smoke`, where the job's fixed link is the platform's standing test meeting; exit code 0 when nothing is missing, 1 otherwise.

- [x] **Step 1: Write the failing tests**

```ts
// packages/worker/src/smoke/entries.test.ts
import { expect, test } from 'bun:test'
import { TeamsSelectorsSchema } from '../adapters/teams/selectors'
import { SMOKE_ENTRIES } from './entries'
import { teamsSmoke } from './teams'

test('the teams smoke entry is registered and checks only real selector keys', () => {
  expect(SMOKE_ENTRIES.map((e) => e.platform)).toEqual(expect.arrayContaining(['zoom', 'teams']))
  for (const key of Object.values(teamsSmoke.checkpoints).flat()) {
    expect(Object.keys(TeamsSelectorsSchema.shape.selectors.shape)).toContain(key)
  }
})
```

```ts
// packages/worker/test/teams/smoke.spec.ts
import { expect, test } from '@playwright/test'
import { runSmokeEntry } from '../../src/smoke/run'
import { teamsSmoke } from '../../src/smoke/teams'
import { serveTeams } from './serve'

const URL = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_TESTTHREAD%40thread.v2/0'
const cfg = {
  scene: 'prejoin',
  mic: 'off',
  camera: 'off',
  audio: 'computer',
  chatOpen: false,
  roster: [{ name: 'Member' }],
  messages: [
    {
      id: 's1',
      sender: 'Host',
      time: '09:00',
      datetime: new Date().toISOString(),
      text: 'smoke'
    }
  ]
} as const

test('passes on the full imitation', async ({ page }) => {
  await serveTeams(page, cfg)
  expect(await runSmokeEntry(page, teamsSmoke, URL)).toEqual({ missing: [] })
})

test('fails loudly, naming the key, when the roster button is gone', async ({ page }) => {
  await serveTeams(page, { ...cfg, omit: ['#roster-button'] })
  expect((await runSmokeEntry(page, teamsSmoke, URL)).missing).toContain('rosterButton')
})
```

- [x] **Step 2: Run them to verify they fail**

Run: `bun test packages/worker/src/smoke/entries.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts test/teams/smoke.spec.ts`
Expected: FAIL, modules `./entries` and `../../src/smoke/run` not found.

- [x] **Step 3: Build the runner, the entries and the monthly run**

Add `TeamsFixtureConfig.omit: string[]` (selectors whose elements the fixture leaves out). `runSmokeEntry` opens `adapterFor(url).normaliseLink(url)`, calls `join` (no guest name) and, on `lobby`, `waitUntilAdmitted` for at most 2 minutes; then it checks `inMeeting`, runs `assertDevicesOff`, `connectOutputAudio` and `ensureLayout`, checks `afterLayout`, runs `readChat`, `sweepChat`, `participantCount` and `meetingState` (which must be `in_meeting`), checks `afterSweep`, runs `leave` and checks `afterLeave`. A key is missing when its selector from `entry.selectors()` matches no element in any frame of the page (a Playwright locator, so `zoom.json`'s `text=` and `:text-matches` selectors work); a step that throws or gives an unexpected result adds `step:<name>`; the run goes on after a failure so that one report lists everything. The entries:

```ts
export const zoomSmoke: SmokeEntry = {
  platform: 'zoom',
  selectors: () => loadSelectors('zoom', ZoomSelectorsSchema),
  checkpoints: {
    inMeeting: ['leaveButton', 'audioButton', 'videoButton', 'participantsButton'],
    afterLayout: ['chatList'],
    afterSweep: ['chatList'],
    afterLeave: []
  }
}
export const teamsSmoke: SmokeEntry = {
  platform: 'teams',
  selectors: teamsSelectors,
  checkpoints: {
    inMeeting: [
      'hangupButton',
      'micButton',
      'micOff',
      'cameraButton',
      'cameraOff',
      'chatButton',
      'rosterButton',
      'viewButton',
      'moreButton'
    ],
    afterLayout: ['chatPane', 'chatScroller', 'chatItem', 'chatMessage', 'chatAuthor', 'chatTime', 'chatBody'],
    afterSweep: ['chatPane'],
    afterLeave: ['endScreen']
  }
}
```

`tm-worker --smoke --job <path>` prepares and launches the job's profile as `--seed` does, runs the entry for the platform of `entry.link.url` on the stage, prints the missing keys, and when any are missing sends `alertPing('Smoke test: <platform>', 'join_failed', 'missing ' + missing.join(', '))` to the job's ntfy topic and exits 1. `docker/worker/smoke.crontab` runs `run-job.sh <job> smoke` at 03:00 on the 1st of each month for each platform's smoke job (one line per platform, job paths as placeholders). The Teams test meeting is a standing meeting organised by the TolongLabs test account, with "Who can bypass the lobby" set to everyone and one message posted in its chat (Teams keeps meeting chat, so the chat checkpoints always have an item to find).

- [x] **Step 4: Run them to verify they pass**

Run: `bun test packages/worker/src/smoke/entries.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts test/teams/smoke.spec.ts`
Expected: PASS (1 and 2 tests).

- [x] **Step 5: Commit**

```bash
git add packages/worker/src/smoke packages/worker/src/cli.ts docker/worker packages/worker/test/teams docs/TRD.md
git commit -m "test(worker): add teams monthly smoke entry"
```

### Task 12: Milestone acceptance

Manual verification on real Teams meetings, mapped to the PRD's [acceptance tests](../PRD.md#acceptance-tests) and to spike 2's open question. Record each result (date, pass or fail, evidence path) in this task.

**Files:**

- Modify: `config/selectors/teams.json`, the Teams fixtures and tests, only where reality differs
- Modify: spike 2's `REPORT.md` (bot labelling), and the design's "Platform realities" Teams line if Teams labels the bot

**Interfaces:**

- Consumes: the deployed stack from plan 01c with plans 01b and 02 in place; the worker image with spike 2's pinned versions; the member's "University" identity signed in to Teams through the remote view; a Microsoft 365 "host account" that can organise Teams meetings with lobby and breakout-room options; a "classmate account"; plan 01b's test forms (an attendance Microsoft Form, an attendance Google Form, and a non-attendance form asking only for name and ID); the member's phone subscribed to their ntfy topic.

- [ ] **Step 1: Selector check**

Run `docker/worker/run-job.sh <teams-smoke-job> smoke` (Task 11) on the server against the standing Teams test meeting, then install `docker/worker/smoke.crontab`. Pass: exit code 0 and no missing keys. Where a selector or text differs, correct `teams.json`, the fixtures and the tests in one commit, then rerun the suites of Tasks 1 to 11.

- [ ] **Step 2: Bot labelling (spike 2)**

The host account schedules a meeting with "Who can bypass the lobby" set to "Only me", and a lecture entry uses its link. While the bot waits, the host screenshots the lobby notification and the "Waiting in lobby" list; after admitting, the bot's roster entry. Pass: the host admits the bot with the normal "Admit" button. Record in spike 2's `REPORT.md` whether Teams shows a bot, "Unverified", "External" or "potential threat" label, or a separate approval step, for the signed-in browser; if it does, update the design's Teams line in "Platform realities" in the same commit.

- [ ] **Step 3: Lobby outcomes**

Three runs against that meeting: the host admits; the host denies; the host leaves the request until Teams times it out. Pass: a "joined" ping with the participant count within 30 seconds of admission; a denial ping and the worker stopping; after the time-out, at most 2 further knocks in the event log and no wait beyond the scheduled end plus 30 minutes.

- [ ] **Step 4: Silence in the meeting**

A 90-minute meeting. Every 15 minutes the host screenshots the bot's roster entry. Pass (design test "Silence in the meeting"): every screenshot shows the microphone muted and the camera off; nothing from the member appears in the meeting chat or as a reaction; the event log shows no click outside join, layout, allowlisted notices and leave; the recording holds only the stage and has meeting audio wherever someone spoke.

- [ ] **Step 5: Chat, roles and forms**

In a lecture entry's meeting: the classmate posts an attendance-looking Microsoft Form link; the host joins 5 minutes after the bot and posts the attendance Microsoft Form link; later the host shares a slide with a QR code to the attendance Google Form while the bot's chat panel is open; the next week's occurrence of the same recurring meeting starts with those links still in the chat. Pass (design tests "Form fixture" and "Unsafe form", Teams variant): the classmate's form gets a "form seen, not submitted" ping within 30 seconds and no submission; both of the host's forms are submitted within 2 minutes with pings; `chat.jsonl` shows the host's message with `senderRole` `host`; the kept frames show the share large with the chat open; the second occurrence handles none of last week's links.

- [ ] **Step 6: Breakout rooms**

The host creates two rooms, assigns the member, and opens them once with "Automatically move people to rooms" off and once with it on. Pass: both lead to a high-priority breakout ping; the event log shows no click on "Join room" or "Return"; with automatic moves off, the bot stays in the main meeting.

- [ ] **Step 7: End, leave and crash**

The host ends a meeting with "End meeting"; in another, the member presses "Make the bot leave"; in a third, the worker container is killed 20 minutes in, after a form was submitted. Pass (design tests "End" and "Crash"): recording stops within 60 seconds of the end and the summary arrives within 10 minutes (live mode); the bot leaves with "Leave" and the meeting carries on for the others; after the kill, the bot rejoins within 2 minutes from the latest checkpoint, the recording has only a short gap, the form isn't submitted again, and a ping arrives.

- [ ] **Step 8: Teams chat watcher**

A lecture entry whose link source is a Teams group chat holding the host, the classmate and the member. The host posts a Zoom link 3 hours before the start and the real Teams meeting link 30 minutes before it; during the meeting the host, named in the entry's trusted senders, posts the attendance Microsoft Form in the group chat. Pass: the 24-hour scan at T-60 finds the first link; the bot switches to the newer Teams link and joins it; the form is handled with the host as sender; the classmate sees no message, reaction or typing from the member; the desk chat tab and the stage meeting run side by side without Teams complaining about another tab.

- [ ] **Step 9: Presence, the note and a Teams free link**

During step 4 the member checks Teams on their own phone; separately, the host account (or any personal Microsoft account) hosts a teams.live.com meeting and an entry uses its link. Pass: the member's presence shows "In a call"; the website shows the note on the Teams entry and on the Accounts page; the teams.live.com meeting is either joined as the member or ends in a "sign in again" ping naming its host, never in a guest join.

- [ ] **Step 10: Commit the corrections**

```bash
git add config/selectors/teams.json packages/worker/test docs
git commit -m "fix(worker): align teams selectors with live UI"
```
