# Google Meet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attend Google Meet meetings on meet.google.com signed in as the member, behind the same `PlatformAdapter` contract as Zoom.

**Architecture:** A `meetAdapter` in `packages/worker/src/adapters/meet/` implements every `PlatformAdapter` method from the architecture page. It reads selectors and text signals from `config/selectors/meet.json` through plan 01a's `loadSelectors`, enforces its own step timeouts as 01a's Zoom adapter does (01a's `runOccurrence` captures the failures), and keeps per-page state (sender roles, layout) in a `WeakMap<Page, ...>`. Meet shows chat and the participant list in one side panel, so the adapter keeps chat open, reads the participant count from the People button's badge, and opens the participant list only briefly to learn who the host and co-hosts are. Behaviour is tested against one configurable imitation of the Meet web client in `packages/worker/test/fixtures/meet/`; what only real meetings can prove sits in the final acceptance task. This plan depends only on 01c, not on the Teams plan, so it shares no Teams code; only the specification of the smoke-test runner lives in plan 04, and this plan builds it if it lands first.

**Tech Stack:** TypeScript (strict), Playwright on Node 24 driving the pinned Chrome, Playwright Test, `bun test`, zod.

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Contract additions](#contract-additions)
1.  [Tasks](#tasks)
    1.  [Task 1: Meet selector map](#task-1-meet-selector-map)
    1.  [Task 2: Link normalisation](#task-2-link-normalisation)
    1.  [Task 3: Pre-join and join](#task-3-pre-join-and-join)
    1.  [Task 4: Admission and meeting state](#task-4-admission-and-meeting-state)
    1.  [Task 5: Devices, notices, audio output and leave](#task-5-devices-notices-audio-output-and-leave)
    1.  [Task 6: Chat with sender roles in the shared side panel](#task-6-chat-with-sender-roles-in-the-shared-side-panel)
    1.  [Task 7: Layout, captions, participant count and shared screen](#task-7-layout-captions-participant-count-and-shared-screen)
    1.  [Task 8: Adapter assembly, registration and run changes](#task-8-adapter-assembly-registration-and-run-changes)
    1.  [Task 9: Monthly smoke test entry](#task-9-monthly-smoke-test-entry)
    1.  [Task 10: Milestone acceptance](#task-10-milestone-acceptance)

## Global Constraints

- Join meet.google.com signed in as the member with the identity's profile. Meet never joins as a guest (the guest fallback is Zoom's only, decision 28), so `join` ignores `opts.guestName` and never returns `account_busy`.
- Turn microphone and camera off on the pre-join screen, then "Join now", or "Ask to join" if the member isn't trusted by the meeting's organisation. A pre-join device toggle may be clicked only to turn a device off; in the meeting the worker never clicks microphone, camera, chat input, reactions, share or record controls.
- Joining and leaving are the only visible actions (anti-goal 4). Breakout prompts are never accepted and trigger a ping. The bot never admits anyone or ends the call for everyone, even when the member is the host.
- Captions are not used: the transcript comes from the recording (live or native mode), and the bot never turns captions on.
- Notices are acknowledged only through the allowlist of button texts in `config/selectors/meet.json`, and each click is logged.
- `waitUntilAdmitted` waits until the scheduled end plus 30 minutes at most; `lobby_expired` allows at most 2 further knocks; `lobby_denied` stops and pings. Meet's review queue for guests defaults to deny, and a denial there is `lobby_denied`.
- Chat is read continuously, with full sweeps every 10 minutes, and a cursor advances only after a durable write (CHAT-03). `participantCount` never closes the chat panel.
- Every adapter step has a timeout; on failure plan 01a's `runOccurrence` saves a screenshot and the page's accessibility tree, and the member is pinged.
- Selectors live in `config/selectors/meet.json`, loaded at start from `TM_SELECTORS_DIR` (default `/app/config/selectors`), so a UI change is fixed without rebuilding. The Meet fixtures mirror the map and change in the same commit.
- Meet blocks browsers that report automation; the adapter relies on 01a's Chrome launch settings and never changes them.
- A monthly smoke test joins each platform's test meeting and fails loudly if a selector is missing.

## Review Focus

1.  Calendar invitations wrap Meet links in Google redirect links or add `authuser` and other parameters, and Outlook mail wraps them in Safe Links. Every one of these should join the same meeting (test in Task 2).
1.  A profile whose Google session has expired can still open Meet, which then shows the anonymous pre-join with a name box. The member expects a "sign in again" ping, not a guest knock under a typed name (test in Task 3).
1.  Meet refuses browsers it takes for automation with "You can't join this video call". The member expects an immediate failure with a screenshot and ping, not a wait in a lobby until the deadline (test in Task 3).
1.  When the member is already in the same call on another device, the pre-join offers "Switch here", which would drop the member's own session. The bot must choose "Join here too" (test in Task 3).
1.  The member's own caption preference persists in the profile, so captions may come on by themselves and cover the bottom of slides, where QR codes often sit. The bot should turn them off (test in Task 7).

## Contract additions

Names this plan adds to [architecture and contracts](../TRD.md), copied there in the commit of the task that creates them:

- **Selector map**: `config/selectors/meet.json` and `MeetSelectorsSchema` (Task 1), in the layout of 01a's `zoom.json`.
- **Worker**: `meetAdapter`, `MEET_TIMEOUTS` and the modules under `packages/worker/src/adapters/meet/` (Tasks 1 to 8).
- **Run and pings** (Task 8): `AlertKind` gains `meet_signin`; `runOccurrence` calls `ensureLayout` on its 10-second refresh (also made by plan 04), and pings `meet_signin` when a Meet join needs a sign-in.
- **Smoke test** (Task 9): `meetSmoke`, plus the runner from plan 04's Task 11 if this plan lands first.

Names used from earlier plans:

- **Plan 01a**: `loadSelectors<T>(platform: Platform, schema: z.ZodType<T>): Promise<T>` and `DevicesOnError { labels: string[] }` (Task 13, with `DevicesOnError` imported from `packages/worker/src/adapters/types.ts`); `unwrapLink` and `extractLinks` (Task 12); `startChatCapture` (Task 15), which writes chat to disk before adopting the cursor and sweeps every 10 minutes; `runOccurrence` (Task 18), which opens the normalised link with `stage.goto` before `join`, reloads and joins again after `lobby_expired` (at most 2 more times), pings `breakout` once per prompt, treats `unknown` for 30 seconds as a drop, logs each dismissed notice as a `notice_dismissed` event, and saves the screenshot and `ariaSnapshot()` under `errors/` when a step fails or times out; `alertPing` and `AlertKind` (Task 3); the Playwright `fixtures` project (Task 7), which must point `TM_SELECTORS_DIR` at the repository's `config/selectors`, as the Zoom specs also need.
- **Plan 01c**: the "Sign in again" ping action.
- **Plan 04** (Task 11): the smoke runner, which this plan builds from that task's specification if plan 04 hasn't landed.

---

## Tasks

### Task 1: Meet selector map

**Files:**

- Create: `config/selectors/meet.json`
- Create: `packages/worker/src/adapters/meet/selectors.ts`
- Test: `packages/worker/test/meet-selectors.test.ts`

**Interfaces:**

- Consumes: `loadSelectors<T>(name: string, schema: z.ZodType<T>, dir?: string): Promise<T>` from plan 01a (Task 13), which takes a map name, not a `Platform`.
- Produces: `MeetSelectorsSchema` (zod, strict at every level, the shape of `meet.json` below), `type MeetSelectors = z.infer<typeof MeetSelectorsSchema>` and `meetSelectors(): Promise<MeetSelectors>` (`loadSelectors('meet', MeetSelectorsSchema)`) in `packages/worker/src/adapters/meet/selectors.ts`. The map follows 01a's `zoom.json` layout: `selectors` holds CSS selectors usable in `document.querySelectorAll`; `texts` holds regular expressions matched case-insensitively against visible text, with apostrophes written as `.` so straight and curly ones both match; `noticeAllowlist` holds exact button texts; `signInHosts` holds host names; `joinButtons` holds exact join-button texts in order of preference.

- [x] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meetSelectors } from './selectors'

const shipped = join(import.meta.dir, '../../../../../config/selectors')

test('the shipped meet.json loads with every key the adapter reads', async () => {
  process.env.TM_SELECTORS_DIR = shipped
  const sel = await meetSelectors()
  expect(sel.joinButtons).toEqual(['Join now', 'Join here too', 'Ask to join'])
  expect(sel.noticeAllowlist).toEqual(['Got it', 'OK', 'Dismiss'])
  expect(sel.selectors.leaveButton).toBe("[aria-label='Leave call']")
  expect(new RegExp(sel.texts.blocked, 'i').test('You can’t join this video call')).toBe(true)
})

test('a missing key fails loudly and names the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'))
  cpSync(shipped, dir, { recursive: true })
  const map = JSON.parse(readFileSync(join(dir, 'meet.json'), 'utf8'))
  delete map.selectors.leaveButton
  writeFileSync(join(dir, 'meet.json'), JSON.stringify(map))
  process.env.TM_SELECTORS_DIR = dir
  await expect(meetSelectors()).rejects.toThrow(/leaveButton/)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/worker/test/meet-selectors.test.ts`
Expected: FAIL, module `../src/adapters/meet/selectors` not found.

- [x] **Step 3: Create `config/selectors/meet.json` and `meetSelectors(): Promise<MeetSelectors>`**

"Switch here", "Present" and "Use Companion mode" are deliberately absent from `joinButtons`. Starting values, mirrored by the fixtures and confirmed or corrected in Task 10:

```json
{
  "signInHosts": ["accounts.google.com"],
  "joinButtons": ["Join now", "Join here too", "Ask to join"],
  "selectors": {
    "prejoinNameInput": "input[aria-label='Your name']",
    "micToggle": "[role='button'][data-is-muted][aria-label*='microphone' i]",
    "micOff": "[role='button'][data-is-muted='true'][aria-label*='microphone' i]",
    "cameraToggle": "[role='button'][data-is-muted][aria-label*='camera' i]",
    "cameraOff": "[role='button'][data-is-muted='true'][aria-label*='camera' i]",
    "leaveButton": "[aria-label='Leave call']",
    "chatButton": "[aria-label='Chat with everyone']",
    "peopleButton": "[aria-label^='People'], [aria-label^='Show everyone']",
    "sidePanel": "[role='complementary']",
    "chatScroller": "[role='complementary'] [aria-live='polite']",
    "chatGroup": "[data-sender-id]",
    "chatSender": "[data-sender-name]",
    "chatTime": "[data-formatted-timestamp]",
    "chatMessage": "[data-message-id]",
    "peopleList": "[role='list'][aria-label='Participants']",
    "peopleItem": "[role='listitem']",
    "moreButton": "[aria-label='More options']",
    "dialogClose": "[role='dialog'] [aria-label='Close']",
    "captionsOnButton": "[aria-label='Turn off captions']",
    "captionsRegion": "[aria-label='Captions']",
    "sharedScreen": "[data-is-presentation='true'] video",
    "noticeContainers": "[role='dialog'], [role='alertdialog'], [role='alert']"
  },
  "texts": {
    "blocked": "you can.t join this video call",
    "invalidLink": "check your meeting code|invalid video call name",
    "permissionContinue": "^continue without microphone and camera$",
    "lobby": "asking to be let in|please wait until a meeting host brings you into the call|your request to join is being reviewed",
    "lobbyDenied": "denied your request to join|your request to join was declined",
    "lobbyExpired": "no one responded to your request to join",
    "leaveConfirm": "^just leave the call$",
    "layoutMenu": "^(adjust view|change layout)$",
    "spotlight": "^spotlight$",
    "breakoutPrompt": "breakout room|you.ve been invited to join",
    "endScreen": "return to home screen",
    "ended": "you left the meeting|the call has ended|the meeting has ended",
    "removed": "you.ve been removed from the meeting"
  },
  "noticeAllowlist": ["Got it", "OK", "Dismiss"]
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/worker/test/meet-selectors.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add config/selectors/meet.json packages/worker/src/adapters/meet/selectors.ts packages/worker/test/meet-selectors.test.ts
git commit -m "feat(worker): meet selector map"
```

### Task 2: Link normalisation

**Files:**

- Create: `packages/worker/src/adapters/meet/link.ts`
- Test: `packages/worker/src/adapters/meet/link.test.ts`

**Interfaces:**

- Consumes: `unwrapLink(url: string): string` from plan 01a (Task 12).
- Produces: `normaliseMeetLink(url: string): string | null` in `packages/worker/src/adapters/meet/link.ts`; Task 8 exposes it as `meetAdapter.normaliseLink`.

- [x] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import { normaliseMeetLink } from './link'

const MEET = 'https://meet.google.com/abc-defg-hij'

test.each([
  [MEET, MEET],
  ['https://meet.google.com/ABCDEFGHIJ', MEET],
  ['meet.google.com/abc-defg-hij', MEET],
  [`${MEET}?authuser=1&hs=122&pli=1`, MEET],
  [`https://www.google.com/url?q=${encodeURIComponent(MEET)}&sa=D&source=calendar`, MEET],
  [`https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(MEET)}&data=TESTDATA&reserved=0`, MEET],
  ['https://g.co/meet/abc-defg-hij', MEET],
  ['https://meet.google.com/lookup/testclass', 'https://meet.google.com/lookup/testclass']
])('normalises %s', (input, expected) => {
  expect(normaliseMeetLink(input)).toBe(expected)
})

test.each([
  'https://meet.google.com/new',
  'https://meet.google.com/landing',
  'https://meet.google.com/abc-defg',
  'https://meet.google.com.evil.example/abc-defg-hij',
  'https://teams.microsoft.com/meet/1234567890123?p=TESTPASS',
  'not a url'
])('rejects %s', (input) => {
  expect(normaliseMeetLink(input)).toBeNull()
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/worker/src/adapters/meet/link.test.ts`
Expected: FAIL, module `./link` not found.

- [x] **Step 3: Implement `normaliseMeetLink(url: string): string | null` in `packages/worker/src/adapters/meet/link.ts`**

Rules, in order:

1.  Prefix `https://` when the input has no scheme, unwrap Safe Links and Google redirects with 01a's `unwrapLink`, then parse with `new URL`; a parse failure returns `null`.
1.  `g.co/meet/<code>` becomes `meet.google.com/<code>`.
1.  The lower-cased host must be exactly `meet.google.com`.
1.  A path code matching `/^[a-z]{3}-?[a-z]{4}-?[a-z]{3}$/i` returns `https://meet.google.com/<xxx>-<xxxx>-<xxx>` in lower case; `/lookup/<name>` returns `https://meet.google.com/lookup/<name>`; every query parameter is dropped.
1.  Anything else returns `null`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/worker/src/adapters/meet/link.test.ts`
Expected: PASS (14 tests).

- [x] **Step 5: Commit**

```bash
git add packages/worker/src/adapters/meet/link.ts packages/worker/src/adapters/meet/link.test.ts
git commit -m "feat(worker): normalise meet links"
```

### Task 3: Pre-join and join

**Files:**

- Create: `packages/worker/test/fixtures/meet/app.html`
- Create: `packages/worker/test/fixtures/meet/signin.html`
- Create: `packages/worker/test/meet/serve.ts`
- Create: `packages/worker/src/adapters/meet/page-state.ts`
- Create: `packages/worker/src/adapters/meet/text.ts`
- Create: `packages/worker/src/adapters/meet/join.ts`
- Test: `packages/worker/test/meet/join.spec.ts`

**Interfaces:**

- Consumes: `MeetSelectors`, `meetSelectors()` (Task 1); `JoinResult` from `packages/worker/src/adapters/types.ts`.
- Produces:
  - `interface MeetPageState { roles: Map<string, SenderRole> | null; shareSeen: boolean }` and `meetState(page: Page): MeetPageState` (one `WeakMap` entry per page) in `packages/worker/src/adapters/meet/page-state.ts`.
  - `meetTextSignal(page: Page, sel: MeetSelectors, pattern: string): Promise<boolean>` in `packages/worker/src/adapters/meet/text.ts`: true when the case-insensitive regular expression matches the page's visible text outside `sidePanel` and `captionsRegion`, so chat and spoken captions never count as signals.
  - `joinMeet(page: Page, sel: MeetSelectors, timeoutMs = 90_000): Promise<JoinResult>` in `packages/worker/src/adapters/meet/join.ts`. It starts on the page the caller has already opened at the normalised link (01a's run sequence) and never navigates itself.
  - Test harness in `packages/worker/test/meet/serve.ts`: `type MeetScene`, `interface MeetFixtureConfig`, `serveMeet(page: Page, cfg: MeetFixtureConfig): Promise<void>` (replaces earlier routes), `setMeetScene(page: Page, scene: MeetScene, patch?: Partial<MeetFixtureConfig>): Promise<void>`, `meetClicks(page: Page): Promise<string[]>`. Later tasks add fields and scenes.

- [x] **Step 1: Build the fixtures and harness**

`app.html` imitates the Meet web client as one page whose scene comes from `window.__cfg` and switches through `window.__scene(scene, patch)`, using the attribute values in `meet.json`. It must contain:

- `prejoin`: microphone and camera buttons (`role="button"`, `data-is-muted` from `cfg.mic` and `cfg.camera`, `aria-label` "Turn off microphone" or "Turn on microphone", and the same for camera), decoys "Present" and "Use Companion mode", and the join buttons named by `cfg.joinAs`: `join-now` ("Join now"), `ask` ("Ask to join") or `other-device` (the text "You're already in this call on another device" with "Switch here" and "Join here too"). A join button switches to `cfg.afterJoin` (default `meeting` for "Join now" and "Join here too", `lobby` for "Ask to join").
- `prejoin-anonymous`: an empty `input[aria-label='Your name']` with "Ask to join".
- `prejoin-permissions`: the pre-join under a `role="dialog"` with "Use microphone and camera" (decoy) and "Continue without microphone and camera" (closes it).
- `signin`: sets `location.href` to `https://accounts.google.com/v3/signin/identifier`.
- `blocked`: "You can't join this video call"; `invalid`: "Check your meeting code".
- `lobby`: "Asking to be let in…".
- `meeting`: the toolbar ("Leave call", microphone and camera buttons with `data-is-muted`, "Chat with everyone", "People", "More options") and two `<audio>` elements.
- `blank`: an empty body.
- A click listener that pushes each clicked control's `aria-label`, else its trimmed text, to `window.__clicks`.

`signin.html` shows a Google sign-in form (`input[type='email']`). `serveMeet` routes `https://meet.google.com/**` to `app.html` with `<script>window.__cfg = ...</script>` prepended, and `https://accounts.google.com/**` to `signin.html`.

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import { joinMeet } from '../../src/adapters/meet/join'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet } from './serve'

const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()

test('turns devices off, then joins now', async ({ page }) => {
  await serveMeet(page, {
    scene: 'prejoin',
    mic: 'on',
    camera: 'on',
    joinAs: 'join-now'
  })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await meetClicks(page)).toEqual(['Turn off microphone', 'Turn off camera', 'Join now'])
})

test('asks to join when the organisation does not trust the member', async ({ page }) => {
  await serveMeet(page, {
    scene: 'prejoin',
    mic: 'off',
    camera: 'off',
    joinAs: 'ask'
  })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'lobby' })
  expect(await meetClicks(page)).toEqual(['Ask to join'])
})

test('passes the device dialog without granting anything', async ({ page }) => {
  await serveMeet(page, {
    scene: 'prejoin-permissions',
    mic: 'off',
    camera: 'off',
    joinAs: 'join-now'
  })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await meetClicks(page)).toEqual(['Continue without microphone and camera', 'Join now'])
})

test('joins here too, never switching the member out of the call', async ({ page }) => {
  await serveMeet(page, {
    scene: 'prejoin',
    mic: 'off',
    camera: 'off',
    joinAs: 'other-device'
  })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({ kind: 'in_meeting' })
  expect(await meetClicks(page)).toEqual(['Join here too'])
})

test('an anonymous pre-join means the session expired: no guest knock', async ({ page }) => {
  await serveMeet(page, { scene: 'prejoin-anonymous' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({
    kind: 'signin_required',
    host: 'meet.google.com'
  })
  await expect(page.locator(sel.selectors.prejoinNameInput)).toHaveValue('')
  expect(await meetClicks(page)).toEqual([])
})

test('a Google sign-in page is signin_required on its host', async ({ page }) => {
  await serveMeet(page, { scene: 'signin' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({
    kind: 'signin_required',
    host: 'accounts.google.com'
  })
})

test('an automation block fails at once', async ({ page }) => {
  await serveMeet(page, { scene: 'blocked' })
  await page.goto(MEET)
  const started = Date.now()
  expect(await joinMeet(page, sel)).toEqual({
    kind: 'failed',
    reason: 'meet_blocked'
  })
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('an invalid code fails; an unrecognised page times out', async ({ page }) => {
  await serveMeet(page, { scene: 'invalid' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel)).toEqual({
    kind: 'failed',
    reason: 'invalid_link'
  })
  await serveMeet(page, { scene: 'blank' })
  await page.goto(MEET)
  expect(await joinMeet(page, sel, 3_000)).toEqual({
    kind: 'failed',
    reason: 'prejoin_timeout'
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/join.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/meet/join`.

- [x] **Step 4: Implement `meetState`, `meetTextSignal` and `joinMeet(page: Page, sel: MeetSelectors, timeoutMs = 90_000): Promise<JoinResult>`**

Every 500 ms until `timeoutMs`, act on the first rule that matches (text checks through `meetTextSignal`):

1.  Page host in `signInHosts`: `{ kind: 'signin_required', host }`.
1.  `texts.blocked`: `{ kind: 'failed', reason: 'meet_blocked' }`.
1.  `texts.invalidLink`: `{ kind: 'failed', reason: 'invalid_link' }`.
1.  `texts.ended` or `texts.endScreen`: `{ kind: 'failed', reason: 'meeting_ended' }` (a rejoin after the call ended or the member left; tested with the `ended` and `left` scenes).
1.  A visible button whose text matches `texts.permissionContinue`: click it.
1.  `prejoinNameInput` visible: `{ kind: 'signin_required', host: 'meet.google.com' }`, without typing.
1.  A visible button whose whole text equals an entry of `joinButtons` (taking the earliest entry present): click `micToggle` if `micOff` doesn't match, then `cameraToggle` if `cameraOff` doesn't match; re-read both and return `{ kind: 'failed', reason: 'device_toggle_stuck' }` if either is still on; then click that join button once.
1.  `texts.lobby`, `texts.lobbyDenied` or `texts.lobbyExpired`: `{ kind: 'lobby' }`.
1.  `leaveButton` visible: `{ kind: 'in_meeting' }`.

At the deadline return `{ kind: 'failed', reason: 'prejoin_timeout' }`.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/join.spec.ts`
Expected: PASS (8 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/meet packages/worker/test/meet packages/worker/src/adapters/meet/page-state.ts packages/worker/src/adapters/meet/text.ts packages/worker/src/adapters/meet/join.ts
git commit -m "feat(worker): join meet calls with devices off"
```

### Task 4: Admission and meeting state

**Files:**

- Modify: `packages/worker/test/fixtures/meet/app.html`, `packages/worker/test/meet/serve.ts`
- Create: `packages/worker/src/adapters/meet/state.ts`
- Test: `packages/worker/test/meet/state.spec.ts`

**Interfaces:**

- Consumes: `MeetSelectors` (Task 1); `meetTextSignal`, `serveMeet`, `setMeetScene`, `meetClicks` (Task 3); `MeetingState`, `AdmissionResult` from `packages/worker/src/adapters/types.ts`.
- Produces: `meetMeetingState(page: Page, sel: MeetSelectors): Promise<MeetingState>` and `waitMeetAdmitted(page: Page, sel: MeetSelectors, deadline: Date, pollMs = 2_000): Promise<AdmissionResult>` in `packages/worker/src/adapters/meet/state.ts`.

- [x] **Step 1: Extend the fixture**

Add scenes `lobby-review` ("Your request to join is being reviewed"), `lobby-denied` ("Someone in the call denied your request to join"), `lobby-expired` ("No one responded to your request to join the call", with an "Ask to join" button), `ended` ("The call has ended" and "Return to home screen"), `left` ("You left the meeting", "Rejoin" and "Return to home screen") and `removed` ("You've been removed from the meeting"). Add `MeetFixtureConfig.breakout: boolean` (a `role="dialog"` "You've been invited to join breakout room 1" with "Join" and "Cancel"), `sidePanel: 'chat' | 'people' | 'closed'` (a `role="complementary"` panel holding the chat or the participant list), `messages: { id: string; sender: string; time: string; text: string; href?: string }[]` (rendered in the chat panel as `[data-sender-id]` groups, each with `[data-sender-name]`, `[data-formatted-timestamp]` and one `[data-message-id]` per message; consecutive messages from one sender share a group) and `captions: string | null` (a `[aria-label='Captions']` region with that text).

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import { meetMeetingState, waitMeetAdmitted } from '../../src/adapters/meet/state'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet, setMeetScene } from './serve'

const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const soon = (ms: number) => new Date(Date.now() + ms)

for (const [scene, state] of [
  ['lobby', 'lobby'],
  ['lobby-review', 'lobby'],
  ['meeting', 'in_meeting'],
  ['ended', 'ended'],
  ['left', 'ended'],
  ['removed', 'removed'],
  ['blank', 'unknown']
] as const) {
  test(`scene ${scene} reads as ${state}`, async ({ page }) => {
    await serveMeet(page, { scene, mic: 'off', camera: 'off' })
    await page.goto(MEET)
    expect(await meetMeetingState(page, sel)).toBe(state)
  })
}

test('chat and spoken captions are never state signals', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    sidePanel: 'chat',
    captions: 'and then you left the meeting',
    messages: [
      {
        id: 'c1',
        sender: 'Student',
        time: '10:01',
        text: "You've been removed from the meeting"
      }
    ]
  })
  await page.goto(MEET)
  expect(await meetMeetingState(page, sel)).toBe('in_meeting')
})

test('a breakout prompt reads as breakout_prompt and is not touched', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    breakout: true
  })
  await page.goto(MEET)
  expect(await meetMeetingState(page, sel)).toBe('breakout_prompt')
  expect(await meetClicks(page)).toEqual([])
})

test('admitted from the lobby, and from the review queue', async ({ page }) => {
  for (const scene of ['lobby', 'lobby-review'] as const) {
    await serveMeet(page, { scene, mic: 'off', camera: 'off' })
    await page.goto(MEET)
    setTimeout(() => void setMeetScene(page, 'meeting'), 2_000)
    expect(await waitMeetAdmitted(page, sel, soon(20_000), 500)).toBe('admitted')
  }
})

test('denied, expired and deadline outcomes', async ({ page }) => {
  await serveMeet(page, { scene: 'lobby-denied' })
  await page.goto(MEET)
  expect(await waitMeetAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_denied')
  await setMeetScene(page, 'lobby-expired')
  expect(await waitMeetAdmitted(page, sel, soon(20_000), 500)).toBe('lobby_expired')
  await setMeetScene(page, 'lobby-review')
  expect(await waitMeetAdmitted(page, sel, soon(2_000), 500)).toBe('lobby_expired')
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/state.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/meet/state`.

- [x] **Step 4: Implement `meetMeetingState` and `waitMeetAdmitted` in `packages/worker/src/adapters/meet/state.ts`**

`meetMeetingState` returns the first match, with every text check through `meetTextSignal`: `texts.removed` → `removed`; `texts.ended` or `texts.endScreen` → `ended`; `texts.breakoutPrompt` → `breakout_prompt`; any lobby text → `lobby`; `leaveButton` visible → `in_meeting`; otherwise `unknown` (a missing Leave button without an end signal is left to 01a's drop handling). `waitMeetAdmitted` polls every `pollMs`: `texts.lobbyDenied` → `lobby_denied`; `texts.lobbyExpired` → `lobby_expired`; `leaveButton` visible with no lobby text → `admitted`; past `deadline` → `lobby_expired`.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/state.spec.ts`
Expected: PASS (11 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/meet packages/worker/test/meet packages/worker/src/adapters/meet/state.ts
git commit -m "feat(worker): read meet lobby and call state"
```

### Task 5: Devices, notices, audio output and leave

**Files:**

- Modify: `packages/worker/test/fixtures/meet/app.html`, `packages/worker/test/meet/serve.ts`
- Create: `packages/worker/src/adapters/meet/controls.ts`
- Test: `packages/worker/test/meet/controls.spec.ts`

**Interfaces:**

- Consumes: `MeetSelectors` (Task 1); `serveMeet`, `meetClicks` (Task 3); `meetMeetingState` (Task 4); `DevicesOnError` from plan 01a.
- Produces, in `packages/worker/src/adapters/meet/controls.ts`:
  - `assertMeetDevicesOff(page: Page, sel: MeetSelectors): Promise<void>`, throwing `DevicesOnError` when `micOff` or `cameraOff` doesn't match a visible element, with `labels` holding the offending controls' `aria-label`s, or `microphone control not found` and `camera control not found` when a control is missing.
  - `dismissMeetNotices(page: Page, sel: MeetSelectors): Promise<string[]>`.
  - `connectMeetOutputAudio(page: Page, sel: MeetSelectors): Promise<void>`.
  - `leaveMeet(page: Page, sel: MeetSelectors): Promise<void>`.

- [x] **Step 1: Extend the fixture**

Add `MeetFixtureConfig.notices: { role: 'dialog' | 'alert'; text: string; button: string }[]` (each a container with that role, its text and one button) and `host: boolean` (clicking "Leave call" opens a `role="dialog"` with "End the call for everyone" and "Just leave the call"; otherwise it switches to `left`). Give the side panel a header button `aria-label="Close"`. Add `MeetFixtureConfig.audioElements: number` (default 2) for the `meeting` scene.

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import {
  assertMeetDevicesOff,
  connectMeetOutputAudio,
  dismissMeetNotices,
  leaveMeet
} from '../../src/adapters/meet/controls'
import { meetMeetingState } from '../../src/adapters/meet/state'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { DevicesOnError } from '../../src/adapters/types'
import { meetClicks, serveMeet } from './serve'

const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()

test('devices off passes; either device on, or a missing control, throws', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await assertMeetDevicesOff(page, sel)
  for (const patch of [{ mic: 'on' }, { camera: 'on' }] as const) {
    await serveMeet(page, {
      scene: 'meeting',
      mic: 'off',
      camera: 'off',
      ...patch
    })
    await page.goto(MEET)
    await expect(assertMeetDevicesOff(page, sel)).rejects.toBeInstanceOf(DevicesOnError)
  }
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await page.evaluate((s) => document.querySelector(s)?.remove(), sel.selectors.micToggle)
  await expect(assertMeetDevicesOff(page, sel)).rejects.toBeInstanceOf(DevicesOnError)
  expect(await meetClicks(page)).toEqual([])
})

test('clicks only allowlisted buttons inside notices, never the breakout prompt or side panel', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    sidePanel: 'chat',
    breakout: true,
    notices: [
      {
        role: 'dialog',
        text: 'Others may see your video differently',
        button: 'Got it'
      },
      { role: 'alert', text: 'This call is being recorded', button: 'Dismiss' },
      {
        role: 'dialog',
        text: 'Someone wants to join this call',
        button: 'Admit'
      },
      { role: 'dialog', text: 'Turn on captions?', button: 'Turn on captions' }
    ]
  })
  await page.goto(MEET)
  expect(await dismissMeetNotices(page, sel)).toEqual(['Got it', 'Dismiss'])
  expect(await meetClicks(page)).toEqual(['Got it', 'Dismiss'])
  await expect(page.locator(sel.selectors.sidePanel)).toBeVisible()
})

test('output audio needs no clicks, and fails loudly when no audio element exists', async ({ page }) => {
  await serveMeet(page, { scene: 'meeting', mic: 'off', camera: 'off' })
  await page.goto(MEET)
  await connectMeetOutputAudio(page, sel)
  expect(await meetClicks(page)).toEqual([])
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    audioElements: 0
  })
  await page.goto(MEET)
  await expect(connectMeetOutputAudio(page, sel)).rejects.toThrow(/no meeting audio/)
})

test('leaves without ending the call for everyone, even as host', async ({ page }) => {
  await serveMeet(page, {
    scene: 'meeting',
    mic: 'off',
    camera: 'off',
    host: true
  })
  await page.goto(MEET)
  await leaveMeet(page, sel)
  expect(await meetClicks(page)).toEqual(['Leave call', 'Just leave the call'])
  expect(await meetMeetingState(page, sel)).toBe('ended')
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/controls.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/meet/controls`.

- [x] **Step 4: Implement the four functions in `packages/worker/src/adapters/meet/controls.ts`**

- `dismissMeetNotices`: for each visible `noticeContainers` element outside `sidePanel` whose text matches no `texts.breakoutPrompt`, click each visible button whose trimmed text or `aria-label` equals an entry of `noticeAllowlist` (case-insensitive).
- `connectMeetOutputAudio`: Meet has no output control to click and plays call audio through page `audio` elements. Wait up to 10 seconds for at least one `audio` element and throw `Error('no meeting audio element')` if none appears; the sink-level check after it is 01a's.
- `leaveMeet`: click `leaveButton`; if a dialog appears within 2 seconds, click the button whose text matches `texts.leaveConfirm`; then wait up to 15 seconds for `texts.ended` or `texts.endScreen`.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/controls.spec.ts`
Expected: PASS (4 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/meet packages/worker/test/meet packages/worker/src/adapters/meet/controls.ts
git commit -m "feat(worker): add meet devices, notices, leave"
```

### Task 6: Chat with sender roles in the shared side panel

**Files:**

- Modify: `packages/worker/test/fixtures/meet/app.html`, `packages/worker/test/meet/serve.ts`
- Create: `packages/worker/src/adapters/meet/chat-dom.ts`
- Create: `packages/worker/src/adapters/meet/roles.ts`
- Create: `packages/worker/src/adapters/meet/chat.ts`
- Test: `packages/worker/src/adapters/meet/chat.test.ts`, `packages/worker/test/meet/chat.spec.ts`

**Interfaces:**

- Consumes: `MeetSelectors` (Task 1); `meetState`, `serveMeet`, `meetClicks` (Task 3); `ChatMessage`, `SenderRole` from `packages/core/src/types.ts`; `ChatCursor` from `packages/worker/src/adapters/types.ts`.
- Produces:
  - `interface RawMeetMessage { id: string | null; sender: string; time: string; text: string; hrefs: string[] }` and `parseMeetMessages(sel: MeetSelectors): RawMeetMessage[]` in `packages/worker/src/adapters/meet/chat-dom.ts`: a self-contained function run through `page.evaluate(parseMeetMessages, sel)` that reads each `chatGroup`'s `chatSender` and `chatTime` and each of its `chatMessage`s.
  - `toMeetChatMessages(raw: RawMeetMessage[], ctx: { roles: Map<string, SenderRole> | null; seenAt: string }): ChatMessage[]` in `packages/worker/src/adapters/meet/chat.ts`.
  - `roleFromMeetLabel(label: string): SenderRole` and `readMeetRoles(page: Page, sel: MeetSelectors): Promise<Map<string, SenderRole>>` in `packages/worker/src/adapters/meet/roles.ts`.
  - `readMeetChat(page: Page, sel: MeetSelectors, cursor: ChatCursor): Promise<{ messages: ChatMessage[]; cursor: ChatCursor }>` and `sweepMeetChat(page: Page, sel: MeetSelectors): Promise<ChatMessage[]>` in `packages/worker/src/adapters/meet/chat.ts`.

- [x] **Step 1: Write the failing unit test**

```ts
import { expect, test } from 'bun:test'
import { toMeetChatMessages } from './chat'
import { roleFromMeetLabel } from './roles'

const seenAt = '2026-11-02T10:06:30.000Z'

test('assigns roles, extracts links and falls back to a composite key', () => {
  const out = toMeetChatMessages(
    [
      {
        id: 'spaces/X/messages/1',
        sender: 'Lecturer',
        time: '10:05 AM',
        text: 'Attendance',
        hrefs: ['https://www.google.com/url?q=https://forms.gle/TESTFORM']
      },
      {
        id: null,
        sender: 'Student',
        time: '10:06 AM',
        text: 'copy: https://docs.google.com/forms/d/e/TESTFORM/viewform).',
        hrefs: []
      }
    ],
    { roles: new Map([['lecturer', 'host']]), seenAt }
  )
  expect(out[0]).toEqual({
    key: 'spaces/X/messages/1',
    sender: 'Lecturer',
    senderRole: 'host',
    time: '10:05 AM',
    seenAt,
    text: 'Attendance',
    links: ['https://www.google.com/url?q=https://forms.gle/TESTFORM'],
    replyTo: null
  })
  expect(out[1]).toMatchObject({
    key: 'Student|10:06 AM|copy: https://docs.google.com/forms/d/e/TESTFORM/viewform).',
    senderRole: 'unknown',
    links: ['https://docs.google.com/forms/d/e/TESTFORM/viewform']
  })
})

test.each([
  ['Meeting host', 'host'],
  ['Host', 'host'],
  ['Co-host', 'co_host'],
  ['Cohost', 'co_host'],
  ['', 'participant'],
  ['External', 'participant']
] as const)('participant label %s is %s', (label, role) => {
  expect(roleFromMeetLabel(label)).toBe(role)
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `bun test packages/worker/src/adapters/meet/chat.test.ts`
Expected: FAIL, module `./chat` not found.

- [x] **Step 3: Implement `toMeetChatMessages` and `roleFromMeetLabel`**

`toMeetChatMessages` sets `key` to `id` or `${sender}|${time}|${text.slice(0, 200)}`, looks up `senderRole` by the trimmed lower-cased sender (`unknown` when absent or when `roles` is null), and sets `links` to the `http`/`https` `hrefs` followed by 01a's `extractLinks(text)`, de-duplicated in order; `replyTo` is always `null`, because Meet chat has no threads. `roleFromMeetLabel` returns `co_host` when the label matches `/co-?host/i`, `host` when it matches `/host/i`, otherwise `participant`.

- [x] **Step 4: Run it to verify it passes**

Run: `bun test packages/worker/src/adapters/meet/chat.test.ts`
Expected: PASS (7 tests).

- [x] **Step 5: Extend the fixture**

Make the chat list scrollable (40 px per message, 10 visible) with `MeetFixtureConfig.chatScroll: 'top' | 'bottom'` (start position; it stays put when messages arrive). Add `people: { name: string; label?: string }[]`, rendered in the people panel as `[role='list'][aria-label='Participants']` with one `[role='listitem']` each (first text line the name, second the label), plus `window.__addMessage(m)` and `window.__addPerson(p)`. Clicking "People" shows the participant list in the side panel, hiding chat; clicking "Chat with everyone" shows chat again with its full history; while chat is hidden, new messages still enter the history, as in Meet.

- [x] **Step 6: Write the failing browser test**

```ts
import { expect, test } from '@playwright/test'
import { readMeetChat, sweepMeetChat } from '../../src/adapters/meet/chat'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet } from './serve'

const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const msgs = (n: number, from = 'Student') =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    sender: from,
    time: '10:00 AM',
    text: `message ${i}`
  }))
const base = {
  scene: 'meeting',
  mic: 'off',
  camera: 'off',
  sidePanel: 'chat',
  people: [{ name: 'Student' }]
} as const

test('returns new messages once, then nothing', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(5) })
  await page.goto(MEET)
  const first = await readMeetChat(page, sel, { seenKeys: [] })
  expect(first.messages.map((m) => m.key)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  expect((await readMeetChat(page, sel, first.cursor)).messages).toEqual([])
})

test('keeps the list at the bottom and the sweep reads everything', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(40), chatScroll: 'top' })
  await page.goto(MEET)
  expect((await readMeetChat(page, sel, { seenKeys: [] })).messages.at(-1)?.key).toBe('m39')
  expect((await sweepMeetChat(page, sel)).length).toBe(40)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test('a host who joined late is recognised when they post a link, and chat is reopened', async ({ page }) => {
  await serveMeet(page, { ...base, messages: msgs(1) })
  await page.goto(MEET)
  const first = await readMeetChat(page, sel, { seenKeys: [] })
  await page.evaluate(() => {
    ;(window as any).__addPerson({ name: 'Lecturer', label: 'Meeting host' })
    ;(window as any).__addMessage({
      id: 'f1',
      sender: 'Lecturer',
      time: '10:05 AM',
      text: 'Attendance',
      href: 'https://forms.gle/TESTFORM'
    })
  })
  const next = await readMeetChat(page, sel, first.cursor)
  expect(next.messages[0]).toMatchObject({
    sender: 'Lecturer',
    senderRole: 'host',
    links: ['https://forms.gle/TESTFORM']
  })
  expect(await meetClicks(page)).toEqual(['People', 'Chat with everyone'])
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test('the chat panel closed means no messages and no clicks', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'closed', messages: msgs(3) })
  await page.goto(MEET)
  expect(await readMeetChat(page, sel, { seenKeys: [] })).toEqual({
    messages: [],
    cursor: { seenKeys: [] }
  })
  expect(await meetClicks(page)).toEqual([])
})
```

- [x] **Step 7: Run it to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/chat.spec.ts`
Expected: FAIL, `readMeetChat` is not exported from `../../src/adapters/meet/chat`.

- [x] **Step 8: Implement `parseMeetMessages`, `readMeetRoles`, `readMeetChat` and `sweepMeetChat`**

- `readMeetRoles`: click `peopleButton`, wait for `peopleList`, map each `peopleItem`'s first text line (trimmed, lower-cased) to `roleFromMeetLabel` of its remaining lines, click `chatButton`, wait for `chatScroller`, store the map in `meetState(page).roles` and return it.
- `readMeetChat`: if `chatScroller` isn't visible, return no messages and the cursor unchanged (Task 7's `ensureMeetLayout` reopens chat). Otherwise scroll `chatScroller` to the bottom, parse, keep messages whose key isn't in `cursor.seenKeys`, and if any kept message has links and a sender missing from the role map (or the map is null), call `readMeetRoles` once, re-parse and map again. Return the messages and a cursor with their keys appended; the caller adopts it only after writing them (CHAT-03).
- `sweepMeetChat`: call `readMeetRoles` first, then scroll `chatScroller` top to bottom in steps of `max(200, clientHeight / 2)` px with a random 300 to 350 ms pause, parsing at each step, and return the union by key in list order.

- [x] **Step 9: Run it to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/chat.spec.ts`
Expected: PASS (4 tests).

- [x] **Step 10: Commit**

```bash
git add packages/worker/test/fixtures/meet packages/worker/test/meet packages/worker/src/adapters/meet/chat-dom.ts packages/worker/src/adapters/meet/roles.ts packages/worker/src/adapters/meet/chat.ts packages/worker/src/adapters/meet/chat.test.ts
git commit -m "feat(worker): read meet chat with roles"
```

### Task 7: Layout, captions, participant count and shared screen

**Files:**

- Modify: `packages/worker/test/fixtures/meet/app.html`, `packages/worker/test/meet/serve.ts`
- Create: `packages/worker/src/adapters/meet/layout.ts`
- Test: `packages/worker/test/meet/layout.spec.ts`

**Interfaces:**

- Consumes: `MeetSelectors` (Task 1); `meetState`, `serveMeet`, `setMeetScene`, `meetClicks` (Task 3); `Rect` from `packages/worker/src/adapters/types.ts`.
- Produces, in `packages/worker/src/adapters/meet/layout.ts`: `meetParticipantCount(page: Page, sel: MeetSelectors): Promise<number | null>`, `ensureMeetLayout(page: Page, sel: MeetSelectors): Promise<void>`, `meetSharedScreenRegion(page: Page, sel: MeetSelectors): Promise<Rect | null>`.

- [x] **Step 1: Extend the fixture**

Add `MeetFixtureConfig.peopleCount: number | null` (shown as a badge inside the "People" button). Whenever `captions` (Task 4) isn't null, the toolbar shows a "Turn off captions" button, which removes the `[aria-label='Captions']` region and becomes "Turn on captions". Add `share: { box: Rect; width: number; height: number } | null`, rendered as `<div data-is-presentation="true"><video></video></div>` at `box` with the stream size given through a canvas `captureStream()` of `width` by `height`, so `videoWidth` and `videoHeight` are real. "More options" opens a `role="menu"` with "Adjust view", "Turn on captions" and "Settings"; "Adjust view" opens a `role="dialog"` with radio options "Auto", "Tiled", "Spotlight" and "Sidebar" and a `aria-label="Close"` button.

- [x] **Step 2: Write the failing test**

```ts
import { expect, test } from '@playwright/test'
import { ensureMeetLayout, meetParticipantCount, meetSharedScreenRegion } from '../../src/adapters/meet/layout'
import { meetSelectors } from '../../src/adapters/meet/selectors'
import { meetClicks, serveMeet, setMeetScene } from './serve'

const MEET = 'https://meet.google.com/abc-defg-hij'
const sel = await meetSelectors()
const base = { scene: 'meeting', mic: 'off', camera: 'off' } as const
const share = {
  box: { x: 0, y: 0, width: 1440, height: 900 },
  width: 1440,
  height: 1080
}

test.use({ viewport: { width: 1920, height: 1080 } })

test('reads the participant count from the badge with chat left open', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'chat', peopleCount: 57 })
  await page.goto(MEET)
  expect(await meetParticipantCount(page, sel)).toBe(57)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
  expect(await meetClicks(page)).toEqual([])
})

test('reopens chat when the people list took the panel', async ({ page }) => {
  await serveMeet(page, { ...base, sidePanel: 'people', share: null })
  await page.goto(MEET)
  await ensureMeetLayout(page, sel)
  expect(await meetClicks(page)).toEqual(['Chat with everyone'])
})

test('turns captions off and spotlights a share once', async ({ page }) => {
  await serveMeet(page, {
    ...base,
    sidePanel: 'chat',
    captions: 'the QR code is at the bottom',
    share
  })
  await page.goto(MEET)
  await ensureMeetLayout(page, sel)
  await ensureMeetLayout(page, sel)
  expect(await meetClicks(page)).toEqual(['Turn off captions', 'More options', 'Adjust view', 'Spotlight', 'Close'])
  await expect(page.locator(sel.selectors.captionsRegion)).toHaveCount(0)
  await expect(page.locator(sel.selectors.chatScroller)).toBeVisible()
})

test('the shared-screen region is the picture inside the letterbox', async ({ page }) => {
  await serveMeet(page, { ...base, share })
  await page.goto(MEET)
  expect(await meetSharedScreenRegion(page, sel)).toEqual({
    x: 120,
    y: 0,
    width: 1200,
    height: 900
  })
  await setMeetScene(page, 'meeting', { share: null })
  expect(await meetSharedScreenRegion(page, sel)).toBeNull()
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/layout.spec.ts`
Expected: FAIL, cannot resolve `../../src/adapters/meet/layout`.

- [x] **Step 4: Implement the three functions in `packages/worker/src/adapters/meet/layout.ts`**

- `meetParticipantCount`: the first integer in `peopleButton`'s text, else in its `aria-label`, else `null`; it never clicks.
- `ensureMeetLayout`, in this order: click `captionsOnButton` when visible (it never turns captions on); click `chatButton` when `chatScroller` isn't visible; when `sharedScreen` is visible and `meetState(page).shareSeen` is false, click `moreButton`, the menu item whose text matches `texts.layoutMenu`, the option whose text matches `texts.spotlight`, then `dialogClose`, and set `shareSeen`; reset `shareSeen` when no share is visible.
- `meetSharedScreenRegion`: the first visible `sharedScreen` element's box, shrunk to the picture inside it by `videoWidth`/`videoHeight` (contain-fit, centred), rounded to whole pixels, in page coordinates, which are stage coordinates as in 01a's Zoom adapter; `null` when no share is visible, so 01a falls back to its brightness crop.

- [x] **Step 5: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/meet/layout.spec.ts`
Expected: PASS (4 tests).

- [x] **Step 6: Commit**

```bash
git add packages/worker/test/fixtures/meet packages/worker/test/meet packages/worker/src/adapters/meet/layout.ts
git commit -m "feat(worker): keep meet share large and chat open"
```

### Task 8: Adapter assembly, registration and run changes

**Files:**

- Create: `packages/worker/src/adapters/meet/index.ts`
- Modify: `packages/worker/src/adapters/index.ts`, plan 01a's `packages/worker/src/run.ts` and `packages/notify/src/messages.ts`
- Test: `packages/worker/src/adapters/meet/index.test.ts`, `packages/worker/test/meet/adapter.spec.ts`, `packages/worker/src/run.test.ts`, `packages/notify/src/messages.test.ts`

**Interfaces:**

- Consumes: everything Tasks 1 to 7 produce; `PlatformAdapter` from `packages/worker/src/adapters/types.ts`; from plan 01a, `runOccurrence` and its test helper `fakeDeps` (Task 18), `alertPing` and `AlertKind` (Task 3).
- Produces: `meetAdapter: PlatformAdapter` (with `platform: 'meet'`) and `MEET_TIMEOUTS` in `packages/worker/src/adapters/meet/index.ts`; `adapterFor(url)` returns `meetAdapter` for any URL `normaliseMeetLink` accepts.
- Produces (adds to contracts): `AlertKind` gains `meet_signin`; `runOccurrence` calls `adapter.ensureLayout` on its 10-second refresh as well as after joining (plan 04 makes the same change; whichever plan lands second finds it in place and keeps its test), and pings `meet_signin` instead of `zoom_signin` when a Meet `join` returns `signin_required`.

- [x] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'
import { adapterFor } from '../index'

test('adapterFor picks meet for meet links only', () => {
  expect(adapterFor('https://meet.google.com/abc-defg-hij?authuser=1')?.platform).toBe('meet')
  expect(adapterFor('https://meet.google.com/new')).toBeNull()
  expect(adapterFor('https://us02web.zoom.us/j/1234567890?pwd=TESTPASS')?.platform).toBe('zoom')
})
```

```ts
import { expect, test } from '@playwright/test'
import { meetAdapter } from '../../src/adapters/meet'
import { serveMeet } from './serve'

test('a step that runs past its timeout rejects, naming the step', async ({ page }) => {
  await serveMeet(page, { scene: 'blank' })
  await page.goto('https://meet.google.com/abc-defg-hij')
  await expect(meetAdapter.leave(page)).rejects.toThrow('meet leave timed out after 20000 ms')
})
```

```ts
// packages/notify/src/messages.test.ts
test('meet sign-in copy', () => {
  expect(alertPing('Data Mining', 'meet_signin').message).toBe(
    "Google asked to sign in, so the bot couldn't join the Meet call. Sign in to Google again for this identity."
  )
})
```

```ts
// packages/worker/src/run.test.ts, with 01a's fakeDeps (give its scripted adapter a platform and a join result if it has no such options yet)
test('a Meet sign-in request pings meet_signin', async () => {
  const d = fakeDeps({
    platform: 'meet',
    join: { kind: 'signin_required', host: 'accounts.google.com' }
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'failed',
    reason: 'signin_required'
  })
  expect(d.alerts).toEqual(['meet_signin'])
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

Run: `bun test packages/worker/src/adapters/meet/index.test.ts packages/worker/src/run.test.ts packages/notify/src/messages.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts test/meet/adapter.spec.ts`
Expected: FAIL: `adapterFor` returns `null` for the Meet link; `meet_signin` is not an `AlertKind`; `../../src/adapters/meet` not found; the layout test fails too unless plan 04 has landed.

- [x] **Step 3: Implement `meetAdapter`, register it and change the run**

Each method loads `meetSelectors()` once (on first use) and delegates to the function of the same role: `normaliseMeetLink`, `joinMeet`, `connectMeetOutputAudio`, `ensureMeetLayout`, `waitMeetAdmitted`, `assertMeetDevicesOff`, `readMeetChat`, `sweepMeetChat`, `meetSharedScreenRegion`, `meetParticipantCount`, `meetMeetingState`, `dismissMeetNotices`, `leaveMeet`. Like 01a's Zoom adapter, it enforces its own timeouts: every method except `normaliseLink` and `waitUntilAdmitted` (bounded by its deadline) races its step against these limits and rejects with `Error('meet <method> timed out after <ms> ms')`; `runOccurrence` then saves the screenshot and `ariaSnapshot()` under `errors/` and pings, as it does for Zoom.

```ts
export const MEET_TIMEOUTS = {
  join: 100_000,
  connectOutputAudio: 15_000,
  ensureLayout: 20_000,
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

`adapterFor` gains `meetAdapter` after the adapters it already tries; the first whose `normaliseLink` isn't null wins. In `run.ts`, step 5 pings `meet_signin` (with plan 01c's "Sign in again" action, as for `zoom_signin`) when the adapter's platform is `meet`, and step 8 calls `ensureLayout` with each 10-second refresh of `sharedScreenRegion` and `participantCount`, so chat comes back after a roster read and a new presentation is spotlighted. In `messages.ts`, add `meet_signin` with the copy in the test.

- [x] **Step 4: Run them to verify they pass**

Run: the commands of Step 2
Expected: PASS, including 01a's existing `run.test.ts` and `messages.test.ts` cases.

- [x] **Step 5: Run the whole worker suite and the type check**

Run: `bun test packages/worker packages/notify` then `bunx playwright test -c packages/worker/playwright.config.ts` then `bun run typecheck`
Expected: all pass; `tsc` reports no errors.

- [x] **Step 6: Commit**

```bash
git add packages/worker/src/adapters packages/worker/src/run.ts packages/worker/src/run.test.ts packages/notify/src packages/worker/test/meet/adapter.spec.ts docs/TRD.md
git commit -m "feat(worker): register the meet adapter"
```

### Task 9: Monthly smoke test entry

No earlier plan builds the design's monthly smoke test. Plan 04's Task 11 specifies its runner (`SmokeEntry`, `SMOKE_ENTRIES`, `runSmokeEntry`, the Zoom entry, `tm-worker --smoke`, `run-job.sh <job> smoke` and `docker/worker/smoke.crontab`). If plan 04 hasn't landed, build those first exactly as that task specifies, leaving out its Teams entry; then add the Meet entry.

**Files:**

- Create (unless plan 04 created them): the runner files listed in plan 04's Task 11
- Create: `packages/worker/src/smoke/meet.ts`
- Modify: `packages/worker/src/smoke/entries.ts`, `docker/worker/smoke.crontab` (a Meet line)
- Test: `packages/worker/src/smoke/meet.test.ts`, `packages/worker/test/meet/smoke.spec.ts`

**Interfaces:**

- Consumes: `MeetSelectorsSchema`, `meetSelectors()` (Task 1); `meetAdapter` (Task 8); `serveMeet` (Task 3); `SmokeEntry`, `SMOKE_ENTRIES`, `runSmokeEntry` (plan 04, Task 11).
- Produces: `meetSmoke: SmokeEntry` in `packages/worker/src/smoke/meet.ts`, registered in `SMOKE_ENTRIES`.

- [x] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test'
import { MeetSelectorsSchema } from '../adapters/meet/selectors'
import { SMOKE_ENTRIES } from './entries'
import { meetSmoke } from './meet'

test('the meet smoke entry is registered and checks only real selector keys', () => {
  expect(SMOKE_ENTRIES).toContain(meetSmoke)
  for (const key of Object.values(meetSmoke.checkpoints).flat()) {
    expect(Object.keys(MeetSelectorsSchema.shape.selectors.shape)).toContain(key)
  }
})
```

```ts
import { expect, test } from '@playwright/test'
import { runSmokeEntry } from '../../src/smoke/run'
import { meetSmoke } from '../../src/smoke/meet'
import { serveMeet } from './serve'

const URL = 'https://meet.google.com/abc-defg-hij'
const cfg = {
  scene: 'prejoin',
  mic: 'off',
  camera: 'off',
  joinAs: 'join-now',
  sidePanel: 'closed',
  people: [{ name: 'Member' }]
} as const

test('passes on the full imitation', async ({ page }) => {
  await serveMeet(page, cfg)
  expect(await runSmokeEntry(page, meetSmoke, URL)).toEqual({ missing: [] })
})

test('fails loudly, naming the key, when the chat button is gone', async ({ page }) => {
  await serveMeet(page, {
    ...cfg,
    omit: ["[aria-label='Chat with everyone']"]
  })
  expect((await runSmokeEntry(page, meetSmoke, URL)).missing).toContain('chatButton')
})
```

- [x] **Step 2: Run them to verify they fail**

Run: `bun test packages/worker/src/smoke/meet.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts test/meet/smoke.spec.ts`
Expected: FAIL, module `./meet` not found.

- [x] **Step 3: Create `meetSmoke` and register it**

Add `MeetFixtureConfig.omit: string[]` (selectors whose elements the fixture leaves out). Meet keeps no chat before someone writes, so the chat item keys aren't checked:

```ts
export const meetSmoke: SmokeEntry = {
  platform: 'meet',
  selectors: meetSelectors,
  checkpoints: {
    inMeeting: [
      'leaveButton',
      'micToggle',
      'micOff',
      'cameraToggle',
      'cameraOff',
      'chatButton',
      'peopleButton',
      'moreButton'
    ],
    afterLayout: ['sidePanel', 'chatScroller'],
    afterSweep: ['chatScroller'],
    afterLeave: []
  }
}
```

The Meet test meeting is a standing meeting owned by a Google Workspace test account with access set to "Open", so the smoke identity joins without knocking. Add its line to `docker/worker/smoke.crontab`.

- [x] **Step 4: Run them to verify they pass**

Run: `bun test packages/worker/src/smoke/meet.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts test/meet/smoke.spec.ts`
Expected: PASS (1 and 2 tests).

- [x] **Step 5: Commit**

```bash
git add packages/worker/src/smoke packages/worker/src/cli.ts docker/worker packages/worker/test/meet docs/TRD.md
git commit -m "test(worker): add meet monthly smoke entry"
```

### Task 10: Milestone acceptance

Manual verification on real Meet meetings, mapped to the PRD's [acceptance tests](../PRD.md#acceptance-tests) and to spike 2's Meet findings. Record each result (date, pass or fail, evidence path) in this task.

**Files:**

- Modify: `config/selectors/meet.json`, the Meet fixtures and tests, only where reality differs
- Modify: spike 2's `REPORT.md` if Meet blocks the browser or a signed-in member lands in the review queue

**Interfaces:**

- Consumes: the deployed stack from plan 01c with plan 01b in place; the worker image with spike 2's pinned versions; the member's "University" identity signed in to Google through the remote view; a "host account" in the member's university Google Workspace, and a second host account in another Google Workspace organisation; a "classmate account"; plan 01b's test forms (an attendance Google Form and a non-attendance form asking only for name and ID); the member's phone subscribed to their ntfy topic.

- [ ] **Step 1: Selector check**

Run `docker/worker/run-job.sh <meet-smoke-job> smoke` (Task 9) on the server against the standing Meet test meeting, and make sure `docker/worker/smoke.crontab` has its Meet line. Pass: exit code 0, no missing keys, and Meet never shows "You can't join this video call". If it does show it, stop the milestone, record it in spike 2's `REPORT.md`, and revisit the Chrome settings there. Where a selector or text differs, correct `meet.json`, the fixtures and the tests in one commit, then rerun the suites of Tasks 1 to 9. Also check one assumption the tests rest on: Meet's chat list is not virtualised, so a burst of messages is still in the DOM when it is read (the burst test in `test/meet/chat.spec.ts` shows no more than that). If the live list drops rows that scroll out of view, add a virtualised fixture mode and an in-page observer like Teams' `teamsChatProbe`.

- [ ] **Step 2: Joining and admission**

Five runs: a meeting from the university host account (same organisation); a meeting from the other organisation's host account, which the host admits; the same, denied; the same, left until Meet times the request out; and, where the other organisation has the safeguarded guest-admit flow, a run in which the bot lands in the review queue and the host denies it there. Pass: "Join now" in the first run and "Ask to join" in the others; a "joined" ping with the participant count within 30 seconds of entering; denial pings and the worker stopping in both denial runs; after the time-out, at most 2 further knocks in the event log and no wait beyond the scheduled end plus 30 minutes. Record in spike 2's `REPORT.md` whether a signed-in member ever lands in the review queue.

- [ ] **Step 3: Silence in the meeting**

A 90-minute meeting. Every 15 minutes the host screenshots the bot's tile and its People entry. Pass (design test "Silence in the meeting"): every screenshot shows the microphone and camera off; nothing from the member appears in chat or as a reaction; the event log shows no click outside join, layout, captions off, allowlisted notices and leave; the recording holds only the stage and has meeting audio wherever someone spoke.

- [ ] **Step 4: Chat, roles, captions and forms**

Turn captions on in the member's profile through the remote view first. In a lecture entry's meeting: the classmate posts an attendance-looking Google Form link; the host joins 5 minutes after the bot, makes a second account co-host, and that co-host posts the attendance Google Form link; later the host presents a slide with a QR code at its bottom edge pointing to the same form type. Pass (design tests "Form fixture" and "Unsafe form", Meet variant): the classmate's link gets a "form seen, not submitted" ping within 30 seconds and no submission; the co-host's link and the QR code are each submitted within 2 minutes with pings; `chat.jsonl` shows the co-host's message with `senderRole` `co_host`; captions are off within one layout pass and the kept frames show the presentation in spotlight with chat open.

- [ ] **Step 5: Breakout rooms, another device, end, leave and crash**

The host opens breakout rooms with the member assigned. In another meeting, the member joins on their own laptop first, then the bot joins. The host ends one meeting for everyone; in another the member presses "Make the bot leave"; in a third the worker container is killed 20 minutes in, after a form was submitted. Pass (design tests "End" and "Crash"): a high-priority breakout ping and no click on the room's "Join"; the bot chooses "Join here too" and the member's laptop stays in the call; recording stops within 60 seconds of the end and the summary arrives within 10 minutes (live mode); the bot leaves with "Leave call" and the call carries on; after the kill, the bot rejoins within 2 minutes from the latest checkpoint, the recording has only a short gap, the form isn't submitted again, and a ping arrives.

- [ ] **Step 6: Commit the corrections**

```bash
git add config/selectors/meet.json packages/worker/test docs
git commit -m "fix(worker): align meet selectors with live UI"
```
