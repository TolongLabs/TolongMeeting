# Link watchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch a member's chosen WhatsApp Web chat or Discord channel from the worker's desk, read-only, so that the newest meeting link posted before the meeting is joined, form links posted during it reach the existing form pipeline with their sender, and a missing link is pinged at the start time.

**Architecture:** One read-only watcher loop in `packages/worker/src/watchers/loop.ts` owns the 24-hour scan, the random poll intervals, the newest-link rule, the pasted-link override and form candidates; each app supplies only a `ChatSourceReader` (open the chat, read history, read the visible messages) in `discord.ts` and `whatsapp.ts`, whose `startWatcher` is the architecture's entry point. The run sequence starts the watcher while verifying accounts at T-60, waits for a link with a pure decision function, and hands form candidates to 1A's resolver and 1B's dispatcher. A pure gate in `packages/core` applies spike 7's verdict on WhatsApp and Discord from the server, in the website, the identity settings and the launcher.

**Tech Stack:** TypeScript (strict), Playwright and Playwright Test on Node 24, `bun test`, zod, Next.js App Router (website notes), React server rendering for component tests.

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Contract additions](#contract-additions)
1.  [Tasks](#tasks)
    1.  [Task 1: Chat identification and the watch gate](#task-1-chat-identification-and-the-watch-gate)
    1.  [Task 2: Watcher rules](#task-2-watcher-rules)
    1.  [Task 3: Watcher loop](#task-3-watcher-loop)
    1.  [Task 4: Discord watcher](#task-4-discord-watcher)
    1.  [Task 5: WhatsApp watcher](#task-5-whatsapp-watcher)
    1.  [Task 6: Link wait, no-link states and run wiring](#task-6-link-wait-no-link-states-and-run-wiring)
    1.  [Task 7: Link-source fields and the ban-risk notice](#task-7-link-source-fields-and-the-ban-risk-notice)
    1.  [Task 8: Gate in identities, sign-in and launch](#task-8-gate-in-identities-sign-in-and-launch)
    1.  [Task 9: Milestone acceptance](#task-9-milestone-acceptance)

## Global Constraints

- **Window**: watchers run as tabs in the desk window from T-60 until the meeting ends. A tab is opened once and kept open, never reloaded on a timer; it is navigated again only to reopen a lost chat, at most 3 times per worker attempt.
- **Chat identification**: Discord by channel URL, normalised to `https://discord.com/channels/<server or @me>/<channel>`; WhatsApp by exact chat name (Unicode NFC, trimmed, case-sensitive, 1 to 100 characters) that exactly one of the member's chats has.
- **History**: at start, read the last 24 hours of the chat (before the meeting), or the messages since T-10 (a restart during the meeting).
- **Polling**: read the visible messages at random intervals of 25 to 45 seconds before the meeting and 12 to 25 seconds during it; "before" ends when joining starts.
- **Meeting links**: only before joining starts; a link counts when `adapterFor(url)` returns an adapter; the newest in chat order within 24 hours wins; a pasted link always overrides watched and fixed links (plan 01c accepts pastes only until joining starts).
- **Form links**: links that aren't meeting links, from messages first seen at or after T-10, become `FormCandidate { source: 'watched_chat', sender, senderRole: 'unknown' }` once joining has started, and go through 1A's `resolveFormLink` and 1B's `FormDispatcher.offer`, like meeting-chat links.
- **Read-only**: the watcher never types in a composer, sends, reacts, replies, pins or presses "mark as read". Its only page actions are `goto`, scrolling a message list, filling WhatsApp's search box and clicking the found chat to open it.
- **Desk pause**: every watcher action on the desk first awaits plan 01c's `deskPause.whenOpen()`; nothing reads or scrolls while the member signs in.
- **No link**: no link by T sends one high-priority ping; watching continues until T+30, then the occurrence goes to `no_link` and the worker finishes without joining.
- **Spike 7 gate**: `TM_WHATSAPP_FROM_SERVER` (`allowed`, `home_only` or `none`; default `home_only`) and `TM_DISCORD_FROM_SERVER` (`allowed` or `home_only`; default `allowed`), copied from `watchers.whatsappFromServer` and `watchers.discordFromServer` in `spikes/DECISIONS.md`. `home_only` allows the app only for identities whose run location isn't `server`.
- **Spike 2**: if `desk.backgroundTabsLive` in `spikes/DECISIONS.md` is `no`, `latest()` calls `desk.bringToFront()` before reading, except while a 1B form tab is open.
- **Selectors**: `config/selectors/discord.json` and `config/selectors/whatsapp.json`, read from `TM_SELECTORS_DIR` and validated with zod; a UI change is fixed there without rebuilding.
- **Secrets**: meeting links (which may carry passcodes) never appear in ping text, logs or event data; events keep host and path only. Watched chat messages aren't stored; only form records keep a sender.
- **Copy**: plain British English; ping and notice wording is exactly as written in the tasks; times through `formatWhen` (`Wed 21 Oct, 14:00`) in the member's time zone.
- **Commits**: conventional commits, header at most 50 characters; each task's commit also copies its "adds to contracts" names into `docs/TRD.md`.

## Review Focus

- **A lecturer posts a link and corrects it minutes later**: before joining starts, the corrected (newer) link must be the one joined, even though the first was already reported. Test in Task 3.
- **Two WhatsApp chats share a name, or the name differs only in case, Unicode form or trailing spaces**: the watcher must refuse an ambiguous name and never watch a near match. Tests in Tasks 5 and 7.
- **A message edited to add or change a link**: Discord and WhatsApp keep the message id, so a key-only "seen" set would miss the new link; the edit must count. Test in Task 3.
- **A form posted in the watched chat while the bot waits in the lobby, or before a late link arrives**: it is first seen before joining starts, so it must be held and offered when joining starts, not dropped. Test in Task 3.
- **A worker restart mid-meeting**: the new attempt must not offer forms from yesterday's class still in the chat, nor report a meeting link; it reads only messages since T-10. Test in Task 3.

## Contract additions

Names this plan adds to [architecture and contracts](../TRD.md), copied there by the task that creates them:

- **Core**: `normaliseDiscordChannelUrl` (`packages/core/src/discord-chat.ts`); `ChatApp`, `WatchGate`, `WatchGateError`, `watchGateFromEnv`, `chatWatchAllowed`, `gateLinkSource` (`packages/core/src/watch-gate.ts`); `SpecEnv.watchGate`; the optional `StateEventData.link`.
- **Worker**: `WatchPhase`, `POLL_MS`, `nextPollDelayMs`, `chooseMeetingLink`, `splitLinks`, `messageSignature` (`watchers/rules.ts`); `ChatSourceReader`, `WatcherEnv`, `WatcherStatus`, `WatcherSigninError`, `WatcherChatError`, `configureWatchers`, `resetWatcherEnv`, `runChatWatcher` (`watchers/loop.ts`); `discordSelectors`, `whatsappSelectors` (`watchers/selectors.ts`); `discordReader`, `whatsappReader`, `parseWhatsAppPrePlain`; `watcherFor` (`watchers/index.ts`); `decideLinkWait`, `waitForMeetingLink`, `LinkChoice` (`watchers/link-wait.ts`); test helpers `serveWatcherFixtures` and `watchHarness` (`packages/worker/test/watchers/`), which plan 04 reuses.
- **Selector maps**: `config/selectors/discord.json`, `config/selectors/whatsapp.json`.
- **Pings**: `pings.noLink`, `pings.noLinkStopped`, `pings.watcherProblem`, `pings.watchingOff` in `packages/notify/src/messages.ts`.
- **Website**: `packages/web/lib/link-notices.ts` (all its exports), `EntryDeps.gate`, `WatchingNotAllowedError`, `BanRiskNotice`.
- **Environment variables**: `TM_WHATSAPP_FROM_SERVER`, `TM_DISCORD_FROM_SERVER` (web, scheduler).

Assumed from earlier plans (use their real names if they differ, and fix this plan in the same commit):

- **Plan 01a**: `Stopper` is callable (`stop()`, possibly async), as plan 01c's tests call it; `adapterFor` with the Zoom adapter registered, accepting `https://example.zoom.us/j/<digits>?pwd=<passcode>`; `resolveFormLink`; `packages/worker/playwright.config.ts` setting `TM_SELECTORS_DIR` to the repository's `config/selectors`; the run sequence in `packages/worker/src/run.ts`.
- **Plan 01b**: `FormDispatcher.offer(f: ResolvedForm)` from `startFormDispatcher`.
- **Plan 01c**: `LinkOverride` (`current()`), `siteLinks(cfg)` and `DeskPause.whenOpen()` in the worker; `AccountCheckData` events and the expired-account path at verification (ping "Sign in again", `nextResume()` until T-5, verify again); the `pings` object and its copy table in `packages/notify/src/messages.ts`; `formatWhen` in `packages/core/src/schedule.ts`; `ChatLinkSchema`, `EntryInputSchema`, `saveEntry` and `EntryDeps` in `packages/web/lib/timetable.ts`; `updateIdentity` and `InUseError` in `packages/web/lib/identities.ts`; the entry form `packages/web/app/timetable/[id]/page.tsx`; the sign-in page `packages/web/app/accounts/[identityId]/signin/page.tsx`; `launchOccurrence` in `packages/scheduler/src/launch.ts`; `SpecEnv` in `packages/core/src/control.ts`; component tests with `react-dom/server` under `bun test`.

---

## Tasks

### Task 1: Chat identification and the watch gate

**Files:**

- Create: `packages/core/src/discord-chat.ts`, `packages/core/src/watch-gate.ts`
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/discord-chat.test.ts`, `packages/core/test/watch-gate.test.ts`

**Interfaces:**

- Consumes: `LinkSource`, `RunLocation` (architecture).
- Produces (adds to contracts):

```ts
// packages/core/src/discord-chat.ts
export function normaliseDiscordChannelUrl(url: string): string | null

// packages/core/src/watch-gate.ts
export type ChatApp = Extract<LinkSource, { kind: 'chat' }>['app']
export interface WatchGate {
  whatsapp: 'allowed' | 'home_only' | 'none'
  discord: 'allowed' | 'home_only'
}
export class WatchGateError extends Error {} // message names the variable, never its value
export function watchGateFromEnv(env: Record<string, string | undefined>): WatchGate
export function chatWatchAllowed(app: ChatApp, runLocation: RunLocation, gate: WatchGate): boolean
export function gateLinkSource(
  link: LinkSource,
  runLocation: RunLocation,
  gate: WatchGate
): { link: LinkSource; blockedApp: ChatApp | null }
```

`normaliseDiscordChannelUrl` accepts `https:` only, hosts `discord.com`, `www.discord.com`, `ptb.discord.com`, `canary.discord.com` and `discordapp.com`, and paths `/channels/<server>/<channel>` with an optional trailing message id, where `<server>` is `@me` or 17 to 20 digits and `<channel>` is 17 to 20 digits; it drops the message id, query and fragment. `chatWatchAllowed` is true for `teams`; for WhatsApp and Discord, `allowed` is true, `home_only` is true unless `runLocation` is `server`, and `none` is false. `gateLinkSource` returns the link unchanged unless it is a chat the gate refuses, which becomes `{ kind: 'paste' }` with `blockedApp` set.

- [x] **Step 1: Write the failing tests**

```ts
// packages/core/test/discord-chat.test.ts
const G = '123456789012345678',
  C = '234567890123456789'
test.each([
  [`https://discord.com/channels/${G}/${C}`, `https://discord.com/channels/${G}/${C}`],
  [`https://ptb.discord.com/channels/${G}/${C}/345678901234567890?x=1#y`, `https://discord.com/channels/${G}/${C}`],
  [`https://discordapp.com/channels/@me/${C}/`, `https://discord.com/channels/@me/${C}`],
  ['https://discord.gg/abcdef', null],
  [`https://discord.com.example.com/channels/${G}/${C}`, null],
  [`http://discord.com/channels/${G}/${C}`, null],
  ['https://discord.com/channels/123/456', null],
  ['general', null]
])('normaliseDiscordChannelUrl(%s) is %p', (url, want) => expect(normaliseDiscordChannelUrl(url)).toBe(want))
```

```ts
// packages/core/test/watch-gate.test.ts
test('the gate defaults to WhatsApp at home only and Discord everywhere', () => {
  expect(watchGateFromEnv({})).toEqual({
    whatsapp: 'home_only',
    discord: 'allowed'
  })
  expect(
    watchGateFromEnv({
      TM_WHATSAPP_FROM_SERVER: 'none',
      TM_DISCORD_FROM_SERVER: 'home_only'
    })
  ).toEqual({ whatsapp: 'none', discord: 'home_only' })
  expect(() => watchGateFromEnv({ TM_DISCORD_FROM_SERVER: 'none' })).toThrow(
    'TM_DISCORD_FROM_SERVER must be allowed or home_only'
  )
})

test('home_only refuses only server identities; none refuses all', () => {
  const g: WatchGate = { whatsapp: 'home_only', discord: 'allowed' }
  expect(chatWatchAllowed('whatsapp', 'server', g)).toBe(false)
  expect(chatWatchAllowed('whatsapp', 'server_via_home', g)).toBe(true)
  expect(chatWatchAllowed('whatsapp', 'local', g)).toBe(true)
  expect(chatWatchAllowed('discord', 'server', g)).toBe(true)
  expect(chatWatchAllowed('whatsapp', 'local', { ...g, whatsapp: 'none' })).toBe(false)
  expect(
    chatWatchAllowed('teams', 'server', {
      whatsapp: 'none',
      discord: 'home_only'
    })
  ).toBe(true)
})

test('a refused chat becomes a pasted link', () => {
  const g: WatchGate = { whatsapp: 'home_only', discord: 'allowed' }
  expect(gateLinkSource({ kind: 'chat', app: 'whatsapp', chat: 'Class group' }, 'server', g)).toEqual({
    link: { kind: 'paste' },
    blockedApp: 'whatsapp'
  })
  const fixed = {
    kind: 'fixed',
    url: 'https://example.zoom.us/j/00000000000'
  } as const
  expect(gateLinkSource(fixed, 'server', g)).toEqual({
    link: fixed,
    blockedApp: null
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/discord-chat.test.ts packages/core/test/watch-gate.test.ts`
Expected: FAIL with `Cannot find module './discord-chat'`.

- [x] **Step 3: Implement both modules in `packages/core/src/` and export them from `index.ts`**

Parse with `new URL` inside `try`; a string that doesn't parse gives `null`.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/discord-chat.test.ts packages/core/test/watch-gate.test.ts`
Expected: PASS, `15 pass, 0 fail` (the plan's 11 cases plus 4 added: userinfo, port, control character, bad value not echoed).

- [x] **Step 5: Commit**

```bash
git add packages/core/src/discord-chat.ts packages/core/src/watch-gate.ts packages/core/test/discord-chat.test.ts packages/core/test/watch-gate.test.ts packages/core/src/index.ts docs/TRD.md
git commit -m "feat: identify chats and gate watching"
```

### Task 2: Watcher rules

**Files:**

- Create: `packages/worker/src/watchers/rules.ts`
- Test: `packages/worker/test/watchers/rules.test.ts`

**Interfaces:**

- Consumes: `ChatMessage` (architecture, with 1A's `replyTo`); `adapterFor` (1A).
- Produces (adds to contracts):

```ts
export type WatchPhase = 'before' | 'during'
export const POLL_MS = {
  before: [25_000, 45_000],
  during: [12_000, 25_000]
} as const
export function nextPollDelayMs(phase: WatchPhase, random: () => number): number // min + floor(random() * (max - min + 1))
export function chooseMeetingLink(watched: string | null, pasted: string | null): string | null // pasted ?? watched
export function splitLinks(m: ChatMessage): {
  meeting: string[]
  other: string[]
}
export function messageSignature(m: ChatMessage): string // `${key}|${sorted links joined by ' '}`
```

`splitLinks` keeps `https:` links only, removes duplicates and keeps message order; `meeting` holds those for which `adapterFor(url)` isn't null, `other` the rest.

- [x] **Step 1: Write the failing tests**

```ts
// packages/worker/test/watchers/rules.test.ts
const ZOOM = 'https://example.zoom.us/j/00000000001?pwd=PASSCODE'
const FORM = 'https://forms.gle/TESTFORM1'
const msg = (links: string[], key = 'k1'): ChatMessage => ({
  key,
  sender: 'Lecturer',
  senderRole: 'unknown',
  time: '',
  seenAt: '',
  text: '',
  links,
  replyTo: null
})

test('poll delays stay inside 25 to 45 s before and 12 to 25 s during', () => {
  expect(nextPollDelayMs('before', () => 0)).toBe(25_000)
  expect(nextPollDelayMs('before', () => 0.9999999)).toBe(45_000)
  expect(nextPollDelayMs('during', () => 0)).toBe(12_000)
  expect(nextPollDelayMs('during', () => 0.9999999)).toBe(25_000)
})

test('a pasted link beats a watched one', () => {
  expect(chooseMeetingLink(ZOOM, null)).toBe(ZOOM)
  expect(chooseMeetingLink(ZOOM, 'https://example.zoom.us/j/00000000009')).toBe('https://example.zoom.us/j/00000000009')
  expect(chooseMeetingLink(null, null)).toBeNull()
})

test('links split into meeting and other, https only, without duplicates', () => {
  expect(splitLinks(msg([FORM, ZOOM, FORM, 'http://forms.gle/TESTFORM2']))).toEqual({ meeting: [ZOOM], other: [FORM] })
})

test('an edited message with a new link has a new signature', () => {
  expect(messageSignature(msg([ZOOM]))).not.toBe(messageSignature(msg([ZOOM, FORM])))
  expect(messageSignature(msg([FORM, ZOOM]))).toBe(messageSignature(msg([ZOOM, FORM])))
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/test/watchers/rules.test.ts`
Expected: FAIL with `Cannot find module './rules'`.

- [x] **Step 3: Implement `packages/worker/src/watchers/rules.ts`**

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/test/watchers/rules.test.ts`
Expected: PASS, `4 pass, 0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/worker/src/watchers/rules* docs/TRD.md
git commit -m "feat(worker): watcher link rules"
```

### Task 3: Watcher loop

**Files:**

- Create: `packages/worker/src/watchers/loop.ts`
- Test: `packages/worker/src/watchers/loop.test.ts`

**Interfaces:**

- Consumes: `ChatMessage`, `FormCandidate` (architecture); `Stopper` (1A); everything in Task 2.
- Produces (adds to contracts):

```ts
export interface ChatSourceReader {           // messages oldest first
  open(desk: Page): Promise<void>;
  history(desk: Page, since: Date): Promise<ChatMessage[]>;
  latest(desk: Page): Promise<ChatMessage[]>;
}
export class WatcherSigninError extends Error { constructor(readonly host: string) }
export class WatcherChatError extends Error { constructor(readonly reason: 'not_found' | 'ambiguous' | 'not_loaded' | 'lost') }
export type WatcherStatus = { kind: 'signed_out'; host: string } | { kind: 'signed_in' } | { kind: 'chat_lost' };
export interface WatcherEnv {                  // the test seam for time and phase
  now(): Date; random(): number; sleep(ms: number): Promise<void>;
  phase(): WatchPhase; formsSince(): Date; pastedLink(): string | null;
  deskOpen(): Promise<void>; onStatus(s: WatcherStatus): void;
}
export function configureWatchers(env: Partial<WatcherEnv>): void;
export function resetWatcherEnv(): void;
export function runChatWatcher(desk: Page, reader: ChatSourceReader, onLink: (c: FormCandidate | { meetingUrl: string }) => void): Promise<Stopper>;
```

Defaults after `resetWatcherEnv`: the real clock, `Math.random`, a `setTimeout` sleep, phase `before`, `formsSince` far in the future (no form candidates until the run sequence configures it), no pasted link, an open desk and a status sink that does nothing. `runChatWatcher` resolves once the chat is open and history is read, so an open error rejects it; the returned `Stopper` wakes a sleeping loop and resolves when the loop has exited.

The loop (the tests pin the observable parts; this fixes the order):

```text
start:  await deskOpen(); await reader.open(desk)
        process(await reader.history(desk, phase() == 'before' ? now() - 24 h : formsSince()))
loop:   sleep(nextPollDelayMs(phase(), random)), raced with stop; while sleeping, check phase() each second and poll at once if it changed
        await deskOpen(); msgs = await reader.latest(desk); process(msgs)
        after a signed_out status, the first good read sends { kind: 'signed_in' }
errors: WatcherSigninError -> onStatus({ kind: 'signed_out', host }) once until a good read; keep polling
        WatcherChatError('lost'), or a 3rd consecutive other error -> reopen (open, then history as at start);
        a 4th reopen -> onStatus({ kind: 'chat_lost' }) and the loop ends
process(msgs), in order:
        skip a message whose messageSignature was seen; else mark it and set seenAt = now() (first sight)
        before: newest = last meeting link of the message, if any; other links first seen at or after formsSince() wait in `held`
        during: other links become candidates at once
        when phase() is 'during': offer every `held` candidate, then clear `held`
        when phase() is 'before': chosen = chooseMeetingLink(newest, pastedLink()); report { meetingUrl: chosen } when it differs from the last report
candidate = { url, source: 'watched_chat', sender: m.sender || null, senderRole: 'unknown', seenAt: m.seenAt }
```

- [x] **Step 1: Write the failing tests**

```ts
// packages/worker/src/watchers/loop.test.ts
// fakeReader({ history, latest }) returns a ChatSourceReader whose history() resolves `history`, whose latest() resolves the
// current value of its mutable `latest` array (or throws reader.throwNext once), and which counts open/history/latest calls and
// records the `since` of each history call. harness(over) calls resetWatcherEnv() and configureWatchers() with a clock at
// NOW = 2026-10-21T05:00:00Z, a sleep that records its delay and waits for tick(), and the overrides; it collects
// meeting reports, form candidates, delays and statuses. tick() releases one sleep and waits until the next poll finishes
// or the loop ends; release() only releases the sleep; settle() waits for the poll in flight; set(over) reconfigures.
// m(key, sender, links) builds a ChatMessage. Z1 to Z4 are https://example.zoom.us/j/0000000000N?pwd=PASSCODE, P is a
// pasted Zoom link, F is https://forms.gle/TESTFORM1.

test('the history scan reports only the newest meeting link', async () => {
  const r = fakeReader({
    history: [m('a', 'Rep', [Z1]), m('b', 'Rep', [Z2]), m('c', 'Rep', [])]
  })
  const h = harness()
  await runChatWatcher(desk, r, h.onLink)
  expect(r.sinces[0].toISOString()).toBe('2026-10-20T05:00:00.000Z')
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
})

test('a corrected link replaces the first; a pasted link overrides; nothing repeats', async () => {
  // Review Focus
  const r = fakeReader({ history: [m('a', 'Rep', [Z1])] })
  const h = harness()
  await runChatWatcher(desk, r, h.onLink)
  r.latest = [m('a', 'Rep', [Z1]), m('b', 'Rep', [Z2])]
  await h.tick()
  h.set({ pastedLink: () => P })
  r.latest.push(m('c', 'Rep', [Z3]))
  await h.tick()
  await h.tick()
  expect(h.meeting).toEqual([{ meetingUrl: Z1 }, { meetingUrl: Z2 }, { meetingUrl: P }])
})

test('an edited message with a new link counts', async () => {
  // Review Focus
  const r = fakeReader({ history: [m('a', 'Rep', [])] })
  const h = harness()
  await runChatWatcher(desk, r, h.onLink)
  r.latest = [m('a', 'Rep', [Z4])]
  await h.tick()
  expect(h.meeting).toEqual([{ meetingUrl: Z4 }])
})

test('a form first seen after T-10 but before joining is offered when joining starts', async () => {
  // Review Focus
  const r = fakeReader({ history: [] })
  const h = harness({ formsSince: () => new Date('2026-10-21T04:55:00Z') })
  await runChatWatcher(desk, r, h.onLink)
  r.latest = [m('f', 'Lecturer', [F])]
  await h.tick()
  expect(h.forms).toEqual([])
  h.set({ phase: () => 'during' })
  await h.tick()
  expect(h.forms).toEqual([
    {
      url: F,
      source: 'watched_chat',
      sender: 'Lecturer',
      senderRole: 'unknown',
      seenAt: '2026-10-21T05:00:00.000Z'
    }
  ])
})

test('a form first seen before T-10 is never offered', async () => {
  const r = fakeReader({ history: [m('f', 'Lecturer', [F])] })
  const h = harness({ formsSince: () => new Date('2026-10-21T05:10:00Z') })
  await runChatWatcher(desk, r, h.onLink)
  h.set({ phase: () => 'during' })
  await h.tick()
  expect(h.forms).toEqual([])
})

test('a restart during the meeting reads from T-10 and reports no meeting link', async () => {
  // Review Focus
  const r = fakeReader({
    history: [m('a', 'Rep', [Z1]), m('f', 'Lecturer', [F])]
  })
  const h = harness({
    phase: () => 'during',
    formsSince: () => new Date('2026-10-21T04:50:00Z')
  })
  await runChatWatcher(desk, r, h.onLink)
  expect(r.sinces[0].toISOString()).toBe('2026-10-21T04:50:00.000Z')
  expect(h.meeting).toEqual([])
  expect(h.forms.map((c) => c.url)).toEqual([F])
})

test('polls use the delay for the current phase', async () => {
  const h = harness({ random: () => 0.5 })
  await runChatWatcher(desk, fakeReader({ history: [] }), h.onLink)
  await h.tick()
  h.set({ phase: () => 'during' })
  await h.tick()
  expect(h.delays.slice(0, 3)).toEqual([35_000, 35_000, 18_500])
})

test('nothing touches the desk while it is paused', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await runChatWatcher(desk, r, h.onLink)
  const gate = Promise.withResolvers<void>()
  h.set({ deskOpen: () => gate.promise })
  h.release() // release the sleep without waiting for a poll
  await Bun.sleep(50)
  expect(r.calls.latest).toBe(0)
  gate.resolve()
  await h.settle()
  expect(r.calls.latest).toBe(1)
})

test('a sign-out is reported once, and so is the recovery', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await runChatWatcher(desk, r, h.onLink)
  r.throwNext = [new WatcherSigninError('web.whatsapp.com'), new WatcherSigninError('web.whatsapp.com')]
  await h.tick()
  await h.tick()
  await h.tick()
  expect(h.statuses).toEqual([{ kind: 'signed_out', host: 'web.whatsapp.com' }, { kind: 'signed_in' }])
})

test('a lost chat is reopened at most 3 times, then the loop ends', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await runChatWatcher(desk, r, h.onLink)
  r.alwaysThrow = new WatcherChatError('lost')
  for (let i = 0; i < 6; i++) await h.tick()
  expect(r.calls.open).toBe(4)
  expect(h.statuses).toEqual([{ kind: 'chat_lost' }])
  expect(r.calls.latest).toBe(4)
})

test('stop ends a sleeping loop at once; an open error rejects the start', async () => {
  const h = harness({ sleep: () => new Promise(() => {}) })
  const stop = await runChatWatcher(desk, fakeReader({ history: [] }), h.onLink)
  const t = performance.now()
  await stop()
  expect(performance.now() - t).toBeLessThan(100)
  const bad = fakeReader({ history: [] })
  bad.open = async () => {
    throw new WatcherSigninError('discord.com')
  }
  await expect(runChatWatcher(desk, bad, h.onLink)).rejects.toBeInstanceOf(WatcherSigninError)
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/watchers/loop.test.ts`
Expected: FAIL with `Cannot find module './loop'`.

- [x] **Step 3: Implement `packages/worker/src/watchers/loop.ts`**

Keep the env in one module-level object that `configureWatchers` merges into; read it on every use, so a phase or paste change applies at the next decision. Seen signatures live in a `Set` per watcher.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/watchers/loop.test.ts`
Expected: PASS, `11 pass, 0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/worker/src/watchers/loop* docs/TRD.md
git commit -m "feat(worker): add read-only watcher loop"
```

### Task 4: Discord watcher

**Files:**

- Create: `config/selectors/discord.json`, `packages/worker/src/watchers/selectors.ts`, `packages/worker/src/watchers/discord.ts`
- Create: `packages/worker/test/fixtures/discord/channel.html`, `packages/worker/test/fixtures/discord/login.html`, `packages/worker/test/watchers/serve.ts`, `packages/worker/test/watchers/harness.ts`
- Test: `packages/worker/test/watchers/discord.spec.ts`

**Interfaces:**

- Consumes: `normaliseDiscordChannelUrl` (Task 1); `ChatSourceReader`, `runChatWatcher`, `WatcherSigninError`, `WatcherChatError`, `configureWatchers`, `resetWatcherEnv`, `WatcherEnv`, `WatcherStatus` (Task 3); `LinkSource`, `FormCandidate`, `ChatMessage` (architecture).
- Produces (adds to contracts):
  - `packages/worker/src/watchers/selectors.ts`: `DiscordSelectorsSchema`, `type DiscordSelectors`, `discordSelectors(): DiscordSelectors` (reads `$TM_SELECTORS_DIR/discord.json`, default directory `/app/config/selectors`, once per process); Task 5 adds the WhatsApp pair.
  - `packages/worker/src/watchers/discord.ts`: `discordReader(channelUrl: string, sel: DiscordSelectors): ChatSourceReader`; `startWatcher(desk: Page, src: LinkSource, onLink: (c: FormCandidate | { meetingUrl: string }) => void): Promise<Stopper>` (architecture).
  - Test helpers, reused by Task 5 and by plan 04: `serveWatcherFixtures(context: BrowserContext, f: { discord?: DiscordFixture; whatsapp?: WhatsAppFixture }): Promise<void>` in `test/watchers/serve.ts`; `watchHarness(over?: Partial<WatcherEnv>)` in `test/watchers/harness.ts`, returning `{ onLink, meeting, forms, delays: { phase: WatchPhase; ms: number }[], statuses, set(over), polls(n): Promise<void> }`, whose sleep records the delay and waits 20 ms, and whose `polls(n)` resolves after `n` more polls.

Starting selector values, from the session's [discord-latest-messages.js](../reference-scripts/browser/discord-latest-messages.js) where it had them; Task 9 checks each on the live site:

```json
{
  "scroller": "[class*=\"messagesWrapper\"] [class*=\"scroller\"]",
  "message": "li[id^=\"chat-messages-\"]",
  "content": "[id^=\"message-content-\"]",
  "username": "[id^=\"message-username-\"]",
  "time": "time[datetime]",
  "channelStart": "[class*=\"emptyChannel\"]",
  "composer": "[role=\"textbox\"][contenteditable=\"true\"]",
  "loginForm": "input[name=\"email\"]"
}
```

Reader behaviour:

- **`open`**: `goto(channelUrl)` unless the desk is already there; wait up to 60 seconds for `scroller`. A final path of `/login`, or a visible `loginForm`, throws `WatcherSigninError('discord.com')`; a final path other than the channel's (Discord redirects channels the member can't see) throws `WatcherChatError('not_found')`; neither within 60 seconds throws `WatcherChatError('not_loaded')`.
- **`history(since)`**: collect the rendered messages by key, then set the scroller's `scrollTop` to 0 and wait up to 3 seconds for older ones, until the oldest collected message is older than `since`, `channelStart` shows, or 40 steps or 60 seconds pass; then scroll to the bottom. Return the messages at or after `since`, ordered by time.
- **`latest`**: a path other than the channel's throws `WatcherChatError('lost')`; a visible `loginForm` throws `WatcherSigninError('discord.com')`; set `scrollTop` to the bottom and return the rendered messages.
- **Message**: `key` is the last `-` part of the item's id; `sender` is the item's `username` text, else the sender of the item before it (Discord drops the name on follow-up messages); `time` is the `datetime` value; `text` is the `content` text; `links` are the absolute `href`s inside `content` only (a reply's quoted parent is outside it); `senderRole` `'unknown'`; `replyTo` null.
- **`startWatcher`** accepts only `{ kind: 'chat', app: 'discord' }` (else a `TypeError`), normalises `chat` with `normaliseDiscordChannelUrl` (null throws `WatcherChatError('not_found')`) and returns `runChatWatcher(desk, discordReader(url, discordSelectors()), onLink)`.

Fixture `channel.html` uses the markup the selectors above match, and reads `window.__fixture = { channelPath, messages: { id, sender, datetime, text, href? }[] }` from an init script. It renders the newest 25 messages; when the scroller reaches the top it prepends the next 25 older after 100 ms and drops rendered items beyond 50 from the bottom; at the oldest it shows the `channelStart` element. A message from the same sender within 5 minutes of the one before renders without a `username`. `window.__addMessage(m)` appends a message (rendered when the list is at the bottom). `window.__touched` becomes true on any click, key or input event in the composer or on a `[data-action]` button (react, reply, mark as read). `login.html` is Discord's sign-in form with `input[name="email"]`. `serveWatcherFixtures` routes `https://discord.com/**` with `context.route`: `/login` gets `login.html`; `__fixture.channelPath` gets `channel.html`, or a 302 to `/login` when `loginRequired` is set; any other `/channels/...` path gets a 302 to `/channels/@me`.

- [x] **Step 1: Write the failing tests**

```ts
// packages/worker/test/watchers/discord.spec.ts
// test.use({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' }); beforeEach: resetWatcherEnv().
// ago(h) is an ISO time h hours before now. CH is https://discord.com/channels/123456789012345678/234567890123456789.
// Z0 to Z5 are https://example.zoom.us/j/0000000000N?pwd=PASSCODE; P is a pasted Zoom link; F2 and F3 are Google Forms links.
// filler(60) is 60 linkless messages from 19 hours to 3 hours ago.
const messages = [
  { id: 'old', sender: 'Rep', datetime: ago(30), text: 'Last week', href: Z0 },
  { id: 'a', sender: 'Rep', datetime: ago(20), text: 'Yesterday', href: Z1 },
  ...filler(60),
  { id: 'b', sender: 'Rep', datetime: ago(2), text: 'Today', href: Z2 },
  {
    id: 'c',
    sender: 'Rep',
    datetime: ago(1),
    text: 'Early form',
    href: 'https://forms.gle/TESTFORM1'
  },
  { id: 'd', sender: 'Rep', datetime: ago(0.2), text: 'See you soon' }
]

test('the 24-hour scan reports only the newest meeting link, without touching the page', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    discord: { channelPath: new URL(CH).pathname, messages }
  })
  const h = watchHarness()
  let navigations = 0
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++
  })
  const stop = await startWatcher(page, { kind: 'chat', app: 'discord', chat: CH }, h.onLink)
  await h.polls(2)
  await stop()
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
  expect(h.forms).toEqual([])
  expect(navigations).toBe(1)
  expect(await page.evaluate(() => (window as any).__touched ?? false)).toBe(false)
})

test('a newer link replaces it and a pasted link overrides both', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    discord: { channelPath: new URL(CH).pathname, messages }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'discord', chat: CH }, h.onLink)
  await page.evaluate(
    (z) =>
      (window as any).__addMessage({
        id: 'e',
        sender: 'Rep',
        datetime: new Date().toISOString(),
        text: 'Corrected',
        href: z
      }),
    Z3
  )
  await h.polls(1)
  h.set({ pastedLink: () => P })
  await h.polls(1)
  await page.evaluate(
    (z) =>
      (window as any).__addMessage({
        id: 'f',
        sender: 'Rep',
        datetime: new Date().toISOString(),
        text: 'Another',
        href: z
      }),
    Z4
  )
  await h.polls(1)
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }, { meetingUrl: Z3 }, { meetingUrl: P }])
})

test('during the meeting form links are reported with their sender, follow-ups included', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    discord: { channelPath: new URL(CH).pathname, messages }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'discord', chat: CH }, h.onLink)
  h.set({
    phase: () => 'during',
    formsSince: () => new Date(Date.now() - 600_000)
  })
  const now = new Date().toISOString()
  await page.evaluate(
    ([f, z, g, t]) => {
      ;(window as any).__addMessage({
        id: 'g',
        sender: 'Lecturer',
        datetime: t,
        text: 'Attendance',
        href: f
      })
      ;(window as any).__addMessage({
        id: 'h',
        sender: 'Lecturer',
        datetime: t,
        text: 'Wrong room',
        href: z
      })
      ;(window as any).__addMessage({
        id: 'i',
        sender: 'Lecturer',
        datetime: t,
        text: 'Second form',
        href: g
      })
    },
    [F2, Z5, F3, now]
  )
  await h.polls(1)
  expect(h.forms.map((c) => [c.url, c.source, c.sender, c.senderRole])).toEqual([
    [F2, 'watched_chat', 'Lecturer', 'unknown'],
    [F3, 'watched_chat', 'Lecturer', 'unknown']
  ])
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
})

test('polls wait 25 to 45 s before the meeting and 12 to 25 s during it', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    discord: { channelPath: new URL(CH).pathname, messages }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'discord', chat: CH }, h.onLink)
  await h.polls(3)
  h.set({ phase: () => 'during' })
  await h.polls(3)
  for (const d of h.delays) expect(d.ms).toBeGreaterThanOrEqual(d.phase === 'before' ? 25_000 : 12_000)
  for (const d of h.delays) expect(d.ms).toBeLessThanOrEqual(d.phase === 'before' ? 45_000 : 25_000)
  expect(new Set(h.delays.map((d) => d.phase))).toEqual(new Set(['before', 'during']))
})

test('a signed-out profile and an unreachable channel reject the start', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    discord: {
      channelPath: new URL(CH).pathname,
      messages,
      loginRequired: true
    }
  })
  const e = await startWatcher(page, { kind: 'chat', app: 'discord', chat: CH }, () => {}).catch((x) => x)
  expect(e).toBeInstanceOf(WatcherSigninError)
  expect(e.host).toBe('discord.com')
  const other = 'https://discord.com/channels/123456789012345678/999999999999999999'
  const e2 = await startWatcher(await context.newPage(), { kind: 'chat', app: 'discord', chat: other }, () => {}).catch(
    (x) => x
  )
  expect([e2 instanceof WatcherChatError, e2.reason]).toEqual([true, 'not_found'])
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/watchers/discord.spec.ts`
Expected: FAIL, cannot resolve `../../src/watchers/discord`.

- [x] **Step 3: Implement `selectors.ts`, `discord.ts`, the fixtures, `serve.ts` and `harness.ts`** (tests live in `packages/worker/test/watchers/` and `test/discord-selectors.test.ts`; `discordSelectors()` is async and cached; specs use `stop.stop()`)

Read each rendered message in one `page.evaluate` call per read, returning plain objects; never `click` or `type` in this reader.

- [x] **Step 4: Run tests to verify they pass**

Run: `bunx playwright test -c packages/worker/playwright.config.ts test/watchers/discord.spec.ts`
Expected: PASS, `5 passed`.

- [x] **Step 5: Commit**

```bash
git add config/selectors/discord.json packages/worker/src/watchers packages/worker/test/watchers packages/worker/test/fixtures/discord docs/TRD.md
git commit -m "feat(worker): add Discord watcher"
```

### Task 5: WhatsApp watcher

**Files:**

- Create: `config/selectors/whatsapp.json`, `packages/worker/src/watchers/whatsapp-time.ts`, `packages/worker/src/watchers/whatsapp.ts`, `packages/worker/test/fixtures/whatsapp/web.html`
- Modify: `packages/worker/src/watchers/selectors.ts`, `packages/worker/test/watchers/serve.ts`
- Test: `packages/worker/src/watchers/whatsapp-time.test.ts`, `packages/worker/test/watchers/whatsapp.spec.ts`

**Interfaces:**

- Consumes: Tasks 3 and 4 (`runChatWatcher`, errors, `serveWatcherFixtures`, `watchHarness`).
- Produces (adds to contracts):
  - `parseWhatsAppPrePlain(attr: string, order: 'dmy' | 'mdy', offsetMinutes: number): { sentAt: string; sender: string; shown: string } | null` in `whatsapp-time.ts`, where `attr` is a message's `data-pre-plain-text` (`[<time>, <date>] <sender>: `), `offsetMinutes` is the page's offset east of UTC and `sentAt` is ISO 8601 UTC;
  - `WhatsAppSelectorsSchema`, `type WhatsAppSelectors`, `whatsappSelectors(): WhatsAppSelectors` in `selectors.ts`;
  - `whatsappReader(chatName: string, sel: WhatsAppSelectors): ChatSourceReader` and `startWatcher` (architecture signature) in `whatsapp.ts`.

Starting selector values (Task 9 checks each on the live site):

```json
{
  "chatList": "#pane-side",
  "searchBox": "#side [contenteditable=\"true\"][role=\"textbox\"]",
  "searchResultTitle": "#pane-side [role=\"listitem\"] span[dir=\"auto\"][title]",
  "headerTitle": "#main header span[dir=\"auto\"]",
  "scroller": "#main [role=\"application\"]",
  "messageRow": "#main div[data-id]",
  "prePlain": ".copyable-text[data-pre-plain-text]",
  "messageText": "span.selectable-text",
  "linkQr": "canvas[aria-label*=\"QR\"]",
  "composer": "footer [contenteditable=\"true\"]"
}
```

Reader behaviour:

- **`open`**: go to `https://web.whatsapp.com/` unless the desk is there; wait up to 60 seconds for `chatList` (else `WatcherChatError('not_loaded')`); a visible `linkQr` throws `WatcherSigninError('web.whatsapp.com')`. Fill `searchBox` with the NFC, trimmed name and wait 3 seconds; compare each `searchResultTitle`'s `title`, also NFC and trimmed, for exact, case-sensitive equality: none throws `WatcherChatError('not_found')`, more than one `WatcherChatError('ambiguous')`, exactly one is clicked. Then fill `searchBox` with `''`, wait up to 10 seconds for `headerTitle` to equal the name (else `not_found`), and read the date order (`dmy` or `mdy`, from `Intl.DateTimeFormat().formatToParts` in the page) and `-new Date().getTimezoneOffset()`.
- **`history(since)`** and **`latest`**: as Discord's, with `scroller` and `messageRow`; `latest` throws `WatcherChatError('lost')` when `headerTitle` no longer equals the name and `WatcherSigninError('web.whatsapp.com')` when `linkQr` shows. Rows without a parseable `prePlain` (system notices, deleted messages) are skipped.
- **Message**: `key` is the row's `data-id`; `sender`, `time` (the `shown` part) and the time used against `since` come from `parseWhatsAppPrePlain`; `text` is the `messageText` text; `links` are the row's absolute `a[href]` values plus `https?://` URLs in the text with trailing `.,;:!?)]` removed, without duplicates.
- **`startWatcher`** accepts only `{ kind: 'chat', app: 'whatsapp' }` (else a `TypeError`) and returns `runChatWatcher(desk, whatsappReader(chat, whatsappSelectors()), onLink)`.

Fixture `web.html` reads `window.__fixture = { mode: 'chats' | 'qr', chats: { name, messages: { id, sender, at, text, href? }[] }[] }`. It renders the chat list, a search box that lists chats whose name contains the typed text (as `searchResultTitle` elements), and on a click the conversation with `headerTitle` and rows whose `data-pre-plain-text` is `[<time>, <date>] <sender>: `, formatted from `at` with the page locale (`en-GB` gives `14:05, 21/10/2026`; `en-US` gives `2:05 PM, 10/21/2026`). It virtualises the rows as Discord's fixture does, and offers `__addMessage(chatName, m)`, `__switchChat(name)` (the member opening another chat) and `__touched` (composer and `[data-action]` buttons only; the search box doesn't count). Mode `qr` shows only the `linkQr` canvas. `serveWatcherFixtures` routes `https://web.whatsapp.com/**` to it.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/watchers/whatsapp-time.test.ts
test.each([
  [
    '[14:05, 21/10/2026] Dr Lecturer: ',
    'dmy',
    {
      sentAt: '2026-10-21T06:05:00.000Z',
      sender: 'Dr Lecturer',
      shown: '14:05, 21/10/2026'
    }
  ],
  [
    '[2:05 pm, 21/10/2026] Dr Lecturer: ',
    'dmy',
    {
      sentAt: '2026-10-21T06:05:00.000Z',
      sender: 'Dr Lecturer',
      shown: '2:05 pm, 21/10/2026'
    }
  ],
  [
    '[2:05 PM, 10/21/2026] +60 12-345 6789: ',
    'mdy',
    {
      sentAt: '2026-10-21T06:05:00.000Z',
      sender: '+60 12-345 6789',
      shown: '2:05 PM, 10/21/2026'
    }
  ],
  [
    '[12:30 am, 01/02/2026] Rep: A: ',
    'dmy',
    {
      sentAt: '2026-01-31T16:30:00.000Z',
      sender: 'Rep: A',
      shown: '12:30 am, 01/02/2026'
    }
  ],
  [
    '[12:00 pm, 01/02/2026] Rep: ',
    'dmy',
    {
      sentAt: '2026-02-01T04:00:00.000Z',
      sender: 'Rep',
      shown: '12:00 pm, 01/02/2026'
    }
  ],
  ['[14:05, 32/10/2026] Rep: ', 'dmy', null],
  ['hello', 'dmy', null]
] as const)('parseWhatsAppPrePlain(%s, %s)', (attr, order, want) =>
  expect(parseWhatsAppPrePlain(attr, order, 480)).toEqual(want)
)
```

```ts
// packages/worker/test/watchers/whatsapp.spec.ts
// test.use({ timezoneId: 'Asia/Kuala_Lumpur', locale: 'en-GB' }) except the last describe, which uses en-US.
// history is the Discord spec's message list (old, a, filler, b, c, d) with `at` for `datetime`; chat(name, msgs = [])
// builds one fixture chat; Z2 and F2 are as in the Discord spec.
test('opens the chat with exactly that name and leaves the search empty', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    whatsapp: {
      mode: 'chats',
      chats: [chat('Class 7A (old)'), chat('class 7a'), chat('Class 7A', history)]
    }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
  expect(await page.textContent(whatsappSelectors().headerTitle)).toBe('Class 7A')
  expect((await page.textContent(whatsappSelectors().searchBox))?.trim()).toBe('')
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
  expect(await page.evaluate(() => (window as any).__touched ?? false)).toBe(false)
})

test('a shared name is ambiguous, a missing one not found, a composed form matches', async ({ context, page }) => {
  // Review Focus
  await serveWatcherFixtures(context, {
    whatsapp: {
      mode: 'chats',
      chats: [chat('Study group'), chat('Study group'), chat('Café')]
    }
  })
  const reason = (name: string) =>
    startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: name }, () => {}).then(
      () => 'ok',
      (e) => e.reason
    )
  expect(await reason('Study group')).toBe('ambiguous')
  expect(await reason('Nope')).toBe('not_found')
  expect(await reason('Café ')).toBe('ok')
})

test('the link-device code means signed out', async ({ context, page }) => {
  await serveWatcherFixtures(context, { whatsapp: { mode: 'qr', chats: [] } })
  const e = await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, () => {}).catch((x) => x)
  expect([e instanceof WatcherSigninError, e.host]).toEqual([true, 'web.whatsapp.com'])
})

test('form links during the meeting carry the WhatsApp sender', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    whatsapp: { mode: 'chats', chats: [chat('Class 7A', history)] }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
  h.set({
    phase: () => 'during',
    formsSince: () => new Date(Date.now() - 600_000)
  })
  await page.evaluate(
    (f) =>
      (window as any).__addMessage('Class 7A', {
        id: 'w1',
        sender: 'Dr Lecturer',
        at: new Date().toISOString(),
        text: `Attendance ${f}`
      }),
    F2
  )
  await h.polls(1)
  expect(h.forms.map((c) => [c.url, c.sender])).toEqual([[F2, 'Dr Lecturer']])
})

test('a chat the member switched away from is reopened, at most 3 times', async ({ context, page }) => {
  await serveWatcherFixtures(context, {
    whatsapp: {
      mode: 'chats',
      chats: [chat('Class 7A', history), chat('Other')]
    }
  })
  const h = watchHarness()
  await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
  await page.evaluate(() => (window as any).__switchChat('Other'))
  await h.polls(1)
  expect(await page.textContent(whatsappSelectors().headerTitle)).toBe('Class 7A')
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).__switchChat('Other'))
    await h.polls(1)
  }
  expect(h.statuses).toEqual([{ kind: 'chat_lost' }])
})

test.describe('US date order', () => {
  test.use({ locale: 'en-US' })
  test('the 24-hour scan still finds the newest link', async ({ context, page }) => {
    await serveWatcherFixtures(context, {
      whatsapp: { mode: 'chats', chats: [chat('Class 7A', history)] }
    })
    const h = watchHarness()
    await startWatcher(page, { kind: 'chat', app: 'whatsapp', chat: 'Class 7A' }, h.onLink)
    expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/watchers/whatsapp-time.test.ts && bunx playwright test -c packages/worker/playwright.config.ts test/watchers/whatsapp.spec.ts`
Expected: FAIL with `Cannot find module './whatsapp-time'`.

- [ ] **Step 3: Implement `whatsapp-time.ts`, `whatsapp.ts`, the selectors, the fixture and the route**

`parseWhatsAppPrePlain` matches `^\[(\d{1,2}):(\d{2})(?:[\s ]*([ap])\.?m\.?)?, (\d{1,2})/(\d{1,2})/(\d{4})\] (.+): $` (case-insensitive), maps 12 am to 0 and 12 pm to 12, rejects impossible dates by round-tripping through `Date.UTC`, and subtracts `offsetMinutes`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/watchers/whatsapp-time.test.ts && bunx playwright test -c packages/worker/playwright.config.ts test/watchers/whatsapp.spec.ts`
Expected: PASS, `7 pass, 0 fail`, then `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add config/selectors/whatsapp.json packages/worker/src/watchers packages/worker/test/watchers packages/worker/test/fixtures/whatsapp docs/TRD.md
git commit -m "feat(worker): add WhatsApp watcher"
```

### Task 6: Link wait, no-link states and run wiring

**Files:**

- Create: `packages/worker/src/watchers/link-wait.ts`, `packages/worker/src/watchers/index.ts`
- Modify: `packages/notify/src/messages.ts`, `packages/core/src/control.ts` (`StateEventData`), `packages/worker/src/run.ts`
- Test: `packages/worker/src/watchers/link-wait.test.ts`, `packages/worker/src/watchers/index.test.ts`, `packages/notify/src/messages.test.ts`

**Interfaces:**

- Consumes: `chooseMeetingLink` (Task 2); `configureWatchers`, `WatcherSigninError`, `WatcherChatError`, `WatcherStatus` (Task 3); both `startWatcher`s (Tasks 4 and 5); `ChatApp` (Task 1); from 01a `resolveFormLink` and the run sequence; from 01b `FormDispatcher`; from 01c `LinkOverride`, `siteLinks`, `DeskPause`, `AccountCheckData`, `StateEventData`, `pings`, `formatWhen`.
- Produces (adds to contracts):

```ts
// packages/worker/src/watchers/link-wait.ts
export const JOIN_FROM_MS = 10 * 60_000 // join from T-10
export const GIVE_UP_AFTER_MS = 30 * 60_000 // stop looking at T+30
export type LinkWaitDecision =
  { kind: 'join'; url: string } | { kind: 'ping_no_link' } | { kind: 'wait' } | { kind: 'give_up' }
export function decideLinkWait(s: {
  now: Date
  start: Date
  link: string | null
  noLinkPinged: boolean
}): LinkWaitDecision
export type LinkChoice = {
  url: string
  source: 'fixed' | 'watched' | 'pasted'
}
export interface LinkWaitDeps {
  start: Date
  now(): Date
  sleep(ms: number): Promise<void>
  fixed: string | null
  watched(): string | null
  pasted(): string | null
  pingNoLink(): Promise<void>
}
export function waitForMeetingLink(d: LinkWaitDeps): Promise<LinkChoice | null> // decides once a second

// packages/worker/src/watchers/index.ts
export function watcherFor(app: ChatApp): typeof import('./discord').startWatcher | null // teams: null until plan 04

// packages/core/src/control.ts
export type StateEventData = {
  state: OccurrenceState
  link?: { source: 'fixed' | 'watched' | 'pasted'; host: string }
} // other plans' optional fields stay
```

`decideLinkWait`, in this order: a link and `now >= start - JOIN_FROM_MS` joins; `now >= start + GIVE_UP_AFTER_MS` gives up; `now >= start` and not yet pinged pings; otherwise wait. `waitForMeetingLink` uses `chooseMeetingLink(d.watched() ?? d.fixed, d.pasted())` and reports the source that supplied the chosen URL.

Ping copy, added to 01c's `pings` (`<start>` and `<until>` are `formatWhen` of T and T+30 in the member's time zone; `<App>` is `WhatsApp`, `Discord` or `Teams`; each action is left out when its URL is null, as in 1A job-file runs):

| Function                                                         | Priority | Title                         | Message                                                                                                                                                                                                                                                                                                                                     | Actions                                               |
| ---------------------------------------------------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `noLink({ entry, start, until, meetingUrl })`                    | high     | `No meeting link: <entry>`    | `<entry> starts at <start> and no meeting link has arrived. Paste it on the meeting page; the bot keeps looking until <until>.`                                                                                                                                                                                                             | `Open meeting page`                                   |
| `noLinkStopped({ entry, until, meetingUrl })`                    | default  | `Not attended: <entry>`       | `No meeting link arrived by <until>, so the bot stopped without joining <entry>.`                                                                                                                                                                                                                                                           | `Open meeting page`                                   |
| `watcherProblem({ entry, app, problem, meetingUrl, signInUrl })` | high     | `Not watching <App>: <entry>` | by `problem`, below                                                                                                                                                                                                                                                                                                                         | `Open meeting page`; `Sign in again` for `signed_out` |
| `watchingOff({ entry, app, gate, meetingUrl, accountsUrl })`     | high     | `Not watching <App>: <entry>` | `home_only`: `<App> is watched only for identities that run at home or on your PC, so the bot won't watch it for <entry>. Paste the meeting link on the meeting page, or change where this identity runs.`; `none`: `WhatsApp watching is switched off, so the bot won't watch it for <entry>. Paste the meeting link on the meeting page.` | `Open meeting page`, `Open accounts`                  |

`watcherProblem` messages:

```text
not_found   The bot couldn't find the chat named on the timetable entry. Check it, and paste the meeting link on the meeting page this time.
ambiguous   More than one WhatsApp chat has the name on the timetable entry. Rename one or change the entry, and paste the meeting link on the meeting page this time.
not_loaded  <App> didn't finish loading within 60 seconds, so the bot isn't watching the chat. Paste the meeting link on the meeting page if one is posted.
lost        The bot lost the chat and stopped watching it. Paste the meeting link on the meeting page if one is posted; forms posted there won't be seen.
signed_out  <App> signed the bot out while it was watching. Sign in again; until then, new links in the chat aren't seen.
```

`run.ts` changes:

- **Start, in `verifying_accounts`**: for a `chat` entry whose `watcherFor(app)` isn't null, call `configureWatchers({ phase, formsSince: () => start - 10 min, pastedLink: () => linkOverride.current(), deskOpen: () => deskPause.whenOpen(), onStatus })`, where `phase` is `'before'` until joining starts, then start the watcher on a new desk tab and emit `AccountCheckData { account: app, signedIn: true }`.
- **Sign-in**: a `WatcherSigninError` emits `{ signedIn: false }` and takes 01c's expired-account path (its "Sign in again" ping, `nextResume()` until T-5, verify again); a second failure leaves the entry with pasted links only, without another ping. A `WatcherChatError` sends `pings.watcherProblem` with its reason, and the entry continues with pasted links only.
- **Links**: `onLink({ meetingUrl })` stores the newest watched link; a `FormCandidate` goes through `resolveFormLink` and, when it resolves, `dispatcher.offer`, the same path as meeting-chat candidates.
- **`watching_for_link`**: `waitForMeetingLink` replaces 01c's race with `linkOverride.next()`; `pingNoLink` sends `pings.noLink`. A choice switches the phase to `'during'`, then emits the `joining` state event with `link: { source, host }` (host only). `null` emits `no_link`, sends `pings.noLinkStopped`, stops the watcher, checkpoints the profile and exits 0 without recording.
- **Status**: `signed_out` sends `pings.watcherProblem('signed_out')` and `AccountCheckData { signedIn: false }`; `signed_in` sends `{ signedIn: true }`; `chat_lost` sends `pings.watcherProblem('lost')`. Each non-ok status also adds an `error` event `{ reason: 'watcher_<kind>' }`.
- **End**: stop the watcher when the worker leaves the meeting for any reason, before the profile checkpoint.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/watchers/link-wait.test.ts
const T = new Date('2026-10-21T06:00:00Z'),
  at = (min: number) => new Date(T.getTime() + min * 60_000),
  L = 'https://example.zoom.us/j/00000000001'
test.each([
  [-60, L, false, { kind: 'wait' }],
  [-10, L, false, { kind: 'join', url: L }],
  [-1, null, false, { kind: 'wait' }],
  [0, null, false, { kind: 'ping_no_link' }],
  [5, null, true, { kind: 'wait' }],
  [29.99, null, true, { kind: 'wait' }],
  [30, null, true, { kind: 'give_up' }],
  [30, L, true, { kind: 'join', url: L }]
] as const)('at T + %p min, link %p, pinged %p', (min, link, noLinkPinged, want) =>
  expect(decideLinkWait({ now: at(min), start: T, link, noLinkPinged })).toEqual(want)
)

// fakeClock(startMin) gives now() and a sleep(ms) that advances it; deps(over) builds LinkWaitDeps on it with start T,
// no links, and a pingNoLink that records the clock in `pinged`.
test('a watched link from T-30 is joined at T-10', async () => {
  const d = deps({ clock: fakeClock(-60), watched: () => L })
  expect(await waitForMeetingLink(d)).toEqual({ url: L, source: 'watched' })
  expect(d.clock.now()).toEqual(at(-10))
})

test('a paste beats watched and fixed links', async () => {
  const P = 'https://example.zoom.us/j/00000000002'
  expect(await waitForMeetingLink(deps({ clock: fakeClock(-12), watched: () => L, pasted: () => P }))).toEqual({
    url: P,
    source: 'pasted'
  })
  expect(await waitForMeetingLink(deps({ clock: fakeClock(-12), fixed: L, pasted: () => P }))).toEqual({
    url: P,
    source: 'pasted'
  })
})

test('no link: one ping at T, then null at T+30', async () => {
  const d = deps({ clock: fakeClock(-60) })
  expect(await waitForMeetingLink(d)).toBeNull()
  expect(d.pinged).toEqual([at(0)])
  expect(d.clock.now()).toEqual(at(30))
})

test('a link pasted at T+12 is joined at once', async () => {
  const d = deps({ clock: fakeClock(-1) })
  d.pasted = () => (d.clock.now() >= at(12) ? L : null)
  expect(await waitForMeetingLink(d)).toEqual({ url: L, source: 'pasted' })
  expect([d.clock.now(), d.pinged.length]).toEqual([at(12), 1])
})
```

```ts
// packages/worker/src/watchers/index.test.ts
test('each chat app has its watcher; Teams arrives with plan 04', () => {
  expect(watcherFor('discord')).toBe(discord.startWatcher)
  expect(watcherFor('whatsapp')).toBe(whatsapp.startWatcher)
  expect(watcherFor('teams')).toBeNull()
})
```

```ts
// packages/notify/src/messages.test.ts (added)
test('no-link and watcher copy', () => {
  const meetingUrl = 'https://tm.example/meetings/o1'
  expect(
    pings.noLink({
      entry: 'Data Mining',
      start: 'Wed 21 Oct, 14:00',
      until: 'Wed 21 Oct, 14:30',
      meetingUrl
    })
  ).toEqual({
    title: 'No meeting link: Data Mining',
    message:
      'Data Mining starts at Wed 21 Oct, 14:00 and no meeting link has arrived. Paste it on the meeting page; the bot keeps looking until Wed 21 Oct, 14:30.',
    priority: 'high',
    actions: [{ label: 'Open meeting page', url: meetingUrl }]
  })
  expect(
    pings.noLinkStopped({
      entry: 'Data Mining',
      until: 'Wed 21 Oct, 14:30',
      meetingUrl: null
    })
  ).toEqual({
    title: 'Not attended: Data Mining',
    message: 'No meeting link arrived by Wed 21 Oct, 14:30, so the bot stopped without joining Data Mining.',
    priority: 'default'
  })
  const p = pings.watcherProblem({
    entry: 'Data Mining',
    app: 'whatsapp',
    problem: 'signed_out',
    meetingUrl,
    signInUrl: 'https://tm.example/accounts/i1/signin'
  })
  expect([p.title, p.priority, p.actions?.map((a) => a.label)]).toEqual([
    'Not watching WhatsApp: Data Mining',
    'high',
    ['Open meeting page', 'Sign in again']
  ])
  expect(p.message).toBe(
    "WhatsApp signed the bot out while it was watching. Sign in again; until then, new links in the chat aren't seen."
  )
  expect(
    pings.watchingOff({
      entry: 'Data Mining',
      app: 'whatsapp',
      gate: 'none',
      meetingUrl,
      accountsUrl: 'https://tm.example/accounts'
    }).message
  ).toBe(
    "WhatsApp watching is switched off, so the bot won't watch it for Data Mining. Paste the meeting link on the meeting page."
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/watchers/link-wait.test.ts packages/worker/src/watchers/index.test.ts packages/notify/src/messages.test.ts`
Expected: FAIL with `Cannot find module './link-wait'`.

- [ ] **Step 3: Implement `link-wait.ts`, `index.ts` and the ping builders, then wire `run.ts` as listed**

- [ ] **Step 4: Run tests and the type check to verify they pass**

Run: `bun test packages/worker/src/watchers packages/notify && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src packages/notify/src packages/core/src/control.ts docs/TRD.md
git commit -m "feat(worker): wait for links and ping no-link"
```

### Task 7: Link-source fields and the ban-risk notice

**Files:**

- Create: `packages/web/lib/link-notices.ts`, `packages/web/app/timetable/ban-risk-notice.tsx`
- Modify: `packages/web/lib/timetable.ts` (`ChatLinkSchema`, the chat refinement, `saveEntry`, `EntryDeps`), `packages/web/app/timetable/[id]/page.tsx`, `packages/web/app/timetable/actions.ts` (passes `gate`)
- Test: `packages/web/lib/link-notices.test.ts`, `packages/web/app/timetable/ban-risk-notice.test.tsx`, `packages/web/lib/timetable.test.ts` (replaces 01c's "refused until link watchers exist" test)

**Interfaces:**

- Consumes: `normaliseDiscordChannelUrl`, `WatchGate`, `watchGateFromEnv`, `chatWatchAllowed`, `ChatApp` (Task 1); from 01c `ChatLinkSchema`, `EntryInputSchema`, `saveEntry`, `EntryDeps`, `MemberScope`.
- Produces (adds to contracts), `packages/web/lib/link-notices.ts`:

```ts
export const BAN_RISK_NOTICE: string
export const TRUSTED_SENDERS_CHAT_HINT: string
export const CHAT_FIELD_COPY: Record<'whatsapp' | 'discord', { label: string; placeholder: string; hint: string }>
export function showsBanRiskNotice(link: LinkSource): boolean // chat sources on WhatsApp or Discord
export function watchingNotAllowedMessage(app: ChatApp, gate: WatchGate): string
export function chatAppOptions(
  runLocation: RunLocation,
  gate: WatchGate
): { app: 'whatsapp' | 'discord'; enabled: boolean; note: string | null }[]
export class WatchingNotAllowedError extends Error {} // message from watchingNotAllowedMessage
```

- Produces: `BanRiskNotice(): JSX.Element` (a `<p role="note">` holding `BAN_RISK_NOTICE`); `EntryDeps` gains `gate: WatchGate` (adds to contracts).

Copy (exact):

```text
BAN_RISK_NOTICE            WhatsApp and Discord don't allow automated use of personal accounts. The bot only reads this chat: it opens it, checks it every 12 to 45 seconds, and never sends, reacts or replies. That lowers the risk of your account being restricted or banned, but doesn't remove it. If that risk isn't acceptable, use a fixed link or paste the link instead.
TRUSTED_SENDERS_CHAT_HINT  For a watched chat, enter each sender as the chat shows them: in WhatsApp, their saved contact name, or their phone number if you haven't saved it.
whatsapp label             WhatsApp chat name
whatsapp placeholder       Class group name
whatsapp hint              Type the name exactly as WhatsApp shows it, including capitals and emoji. Only one of your chats may have this name.
discord label              Discord channel address
discord placeholder        https://discord.com/channels/<server>/<channel>
discord hint               Open the channel in Discord in a browser and copy the address bar.
not allowed, home_only     <App> is watched only for identities that run at home or on your PC. Change where this identity runs, or choose another link source.
not allowed, none          WhatsApp watching is switched off. Choose another link source.
```

Schema and save rules:

- `ChatLinkSchema`: a Discord `chat` is replaced by `normaliseDiscordChannelUrl(chat)`, and null fails with `Paste the channel's address, such as https://discord.com/channels/<server>/<channel>.`; a WhatsApp `chat` is NFC-normalised and trimmed, 1 to 100 characters without line breaks, else `Type the chat's name exactly as WhatsApp shows it.`; Teams is unchanged.
- The 1C refinement now refuses only `app: 'teams'`, with `Watching a Teams chat arrives with Teams support.` (plan 04 removes it).
- `saveEntry` loads the identity's run location and throws `WatchingNotAllowedError` when `chatWatchAllowed(app, runLocation, deps.gate)` is false.
- The entry form shows the chat field with `CHAT_FIELD_COPY`, the app choice from `chatAppOptions` (a disabled option shows its `note`), `BanRiskNotice` whenever `showsBanRiskNotice` is true, and `TRUSTED_SENDERS_CHAT_HINT` under trusted senders for chat sources. `actions.ts` passes `gate: watchGateFromEnv(process.env)`.

- [x] **Step 1: Write the failing tests**

```ts
// packages/web/lib/link-notices.test.ts
test('the ban-risk notice shows for WhatsApp and Discord only', () => {
  expect(showsBanRiskNotice({ kind: 'chat', app: 'whatsapp', chat: 'Class group' })).toBe(true)
  expect(
    showsBanRiskNotice({
      kind: 'chat',
      app: 'discord',
      chat: 'https://discord.com/channels/@me/234567890123456789'
    })
  ).toBe(true)
  expect(
    showsBanRiskNotice({
      kind: 'chat',
      app: 'teams',
      chat: 'https://teams.microsoft.com/l/chat/x'
    })
  ).toBe(false)
  expect(showsBanRiskNotice({ kind: 'paste' })).toBe(false)
  expect(BAN_RISK_NOTICE).toStartWith("WhatsApp and Discord don't allow automated use of personal accounts.")
})

test('app options follow the gate and the run location', () => {
  expect(chatAppOptions('server', { whatsapp: 'home_only', discord: 'allowed' })).toEqual([
    {
      app: 'whatsapp',
      enabled: false,
      note: 'WhatsApp is watched only for identities that run at home or on your PC. Change where this identity runs, or choose another link source.'
    },
    { app: 'discord', enabled: true, note: null }
  ])
  expect(chatAppOptions('local', { whatsapp: 'home_only', discord: 'allowed' })[0].enabled).toBe(true)
  expect(chatAppOptions('local', { whatsapp: 'none', discord: 'allowed' })[0].note).toBe(
    'WhatsApp watching is switched off. Choose another link source.'
  )
})
```

```tsx
// packages/web/app/timetable/ban-risk-notice.test.tsx
test('renders the notice as a note', () => {
  const html = renderToStaticMarkup(<BanRiskNotice />)
  expect(html).toContain('role="note"')
  expect(html).toContain('never sends, reacts or replies')
})
```

```ts
// packages/web/lib/timetable.test.ts (replaces "a chat link source is refused until link watchers exist")
test('chat sources are normalised; Teams waits for plan 04', () => {
  const d = EntryInputSchema.parse({
    ...base,
    identityId: ID,
    link: {
      kind: 'chat',
      app: 'discord',
      chat: 'https://ptb.discord.com/channels/123456789012345678/234567890123456789/345678901234567890'
    }
  })
  expect(d.link).toEqual({
    kind: 'chat',
    app: 'discord',
    chat: 'https://discord.com/channels/123456789012345678/234567890123456789'
  })
  expect(
    EntryInputSchema.parse({
      ...base,
      identityId: ID,
      link: { kind: 'chat', app: 'whatsapp', chat: ' Café group ' }
    }).link
  ).toEqual({ kind: 'chat', app: 'whatsapp', chat: 'Café group' })
  expect(
    EntryInputSchema.safeParse({
      ...base,
      identityId: ID,
      link: { kind: 'chat', app: 'whatsapp', chat: 'two\nlines' }
    }).error?.issues[0].message
  ).toBe("Type the chat's name exactly as WhatsApp shows it.")
  expect(
    EntryInputSchema.safeParse({
      ...base,
      identityId: ID,
      link: {
        kind: 'chat',
        app: 'teams',
        chat: 'https://teams.microsoft.com/l/chat/x'
      }
    }).error?.issues[0].message
  ).toBe('Watching a Teams chat arrives with Teams support.')
})

test('saving a WhatsApp chat on a server identity follows the gate', async () => {
  const { scope, identityId, deps } = await bareWithDeps() // the identity runs on the server
  const entry = {
    ...base,
    identityId,
    link: { kind: 'chat', app: 'whatsapp', chat: 'Class group' }
  }
  await expect(
    saveEntry(scope, entry, {
      ...deps,
      gate: { whatsapp: 'home_only', discord: 'allowed' }
    })
  ).rejects.toThrow(WatchingNotAllowedError)
  await expect(
    saveEntry(scope, entry, {
      ...deps,
      gate: { whatsapp: 'allowed', discord: 'allowed' }
    })
  ).resolves.toMatchObject({ clashes: [] })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/link-notices.test.ts packages/web/app/timetable/ban-risk-notice.test.tsx packages/web/lib/timetable.test.ts`
Expected: FAIL with `Cannot find module './link-notices'`.

- [ ] **Step 3: Implement `link-notices.ts`, `ban-risk-notice.tsx` and the schema, save and form changes** (lib, schema, save and action wiring done; `ban-risk-notice.tsx`, its test and the `[id]/page.tsx` form are deferred: Figma gate)

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/link-notices.test.ts packages/web/app/timetable/ban-risk-notice.test.tsx packages/web/lib/timetable.test.ts && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/web/lib packages/web/app/timetable docs/TRD.md
git commit -m "feat(web): add chat link sources and notice"
```

### Task 8: Gate in identities, sign-in and launch

**Files:**

- Modify: `packages/core/src/control.ts` (`SpecEnv`), `packages/web/lib/link-notices.ts` (`signinNotes`), `packages/web/lib/identities.ts` (`updateIdentity`), `packages/web/app/accounts/[identityId]/signin/page.tsx`, `packages/scheduler/src/launch.ts`, the code that builds `SpecEnv` in `packages/scheduler` and `packages/web/db`, `docker/compose.yaml` (`web` and `scheduler` environment), `.env.example`
- Test: `packages/web/lib/link-notices.test.ts`, `packages/web/lib/identities.test.ts`, `packages/scheduler/src/launch.test.ts` (and 01c's `launchFixture`, which gains a `watchGate` option)

**Interfaces:**

- Consumes: `WatchGate`, `watchGateFromEnv`, `chatWatchAllowed`, `gateLinkSource` (Task 1); `pings.watchingOff` (Task 6); `BAN_RISK_NOTICE` (Task 7); from 01c `updateIdentity`, `InUseError`, `launchOccurrence`, `buildEntrySnapshot`, `SpecEnv`, `Notifier`.
- Produces (adds to contracts): `SpecEnv.watchGate: WatchGate` (from `watchGateFromEnv(process.env)` wherever `SpecEnv` is built); `signinNotes(runLocation: RunLocation, gate: WatchGate): { whatsapp: string; discord: string }`; `updateIdentity(scope, id, input, gate = watchGateFromEnv(process.env))`.

Rules:

- **Identity settings**: `updateIdentity` refuses a run-location change after which `chatWatchAllowed` would be false for any unpaused entry of that identity, with `InUseError('This identity has entries that watch <App>, which is watched only at home or on your PC. Change those entries first.')`. Until plan 08 enables other run locations this can't trigger in the app, but plan 08 relies on it.
- **Sign-in page**: the WhatsApp and Discord lines of 01c's list come from `signinNotes`, followed by `BAN_RISK_NOTICE`.
- **Launch**: in `launchOccurrence` step 6, apply `gateLinkSource(snapshot.link, identity.runLocation, deps.env.watchGate)` to the snapshot before it is stored; when `blockedApp` is set, send `pings.watchingOff` with the meeting page and Accounts URLs. The occurrence then runs as a pasted-link entry. This covers a gate tightened after an entry was saved.
- **Deployment**: `TM_WHATSAPP_FROM_SERVER` and `TM_DISCORD_FROM_SERVER` are set on `web` and `scheduler` in `docker/compose.yaml` from `.env`, and their values are copied from `watchers.whatsappFromServer` and `watchers.discordFromServer` in `spikes/DECISIONS.md`.

`signinNotes` copy (exact):

```text
whatsapp, allowed    WhatsApp Web: on your phone, open WhatsApp, then Settings, Linked devices, Link a device, and scan the code shown here. WhatsApp allows 4 linked devices and this uses one. Wait until your chats appear before pressing Done. If WhatsApp later unlinks the bot, you'll get a "Sign in again" ping.
whatsapp, home_only  Don't link WhatsApp here: this identity runs on the server, and WhatsApp is watched only for identities that run at home or on your PC.
whatsapp, none       WhatsApp watching is switched off, so there's no need to link it.
discord, allowed     Discord: sign in at discord.com in this view. If Discord asks for a code from your phone or email, enter it here; the bot never signs in for you.
discord, home_only   Don't sign in to Discord here: this identity runs on the server, and Discord is watched only for identities that run at home or on your PC.
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/link-notices.test.ts (added)
test('sign-in notes follow the gate', () => {
  const home = { whatsapp: 'home_only', discord: 'allowed' } as const
  expect(signinNotes('server', home).whatsapp).toStartWith("Don't link WhatsApp here")
  expect(signinNotes('local', home).whatsapp).toStartWith('WhatsApp Web: on your phone')
  expect(signinNotes('server', { whatsapp: 'none', discord: 'home_only' })).toEqual({
    whatsapp: "WhatsApp watching is switched off, so there's no need to link it.",
    discord:
      "Don't sign in to Discord here: this identity runs on the server, and Discord is watched only for identities that run at home or on your PC."
  })
})
```

```ts
// packages/web/lib/identities.test.ts (added). withChatEntry(opts) seeds a member whose identity has run_location
// opts.runLocation (written directly, past the 1C schema) and one unpaused entry with opts.link.
test('moving an identity to the server is refused while it has WhatsApp-watched entries', async () => {
  const { scope, identityId } = await withChatEntry({
    runLocation: 'local',
    link: { kind: 'chat', app: 'whatsapp', chat: 'Class group' }
  })
  const input = {
    name: 'University',
    runLocation: 'server',
    zoomGuestName: 'A Member'
  }
  await expect(
    updateIdentity(scope, identityId, input, {
      whatsapp: 'home_only',
      discord: 'allowed'
    })
  ).rejects.toThrow(
    'This identity has entries that watch WhatsApp, which is watched only at home or on your PC. Change those entries first.'
  )
  await expect(
    updateIdentity(scope, identityId, input, {
      whatsapp: 'allowed',
      discord: 'allowed'
    })
  ).resolves.toBeUndefined()
})
```

```ts
// packages/scheduler/src/launch.test.ts (added)
test('a WhatsApp chat the gate refuses launches as a pasted-link entry, with a ping', async () => {
  const f = await launchFixture({
    link: { kind: 'chat', app: 'whatsapp', chat: 'Class group' },
    watchGate: { whatsapp: 'home_only', discord: 'allowed' }
  })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  expect((await f.job0()).entry.link).toEqual({ kind: 'paste' })
  expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Not watching WhatsApp: Data Mining'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/link-notices.test.ts packages/web/lib/identities.test.ts packages/scheduler/src/launch.test.ts`
Expected: FAIL with `signinNotes is not a function` (and the identity and launch tests failing on their assertions).

- [ ] **Step 3: Implement the rules above, and add the two variables to `docker/compose.yaml` and `.env.example`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web packages/scheduler && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/control.ts packages/web packages/scheduler docker/compose.yaml .env.example docs/TRD.md
git commit -m "feat: apply spike 7 watch gate"
```

### Task 9: Milestone acceptance

**Files:**

- Modify: `config/selectors/discord.json`, `config/selectors/whatsapp.json` and the two fixtures, only where step 1 finds a difference
- Create: `docs/plans/02-acceptance.md` (dated results of each step)

**Interfaces:**

- Consumes: everything above, deployed with plan 01c's Compose stack; a TolongLabs test Discord server with a channel, a WhatsApp test group made with a second phone (as in spike 7), a Zoom test meeting hosted from a second account, and a two-question Google Form with an attendance confirmation.
- Produces: the plan's exit evidence. These runs use only test accounts, test chats and test meetings; any warning from WhatsApp or Discord stops the run at once with no retry (anti-goal 3).

- [ ] **Step 1: Check the selectors on the live sites**

With the member's identity signed in to Discord and linked to WhatsApp (step 2), open each app in a sign-in view and evaluate every selector of both JSON files in the desk tab's console. Pass: each matches what its key names (for example `message` matches each message item, `searchResultTitle` only chat names). Fix the JSON and the fixture together, and rerun Tasks 4 and 5's specs until they pass.

- [ ] **Step 2: Link WhatsApp through the remote sign-in view**

With `TM_WHATSAPP_FROM_SERVER` as spike 7 decided, open Accounts, "Sign in" for the identity, and follow the WhatsApp note (if the gate refuses this identity, the note must say so; then use an identity that runs at home, after plan 08, or skip the WhatsApp steps). Pass: the phone lists one new linked device; after "Done" and the next worker run, the Accounts page shows WhatsApp Web signed in; the recording of any meeting running meanwhile shows no part of the view.

- [ ] **Step 3: Newest link, correction and paste (Discord)**

Make a lecture entry 20 minutes ahead with the channel as its link source. Post a Zoom link to a different test meeting at T-50, then the correct one at T-20; in a second run, post a link at T-40 and paste another on the meeting page at T-15. Pass: the bot joins the T-20 link (first run) and the pasted link (second run) between T-10 and T-5, the `joining` state event shows `source` and the host only, and no ping or log line contains a passcode.

- [ ] **Step 4: No link**

Make an entry with the channel as its source and post nothing. Pass: "No meeting link" arrives within 60 seconds of T at high priority; at T+30 the meeting page shows `no_link` and "Not attended" arrives. In a second run, paste a link at T+12. Pass: the bot joins within 60 seconds of the paste, and only one "No meeting link" ping was sent.

- [ ] **Step 5: Form links in a watched chat (WhatsApp)**

With the test group as the link source and the second phone's contact name in trusted senders, post the meeting link before T-10, then the attendance form link from the second phone during the meeting, and later the same form from a third account that isn't trusted. Pass, matching the design's "Form fixture" and "Unsafe form" (untrusted sender) tests: the trusted post is submitted within 2 minutes with its ping; the untrusted one gets "form seen, not submitted" within 30 seconds; the form record shows source `watched_chat` and the sender's name.

- [ ] **Step 6: Read-only and kept open**

Across steps 3 to 5, check from the second account and phone. Pass: no message, reaction, reply or typing indicator ever came from the member, and WhatsApp shows only read receipts. During a sign-in pause, scroll the watched chat up in the view and wait 2 minutes. Pass: it stays where the member left it until "Done".

- [ ] **Step 7: Sign-out, restart and gate**

During a watched meeting: unlink the bot's device on the phone (pass: "Not watching WhatsApp ... signed the bot out" within 2 polls, recording continues); in another, `docker kill` the worker after a form was submitted (pass, matching the design's "Crash" test: attempt 2 rejoins the same meeting, doesn't resubmit the form or offer older chat forms, and pings once); set `TM_WHATSAPP_FROM_SERVER=home_only` and launch a WhatsApp entry on a server identity (pass: "Not watching WhatsApp" at T-60 and the entry waits for a paste).

- [ ] **Step 8: Two weeks of use**

Use Discord and WhatsApp watching for every test meeting over 2 weeks, at least 6 meetings. Pass: no warning, verification demand, unlinking or ban notice from either app, by app, email or phone; `docker stats` peaks stay within spike 6's per-worker limits with two watcher tabs open.

- [ ] **Step 9: Record and commit**

Write each step's date, result and evidence (event ids, ping times, no screenshots of other people) to `docs/plans/02-acceptance.md`.

```bash
git add docs/plans/02-acceptance.md config/selectors packages/worker/test/fixtures
git commit -m "docs: record link watcher acceptance"
```
