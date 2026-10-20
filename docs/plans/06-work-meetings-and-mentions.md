# Work meetings and mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give work meetings their own short summary, ping the member at high priority when their name is spoken in a live-transcribed meeting, and let the member make the bot leave or take over from it, from a ping or the website, with the bot always out of the meeting before the member's link opens.

**Architecture:** The pipeline gains a work-meeting inventory and renderer beside 1A's lecture pair, chosen by the entry type. The worker matches each live transcript result against the member's normalised names, debounced, and pings with the last 30 seconds of transcript. Ping buttons open authenticated website pages whose button queues `leave_now` or `take_over` through plan 01c's `pending_commands`; the worker leaves, confirms it is out (closing the stage page if it must), reports `left_by_member`, and the take-over page then opens the meeting link it was given before the bot left.

**Tech Stack:** TypeScript (strict), Bun 1.x, `bun test`, zod, Playwright on Node 24 (worker), Next.js App Router with server actions, React server rendering for component tests, DashScope through 1A's `chatJson`, self-hosted ntfy.

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Contract additions](#contract-additions)
1.  [Tasks](#tasks)
    1.  [Task 1: Work-meeting summary](#task-1-work-meeting-summary)
    1.  [Task 2: Name matching](#task-2-name-matching)
    1.  [Task 3: Mention alerts in the worker](#task-3-mention-alerts-in-the-worker)
    1.  [Task 4: Leaving and taking over in the worker](#task-4-leaving-and-taking-over-in-the-worker)
    1.  [Task 5: Leave and take-over pages](#task-5-leave-and-take-over-pages)
    1.  [Task 6: Milestone acceptance](#task-6-milestone-acceptance)

## Global Constraints

- **Work template**: exactly the design's work-meeting template; empty sections are left out; at most 5 items per section, most urgent first; action items that don't fit go under `More deadlines` (uncapped, after `Open questions`), as 1A's lecture renderer does with tasks; owners only as spoken, with no speaker identification.
- **Work defaults already built**: work entries default to native transcription and show `EMPLOYER_NOTICE` next to the transcription choice, delivered by plan 01c Task 10 (`EntryInputSchema` and the entry form). This plan doesn't rebuild them; Task 6 only checks them.
- **Mentions**: live transcription mode only, and only when the member has names on My details (`mention_names`); names and transcript text are compared after `normaliseName` (compatibility decomposition, accents removed, lower case, anything but letters and digits becomes a space, spaces collapsed), as whole-word sequences; names shorter than 2 characters after normalisation are ignored.
- **Mention ping**: high priority, at most one per 2 minutes per worker attempt (`MENTION_DEBOUNCE_MS = 120_000`), with the last 30 seconds of transcript cut to its final 1,500 characters, and the buttons "Open meeting page" and "Take over". Every match is still logged as a `mention` event with its offset only. The bot never responds in the meeting.
- **Commands**: ping buttons are ntfy `view` actions that open website pages; opening a page never acts; the page's button (a server action) queues `leave_now` or `take_over` only for the member's own occurrence while it is in `ACTIVE_STATES`.
- **Take over**: the worker leaves first, confirms within 10 seconds that it is no longer in the meeting (otherwise closes the stage page), and only then reports `left_by_member`; the page opens the meeting link only after it sees that state, or after 60 seconds if the member chooses to open it anyway.
- **Passcodes**: the full meeting link (passcode included) reaches the browser only in the take-over action's response to the owning member (session, and Next's same-origin check on server actions). The server builds it from the occurrence's `entry_snapshot` fixed link or its `pasted_link`, whichever names the meeting the bot joined (`link_used`, passcode already cut); it is never stored anywhere new and never appears in ping text, URL query strings of the app's own API, events or logs. When the bot joined a link from a watched chat, which the server does not hold, the response carries the masked link (host and meeting id) and `passcodeFromChat: true`, and the page tells the member to enter the passcode from the chat. The meeting page shows only the host and meeting id of the joined link.
- **Pings**: at most 3 actions each (ntfy's limit); wording exactly as in the tasks; times through `formatWhen` in the member's time zone.
- **Copy and commits**: plain British English; conventional commits with headers of at most 50 characters; each task's commit copies its "adds to contracts" names into `docs/TRD.md`.

## Review Focus

- **The name inside another word, or in other capitals or accents** ("Aisyahrani", "AISYAH", "Zoë" heard as "Zoe"): only whole-word matches after normalisation ping. Test in Task 2.
- **A roll call that repeats the name** ("Aisyah? Aisyah, are you there?") across several transcript results, or a speech-recognition reconnect that repeats text: one ping, not several. Test in Task 3.
- **"Take over" pressed twice, after the bot already left, or for another member's meeting**: the second press changes nothing, a finished meeting says the bot isn't there, and another member's meeting is not found. Test in Task 5.
- **A leave click that doesn't take effect** (a hidden confirmation or a frozen page): the member must not join while the bot is still in, or Zoom disconnects one of them; the worker closes the stage page before it reports leaving. Test in Task 4.
- **A pasted link replaced the entry's fixed link, then the member takes over**: the page must open the link the bot actually joined, not the stale one stored at launch. Tests in Tasks 4 and 5.

## Contract additions

Names this plan adds to [architecture and contracts](../TRD.md), copied there by the task that creates them:

- **Pipeline**: `WorkInventorySchema`, `WorkInventory`, `buildWorkInventory`, `renderWorkSummary`, `pickDoNext` (`packages/pipeline/src/summary/work.ts`); `chooseDue` widened to `Pick<InventoryItem, 'source' | 'due' | 'conflicts'>`.
- **Core**: `normaliseName` (`packages/core/src/names.ts`); `StateEventData.command`; `Heartbeat.linkUsed`.
- **Worker**: `compileNames`, `findMention`, `transcriptWindow` (`src/mentions/match.ts`); `MENTION_DEBOUNCE_MS`, `startMentionWatch` (`src/mentions/watch.ts`); `LiveAsrOptions.onResult`; `leaveMeeting` (`src/control/leave.ts`); `siteLinks(cfg).leave` and `.takeOver`.
- **Pings**: `pings.nameMentioned`, and the joined ping's two extra actions.
- **Website**: `takeOver` (`packages/web/lib/meeting.ts`); pages `/meetings/<id>/leave` and `/meetings/<id>/take-over`; `GET /api/meetings/<id>/state`.

Assumed from earlier plans (use their real names if they differ, and fix this plan in the same commit):

- **Plan 01a**: `InventorySchema`, `InventoryItem`, `chooseDue`, `buildInventory`, `renderLectureSummary`, `runPipeline` and the summary system prompt's style (`packages/pipeline/src/summary/`); `localParts`; `chatJson`; `startLiveAsr`, `LiveAsrOptions`, `AsrResult` (recording-relative in `live.jsonl`); `PlatformAdapter.leave` and `meetingState`; the run sequence in `packages/worker/src/run.ts`.
- **Plan 01c**: `pings`, `formatWhen`; `siteLinks`, `dispatchCommands`, `startHeartbeat` and the `leave` path in `run.ts` (Task 16); `handleHeartbeat` in `packages/web/lib/control.ts`; `StateEventData`; `ACTIVE_STATES`; `MemberScope`, `scopeForAuthUser`; `makeBotLeave`, `meetingData` and `InUseError` (`packages/web/lib/meeting.ts`, `packages/web/lib/identities.ts`); the meeting page `packages/web/app/meetings/[id]/page.tsx`; `createTestDb`, `seedMember` and the `meetingFixture` and `controlFixture` test helpers; `EntryInputSchema` and `EMPLOYER_NOTICE` (`packages/web/lib/timetable.ts`).

---

## Tasks

### Task 1: Work-meeting summary

**Files:**

- Create: `packages/core/src/names.ts`, `packages/pipeline/src/summary/work.ts`
- Modify: `packages/pipeline/src/summary/render.ts` (`chooseDue`'s parameter type), `packages/pipeline/src/pipeline.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/names.test.ts`, `packages/pipeline/src/summary/work.test.ts`, `packages/pipeline/src/pipeline.test.ts` (added case)

**Interfaces:**

- Consumes: 1A's `InventorySchema` (its `Source` enum and `due` rule), `chooseDue`, `buildInventory`'s four-section user turn, `renderLectureSummary`'s due text and title line, `localParts`, `chatJson`, `runPipeline`; `JobConfig` (architecture).
- Produces (adds to contracts):

```ts
// packages/core/src/names.ts
export function normaliseName(s: string): string // NFKD, strip \p{M}, lower case, [^\p{L}\p{N}]+ -> ' ', trim

// packages/pipeline/src/summary/work.ts
export const WorkInventorySchema = z.object({
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      owner: z.string().nullable(), // as spoken; null when nobody was named
      task: z.string(),
      due: Due.nullable(), // 1A's due rule, in the entry's time zone
      source: Source,
      ref: z.string().nullable(),
      conflicts: z.array(
        z.object({
          source: Source,
          due: z.string().nullable(),
          text: z.string()
        })
      )
    })
  ),
  discussed: z.array(z.string()),
  openQuestions: z.array(z.string())
})
export type WorkInventory = z.infer<typeof WorkInventorySchema>
export function buildWorkInventory(
  cfg: JobConfig,
  src: { transcriptMd: string; slides: Slide[]; chat: ChatMessage[] }
): Promise<WorkInventory>
export function pickDoNext(inv: WorkInventory, memberNames: string[]): WorkInventory['actionItems'][number] | null
export function renderWorkSummary(
  inv: WorkInventory,
  ctx: { cfg: JobConfig; meetingUrl: string | null; outDir: string }
): string
```

Rules:

- `buildWorkInventory` makes one `chatJson(cfg.ai, cfg.ai.models.summary, ..., WorkInventorySchema, 180_000)` call with thinking off. Its user turn is 1A's four sections with `## Host chat` (host and co-host messages) in place of `## Lecturer chat`. The system prompt (exact copy):

```text
You extract an inventory from one work meeting. Reply with JSON for the given schema and nothing else.
- List every decision, action item, discussion point and open question from the slides, the chat and the transcript. Do not cap or merge the lists.
- "owner": the person named as responsible, written exactly as they were named; null when nobody was named. Never guess an owner.
- Sources rank: slide text first, then the host's chat messages, then speech. Put the highest-ranked source in "source" and "due".
- When sources disagree on a date or detail, keep the item once and list each other version in "conflicts".
- Dates are "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the meeting's time zone, resolved against the meeting date <YYYY-MM-DD>. Use null when no date was given; never guess one.
- Order each list by importance, most important first.
- Do not add a preamble, a recap or advice.
```

- `pickDoNext` takes the action items whose `normaliseName(owner)` equals `normaliseName` of one of `memberNames`, and returns the one with the earliest due date from `chooseDue` (undated last), or null.
- `renderWorkSummary` writes the design's work template: the title line as 1A's lecture title without a session label; `Do next: <task> (<due text>)` for `pickDoNext(inv, [...cfg.member.mentionNames, cfg.member.displayName])`, else `Do next: nothing assigned to you in this meeting`; `Decisions`, `What was discussed` and `Open questions` with their first 5 items; `Action items` sorted by due date (undated last), first 5, each `<owner>: <task> (<due text>)`, without `<owner>: ` when the owner is null and without the brackets when undated; `More deadlines` with every remaining action item in the same form; `Details: <meetingUrl>`, or 1A's `Details: the transcript, slides and chat files in <outDir>` when it is null. Due text is 1A's (`due Wed 28 Oct 2026`, `, HH:mm` when timed, `; <note>` from `chooseDue`).
- `runPipeline` uses `buildWorkInventory` and `renderWorkSummary` when `cfg.entry.type` is `'work'`, with `meetingUrl` `${TM_PUBLIC_URL}/meetings/<occurrenceId>` when that variable is set, else null; lectures are unchanged.

- [x] **Step 1: Write the failing tests**

```ts
// packages/core/src/names.test.ts
test('names compare without case, accents or punctuation', () => {
  expect(normaliseName('  Nur-AISYAH binti Ahmad ')).toBe('nur aisyah binti ahmad')
  expect(normaliseName('Zoë')).toBe('zoe')
  expect(normaliseName("O'Neil, J.")).toBe('o neil j')
})
```

```ts
// packages/pipeline/src/summary/work.test.ts
// jobFor(over) is a JobConfig for a work entry "Weekly sync", 2026-10-21T06:00:00Z to 07:00:00Z, Asia/Kuala_Lumpur,
// member display name "A Member" and mentionNames ["Nur Aisyah", "Aisyah"], with `over` merged into entry and member.
// section(md, title) returns the numbered lines under a heading; emptyWork has four empty lists; item(owner, task, due)
// builds an action item with source 'speech', ref null and no conflicts.
const inv: WorkInventory = {
  decisions: ['Ship the beta on 3 Nov'],
  actionItems: [item('Ben', 'Book the demo room', null), item('Aisyah', 'Draft the release notes', '2026-10-28')],
  discussed: ['Beta scope', 'Support rota'],
  openQuestions: ['Who covers on-call in November?']
}

test('the work template, exactly', () => {
  expect(
    renderWorkSummary(inv, {
      cfg: jobFor({}),
      meetingUrl: 'https://tm.example/meetings/o1',
      outDir: '/o'
    })
  ).toBe(
    [
      'Weekly sync (Wed 21 Oct 2026, 14:00 to 15:00)',
      '',
      'Do next: Draft the release notes (due Wed 28 Oct 2026)',
      '',
      'Decisions',
      '1. Ship the beta on 3 Nov',
      '',
      'Action items',
      '1. Aisyah: Draft the release notes (due Wed 28 Oct 2026)',
      '2. Ben: Book the demo room',
      '',
      'What was discussed',
      '1. Beta scope',
      '2. Support rota',
      '',
      'Open questions',
      '1. Who covers on-call in November?',
      '',
      'Details: https://tm.example/meetings/o1',
      ''
    ].join('\n')
  )
})

test('7 action items: the 5 most urgent, the rest under More deadlines; empty sections left out', () => {
  const seven = ['2026-10-30', null, '2026-10-22', '2026-11-05', '2026-10-23T09:00', '2026-10-26', '2026-11-20'].map(
    (d, i) => item(null, `Task ${i + 1}`, d)
  )
  const out = renderWorkSummary(
    { ...emptyWork, actionItems: seven },
    { cfg: jobFor({}), meetingUrl: null, outDir: '/o' }
  )
  expect(section(out, 'Action items')).toEqual([
    '1. Task 3 (due Thu 22 Oct 2026)',
    '2. Task 5 (due Fri 23 Oct 2026, 09:00)',
    '3. Task 6 (due Mon 26 Oct 2026)',
    '4. Task 1 (due Fri 30 Oct 2026)',
    '5. Task 4 (due Thu 5 Nov 2026)'
  ])
  expect(section(out, 'More deadlines')).toEqual(['1. Task 7 (due Fri 20 Nov 2026)', '2. Task 2'])
  expect(out).not.toContain('Decisions')
  expect(out).not.toContain('Attendance')
  expect(out.split('\n').at(-2)).toBe('Details: the transcript, slides and chat files in /o')
})

test("do next is the member's own most urgent item", () => {
  expect(pickDoNext(inv, ['AISYAH'])?.task).toBe('Draft the release notes')
  expect(pickDoNext(inv, ['Charlie'])).toBeNull()
  const md = renderWorkSummary(inv, {
    cfg: jobFor({ mentionNames: [], displayName: 'Charlie' }),
    meetingUrl: null,
    outDir: '/o'
  })
  expect(md.split('\n')[2]).toBe('Do next: nothing assigned to you in this meeting')
})
```

```ts
// packages/pipeline/src/pipeline.test.ts (added; workCfg is 1A's fixture config with entry type 'work' and name "Weekly sync")
test('a work entry gets the work inventory and summary, with no attendance line', async () => {
  const r = await runPipeline(workCfg)
  const md = await Bun.file(r.summaryPath).text()
  expect(md.split('\n')[0]).toStartWith('Weekly sync (')
  expect(md).not.toContain('Attendance:')
  const body = ai.requests[0].body
  expect(body).toMatchObject({ model: 'qwen3.7-plus', enable_thinking: false })
  expect(body.messages[0].content).toStartWith('You extract an inventory from one work meeting.')
  expect(body.messages[1].content).toContain('## Host chat')
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `TZ=UTC bun test packages/core/src/names.test.ts packages/pipeline/src/summary/work.test.ts packages/pipeline/src/pipeline.test.ts`
Expected: FAIL with `Cannot find module './names'`.

- [x] **Step 3: Implement `names.ts`, `work.ts`, the `chooseDue` widening and the dispatch in `pipeline.ts`**

Share 1A's due-text and title helpers from `render.ts`, and its `Source` and due-pattern schemas (`Due` above) from `inventory.ts`, rather than copying them; export them if 1A kept them private.

- [x] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC bun test packages/core packages/pipeline && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/names* packages/core/src/index.ts packages/pipeline/src docs/TRD.md
git commit -m "feat(pipeline): add work-meeting summary"
```

### Task 2: Name matching

**Files:**

- Create: `packages/worker/src/mentions/match.ts`
- Test: `packages/worker/src/mentions/match.test.ts`

**Interfaces:**

- Consumes: `normaliseName` (Task 1); `AsrResult` (1A).
- Produces (adds to contracts):

```ts
export type CompiledName = { name: string; tokens: string[] }
export function compileNames(names: string[]): CompiledName[] // normalised, < 2 characters dropped, duplicates removed
export function findMention(text: string, names: CompiledName[]): string | null // the longest name whose tokens occur as a contiguous run of whole tokens in normaliseName(text)
export function transcriptWindow(results: AsrResult[], endMs: number, spanMs = 30_000, maxChars = 1_500): string
```

`transcriptWindow` joins, in order and with single spaces, the texts of results with `endMs > endMs - spanMs` and `startMs <= endMs`; text longer than `maxChars` keeps its last `maxChars - 1` characters after a leading `…`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/mentions/match.test.ts
const names = compileNames(['Nur Aisyah', 'Aisyah', 'Zoë', 'A', '  '])

test('names compile once each; one-letter and blank names are dropped', () => {
  expect(names.map((n) => n.tokens)).toEqual([['nur', 'aisyah'], ['aisyah'], ['zoe']])
})

test.each([
  ['Aisyah, can you answer the next one?', 'Aisyah'],
  ['Thank you, Nur-Aisyah.', 'Nur Aisyah'],
  ['AISYAH?', 'Aisyah'],
  ['zoe is next', 'Zoë'],
  ['Aisyahrani will present', null],
  ['Nurul will present', null]
])('findMention(%p) is %p', (text, want) => expect(findMention(text, names)).toBe(want)) // Review Focus

test('the window holds the last 30 seconds, cut from the front', () => {
  const rs = [
    { startMs: 0, endMs: 10_000, text: 'one' },
    { startMs: 10_000, endMs: 25_000, text: 'two' },
    { startMs: 25_000, endMs: 40_000, text: 'three' },
    { startMs: 40_000, endMs: 52_000, text: 'Aisyah?' }
  ]
  expect(transcriptWindow(rs, 52_000)).toBe('two three Aisyah?')
  const long = transcriptWindow([{ startMs: 0, endMs: 1_000, text: 'x'.repeat(2_000) }], 1_000)
  expect([long.length, long[0]]).toEqual([1_500, '…'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/mentions/match.test.ts`
Expected: FAIL with `Cannot find module './match'`.

- [ ] **Step 3: Implement `packages/worker/src/mentions/match.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/mentions/match.test.ts`
Expected: PASS, `8 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/mentions docs/TRD.md
git commit -m "feat(worker): match the member's names"
```

### Task 3: Mention alerts in the worker

**Files:**

- Create: `packages/worker/src/mentions/watch.ts`
- Modify: `packages/worker/src/asr/live.ts` (`LiveAsrOptions.onResult`), `packages/worker/src/control/links.ts` (`siteLinks`), `packages/notify/src/messages.ts`, `packages/worker/src/run.ts`
- Test: `packages/worker/src/mentions/watch.test.ts`, `packages/worker/src/asr/live.test.ts` (added), `packages/worker/src/control/links.test.ts`, `packages/notify/src/messages.test.ts` (added)

**Interfaces:**

- Consumes: Task 2; 1A's `startLiveAsr`, `LiveAsrOptions`, `AsrResult`; 01c's `siteLinks`, `pings`, `formatWhen`; `Ping` (architecture).
- Produces (adds to contracts):

```ts
// packages/worker/src/mentions/watch.ts
export const MENTION_DEBOUNCE_MS = 120_000;
export interface MentionWatchDeps {
  names: string[];                 // cfg.member.mentionNames
  entry: string;
  timeZone: string;
  recordingStartedAt: Date;        // the wall-clock time that live.jsonl offsets count from
  links: { meetingPage: string; takeOver: string } | null;
  emit(atMs: number): void;        // becomes a `mention` event { atMs }
  ping(p: Ping): Promise<void>;
}
export function startMentionWatch(d: MentionWatchDeps): { onResult(r: AsrResult): void } | null;   // null when no name compiles

// packages/worker/src/asr/live.ts
interface LiveAsrOptions { /* 1A's fields */ onResult?: (r: AsrResult) => void }   // recording-relative, after the line is written

// packages/worker/src/control/links.ts
siteLinks(cfg): { meetingPage: string; signIn: string; leave: string; takeOver: string } | null   // leave = <meetingPage>/leave, takeOver = <meetingPage>/take-over
```

`onResult` keeps the last 60 seconds of results. A result that `findMention` matches calls `emit(r.endMs)`, and pings when no ping went out in the last `MENTION_DEBOUNCE_MS` of stream offset. A ping that fails is logged as `mention ping failed` and never reaches the speech path. In `run.ts`, live-mode occurrences start the watch with `cfg.member.mentionNames` and pass `onResult` to `startLiveAsr`; native-mode occurrences never do.

Ping copy, added to 01c's `pings` (actions left out when `links` is null, as in 1A job-file runs):

| Function                                                            | Priority | Title                              | Message                                                                    | Actions                          |
| ------------------------------------------------------------------- | -------- | ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| `nameMentioned({ entry, at, transcript, meetingUrl, takeOverUrl })` | high     | `Your name was mentioned: <entry>` | `Heard at <at>. The last 30 seconds:` then a line break and `<transcript>` | `Open meeting page`, `Take over` |

- [x] **Step 1: Write the failing tests**

```ts
// packages/worker/src/mentions/watch.test.ts
// deps(over) builds MentionWatchDeps for entry "Data Mining", names ['Aisyah'], Asia/Kuala_Lumpur, recordingStartedAt
// 2026-10-21T06:00:00Z, links for https://tm.example/meetings/o1, recording emitted offsets in `emitted` and pings in `pings`.
const r = (startMs: number, endMs: number, text: string) => ({
  startMs,
  endMs,
  text
})

test('a mention pings with the last 30 seconds and both buttons', async () => {
  const d = deps({})
  const w = startMentionWatch(d)!
  for (const x of [
    r(0, 10_000, 'one'),
    r(10_000, 25_000, 'two'),
    r(25_000, 40_000, 'three'),
    r(40_000, 52_000, 'Aisyah?')
  ])
    w.onResult(x)
  await Bun.sleep(0)
  expect(d.emitted).toEqual([52_000])
  expect(d.pings).toEqual([
    {
      title: 'Your name was mentioned: Data Mining',
      message: 'Heard at Wed 21 Oct, 14:00. The last 30 seconds:\ntwo three Aisyah?',
      priority: 'high',
      actions: [
        { label: 'Open meeting page', url: 'https://tm.example/meetings/o1' },
        { label: 'Take over', url: 'https://tm.example/meetings/o1/take-over' }
      ]
    }
  ])
})

test('a roll call pings once in 2 minutes; a later mention pings again', async () => {
  // Review Focus
  const d = deps({})
  const w = startMentionWatch(d)!
  for (const at of [52_000, 58_000, 70_000, 175_000]) w.onResult(r(at - 2_000, at, 'Aisyah, are you there?'))
  await Bun.sleep(0)
  expect(d.emitted).toEqual([52_000, 58_000, 70_000, 175_000])
  expect(d.pings).toHaveLength(2)
})

test('no names means no watch; no links means no buttons; a failed ping is contained', async () => {
  expect(startMentionWatch(deps({ names: ['A', ''] }))).toBeNull()
  const d = deps({
    links: null,
    ping: async () => {
      throw new Error('ntfy down')
    }
  })
  expect(() => startMentionWatch(d)!.onResult(r(0, 1_000, 'aisyah'))).not.toThrow()
  const e = deps({ links: null })
  startMentionWatch(e)!.onResult(r(0, 1_000, 'aisyah'))
  await Bun.sleep(0)
  expect(e.pings[0].actions).toBeUndefined()
})
```

```ts
// packages/worker/src/asr/live.test.ts (added; 1A's fakes)
test('onResult receives each recording-relative result', async () => {
  const seen: AsrResult[] = []
  await startLiveAsr(fakeAudio, ai, out, {
    baseMs: 4000,
    open: fakeOpen,
    onResult: (x) => seen.push(x)
  })
  fakeAudio.emit(Buffer.alloc(3200))
  fakeOpen.stream.result({
    startMs: 500,
    endMs: 2500,
    text: 'selamat petang semua'
  })
  expect(seen).toEqual([{ startMs: 4500, endMs: 6500, text: 'selamat petang semua' }])
})
```

```ts
// packages/worker/src/control/links.test.ts
test('site links include the leave and take-over pages', () => {
  process.env.TM_PUBLIC_URL = 'https://tm.example'
  expect(siteLinks(cfgFor({ occurrenceId: 'o1', identityId: 'i1' }))).toEqual({
    meetingPage: 'https://tm.example/meetings/o1',
    signIn: 'https://tm.example/accounts/i1/signin',
    leave: 'https://tm.example/meetings/o1/leave',
    takeOver: 'https://tm.example/meetings/o1/take-over'
  })
  delete process.env.TM_PUBLIC_URL
  expect(siteLinks(cfgFor({ occurrenceId: 'o1', identityId: 'i1' }))).toBeNull()
})
```

```ts
// packages/notify/src/messages.test.ts (added)
test('mention copy', () => {
  const p = pings.nameMentioned({
    entry: 'Data Mining',
    at: 'Wed 21 Oct, 14:32',
    transcript: 'two three Aisyah?',
    meetingUrl: 'https://tm.example/meetings/o1',
    takeOverUrl: 'https://tm.example/meetings/o1/take-over'
  })
  expect([p.title, p.priority, p.message, p.actions?.map((a) => a.label)]).toEqual([
    'Your name was mentioned: Data Mining',
    'high',
    'Heard at Wed 21 Oct, 14:32. The last 30 seconds:\ntwo three Aisyah?',
    ['Open meeting page', 'Take over']
  ])
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/mentions packages/worker/src/asr/live.test.ts packages/worker/src/control/links.test.ts packages/notify`
Expected: FAIL with `Cannot find module './watch'`.

- [x] **Step 3: Implement `watch.ts`, `onResult`, the two links, `pings.nameMentioned` and the `run.ts` wiring**

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src packages/notify && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/worker/src packages/notify/src docs/TRD.md
git commit -m "feat(worker): ping when the member is named"
```

### Task 4: Leaving and taking over in the worker

**Files:**

- Create: `packages/worker/src/control/leave.ts`
- Modify: `packages/worker/src/control/commands.ts` (`dispatchCommands`), `packages/core/src/types.ts` (`Heartbeat`), `packages/core/src/control.ts` (`HeartbeatSchema`, `StateEventData`), `packages/worker/src/run.ts`
- Test: `packages/worker/src/control/leave.test.ts`, `packages/worker/src/control/commands.test.ts` (01c's batch test, changed), `packages/core/src/control.test.ts` (added)

**Interfaces:**

- Consumes: `PlatformAdapter` (`leave`, `meetingState`) (architecture, 1A); 01c's `dispatchCommands`, `HeartbeatSchema`, `StateEventData`, the `leave` path and `getStatus` in `run.ts`; `siteLinks` with `leave` and `takeOver` (Task 3).
- Produces (adds to contracts):

```ts
// packages/worker/src/control/leave.ts
export function leaveMeeting(stage: Page, adapter: PlatformAdapter, opts?: { confirmMs?: number; pollMs?: number }): Promise<'left' | 'closed'>;   // defaults 10_000 and 500

// packages/worker/src/control/commands.ts (changed handler)
dispatchCommands(cmds: ControlCommand[], h: { leave(command: 'leave_now' | 'take_over'): Promise<void>; stop(): Promise<void>; pause(): Promise<void>; resume(): Promise<void> }): Promise<void>;

// packages/core
interface Heartbeat { /* architecture's fields */ linkUsed?: string }             // the link the worker joined with, before normaliseLink
type StateEventData = { state: OccurrenceState; command?: 'leave_now' | 'take_over' };   // command only on left_by_member; other plans' optional fields stay
```

Rules:

- `leaveMeeting`: when `meetingState` is neither `in_meeting` nor `lobby`, return `'left'` without clicking. Otherwise call `adapter.leave(stage)` and poll `meetingState` every `pollMs` until it is neither; if that hasn't happened within `confirmMs`, or `leave` throws, close the stage page (`stage.close({ runBeforeUnload: false })`) and return `'closed'`.
- `dispatchCommands` calls `h.leave` once per batch, with `'take_over'` when the batch holds one, else `'leave_now'`.
- `run.ts`: 01c's leave handler calls `leaveMeeting` in place of `adapter.leave`, and only after it returns emits `left_by_member` with `command`; the rest of 01c's finish is unchanged. From the moment joining starts, `getStatus` sends `linkUsed`. The joined ping's actions become `Open meeting page`, `Make the bot leave` and `Take over`, from `siteLinks`. The leave step's bound (`BOUND.leave`) is 20 s, so the 10 s confirmation of `leaveMeeting` is not cut; a leave that failed or was cut also closes the browser. A leave or take-over command waits first for the form submit in progress (the dispatcher settles its running forms, bounded by `BOUND.forms`), then leaves; no Submit is clicked twice. A take-over ends with `left_by_member` and no summary hand-over.
- `HeartbeatSchema` accepts an optional `linkUsed`: an `https:` URL of at most 2,048 characters. Any other value is read as absent (`.catch(undefined)`), so a bad optional link never makes the whole heartbeat a 400.

- [x] **Step 1: Write the failing tests**

```ts
// packages/worker/src/control/leave.test.ts
// fakeStage() records close() calls; fakeAdapter(states) answers meetingState from the `states` queue (repeating the last)
// and records leave() calls; `leaveSetsEnded` makes leave() switch the answer to 'ended'.
test('leaves and confirms without closing the stage', async () => {
  const stage = fakeStage(),
    a = fakeAdapter(['in_meeting'], { leaveSetsEnded: true })
  expect(await leaveMeeting(stage, a, { confirmMs: 200, pollMs: 10 })).toBe('left')
  expect([a.leaveCalls, stage.closeCalls]).toEqual([1, 0])
})

test('a leave that does not take closes the stage before reporting', async () => {
  // Review Focus
  const stage = fakeStage(),
    a = fakeAdapter(['in_meeting'])
  const t = performance.now()
  expect(await leaveMeeting(stage, a, { confirmMs: 200, pollMs: 10 })).toBe('closed')
  expect(stage.closeCalls).toBe(1)
  expect(performance.now() - t).toBeLessThan(1_000)
})

test('a leave that throws closes the stage; no meeting yet means nothing to click', async () => {
  const stage = fakeStage(),
    a = fakeAdapter(['lobby'])
  a.leave = async () => {
    throw new Error('button gone')
  }
  expect(await leaveMeeting(stage, a, { confirmMs: 200, pollMs: 10 })).toBe('closed')
  const idle = fakeAdapter(['unknown'])
  expect(await leaveMeeting(fakeStage(), idle)).toBe('left')
  expect(idle.leaveCalls).toBe(0)
})
```

```ts
// packages/worker/src/control/commands.test.ts (replaces 01c's "commands run in order and leave runs once per batch")
test('leave runs once per batch, as take_over when one was sent', async () => {
  const calls: string[] = []
  const h = {
    leave: async (c: string) => void calls.push(`leave:${c}`),
    stop: async () => void calls.push('stop'),
    pause: async () => void calls.push('pause'),
    resume: async () => void calls.push('resume')
  }
  await dispatchCommands(['pause_for_signin', 'leave_now', 'take_over', 'resume_after_signin'], h)
  expect(calls).toEqual(['pause', 'leave:take_over', 'resume'])
  calls.length = 0
  await dispatchCommands(['leave_now'], h)
  expect(calls).toEqual(['leave:leave_now'])
})
```

```ts
// packages/core/src/control.test.ts (added; hb() is a valid Heartbeat)
test('a heartbeat may carry the joined link', () => {
  expect(
    HeartbeatSchema.safeParse({
      ...hb(),
      linkUsed: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
    }).success
  ).toBe(true)
  // A value that is not an https URL is ignored, never a refused heartbeat.
  expect(HeartbeatSchema.parse({ ...hb(), linkUsed: 'javascript:alert(1)' }).linkUsed).toBeUndefined()
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/control packages/core/src/control.test.ts`
Expected: FAIL with `Cannot find module './leave'`.

- [x] **Step 3: Implement `leave.ts`, the command change, the schema and type changes, and the `run.ts` wiring**

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/control packages/core && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/worker/src packages/core/src docs/TRD.md
git commit -m "feat(worker): leave first on take over"
```

### Task 5: Leave and take-over pages

**Files:**

- Create: `packages/web/lib/meeting-control.ts`, `packages/web/app/meetings/[id]/control-actions.ts`, `packages/web/app/meetings/[id]/control-panel.tsx`, `packages/web/app/meetings/[id]/leave/page.tsx`, `packages/web/app/meetings/[id]/take-over/page.tsx`, `packages/web/app/api/meetings/[id]/state/route.ts`
- Modify: `packages/web/lib/meeting.ts` (`takeOver`, `controlState`), `packages/web/lib/control.ts` (`handleHeartbeat` stores `linkUsed`), `packages/web/app/meetings/[id]/page.tsx` ("Take over" beside "Make the bot leave")
- Test: `packages/web/lib/meeting-control.test.ts`, `packages/web/lib/meeting.test.ts` (added), `packages/web/lib/control.test.ts` (added)

**Interfaces:**

- Consumes: 01c's `MemberScope`, `scopeForAuthUser`, `makeBotLeave`, `meetingData`, `InUseError`, `ACTIVE_STATES`, `handleHeartbeat`, `meetingFixture`, `controlFixture`, `twoMembers`; `Heartbeat.linkUsed` (Task 4).
- Produces (adds to contracts):

```ts
// packages/web/lib/meeting.ts
export function takeOver(
  scope: MemberScope,
  id: string
): Promise<{ link: string | null; passcodeFromChat: boolean; alreadyLeft: boolean } | null> // null: not this member's occurrence
export function controlState(scope: MemberScope, id: string): Promise<{ state: OccurrenceState } | null>

// packages/web/lib/meeting-control.ts
export const CONTROL_COPY: Record<
  | 'takeOverIntro'
  | 'takeOverButton'
  | 'waiting'
  | 'takeOverNoLink'
  | 'takeOverPasscodeFromChat'
  | 'takeOverAlreadyLeft'
  | 'takeOverTimeout'
  | 'takeOverAnyway'
  | 'leaveIntro'
  | 'leaveButton'
  | 'leaveDone'
  | 'leaveTimeout'
  | 'notRunning',
  string
>
export function waitUntilLeft(
  getState: () => Promise<OccurrenceState>,
  opts?: {
    intervalMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<'left' | 'timeout'> // defaults 1_000 and 60_000
```

Rules:

- `takeOver`: null when the scope finds no such occurrence; `InUseError('The bot is not in this meeting.')` outside `ACTIVE_STATES`; in `leaving` or `uploading` the bot is already out: nothing is queued and the result has `alreadyLeft: true`; otherwise append `take_over` to `pending_commands` unless it is already there. The result is `{ link, passcodeFromChat, alreadyLeft }`: `link` is the occurrence's `pasted_link`, else the `entry_snapshot` fixed link, whichever names the same meeting as `link_used` (full, passcode included, read in the same transaction); if neither does (a chat watcher found it) it is the masked link (`https://<host><meeting path>`, no query or fragment) with `passcodeFromChat: true`; null when `link_used` is not a Zoom, Teams or Meet link. Nothing is written for the link.
- `handleHeartbeat`: when `body.linkUsed` is present and the occurrence is in `ACTIVE_STATES`, set `link_used` to it. It goes in no event.
- `waitUntilLeft` resolves `'left'` as soon as `getState()` returns a state outside `ACTIVE_STATES` or `leaving` or `uploading` (the bot is then only wrapping up its files), else `'timeout'` after `timeoutMs`.
- **Pages**: `/meetings/<id>/leave` and `/meetings/<id>/take-over` are server components that show the entry name and the intro and button from `CONTROL_COPY` (or `notRunning`, or a 404 when `meetingData` is null), and change nothing when opened. `ControlPanel` (client) calls `leaveAction(id)` (01c's `makeBotLeave`) or `takeOverAction(id)` (`takeOver`), shows `waiting`, then runs `waitUntilLeft` over `GET /api/meetings/<id>/state` (`controlState`, 404 for other members). When `alreadyLeft` the page shows `takeOverAlreadyLeft` and does not wait. On `'left'`, take over calls `window.location.assign(link)` (with `takeOverPasscodeFromChat` shown first when `passcodeFromChat`), or shows `takeOverNoLink` when the link is null; leave shows `leaveDone`. On `'timeout'`, take over shows `takeOverTimeout` with a `takeOverAnyway` button, and leave shows `leaveTimeout`. The link lives only in the component's memory.

`CONTROL_COPY` (exact; `<entry>` is the entry name):

```text
takeOverIntro    The bot will leave <entry> first, then this page opens the meeting for you. Joining with the same account while the bot is still in can disconnect one of you.
takeOverButton   Take over now
waiting          Waiting for the bot to leave…
takeOverNoLink   The bot has left. Open the meeting from where its link was posted.
takeOverPasscodeFromChat  The bot joined with a link from a chat, so this link has no passcode. Enter the passcode from that chat.
takeOverAlreadyLeft       The bot has already left. You can open the meeting now.
takeOverTimeout  The bot hasn't confirmed that it left. If you join now, the meeting may disconnect one of you.
takeOverAnyway   Open the meeting anyway
leaveIntro       The bot will leave <entry> and stop recording. What it recorded so far stays on the meeting page.
leaveButton      Make the bot leave
leaveDone        The bot has left the meeting.
leaveTimeout     The bot hasn't confirmed that it left yet. Check the meeting page in a minute.
notRunning       The bot is not in this meeting.
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/meeting.test.ts (added)
const LINK = 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'

test('take over queues once and returns the link the bot reported', async () => {
  // Review Focus
  const { scope, occurrenceId } = await meetingFixture()
  await scope.update(occurrences, { state: 'in_meeting', linkUsed: LINK }, eq(occurrences.id, occurrenceId))
  expect(await takeOver(scope, occurrenceId)).toEqual({ link: LINK })
  expect(await takeOver(scope, occurrenceId)).toEqual({ link: LINK })
  const [o] = await scope.select(occurrences, eq(occurrences.id, occurrenceId))
  expect(o.pendingCommands).toEqual(['take_over'])
})

test("a finished meeting refuses take over; another member's is not found", async () => {
  // Review Focus
  const { db, a, b } = await twoMembers()
  const sa = createScope(db, a.memberId)
  await sa.update(occurrences, { state: 'completed' }, eq(occurrences.id, a.ids.occurrences))
  await expect(takeOver(sa, a.ids.occurrences)).rejects.toThrow('The bot is not in this meeting.')
  expect(await takeOver(createScope(db, b.memberId), a.ids.occurrences)).toBeNull()
  expect(await controlState(createScope(db, b.memberId), a.ids.occurrences)).toBeNull()
})
```

```ts
// packages/web/lib/control.test.ts (added). 01c's controlFixture gains a `linkUsed` option; f.heartbeat(state) builds a
// valid body for the fixture's occurrence, and f.occurrence() and f.events() read its rows.
test('a heartbeat replaces link_used with the link the worker joined', async () => {
  // Review Focus
  const f = await controlFixture({
    state: 'joining',
    token: '1.abc',
    linkUsed: 'https://example.zoom.us/j/00000000000?pwd=OLD'
  })
  const r = await handleHeartbeat(f.deps, 'Bearer 1.abc', {
    ...f.heartbeat('joining'),
    linkUsed: 'https://example.zoom.us/j/00000000001?pwd=NEW'
  })
  expect(r.status).toBe(200)
  expect((await f.occurrence()).linkUsed).toBe('https://example.zoom.us/j/00000000001?pwd=NEW')
  expect(JSON.stringify(await f.events())).not.toContain('NEW')
})
```

```ts
// packages/web/lib/meeting-control.test.ts
test('waits until the bot is out of the active states', async () => {
  const states: OccurrenceState[] = ['in_meeting', 'in_meeting', 'left_by_member']
  let calls = 0
  expect(
    await waitUntilLeft(async () => states[Math.min(calls++, 2)], {
      sleep: async () => {}
    })
  ).toBe('left')
  expect(calls).toBe(3)
})

test('gives up after the timeout', async () => {
  let t = 0
  expect(
    await waitUntilLeft(async () => 'in_meeting', {
      intervalMs: 1_000,
      timeoutMs: 60_000,
      sleep: async (ms) => void (t += ms)
    })
  ).toBe('timeout')
  expect(t).toBe(60_000)
})

test('the take-over copy warns before it acts', () => {
  expect(CONTROL_COPY.takeOverIntro).toStartWith('The bot will leave <entry> first')
  expect(CONTROL_COPY.takeOverButton).toBe('Take over now')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/meeting-control.test.ts packages/web/lib/meeting.test.ts packages/web/lib/control.test.ts`
Expected: FAIL with `Cannot find module './meeting-control'`.

- [ ] **Step 3: Implement the library functions, the actions, the route, the two pages and the panel, and add the button to the meeting page**

Server actions get the scope from `scopeForAuthUser` for the signed-in user, as 01c's meeting actions do; Next.js checks their origin, and nothing acts on a `GET`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web && bun run typecheck`
Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web docs/TRD.md
git commit -m "feat(web): add leave and take-over pages"
```

### Task 6: Milestone acceptance

**Files:**

- Create: `docs/plans/06-acceptance.md` (dated results of each step)

**Interfaces:**

- Consumes: everything above, deployed with plan 01c's Compose stack; a Zoom test meeting hosted from a second account in which the bot joins signed in as the member's own Zoom account (not as a guest); the member's names on My details; a working DashScope key.
- Produces: the plan's exit evidence.

- [ ] **Step 1: Work-meeting defaults (plan 01c's, checked here)**

Create a work entry. Pass: transcription is preselected as native and `EMPLOYER_NOTICE` shows beside the choice; choosing live keeps the notice visible.

- [ ] **Step 2: Work-meeting summary**

Run a 30-minute test work meeting in live mode in which the host states two decisions, three action items (one for the member's short name with a date, one with no owner, one for someone else), and one open question, and shows one slide with a date. Pass: the summary arrives within 10 minutes of the end; it follows the work template with no `Attendance` line; `Do next` is the member's item with its date; the unowned item has no owner prefix; the slide's date wins any disagreement.

- [ ] **Step 3: Name mention**

In a live-mode test lecture, the host says the member's short name once, then three more times within a minute, then again after 3 minutes, and once says a longer word that starts with the name. Pass: the first ping arrives within 30 seconds of the name being spoken, at high priority, with the sentence in its transcript tail and the "Open meeting page" and "Take over" buttons; exactly 2 mention pings arrive in total; the event log shows 5 `mention` events; the longer word triggers nothing; the bot stays silent throughout.

- [ ] **Step 4: Make the bot leave**

From the joined ping, press "Make the bot leave", then the page's button. Pass: the bot disappears from the host's participant list within 15 seconds; the meeting page shows `left_by_member` with `command` `leave_now`; the recording up to that point is on the meeting page.

- [ ] **Step 5: Take over (the design's "Take over" test)**

In a new run, from the mention ping press "Take over", then "Take over now". Pass: the host's participant list shows the bot gone before the member's own join appears; the meeting opens from the link the bot used; neither session is disconnected over the next 5 minutes; the meeting page shows `left_by_member` with `command` `take_over`. Repeat with an entry whose fixed link was replaced by a pasted one before the start. Pass: the pasted link opens.

- [ ] **Step 6: Isolation**

Signed in as a second member, open the first member's `/meetings/<id>/take-over` and `/api/meetings/<id>/state`. Pass: both answer 404 and nothing is queued for the first member's occurrence.

- [ ] **Step 7: Record and commit**

Write each step's date, result and evidence (event ids, ping times; no recordings of other people) to `docs/plans/06-acceptance.md`.

```bash
git add docs/plans/06-acceptance.md
git commit -m "docs: record work and mention acceptance"
```
