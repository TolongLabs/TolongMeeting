# Companion app and native mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Windows companion app (pairing, desktop notifications, summary files) and native-mode transcription, in which the server extracts the meeting audio and the member's PC transcribes it with their own whisper-transcriber.

**Architecture:** Server pieces go in `packages/web` (pairing, device-token authentication and scoping, the companion API and its server-sent event stream), `packages/web/db/companion.ts` (tables and queries, shared with the pipeline like the rest of `packages/web/db`) and `packages/pipeline/src/native/` (FLAC extraction, native jobs, the `waiting_for_pc` check, reading the native transcript). The companion in `packages/companion` is an Electron tray app whose logic lives in plain TypeScript modules that receive Electron, `fetch` and `child_process` through small injected ports, so `bun test` covers them; `src/main/` only wires those ports to Electron. The PC only makes outbound HTTPS requests: it polls for jobs every 60 seconds and keeps a server-sent event stream open that tells it when to poll at once.

**Tech Stack:** Electron (the current stable major at build time, pinned exactly in `packages/companion/package.json`), electron-builder with the NSIS target, TypeScript bundled with `bun build`, zod, Next.js route handlers, Drizzle on Postgres, pg-boss, ffmpeg and ffprobe, ntfy's JSON stream, whisper-transcriber.

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Tasks](#tasks)
    1.  [Task 1: Companion contracts in core](#task-1-companion-contracts-in-core)
    1.  [Task 2: Companion tables and queries](#task-2-companion-tables-and-queries)
    1.  [Task 3: Pairing and device tokens](#task-3-pairing-and-device-tokens)
    1.  [Task 4: Device-token scope](#task-4-device-token-scope)
    1.  [Task 5: Command stream and job endpoints](#task-5-command-stream-and-job-endpoints)
    1.  [Task 6: Server FLAC extraction and the PC check](#task-6-server-flac-extraction-and-the-pc-check)
    1.  [Task 7: Audio download, transcript upload and failures](#task-7-audio-download-transcript-upload-and-failures)
    1.  [Task 8: Pipeline from the native transcript](#task-8-pipeline-from-the-native-transcript)
    1.  [Task 9: Summary endpoints and the summary tag](#task-9-summary-endpoints-and-the-summary-tag)
    1.  [Task 10: Companion shell and installer](#task-10-companion-shell-and-installer)
    1.  [Task 11: Companion API client and pairing](#task-11-companion-api-client-and-pairing)
    1.  [Task 12: ntfy subscription and desktop notifications](#task-12-ntfy-subscription-and-desktop-notifications)
    1.  [Task 13: Summary files](#task-13-summary-files)
    1.  [Task 14: Command stream client and job poller](#task-14-command-stream-client-and-job-poller)
    1.  [Task 15: Native transcription runner and keep-awake](#task-15-native-transcription-runner-and-keep-awake)
    1.  [Task 16: Milestone acceptance](#task-16-milestone-acceptance)

## Global Constraints

- **Companion app**: Electron (decision 43), Windows first, a tray icon and no main window. It is installed with electron-builder's NSIS target under the app ID `com.tolonglabs.tolongmeeting`, which is also passed to `app.setAppUserModelId` before any notification, so notification clicks reach the app.
- **Summary files**: saved to `Documents\Meeting summaries` by default, named `YYYY-MM-DD HHmm <entry name>.md`, and opened in the default app only when their notification is clicked. The companion never opens a file, window or browser on its own and never takes focus.
- **Native mode**: the server extracts 48 kHz mono FLAC (`-map 0:a -ac 1 -ar 48000 -c:a flac`) from `recording/meeting.mkv` into the occurrence's `audio.flac`. The companion downloads it, runs the member's configured whisper-transcriber command with default model `medium`, one job at a time, and uploads the text, subtitles and segment JSON (`txt`, `srt`, `json`). The FLAC is deleted on the server and the PC once the transcript is uploaded.
- **PC off**: the occurrence moves to `waiting_for_pc` and the member gets exactly one normal-priority ping for it.
- **Staying awake**: during a job the companion asks Windows to stay awake with `powerSaveBlocker.start('prevent-app-suspension')` and never changes power settings; nothing in `packages/companion` runs `powercfg`.
- **Device token**: revocable, sent only in an `Authorization: Bearer` header, stored on the server as a SHA-256 hash, and accepted only under `/api/companion/`: jobs for this member, audio downloads, artefact uploads, summary files and (plan 08) the saved details and AI key for an active local job. It can't reach browser profiles, remote views, export tokens or any other page or API.
- **Local secrets**: the device token and ntfy token are stored only through Electron `safeStorage` (DPAPI on Windows). If encryption isn't available, the companion refuses to store them rather than write plaintext.
- **Transport**: HTTPS polling plus a server-sent event stream for commands; the PC never listens for incoming connections.
- **Logs and URLs**: tokens, keys, pairing codes and transcript text are never logged and never put in URL query strings.
- **Desktop**: no keyboard or mouse input is ever synthesised (SAFE-02 in the problems and fixes catalogue); child processes start with `windowsHide: true` and no shell.
- **From plan 01c, by name**: `Db`, `schema`, `createTestDb()` and `seedMember(db, opts?)` (`packages/web/db/index.ts` and `packages/web/db/testing.ts`); the `device_tokens` table (`id`, `member_id`, `name`, `token_hash`, `created_at`, `last_used_at`, `revoked_at`) and the `artefacts` table (`kind` `'summary'`); `applyTrigger(db: Db, occurrenceId: string, trigger: OccurrenceTrigger, opts?: { reason?: string; recordEvent?: boolean }): Promise<{ from: OccurrenceState; to: OccurrenceState }>` (`packages/web/db/transitions.ts`) with the triggers `wait_for_pc` (`transcribing -> waiting_for_pc`), `transcript_ready` and `fail`; the App Router under `packages/web/app/`, libraries under `packages/web/lib/`, and the Next.js middleware at `packages/web/middleware.ts`; ping wording in `packages/notify/src/messages.ts`, where this plan's ping copy goes too.
- **From plan 01c, by role** (01c hadn't named them when this plan was written; use 01c's names and keep these signatures): `enqueuePipeline(occurrenceId: string): Promise<void>`; `scheduleJob(queue: string, data: object, startAfterSec: number): Promise<void>` (pg-boss `send` with `startAfter`); `memberNtfy(db: Db, memberId: string): Promise<NtfyConfig>`; `meetingUrl(occurrenceId: string): string`; `requireMember(req: Request): Promise<{ memberId: string }>`.
- **Isolation**: member-facing routes added here (the Devices page and its API) go through plan 01c's `packages/web/lib/scope.ts`. Device-token routes go through `packages/web/lib/companion/`, whose every query takes a `DeviceAuth` and filters by its member and device: the device-side sibling of 01c's scope module.
- **Database tests**: run under `bun test` on `createTestDb()` (PGlite with every migration applied), seeded with `seedMember`.
- **Server data access**: `TM_DATA_ROOT` is also mounted into `tm-web`, which serves companion audio downloads and receives uploads (adds to contracts: `web` joins the variable's "Used by" list).

## Review Focus

- **Entry names Windows can't use in file names** (for example `CS6013: AI/ML?`): the summary is still saved, under a safe name, and an existing file is never overwritten (Task 13).
- **whisper-transcriber missing, misconfigured or crashing**: the job is retried once, then the occurrence fails with a ping naming the error instead of sitting in `transcribing` (Tasks 7 and 15).
- **PC sleeps or the companion quits mid-job**: the lease lapses after 5 minutes, the job returns to `pending`, the occurrence shows `waiting_for_pc` without a second ping, and the next claim carries on (Tasks 2 and 6).
- **Device revoked, for example after a lost laptop**: every request answers 401, and the companion deletes its secrets, stops, and shows an "unpaired" notification (Tasks 3 and 11).
- **Interrupted download or upload**: the FLAC download resumes from the partial file, an incomplete transcript upload is refused, and neither side deletes the FLAC until the server has accepted the transcript (Tasks 7 and 15).

## Tasks

### Task 1: Companion contracts in core

**Files:**

- Create: `packages/core/src/companion.ts`
- Modify: `packages/core/src/index.ts` (export the new module)
- Test: `packages/core/src/companion.test.ts`

**Interfaces:**

- Consumes: `NtfyConfig` (`packages/notify`).
- Produces (adds to contracts), all with matching zod schemas named `<Type>Schema`:

```ts
export type CompanionJobKind = 'native_transcription' // plan 08 adds 'local_run'
export type CompanionJobState = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled'
export interface NativeJobPayload {
  occurrenceId: string
  entryName: string
  start: string
  timeZone: string
  durationSec: number
  flacBytes: number
}
export interface CompanionJob {
  id: string
  kind: CompanionJobKind
  state: CompanionJobState
  occurrenceId: string
  attempts: number
  payload: NativeJobPayload
}
export type CompanionCommand = { type: 'job_available'; jobId: string } // plan 08 widens
export interface CompanionEvent {
  id: number
  command: CompanionCommand
}
export interface PairRequest {
  code: string
  deviceName: string
}
export interface PairResponse {
  deviceId: string
  token: string
  ntfy: NtfyConfig
  pairedAt: string
}
export interface SummaryListItem {
  occurrenceId: string
  fileName: string
  readyAt: string
}
export const WhisperJsonSchema: z.ZodType<{
  segments: { start: number; end: number; text: string }[]
}> // passthrough on unknown keys
export const DEVICE_TOKEN_PREFIX = 'tmd_'
export const JOB_LEASE_MS = 300_000
export const PC_CLAIM_GRACE_MS = 120_000
export const NATIVE_MAX_ATTEMPTS = 2
export function shortDate(iso: string, timeZone: string): string // 'Wed 21 Oct': en-GB, weekday short, day numeric, month short
```

- [x] **Step 1: Write the failing test**

```ts
test('shortDate formats in the member time zone', () => {
  expect(shortDate('2026-10-21T14:00:00+08:00', 'Asia/Kuala_Lumpur')).toBe('Wed 21 Oct')
  expect(shortDate('2026-10-21T23:30:00Z', 'Asia/Kuala_Lumpur')).toBe('Thu 22 Oct')
})
test('pinned companion timings', () => {
  expect(JOB_LEASE_MS).toBe(300_000)
  expect(PC_CLAIM_GRACE_MS).toBe(120_000)
  expect(NATIVE_MAX_ATTEMPTS).toBe(2)
})
test('only known commands parse', () => {
  expect(
    CompanionEventSchema.parse({
      id: 7,
      command: { type: 'job_available', jobId: 'j1' }
    }).id
  ).toBe(7)
  expect(() =>
    CompanionEventSchema.parse({
      id: 8,
      command: { type: 'run', cmd: 'calc' }
    })
  ).toThrow()
})
test('a pair response needs a tmd_ token', () => {
  const ntfy = { url: 'https://ntfy.example', topic: 't', token: 'x' }
  expect(() =>
    PairResponseSchema.parse({
      deviceId: 'd',
      token: 'abc',
      ntfy,
      pairedAt: '2026-10-21T00:00:00Z'
    })
  ).toThrow()
})
test('whisper JSON keeps start, end and text', () => {
  const j = WhisperJsonSchema.parse({
    text: 'Hi',
    language: 'en',
    segments: [{ id: 0, start: 0.5, end: 1.25, text: ' Hi', tokens: [1] }]
  })
  expect(j.segments[0]).toMatchObject({ start: 0.5, end: 1.25, text: ' Hi' })
  expect(() => WhisperJsonSchema.parse({ segments: [{ start: 'x' }] })).toThrow()
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/companion.test.ts`
Expected: FAIL with "Cannot find module './companion'"

- [x] **Step 3: Implement the types, schemas and constants above in `packages/core/src/companion.ts`**

`PairResponseSchema.token` is `z.string().startsWith(DEVICE_TOKEN_PREFIX)`; `CompanionCommandSchema` is a `z.discriminatedUnion('type', [...])` so plan 08 can add members.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/companion.test.ts`
Expected: PASS (5 tests)

- [x] **Step 5: Commit**

```bash
git add packages/core/src/companion.ts packages/core/src/companion.test.ts packages/core/src/index.ts
git commit -m "feat(core): add companion contracts"
```

### Task 2: Companion tables and queries

**Files:**

- Create: `packages/web/db/companion.ts`, `packages/web/db/companion.fixtures.ts`
- Modify: `packages/web/db/index.ts` (export the new tables and functions); `packages/web/db/schema.test.ts` and `MEMBER_OWNED` (plan 01c: the three new tables join the table list); a new drizzle-kit migration
- Test: `packages/web/db/companion.test.ts`

**Interfaces:**

- Consumes: Task 1 types; `Db`, `schema`, `createTestDb`, `seedMember` and the `device_tokens`, `members` and `occurrences` tables (plan 01c).
- Produces (adds to contracts): tables `device_pairings` (`code_hash` unique, `member_id`, `expires_at`, `used_at`), `companion_jobs` (`id`, `member_id`, `occurrence_id`, `kind`, `state`, `payload` jsonb, `attempts`, `device_id` and `target_device_id` referencing `device_tokens`, `lease_until`, `pc_ping_sent_at`, `error`, `created_at`, `updated_at`) and `companion_events` (`id` bigserial, `member_id`, `device_id` nullable, `command` jsonb, `created_at`); every one has a non-null `member_id`, so they join 01c's `MEMBER_OWNED` and its schema test's table list. Functions:

```ts
export interface DeviceAuth {
  deviceId: string
  memberId: string
}
export function createCompanionJob(
  db: Db,
  j: {
    memberId: string
    occurrenceId: string
    kind: CompanionJobKind
    payload: CompanionJob['payload']
    targetDeviceId?: string
  }
): Promise<string>
export function emitCompanionEvent(
  db: Db,
  memberId: string,
  command: CompanionCommand,
  deviceId?: string,
  now?: Date
): Promise<number>
export function listCompanionEvents(db: Db, device: DeviceAuth, afterId: number): Promise<CompanionEvent[]>
export function listJobsForDevice(db: Db, device: DeviceAuth): Promise<CompanionJob[]>
export function claimJob(
  db: Db,
  device: DeviceAuth,
  jobId: string,
  now?: Date
): Promise<CompanionJob | 'conflict' | null>
export function renewLease(db: Db, device: DeviceAuth, jobId: string, now?: Date): Promise<boolean>
export function releaseExpiredLeases(db: Db, now?: Date): Promise<string[]>
export function getClaimedJob(db: Db, device: DeviceAuth, jobId: string): Promise<CompanionJob | null>
export function getJob(db: Db, jobId: string): Promise<(CompanionJob & { memberId: string }) | null>
export function completeJob(db: Db, jobId: string): Promise<void>
export function failJobAttempt(db: Db, jobId: string, error: string): Promise<'retry' | 'failed'>
export function markPcPingSent(db: Db, jobId: string, now?: Date): Promise<boolean>
export function seedCompanionFixture(db: Db): Promise<{
  a1: DeviceAuth
  a2: DeviceAuth
  b1: DeviceAuth
  occA: string
  occB: string
}> // fixtures file: two seedMember calls; member A gets devices 'DESKTOP-ABC' and 'LAPTOP-A', member B one device
```

- [ ] **Step 1: Write the failing test**

```ts
const native = (occurrenceId: string) => ({
  occurrenceId,
  entryName: 'Data Mining',
  start: '2026-10-21T14:00:00+08:00',
  timeZone: 'Asia/Kuala_Lumpur',
  durationSec: 5400,
  flacBytes: 1000
})
const t0 = new Date('2026-10-21T08:00:00Z')
const plus = (ms: number) => new Date(t0.getTime() + ms)

test('the first device to claim wins; the second gets a conflict', async () => {
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: native(f.occA)
  })
  expect((await claimJob(db, f.a1, id, t0)) as CompanionJob).toMatchObject({
    state: 'claimed'
  })
  expect(await claimJob(db, f.a2, id, t0)).toBe('conflict')
})
test("a device never sees or claims another member's job", async () => {
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: native(f.occA)
  })
  expect((await listJobsForDevice(db, f.b1)).map((j) => j.id)).not.toContain(id)
  expect(await claimJob(db, f.b1, id, t0)).toBeNull()
})
test('a lease lapses 5 minutes after the last progress', async () => {
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: native(f.occA)
  })
  await claimJob(db, f.a1, id, t0)
  await renewLease(db, f.a1, id, plus(240_000))
  expect(await releaseExpiredLeases(db, plus(539_000))).not.toContain(id)
  expect(await releaseExpiredLeases(db, plus(541_000))).toContain(id)
  expect((await getJob(db, id))?.state).toBe('pending')
})
test('a failed attempt is retried once, then the job fails', async () => {
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: native(f.occA)
  })
  expect(await failJobAttempt(db, id, 'exit 1')).toBe('retry')
  expect((await getJob(db, id))?.state).toBe('pending')
  expect(await failJobAttempt(db, id, 'exit 1')).toBe('failed')
})
test("events are listed after an id and the member's events older than 24 hours are pruned", async () => {
  const old = await emitCompanionEvent(db, f.a1.memberId, { type: 'job_available', jobId: 'x' }, undefined, t0)
  const fresh = await emitCompanionEvent(
    db,
    f.a1.memberId,
    { type: 'job_available', jobId: 'y' },
    undefined,
    plus(86_401_000)
  )
  expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.id)).toEqual([fresh])
  expect(await listCompanionEvents(db, f.b1, 0)).toEqual([])
  expect(old).toBeLessThan(fresh)
})
test('the PC ping is marked sent only once', async () => {
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: native(f.occA)
  })
  expect(await markPcPingSent(db, id, t0)).toBe(true)
  expect(await markPcPingSent(db, id, t0)).toBe(false)
})
```

In `beforeEach`, `db` is `await createTestDb()` and `f` is `await seedCompanionFixture(db)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/db/companion.test.ts`
Expected: FAIL with "Cannot find module './companion'"

- [ ] **Step 3: Implement the tables, the functions and the fixture in `packages/web/db/companion.ts` and `packages/web/db/companion.fixtures.ts`, then generate the migration**

`listJobsForDevice` returns the member's `pending` jobs whose `target_device_id` is null or this device, plus the jobs this device holds. `claimJob` is one `UPDATE ... WHERE id = $1 AND state = 'pending' AND member_id = $2 AND (target_device_id IS NULL OR target_device_id = $3) RETURNING *`, setting `state = 'claimed'`, `device_id` and `lease_until = now + JOB_LEASE_MS`; if no row updates, it returns `'conflict'` when the job exists for that member, else `null`. `releaseExpiredLeases` sets `state = 'pending'`, `device_id = NULL`, `lease_until = NULL` for claimed jobs whose `lease_until < now`. `failJobAttempt` increments `attempts` and returns `'failed'` (state `failed`) once `attempts >= NATIVE_MAX_ATTEMPTS`, otherwise releases the job to `pending`. `emitCompanionEvent` deletes the member's events older than 24 hours in the same transaction. `markPcPingSent` is `UPDATE ... SET pc_ping_sent_at = $now WHERE id = $1 AND pc_ping_sent_at IS NULL`. Generate the migration with `cd packages/web && bunx drizzle-kit generate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/db/companion.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/db
git commit -m "feat(web): add companion tables and queries"
```

### Task 3: Pairing and device tokens

**Files:**

- Create: `packages/web/lib/companion/tokens.ts`, `packages/web/app/api/companion/pair/route.ts`, `packages/web/app/api/devices/pairing-code/route.ts`, `packages/web/app/api/devices/[id]/revoke/route.ts`, `packages/web/app/devices/page.tsx`
- Test: `packages/web/lib/companion/tokens.test.ts`

**Interfaces:**

- Consumes: Task 2 tables and `DeviceAuth`; `memberNtfy`, `requireMember` (plan 01c).
- Produces:

```ts
export function newDeviceToken(): { token: string; hash: string } // 'tmd_' + 32 random bytes base64url; hash = sha256 hex
export function hashSecret(value: string): string // sha256 hex
export function normalisePairingCode(input: string): string // upper-case, drop '-' and spaces, I and L -> 1, O -> 0
export function createPairingCode(db: Db, memberId: string, now?: Date): Promise<{ code: string; expiresAt: Date }>
export function redeemPairingCode(db: Db, req: PairRequest, now?: Date): Promise<PairResponse | null>
export function authenticateDevice(db: Db, authorization: string | null, now?: Date): Promise<DeviceAuth | null>
export function listDevices(
  db: Db,
  memberId: string
): Promise<
  {
    id: string
    name: string
    createdAt: Date
    lastUsedAt: Date | null
    revokedAt: Date | null
  }[]
>
export function revokeDevice(db: Db, memberId: string, deviceId: string, now?: Date): Promise<boolean>
```

- Routes (adds to contracts): `POST /api/companion/pair` (body `PairRequest`, no session, answers `PairResponse` or 400), `POST /api/devices/pairing-code` and `POST /api/devices/<id>/revoke` (member session). The Devices page at `/devices` lists the member's PCs (name, paired, last seen, Remove) and a "Pair a PC" button that shows the website address and the code as `XXXX-XXXX`, "valid for 10 minutes".

- [ ] **Step 1: Write the failing test**

```ts
const t0 = new Date('2026-10-21T08:00:00Z')
const min = (n: number) => new Date(t0.getTime() + n * 60_000)

test('a pairing code works once, within 10 minutes', async () => {
  const { code } = await createPairingCode(db, memberA, t0)
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, min(11))).toBeNull()
  const { code: c2 } = await createPairingCode(db, memberA, t0)
  const res = await redeemPairingCode(db, { code: c2.toLowerCase().replace('-', ' '), deviceName: 'PC' }, min(9))
  expect(res?.token).toStartWith('tmd_')
  expect(res?.ntfy.topic).toBe(memberANtfy.topic)
  expect(await redeemPairingCode(db, { code: c2, deviceName: 'PC' }, min(9))).toBeNull()
})
test('only the token hash is stored', async () => {
  const { code } = await createPairingCode(db, memberA, t0)
  const res = (await redeemPairingCode(db, { code, deviceName: 'PC' }, t0))!
  const row = await db.query.deviceTokens.findFirst({
    where: eq(deviceTokens.id, res.deviceId)
  })
  expect(row!.tokenHash).toBe(hashSecret(res.token))
  expect(JSON.stringify(row)).not.toContain(res.token)
})
test('authenticateDevice accepts the bearer token and records last_used_at', async () => {
  const res = await pairA(t0)
  expect(await authenticateDevice(db, `Bearer ${res.token}`, min(1))).toEqual({
    deviceId: res.deviceId,
    memberId: memberA
  })
  expect((await listDevices(db, memberA))[0].lastUsedAt).toEqual(min(1))
  expect(await authenticateDevice(db, `Bearer tmd_wrong`, min(1))).toBeNull()
  expect(await authenticateDevice(db, null, min(1))).toBeNull()
})
test('a revoked token is refused; another member cannot revoke it', async () => {
  const res = await pairA(t0)
  expect(await revokeDevice(db, memberB, res.deviceId, min(1))).toBe(false)
  expect(await revokeDevice(db, memberA, res.deviceId, min(1))).toBe(true)
  expect(await authenticateDevice(db, `Bearer ${res.token}`, min(2))).toBeNull()
})
```

`pairA(at)` creates and redeems a code for `memberA`; `memberANtfy` is what `memberNtfy` returns for member A in the fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/lib/companion/tokens.test.ts`
Expected: FAIL with "Cannot find module './tokens'"

- [ ] **Step 3: Implement the functions in `packages/web/lib/companion/tokens.ts`, the three routes and the Devices page**

Codes are 8 characters from the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, stored only as `hashSecret(normalisePairingCode(code))`, valid 10 minutes, single use. `redeemPairingCode` marks the pairing used and inserts the device token in one transaction; `pairedAt` is `now`. `authenticateDevice` accepts only `Bearer tmd_...` and refuses revoked rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/lib/companion/tokens.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/companion packages/web/app/api/companion/pair packages/web/app/api/devices packages/web/app/devices
git commit -m "feat(web): pair PCs with device tokens"
```

### Task 4: Device-token scope

**Files:**

- Create: `packages/web/lib/companion/scope.ts`
- Modify: `packages/web/middleware.ts` (plan 01c), so it runs the guard on every request, including plan 01c's `forward_auth` endpoint for remote views
- Test: `packages/web/lib/companion/scope.test.ts`

**Interfaces:**

- Consumes: `authenticateDevice` (Task 3).
- Produces:

```ts
export function isCompanionPath(pathname: string): boolean // after URL normalisation, starts with '/api/companion/'
export function misplacedDeviceToken(pathname: string, authorization: string | null): boolean
export function withDevice<C>(
  handler: (req: Request, device: DeviceAuth, ctx: C) => Promise<Response>
): (req: Request, ctx: C) => Promise<Response>
```

- [ ] **Step 1: Write the failing test**

```ts
test.each([
  ['/api/companion/jobs', true],
  ['/api/companion/events', true],
  ['/api/companionx/jobs', false],
  ['/api/companion/../profiles/x', false],
  ['/api/meetings/abc', false],
  ['/api/exports/google', false],
  ['/devices', false]
])('isCompanionPath(%s) is %p', (path, ok) => expect(isCompanionPath(path)).toBe(ok))

test('a device token anywhere outside /api/companion/ is refused with 403', async () => {
  for (const path of [
    '/api/meetings/abc',
    '/api/profiles/p1',
    '/api/exports/github',
    '/',
    '/api/companion/../identities'
  ]) {
    const res = await middleware(
      new NextRequest(`https://tm.example${path}`, {
        headers: { authorization: 'Bearer tmd_abc' }
      })
    )
    expect(res?.status).toBe(403)
  }
})
test('withDevice ignores session cookies and answers 401 without a device token', async () => {
  const route = withDevice(async () => new Response('ok'))
  const res = await route(
    new Request('https://tm.example/api/companion/jobs', {
      headers: { cookie: memberSessionCookie }
    }),
    {}
  )
  expect(res.status).toBe(401)
})
test('withDevice passes the authenticated device to the handler', async () => {
  const route = withDevice(async (_req, device) => Response.json(device))
  const res = await route(
    new Request('https://tm.example/api/companion/jobs', {
      headers: { authorization: `Bearer ${tokenA}` }
    }),
    {}
  )
  expect(await res.json()).toEqual({ deviceId: deviceA, memberId: memberA })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/lib/companion/scope.test.ts`
Expected: FAIL with "Cannot find module './scope'"

- [ ] **Step 3: Implement `scope.ts` and call `misplacedDeviceToken` first in the middleware**

The middleware answers `403` with `{ "error": "device_token_not_allowed" }`. `withDevice` reads only the `Authorization` header and answers `401` with `{ "error": "device_revoked_or_unknown" }` when `authenticateDevice` returns `null`. Every route under `packages/web/app/api/companion/` except `pair` is wrapped in `withDevice`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/lib/companion/scope.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/companion/scope.ts packages/web/lib/companion/scope.test.ts packages/web/middleware.ts
git commit -m "feat(web): scope device tokens to companion API"
```

### Task 5: Command stream and job endpoints

**Files:**

- Create: `packages/web/lib/companion/sse.ts`, `packages/web/app/api/companion/events/route.ts`, `packages/web/app/api/companion/jobs/route.ts`, `packages/web/app/api/companion/jobs/[id]/claim/route.ts`, `packages/web/app/api/companion/jobs/[id]/progress/route.ts`
- Test: `packages/web/lib/companion/sse.test.ts`, `packages/web/app/api/companion/jobs/jobs.test.ts`

**Interfaces:**

- Consumes: Task 2 queries; `withDevice` (Task 4); `authenticateDevice` (Task 3).
- Produces:

```ts
export function formatSse(e: CompanionEvent): string
export function companionEventStream(
  db: Db,
  device: DeviceAuth,
  lastEventId: number,
  signal: AbortSignal,
  opts?: { pollMs?: number; keepAliveMs?: number }
): ReadableStream<Uint8Array> // defaults 2000 and 25000
```

- Routes (adds to contracts): `GET /api/companion/events` (SSE, resumes from the `Last-Event-ID` header), `GET /api/companion/jobs` (answers `{ jobs: CompanionJob[] }` after `releaseExpiredLeases`), `POST /api/companion/jobs/<id>/claim` (200 with the job, 409 when another device holds it, 404 otherwise), `POST /api/companion/jobs/<id>/progress` (204, or 404 when this device doesn't hold the job).

- [ ] **Step 1: Write the failing tests**

```ts
// sse.test.ts
test('formatSse writes id, event and data lines', () => {
  expect(formatSse({ id: 7, command: { type: 'job_available', jobId: 'j1' } })).toBe(
    'id: 7\nevent: job_available\ndata: {"type":"job_available","jobId":"j1"}\n\n'
  )
})
test('the stream replays events after Last-Event-ID, then sends new ones', async () => {
  const e1 = await emitCompanionEvent(db, f.a1.memberId, {
    type: 'job_available',
    jobId: 'j1'
  })
  const e2 = await emitCompanionEvent(db, f.a1.memberId, {
    type: 'job_available',
    jobId: 'j2'
  })
  const ac = new AbortController()
  const read = collect(
    companionEventStream(db, f.a1, e1, ac.signal, {
      pollMs: 10,
      keepAliveMs: 1000
    })
  )
  const e3 = await emitCompanionEvent(db, f.a1.memberId, {
    type: 'job_available',
    jobId: 'j3'
  })
  await Bun.sleep(50)
  ac.abort()
  const text = await read
  expect(text).not.toContain(`id: ${e1}\n`)
  expect(text).toContain(`id: ${e2}\n`)
  expect(text).toContain(`id: ${e3}\n`)
})
test('the stream sends a keepalive comment and refreshes last_used_at', async () => {
  const ac = new AbortController()
  const read = collect(
    companionEventStream(db, f.a1, 0, ac.signal, {
      pollMs: 10,
      keepAliveMs: 20
    })
  )
  await Bun.sleep(60)
  ac.abort()
  expect(await read).toContain(': keepalive\n\n')
  expect((await listDevices(db, f.a1.memberId)).find((d) => d.id === f.a1.deviceId)!.lastUsedAt).not.toBeNull()
})

// jobs.test.ts
test('GET jobs releases lapsed leases before listing', async () => {
  const id = await claimedJobWithLapsedLease(f.a1)
  const res = await GET(authed('/api/companion/jobs', tokenA2), {})
  expect((await res.json()).jobs).toContainEqual(expect.objectContaining({ id, state: 'pending' }))
})
test('claim answers 409 when another device holds the job and 404 for another member', async () => {
  const id = await pendingJob(f.occA)
  expect((await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokenA1, 'POST'), params(id))).status).toBe(200)
  expect((await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokenA2, 'POST'), params(id))).status).toBe(409)
  expect((await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokenB1, 'POST'), params(id))).status).toBe(404)
})
test('progress from a device that does not hold the job answers 404', async () => {
  const id = await pendingJob(f.occA)
  await CLAIM(authed(`/api/companion/jobs/${id}/claim`, tokenA1, 'POST'), params(id))
  expect((await PROGRESS(authed(`/api/companion/jobs/${id}/progress`, tokenA2, 'POST'), params(id))).status).toBe(404)
})
```

`collect` reads a stream to a string until it closes; `authed(path, token, method?)` builds a `Request` with the bearer header; `params(id)` builds the route context.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/companion/sse.test.ts packages/web/app/api/companion/jobs/jobs.test.ts`
Expected: FAIL with "Cannot find module './sse'" and missing route modules

- [ ] **Step 3: Implement `sse.ts` and the four routes**

The events route sets `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no` and `export const dynamic = 'force-dynamic'`; the stream polls `listCompanionEvents` every `pollMs`, writes `: keepalive\n\n` every `keepAliveMs`, touches `device_tokens.last_used_at` on each keepalive, and closes on `signal` abort. Caddy flushes `text/event-stream` responses immediately, so the Caddyfile needs no change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/companion/sse.test.ts packages/web/app/api/companion/jobs/jobs.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/companion/sse.ts packages/web/lib/companion/sse.test.ts packages/web/app/api/companion/events packages/web/app/api/companion/jobs
git commit -m "feat(web): add companion event stream and jobs"
```

### Task 6: Server FLAC extraction and the PC check

**Files:**

- Create: `packages/pipeline/src/native/flac.ts`, `packages/pipeline/src/native/start.ts`, `packages/pipeline/src/native/pc-check.ts`
- Modify: `packages/core/src/occurrence-machine.ts` (one trigger); `packages/notify/src/messages.ts` (the waiting ping); plan 01c's pipeline job consumer in `packages/pipeline/src/` (the pg-boss handler that calls `runPipeline`), where `startNativeTranscription` replaces 01c's immediate `wait_for_pc` for native occurrences, and which registers the `native-job-check` handler; `packages/web/app/api/companion/jobs/[id]/claim/route.ts` (move a `waiting_for_pc` occurrence back to `transcribing`)
- Test: `packages/pipeline/src/native/flac.test.ts`, `packages/pipeline/src/native/pc-check.test.ts`, `packages/core/src/occurrence-machine.test.ts`

**Interfaces:**

- Consumes: `shortDate` (Task 1); `createCompanionJob`, `emitCompanionEvent`, `getJob`, `releaseExpiredLeases`, `markPcPingSent` (Task 2); `applyTrigger` and its `wait_for_pc` trigger, `scheduleJob`, `memberNtfy`, `meetingUrl` (plan 01c); `sendPing` (`packages/notify`); `JobConfig`.
- Produces (adds to contracts): `OccurrenceTrigger` gains `'pc_claimed'` (`waiting_for_pc -> transcribing`), so the meeting page stops saying "waiting for your PC" once the PC has the job; pg-boss queue `native-job-check`; and:

```ts
export type RunLike = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
export function extractFlac(
  occDir: string,
  run?: RunLike
): Promise<{ path: string; durationSec: number; bytes: number }>
export interface NativeDeps {
  sendPing: typeof sendPing
  transition: typeof applyTrigger
  schedule: typeof scheduleJob
  memberNtfy: typeof memberNtfy
  meetingUrl: typeof meetingUrl
}
export function startNativeTranscription(
  db: Db,
  cfg: JobConfig,
  deps: NativeDeps,
  run?: RunLike
): Promise<string | null> // job id, or null when transcript/native/audio.json exists
export function checkNativeJob(
  db: Db,
  jobId: string,
  deps: NativeDeps,
  now?: Date
): Promise<'done' | 'failed' | 'claimed' | 'waiting_for_pc'>
```

- [ ] **Step 1: Write the failing tests**

```ts
// occurrence-machine.test.ts (added cases)
test('native PC triggers', () => {
  expect(nextOccurrenceState('transcribing', 'wait_for_pc')).toBe('waiting_for_pc')
  expect(nextOccurrenceState('waiting_for_pc', 'pc_claimed')).toBe('transcribing')
  expect(() => nextOccurrenceState('in_meeting', 'pc_claimed')).toThrow(IllegalTransition)
})

// flac.test.ts
test('extractFlac writes 48 kHz mono FLAC and reads its duration', async () => {
  const calls: string[][] = []
  const run: RunLike = async (argv) => {
    calls.push(argv)
    return {
      code: 0,
      stdout: argv[0] === 'ffprobe' ? '5400.5\n' : '',
      stderr: ''
    }
  }
  const out = await extractFlac('/occ', run)
  expect(calls[0]).toEqual([
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    '/occ/recording/meeting.mkv',
    '-map',
    '0:a',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'flac',
    '/occ/audio.flac'
  ])
  expect(calls[1]).toEqual([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    '/occ/audio.flac'
  ])
  expect(out.durationSec).toBe(5400.5)
})
test('extractFlac throws with the stderr when ffmpeg fails', async () => {
  await expect(
    extractFlac('/occ', async () => ({
      code: 1,
      stdout: '',
      stderr: 'no audio stream'
    }))
  ).rejects.toThrow('no audio stream')
})

// pc-check.test.ts
test('startNativeTranscription creates one job, announces it and schedules the check at 120 s', async () => {
  const id = await startNativeTranscription(db, cfgA, deps, fakeFfmpeg)
  expect((await getJob(db, id!))?.payload).toMatchObject({
    entryName: 'Data Mining',
    durationSec: 5400.5
  })
  expect(await listCompanionEvents(db, f.a1, 0)).toContainEqual(
    expect.objectContaining({ command: { type: 'job_available', jobId: id } })
  )
  expect(deps.scheduled).toEqual([['native-job-check', { jobId: id }, 120]])
})
test('startNativeTranscription does nothing when the native transcript exists', async () => {
  await writeFixture(cfgA.dataDir, 'transcript/native/audio.json', '{"segments":[]}')
  expect(await startNativeTranscription(db, cfgA, deps, fakeFfmpeg)).toBeNull()
})
test('an unclaimed job moves the occurrence to waiting_for_pc and pings once', async () => {
  const id = (await startNativeTranscription(db, cfgA, deps, fakeFfmpeg))!
  expect(await checkNativeJob(db, id, deps, plus(120_000))).toBe('waiting_for_pc')
  expect(deps.transitions).toEqual([[cfgA.occurrenceId, 'wait_for_pc']])
  expect(deps.pings).toEqual([
    {
      title: 'Waiting for your PC',
      message: 'Data Mining (Wed 21 Oct) will be transcribed when your PC is on and TolongMeeting is running.',
      priority: 'default',
      actions: [{ label: 'Open meeting page', url: deps.meetingUrl(cfgA.occurrenceId) }]
    }
  ])
  expect(deps.scheduled.at(-1)).toEqual(['native-job-check', { jobId: id }, 300])
})
test('a lapsed lease returns the job to waiting_for_pc without a second ping', async () => {
  const id = (await startNativeTranscription(db, cfgA, deps, fakeFfmpeg))!
  await checkNativeJob(db, id, deps, plus(120_000))
  await claimJob(db, f.a1, id, plus(200_000))
  await deps.transition(db, cfgA.occurrenceId, 'pc_claimed') // what the claim route does
  expect(await checkNativeJob(db, id, deps, plus(900_000))).toBe('waiting_for_pc')
  expect(deps.transitions.map((t) => t[1])).toEqual(['wait_for_pc', 'pc_claimed', 'wait_for_pc'])
  expect(deps.pings).toHaveLength(1)
})
test('a done job stops the checks', async () => {
  const id = (await startNativeTranscription(db, cfgA, deps, fakeFfmpeg))!
  await completeJob(db, id)
  expect(await checkNativeJob(db, id, deps, plus(120_000))).toBe('done')
  expect(deps.scheduled).toHaveLength(1)
})
```

`deps` records `pings`, `transitions` and `scheduled`; its `transition` also updates the fixture occurrence's state; `cfgA` is a `JobConfig` for `f.occA` with entry "Data Mining" starting `2026-10-21T14:00:00+08:00`, time zone `Asia/Kuala_Lumpur`, transcription `native`; `fakeFfmpeg` answers duration `5400.5`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/occurrence-machine.test.ts packages/pipeline/src/native`
Expected: FAIL with "Cannot find module './flac'" and an `IllegalTransition` for `pc_claimed`

- [ ] **Step 3: Implement the triggers, `flac.ts`, `start.ts`, `pc-check.ts`, the consumer branch and the claim hook**

`checkNativeJob`: return `done` or `failed` for finished jobs without rescheduling; otherwise call `releaseExpiredLeases`; if the job is `pending` and the occurrence is `transcribing`, apply `wait_for_pc`, and send the ping above only when `markPcPingSent` returns `true`; reschedule itself after `JOB_LEASE_MS / 1000` seconds while the job is `pending` or `claimed`. The consumer branch runs only when `cfg.entry.transcription === 'native'` and the occurrence is `transcribing`: when `startNativeTranscription` returns a job id the consumer stops there, and when it returns `null` (the native transcript is already uploaded) the consumer goes on to `runPipeline` as for live mode. The claim route applies `pc_claimed` after a successful claim when the occurrence is `waiting_for_pc`. ffmpeg and ffprobe are already in the image `tm-pipeline` runs in (plan 01a).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/occurrence-machine.test.ts packages/pipeline/src/native`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/occurrence-machine.ts packages/core/src/occurrence-machine.test.ts packages/pipeline/src packages/web/app/api/companion/jobs packages/notify/src/messages.ts
git commit -m "feat(pipeline): extract FLAC and wait for the PC"
```

### Task 7: Audio download, transcript upload and failures

**Files:**

- Create: `packages/web/lib/companion/native.ts`, `packages/web/app/api/companion/jobs/[id]/audio/route.ts`, `packages/web/app/api/companion/jobs/[id]/transcript/route.ts`, `packages/web/app/api/companion/jobs/[id]/fail/route.ts`
- Modify: `docker/compose.yaml` (mount the `TM_DATA_ROOT` volume into `web` and set the variable there); `packages/notify/src/messages.ts` (the failure ping)
- Test: `packages/web/lib/companion/native.test.ts`

**Interfaces:**

- Consumes: `getClaimedJob`, `completeJob`, `failJobAttempt`, `emitCompanionEvent` (Task 2); `withDevice` (Task 4); `WhisperJsonSchema`, `shortDate` (Task 1); `applyTrigger` (`fail`), `enqueuePipeline`, `memberNtfy`, `meetingUrl` (plan 01c); `sendPing`.
- Produces:

```ts
export function serveAudio(db: Db, device: DeviceAuth, jobId: string, range: string | null): Promise<Response>
export function acceptTranscript(db: Db, device: DeviceAuth, jobId: string, form: FormData): Promise<Response>
export function reportFailure(db: Db, device: DeviceAuth, jobId: string, error: string): Promise<Response>
export const MAX_TRANSCRIPT_FILE_BYTES = 50 * 1024 * 1024
```

- Routes (adds to contracts): `GET /api/companion/jobs/<id>/audio` (200 or 206 with `Accept-Ranges: bytes`; 404 unless this device holds the native job; 410 when `audio.flac` is gone), `POST /api/companion/jobs/<id>/transcript` (multipart fields `txt`, `srt`, `json`; 204 or 400), `POST /api/companion/jobs/<id>/fail` (body `{ error: string }`; 204).

- [ ] **Step 1: Write the failing test**

```ts
test('audio goes only to the device that holds the job', async () => {
  const id = await claimedNativeJob(f.a1, flacOf(1000))
  expect((await serveAudio(db, f.a1, id, null)).status).toBe(200)
  expect((await serveAudio(db, f.a2, id, null)).status).toBe(404)
  expect((await serveAudio(db, f.b1, id, null)).status).toBe(404)
})
test('a Range request resumes the download', async () => {
  const id = await claimedNativeJob(f.a1, flacOf(1000))
  const res = await serveAudio(db, f.a1, id, 'bytes=400-')
  expect(res.status).toBe(206)
  expect(res.headers.get('content-range')).toBe('bytes 400-999/1000')
  expect((await res.arrayBuffer()).byteLength).toBe(600)
})
test('an upload without srt is refused and keeps audio.flac and the claim', async () => {
  const id = await claimedNativeJob(f.a1, flacOf(1000))
  const res = await acceptTranscript(db, f.a1, id, form({ txt: 'Hello', json: '{"segments":[]}' }))
  expect(res.status).toBe(400)
  expect(existsSync(join(occDirA, 'audio.flac'))).toBe(true)
  expect((await getJob(db, id))?.state).toBe('claimed')
})
test('invalid segment JSON is refused', async () => {
  const id = await claimedNativeJob(f.a1, flacOf(1000))
  expect(
    (await acceptTranscript(db, f.a1, id, form({ txt: 'x', srt: 'x', json: '{"segments":[{"start":"a"}]}' }))).status
  ).toBe(400)
})
test('a valid upload stores three files, deletes audio.flac, completes the job and continues the pipeline', async () => {
  const id = await claimedNativeJob(f.a1, flacOf(1000))
  const res = await acceptTranscript(
    db,
    f.a1,
    id,
    form({
      txt: 'Hello',
      srt: '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
      json: '{"segments":[{"start":1,"end":2,"text":" Hello"}]}'
    })
  )
  expect(res.status).toBe(204)
  for (const ext of ['txt', 'srt', 'json'])
    expect(existsSync(join(occDirA, `transcript/native/audio.${ext}`))).toBe(true)
  expect(existsSync(join(occDirA, 'audio.flac'))).toBe(false)
  expect((await getJob(db, id))?.state).toBe('done')
  expect(enqueued).toEqual([f.occA])
})
test('the first failure re-announces the job; the second fails the occurrence and pings', async () => {
  const id = await claimedNativeJob(f.a1, flacOf(1000))
  await reportFailure(db, f.a1, id, 'RuntimeError: CUDA out of memory\nTraceback (most recent call last):')
  expect(await listCompanionEvents(db, f.a1, 0)).toContainEqual(
    expect.objectContaining({ command: { type: 'job_available', jobId: id } })
  )
  await claimJob(db, f.a1, id)
  await reportFailure(db, f.a1, id, 'RuntimeError: CUDA out of memory\nTraceback (most recent call last):')
  expect(triggers).toEqual([[f.occA, 'fail', { reason: 'native_transcription_failed' }]])
  expect(pings).toEqual([
    {
      title: 'Transcription failed on your PC',
      message: 'Data Mining (Wed 21 Oct): RuntimeError: CUDA out of memory. The recording is on the meeting page.',
      priority: 'default',
      actions: [{ label: 'Open meeting page', url: meetingUrl(f.occA) }]
    }
  ])
})
```

`applyTrigger`, `enqueuePipeline` and `sendPing` are replaced by recorders (`triggers`, `enqueued`, `pings`) through `bun:test`'s `mock.module`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/lib/companion/native.test.ts`
Expected: FAIL with "Cannot find module './native'"

- [ ] **Step 3: Implement `native.ts` and the three routes**

Files are written under `$TM_DATA_ROOT/occurrences/<occurrenceId>/transcript/native/` as `audio.txt`, `audio.srt` and `audio.json`, each through a temporary name and a rename, each at most `MAX_TRANSCRIPT_FILE_BYTES`. Order on success: write the three files, delete `audio.flac`, `completeJob`, `enqueuePipeline`. The failure message uses the error's first line cut to 200 characters; the error is stored on the job and never logged with its full text.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/lib/companion/native.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/companion/native.ts packages/web/lib/companion/native.test.ts packages/web/app/api/companion/jobs docker/compose.yaml packages/notify/src/messages.ts
git commit -m "feat(web): serve audio and accept transcripts"
```

### Task 8: Pipeline from the native transcript

**Files:**

- Create: `packages/pipeline/src/native/read.ts`
- Modify: plan 01a's transcript step in `packages/pipeline/src/` (the reader of `transcript/live.jsonl`), which reads `readNativeTranscript(cfg.dataDir)` when `cfg.entry.transcription === 'native'`
- Test: `packages/pipeline/test/native-read.test.ts`

**Interfaces:**

- Consumes: `WhisperJsonSchema` (Task 1); `runPipeline(cfg: JobConfig): Promise<PipelineResult>`; plan 01a's hallucination filter if `packages/pipeline` exports one.
- Produces: `readNativeTranscript(occDir: string): Promise<{ startMs: number; endMs: number; text: string }[]>`, the same row shape as `transcript/live.jsonl`.

- [x] **Step 1: Write the failing test**

```ts
test('whisper segments become recording-relative rows in milliseconds', async () => {
  const dir = await fixtureOcc({
    'transcript/native/audio.json': JSON.stringify({
      segments: [{ start: 1.234, end: 3.5, text: ' Hello class ' }]
    })
  })
  expect(await readNativeTranscript(dir)).toEqual([{ startMs: 1234, endMs: 3500, text: 'Hello class' }])
})
test('hallucination-only and empty segments are dropped', async () => {
  const segments = [
    { start: 0, end: 1, text: ' you' },
    { start: 1, end: 2, text: ' Thank you for watching!' },
    { start: 2, end: 3, text: '  ' },
    { start: 3, end: 4, text: ' Quiz on Friday.' }
  ]
  const dir = await fixtureOcc({
    'transcript/native/audio.json': JSON.stringify({ segments })
  })
  expect((await readNativeTranscript(dir)).map((r) => r.text)).toEqual(['Quiz on Friday.'])
})
test('runPipeline builds transcript.md from the native transcript', async () => {
  const cfg = await nativeOccurrenceFixture([{ start: 1, end: 2, text: ' Hello class' }])
  const out = await runPipeline(cfg)
  expect(await Bun.file(out.transcriptPath).text()).toContain('[00:00:01] Hello class')
})
```

`nativeOccurrenceFixture` writes a minimal occurrence directory (no `transcript/live.jsonl`) and stubs the AI client the way plan 01a's pipeline tests do.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/pipeline/test/native-read.test.ts`
Expected: FAIL with "Cannot find module './read'"

- [x] **Step 3: Implement `readNativeTranscript` and the branch in the transcript step**

Drop a segment when its text, trimmed, lower-cased and stripped of trailing punctuation, is empty, `you` or `thank you for watching` (reuse plan 01a's filter when it exists, keeping these cases). Round seconds to milliseconds with `Math.round(s * 1000)`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/pipeline/test/native-read.test.ts`
Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add packages/pipeline/src
git commit -m "feat(pipeline): summarise from native transcript"
```

### Task 9: Summary endpoints and the summary tag

**Files:**

- Create: `packages/web/lib/companion/summaries.ts`, `packages/web/app/api/companion/summaries/route.ts`, `packages/web/app/api/companion/summaries/[occurrenceId]/route.ts`
- Modify: the file in `packages/notify/src/` that defines `sendPing` (add `tags`); the summary-ready ping (its builder in `packages/notify/src/messages.ts`, or the `sendPing` call in `packages/pipeline/src/` that sends it), which passes `tags: ['tm_summary']`
- Test: `packages/web/lib/companion/summaries.test.ts`, `packages/notify/src/tags.test.ts`

**Interfaces:**

- Consumes: `withDevice` (Task 4); the `artefacts` table (plan 01c).
- Produces (adds to contracts): `Ping.tags?: string[]`, sent as the ntfy `Tags` header (comma-separated); the tag `tm_summary` on the summary-ready ping; and:

```ts
export function listSummaries(db: Db, memberId: string, after: Date): Promise<SummaryListItem[]> // oldest first, at most 50
export function readSummary(
  db: Db,
  memberId: string,
  occurrenceId: string
): Promise<{ fileName: string; text: string } | null>
```

- Routes (adds to contracts): `GET /api/companion/summaries?after=<ISO 8601>` answers `{ summaries: SummaryListItem[] }`; `GET /api/companion/summaries/<occurrenceId>` answers `text/markdown; charset=utf-8` or 404.

- [ ] **Step 1: Write the failing tests**

```ts
// summaries.test.ts
test("listSummaries returns the member's summaries after a time, oldest first", async () => {
  await summaryArtefact(f.occA, '2026-10-21 1400 Data Mining.md', new Date('2026-10-21T08:00:00Z'))
  await summaryArtefact(f.occB, '2026-10-21 1500 Other.md', new Date('2026-10-21T09:00:00Z'))
  expect(await listSummaries(db, f.a1.memberId, new Date('2026-10-21T07:00:00Z'))).toEqual([
    {
      occurrenceId: f.occA,
      fileName: '2026-10-21 1400 Data Mining.md',
      readyAt: '2026-10-21T08:00:00.000Z'
    }
  ])
  expect(await listSummaries(db, f.a1.memberId, new Date('2026-10-21T08:00:00Z'))).toEqual([])
})
test("another member's summary is a 404", async () => {
  await summaryArtefact(f.occB, '2026-10-21 1500 Other.md', new Date())
  const res = await GET_ONE(authed(`/api/companion/summaries/${f.occB}`, tokenA1), params({ occurrenceId: f.occB }))
  expect(res.status).toBe(404)
})

// tags.test.ts
test('sendPing sends tags as the ntfy Tags header', async () => {
  const seen: Request[] = []
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    seen.push(new Request(input, init))
    return new Response('{}')
  }) as typeof fetch
  await sendPing(
    { url: 'https://ntfy.example', topic: 't', token: 'k' },
    {
      title: 'Summary ready',
      message: 'x',
      priority: 'default',
      tags: ['tm_summary']
    }
  )
  expect(seen[0].headers.get('tags')).toBe('tm_summary')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/companion/summaries.test.ts packages/notify/src/tags.test.ts`
Expected: FAIL with "Cannot find module './summaries'" and a missing `tags` header

- [ ] **Step 3: Implement `summaries.ts`, the two routes, `Ping.tags` and the tag on the summary-ready ping**

A summary is a plan 01c `artefacts` row of the summary kind on one of the member's occurrences; `fileName` is its path's base name and `readyAt` its creation time.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/companion/summaries.test.ts packages/notify/src/tags.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib packages/web/app packages/notify/src packages/pipeline/src
git commit -m "feat(web): list summaries for the companion"
```

### Task 10: Companion shell and installer

**Files:**

- Create: `packages/companion/package.json` (with the electron-builder `build` key), `packages/companion/tsconfig.json`, `packages/companion/src/app-id.ts`, `packages/companion/src/paths.ts`, `packages/companion/src/settings.ts`, `packages/companion/src/state.ts`, `packages/companion/src/secrets.ts`, `packages/companion/src/notifier.ts`, `packages/companion/src/main/index.ts`, `packages/companion/src/main/tray.ts`, `packages/companion/src/main/ports.ts`, `packages/companion/src/preload.ts`, `packages/companion/src/renderer/settings.html`, `packages/companion/assets/icon.ico`, `packages/companion/assets/tray.png`
- Modify: root `package.json` (`"trustedDependencies": ["electron"]`, so Bun runs Electron's binary download)
- Test: `packages/companion/src/shell.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:

```ts
export const APP_USER_MODEL_ID = 'com.tolonglabs.tolongmeeting'
export interface CompanionPaths {
  userData: string
  localData: string
  documents: string
} // %APPDATA%\TolongMeeting, %LOCALAPPDATA%\TolongMeeting, Documents
export const SettingsSchema: z.ZodType<Settings>
export interface Settings {
  serverUrl: string
  summariesDir: string
  whisper: { command: string; cwd: string | null; model: string }
}
export function defaultSettings(documentsDir: string, serverUrl: string): Settings
export function loadSettings(file: string, documentsDir: string, serverUrl: string): Promise<Settings>
export function saveSettings(file: string, s: Settings): Promise<void>
export interface CompanionState {
  ntfyLastId: string | null
  summariesAfter: string | null
  lastEventId: number
}
export class StateStore {
  constructor(file: string)
  get(): CompanionState
  update(patch: Partial<CompanionState>): Promise<void>
}
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}
export type SecretName = 'deviceToken' | 'ntfyToken' // plan 08 adds 'profileKey'
export class EncryptionUnavailableError extends Error {}
export class SecretStore {
  constructor(file: string, safe: SafeStorageLike)
  get(n: SecretName): Promise<string | null>
  set(n: SecretName, v: string): Promise<void>
  clear(): Promise<void>
}
export interface DesktopNotifier {
  show(
    n: { title: string; body: string; sticky: boolean; buttons: string[] },
    on: { click(): void; action(index: number): void }
  ): void
}
```

- [ ] **Step 1: Write the failing test**

```ts
test('defaults: Documents\\Meeting summaries and whisper model medium', () => {
  const s = defaultSettings('C:\\Users\\m\\Documents', 'https://tm.example')
  expect(s.summariesDir).toBe(join('C:\\Users\\m\\Documents', 'Meeting summaries'))
  expect(s.whisper).toEqual({
    command: 'uv run transcriber {audio} -m {model} -f txt,srt,json -o {outDir}',
    cwd: null,
    model: 'medium'
  })
})
test('the installer app ID is the app user model ID', async () => {
  const pkg = await Bun.file('packages/companion/package.json').json()
  expect(pkg.build.appId).toBe(APP_USER_MODEL_ID)
  expect(pkg.build.win.target).toBe('nsis')
  expect(pkg.build.nsis).toMatchObject({ oneClick: true, perMachine: false })
})
test('SecretStore round-trips through safeStorage and never writes plaintext', async () => {
  const file = tmpFile()
  const store = new SecretStore(file, fakeSafe(true))
  await store.set('deviceToken', 'tmd_secret')
  expect(await store.get('deviceToken')).toBe('tmd_secret')
  expect(await Bun.file(file).text()).not.toContain('tmd_secret')
})
test('SecretStore refuses to store when encryption is unavailable', async () => {
  const store = new SecretStore(tmpFile(), fakeSafe(false))
  await expect(store.set('deviceToken', 'tmd_secret')).rejects.toBeInstanceOf(EncryptionUnavailableError)
})
test('loadSettings rejects a malformed file and keeps defaults for missing keys', async () => {
  const file = tmpFile('{"summariesDir":"D:\\\\Notes"}')
  expect((await loadSettings(file, 'C:\\Docs', 'https://tm.example')).whisper.model).toBe('medium')
  await expect(loadSettings(tmpFile('{"whisper":{"model":5}}'), 'C:\\Docs', 'https://tm.example')).rejects.toThrow()
})
```

`fakeSafe(available)` reverses and base64-encodes strings; `tmpFile(content?)` writes a file in a temporary directory.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/shell.test.ts`
Expected: FAIL with "Cannot find module './settings'"

- [ ] **Step 3: Implement the modules and the Electron shell**

- `package.json`: `"main": "dist/main/index.js"`; scripts `build` (`bun build src/main/index.ts src/preload.ts --target=node --format=cjs --external electron --outdir dist`), `start` (`bun run build && electron .`), `pack` (`bun run build && electron-builder --win --dir`), `dist` (`bun run build && electron-builder --win`); `build` key: `appId` `com.tolonglabs.tolongmeeting`, `productName` `TolongMeeting`, `files` `["dist/**", "assets/**", "src/renderer/**"]`, `directories.output` `release`, `win.target` `nsis`, `win.icon` `assets/icon.ico`, `nsis.oneClick` `true`, `nsis.perMachine` `false`. The build is unsigned (internal tool); the acceptance task covers the SmartScreen prompt.
- `main/index.ts`, in this order: `app.requestSingleInstanceLock()` (quit if taken); `app.setAppUserModelId(APP_USER_MODEL_ID)`; `app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })`; build `ports.ts` adapters (`safeStorage`, `powerSaveBlocker`, `Notification` with `actions: [{ type: 'button', text }]` and `timeoutType: 'never'` when sticky, `shell.openPath`, `shell.openExternal`); create the tray; open no window when started with `--hidden`. Later tasks start their loops from here.
- Tray menu, exactly: a disabled status item (`Connected`, `Offline` or `Not paired`), `Open summaries folder`, `Settings`, `Quit TolongMeeting`.
- Windows (`settings.html`, and the pairing view in Task 11) use `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a preload exposing only the IPC calls they need.
- Settings, state and secrets live in `%APPDATA%\TolongMeeting\settings.json`, `state.json` and `secrets.json`; job scratch space in `%LOCALAPPDATA%\TolongMeeting\jobs\`. The default `serverUrl` is injected at build time with `bun build --define` from `TM_PUBLIC_URL`.

- [ ] **Step 4: Run tests, the type check and an unpacked build**

Run: `bun test packages/companion/src/shell.test.ts && bun run typecheck && cd packages/companion && bun run pack`
Expected: PASS (5 tests); no type errors; `packages/companion/release/win-unpacked/TolongMeeting.exe` exists

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock packages/companion
git commit -m "feat(companion): add Electron tray shell"
```

### Task 11: Companion API client and pairing

**Files:**

- Create: `packages/companion/src/api.ts`, `packages/companion/src/pairing.ts`, `packages/companion/src/renderer/pairing.html`
- Modify: `packages/companion/src/main/index.ts` (pairing window on first run or on the unpaired notification's click; `handleRevoked` on 401)
- Test: `packages/companion/src/api.test.ts`

**Interfaces:**

- Consumes: Task 1 schemas; `SecretStore`, `StateStore`, `Settings`, `DesktopNotifier` (Task 10).
- Produces:

```ts
export class DeviceRevokedError extends Error {}
export class CompanionApi {
  constructor(opts: {
    serverUrl: string
    token: () => Promise<string | null>
    onRevoked: () => void
    fetch?: typeof fetch
  })
  jobs(): Promise<CompanionJob[]>
  claim(jobId: string): Promise<CompanionJob | null> // null on 409 or 404
  progress(jobId: string): Promise<void>
  fail(jobId: string, error: string): Promise<void>
  downloadAudio(jobId: string, dest: string): Promise<void> // resumes from `${dest}.part`, renames when complete
  uploadTranscript(jobId: string, files: { txt: string; srt: string; json: string }): Promise<void>
  summaries(after: string): Promise<SummaryListItem[]>
  summary(occurrenceId: string): Promise<string>
  events(lastEventId: number, signal: AbortSignal): Promise<Response> // raw SSE response for Task 14
}
export function pairDevice(serverUrl: string, req: PairRequest, f?: typeof fetch): Promise<PairResponse>
export function completePairing(d: {
  serverUrl: string
  code: string
  deviceName: string
  secrets: SecretStore
  state: StateStore
  saveServerUrl(url: string): Promise<void>
  fetch?: typeof fetch
}): Promise<void>
export function handleRevoked(d: {
  secrets: SecretStore
  stopAll(): void
  notifier: DesktopNotifier
  openPairing(): void
}): Promise<void>
```

- [ ] **Step 1: Write the failing test**

```ts
test('requests carry the token in the Authorization header, never in the URL', async () => {
  const seen: Request[] = []
  const api = new CompanionApi({
    serverUrl: 'https://tm.example',
    token: async () => 'tmd_x',
    onRevoked: () => {},
    fetch: recorder(seen, () => Response.json({ jobs: [] }))
  })
  await api.jobs()
  expect(seen[0].url).toBe('https://tm.example/api/companion/jobs')
  expect(seen[0].headers.get('authorization')).toBe('Bearer tmd_x')
  expect(seen[0].url).not.toContain('tmd_x')
})
test('a 401 calls onRevoked and throws DeviceRevokedError', async () => {
  let revoked = 0
  const api = new CompanionApi({
    serverUrl: 'https://tm.example',
    token: async () => 'tmd_x',
    onRevoked: () => revoked++,
    fetch: recorder([], () => new Response('', { status: 401 }))
  })
  await expect(api.jobs()).rejects.toBeInstanceOf(DeviceRevokedError)
  expect(revoked).toBe(1)
})
test('downloadAudio resumes from the partial file with a Range header', async () => {
  const dest = tmpPath('audio.flac')
  await Bun.write(`${dest}.part`, new Uint8Array(400))
  const seen: Request[] = []
  const api = apiWith(
    recorder(
      seen,
      () =>
        new Response(new Uint8Array(600), {
          status: 206,
          headers: { 'content-range': 'bytes 400-999/1000' }
        })
    )
  )
  await api.downloadAudio('j1', dest)
  expect(seen[0].headers.get('range')).toBe('bytes=400-')
  expect(Bun.file(dest).size).toBe(1000)
})
test('completePairing stores both tokens in the SecretStore and starts summaries at pairedAt', async () => {
  const secrets = new SecretStore(tmpFile(), fakeSafe(true))
  const state = new StateStore(tmpFile('{}'))
  await completePairing({
    serverUrl: 'https://tm.example',
    code: 'ABCD-EFGH',
    deviceName: 'PC',
    secrets,
    state,
    saveServerUrl: async () => {},
    fetch: recorder([], () => Response.json(pairResponse))
  })
  expect(await secrets.get('deviceToken')).toBe(pairResponse.token)
  expect(await secrets.get('ntfyToken')).toBe(pairResponse.ntfy.token)
  expect(state.get().summariesAfter).toBe(pairResponse.pairedAt)
})
test('handleRevoked clears secrets, stops loops and shows the unpaired notification', async () => {
  const shown: { title: string; body: string }[] = []
  let stopped = false
  let opened = false
  const secrets = new SecretStore(tmpFile(), fakeSafe(true))
  await secrets.set('deviceToken', 'tmd_x')
  await handleRevoked({
    secrets,
    stopAll: () => (stopped = true),
    openPairing: () => (opened = true),
    notifier: {
      show: (n, on) => {
        shown.push(n)
        on.click()
      }
    }
  })
  expect(await secrets.get('deviceToken')).toBeNull()
  expect(stopped).toBe(true)
  expect(shown[0]).toMatchObject({
    title: 'TolongMeeting is unpaired',
    body: 'This PC was removed from your account. Click to pair it again.'
  })
  expect(opened).toBe(true)
})
```

`recorder(seen, respond)` is a fake `fetch` that records each `Request` and answers with `respond()`; `apiWith(fetch)` builds a `CompanionApi` with token `tmd_x`; `pairResponse` is a valid `PairResponse` fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/api.test.ts`
Expected: FAIL with "Cannot find module './api'"

- [ ] **Step 3: Implement `api.ts`, `pairing.ts`, the pairing view and the wiring**

The pairing view has two fields, "Website address" (prefilled with `Settings.serverUrl`) and "Pairing code", and shows the server's error text on failure. `ntfy.url` and `ntfy.topic` go into `state.json`; the ntfy token goes only into the `SecretStore`. The device name is `os.hostname()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/api.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): pair with the website"
```

### Task 12: ntfy subscription and desktop notifications

**Files:**

- Create: `packages/companion/src/backoff.ts`, `packages/companion/src/ntfy.ts`
- Modify: `packages/companion/src/main/index.ts` (start the subscriber after pairing; map displays to `DesktopNotifier.show`)
- Test: `packages/companion/src/ntfy.test.ts`

**Interfaces:**

- Consumes: `StateStore`, `DesktopNotifier` (Task 10); the member's `NtfyConfig` (state plus `SecretStore`).
- Produces:

```ts
export function reconnectDelayMs(attempt: number): number // 1000, 2000, 5000, 10000, then 30000
export interface NtfyMessage {
  id: string
  time: number
  title?: string
  message?: string
  priority?: number
  tags?: string[]
  click?: string
  actions?: { action: string; label: string; url?: string }[]
}
export function parseNtfyLine(line: string): NtfyMessage | null // only event === 'message'
export type NtfyDisplay =
  | {
      kind: 'show'
      title: string
      body: string
      sticky: boolean
      buttons: { label: string; url: string }[]
      clickUrl: string | null
    }
  | { kind: 'sync_summaries' }
  | { kind: 'ignore' }
export function toDisplay(m: NtfyMessage, now: Date): NtfyDisplay
export function startNtfySubscriber(d: {
  cfg: NtfyConfig
  state: StateStore
  onMessage(m: NtfyMessage): void
  fetch?: typeof fetch
}): { stop(): void }
```

- [ ] **Step 1: Write the failing test**

```ts
const now = new Date('2026-10-21T08:00:00Z')
const at = (minAgo: number) => Math.floor(now.getTime() / 1000) - minAgo * 60

test('parseNtfyLine keeps message events only', () => {
  expect(parseNtfyLine('{"id":"a","time":1,"event":"keepalive"}')).toBeNull()
  expect(parseNtfyLine('{"id":"b","time":1,"event":"message","message":"hi"}')?.id).toBe('b')
  expect(parseNtfyLine('not json')).toBeNull()
})
test('high priority stays on screen; default does not', () => {
  expect(
    toDisplay(
      {
        id: 'a',
        time: at(0),
        title: 'Form submitted',
        message: 'x',
        priority: 4
      },
      now
    )
  ).toMatchObject({ kind: 'show', sticky: true })
  expect(toDisplay({ id: 'b', time: at(0), message: 'Joined', priority: 3 }, now)).toMatchObject({
    kind: 'show',
    sticky: false,
    title: 'TolongMeeting'
  })
})
test('view actions become buttons and only https URLs are kept', () => {
  const d = toDisplay(
    {
      id: 'a',
      time: at(0),
      message: 'x',
      actions: [
        {
          action: 'view',
          label: 'Open form',
          url: 'https://forms.office.com/r/abc'
        },
        {
          action: 'view',
          label: 'Bad',
          url: 'file:///C:/Windows/system32/calc.exe'
        },
        { action: 'http', label: 'Post', url: 'https://tm.example/x' }
      ]
    },
    now
  )
  expect(d).toMatchObject({
    kind: 'show',
    buttons: [{ label: 'Open form', url: 'https://forms.office.com/r/abc' }],
    clickUrl: 'https://forms.office.com/r/abc'
  })
})
test('messages older than 30 minutes are not shown', () => {
  expect(toDisplay({ id: 'a', time: at(31), message: 'old' }, now).kind).toBe('ignore')
})
test('tm_summary messages trigger a summary sync instead of a notification, however old', () => {
  expect(toDisplay({ id: 'a', time: at(0), message: 'x', tags: ['tm_summary'] }, now).kind).toBe('sync_summaries')
  expect(toDisplay({ id: 'b', time: at(600), message: 'x', tags: ['tm_summary'] }, now).kind).toBe('sync_summaries')
})
test('the subscriber sends the token as a header and resumes with since=<last id>', async () => {
  const seen: Request[] = []
  const state = new StateStore(tmpFile('{"ntfyLastId":"m41"}'))
  const sub = startNtfySubscriber({
    cfg: { url: 'https://ntfy.example', topic: 'tm-abc', token: 'tk' },
    state,
    onMessage: () => {},
    fetch: recorder(seen, () => streamOf('{"id":"m42","time":1,"event":"message","message":"x"}\n'))
  })
  await Bun.sleep(20)
  sub.stop()
  expect(seen[0].url).toBe('https://ntfy.example/tm-abc/json?since=m41')
  expect(seen[0].headers.get('authorization')).toBe('Bearer tk')
  expect(state.get().ntfyLastId).toBe('m42')
})
```

`streamOf(text)` answers a 200 response whose body streams `text` and then closes; `recorder` is Task 11's fake `fetch`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/ntfy.test.ts`
Expected: FAIL with "Cannot find module './ntfy'"

- [ ] **Step 3: Implement `backoff.ts`, `ntfy.ts` and the wiring**

`sticky` is `priority >= 4`; `title` falls back to `TolongMeeting`; `clickUrl` is the message's `click` when it is `https:`, else the first kept button's URL. In `main/index.ts`, a click or button opens its URL with `shell.openExternal` only after a second `https:` check; `sync_summaries` calls Task 13's `syncSummaries`. Without a stored `ntfyLastId`, the first connection omits `since`. Reconnects wait `reconnectDelayMs(attempt)`, resetting after a message arrives.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/ntfy.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): show ntfy pings as notifications"
```

### Task 13: Summary files

**Files:**

- Create: `packages/companion/src/summaries.ts`
- Modify: `packages/companion/src/main/index.ts` (sync at start, after each reconnect of the command stream and on `sync_summaries`; `Open summaries folder` tray item)
- Test: `packages/companion/src/summaries.test.ts`

**Interfaces:**

- Consumes: `CompanionApi.summaries`, `CompanionApi.summary` (Task 11); `StateStore`, `DesktopNotifier` (Task 10).
- Produces:

```ts
export function windowsSafeFileName(name: string): string
export function syncSummaries(d: {
  api: Pick<CompanionApi, 'summaries' | 'summary'>
  dir: string
  state: StateStore
}): Promise<string[]> // paths newly written
export function showSummaryNotification(
  path: string,
  dir: string,
  d: {
    notifier: DesktopNotifier
    openPath(p: string): Promise<string>
    exists(p: string): boolean
  }
): void
```

- [ ] **Step 1: Write the failing test**

```ts
test('windowsSafeFileName replaces what Windows forbids', () => {
  expect(windowsSafeFileName('2026-10-21 1400 CS6013: AI/ML?.md')).toBe('2026-10-21 1400 CS6013- AI-ML-.md')
  expect(windowsSafeFileName('2026-10-21 1400 Week 3. .md')).toBe('2026-10-21 1400 Week 3.md')
  expect(windowsSafeFileName('CON.md')).toBe('_CON.md')
  expect(windowsSafeFileName(`2026-10-21 1400 ${'x'.repeat(300)}.md`).length).toBe(200)
})
test('syncSummaries saves new files and never overwrites an existing one', async () => {
  const dir = tmpDir()
  await Bun.write(join(dir, '2026-10-20 0900 Old.md'), 'my edits')
  const api = fakeSummaries([
    {
      occurrenceId: 'o1',
      fileName: '2026-10-20 0900 Old.md',
      readyAt: '2026-10-21T01:00:00.000Z',
      text: 'server copy'
    },
    {
      occurrenceId: 'o2',
      fileName: '2026-10-21 1400 CS6013: AI.md',
      readyAt: '2026-10-21T08:00:00.000Z',
      text: 'Do next: read ch. 3'
    }
  ])
  const state = new StateStore(tmpFile('{"summariesAfter":"2026-10-21T00:00:00.000Z"}'))
  const written = await syncSummaries({ api, dir, state })
  expect(written).toEqual([join(dir, '2026-10-21 1400 CS6013- AI.md')])
  expect(await Bun.file(join(dir, '2026-10-20 0900 Old.md')).text()).toBe('my edits')
  expect(state.get().summariesAfter).toBe('2026-10-21T08:00:00.000Z')
})
test('syncing never opens anything; clicking the notification opens the file', async () => {
  const opened: string[] = []
  const shown: { title: string; body: string }[] = []
  let click = () => {}
  const d = {
    notifier: {
      show: (n: { title: string; body: string }, on: { click(): void }) => {
        shown.push(n)
        click = on.click
      }
    },
    openPath: async (p: string) => (opened.push(p), ''),
    exists: () => true
  }
  showSummaryNotification('C:\\S\\2026-10-21 1400 Data Mining.md', 'C:\\S', d)
  expect(opened).toEqual([])
  expect(shown[0]).toEqual(
    expect.objectContaining({
      title: 'Summary ready',
      body: '2026-10-21 1400 Data Mining'
    })
  )
  click()
  expect(opened).toEqual(['C:\\S\\2026-10-21 1400 Data Mining.md'])
})
test('clicking a summary whose file was moved opens the folder', () => {
  const opened: string[] = []
  let click = () => {}
  showSummaryNotification('C:\\S\\gone.md', 'C:\\S', {
    notifier: {
      show: (_n, on) => {
        click = on.click
      }
    },
    openPath: async (p) => (opened.push(p), ''),
    exists: () => false
  })
  click()
  expect(opened).toEqual(['C:\\S'])
})
```

`fakeSummaries(items)` implements `summaries(after)` (items with `readyAt > after`) and `summary(occurrenceId)` (the item's `text`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/summaries.test.ts`
Expected: FAIL with "Cannot find module './summaries'"

- [ ] **Step 3: Implement `summaries.ts` and the wiring**

`windowsSafeFileName`: replace each of `<>:"/\|?*` and control characters with `-`; trim trailing dots and spaces from the stem; prefix `_` when the stem is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`); cut the stem so the whole name is at most 200 characters, keeping `.md`. `syncSummaries` pages through `summaries(after)` until a page has fewer than 50 items, creates the folder if needed, writes through `<name>.part` and a rename, skips names that already exist, and advances `summariesAfter` after each item. The wiring shows one notification per newly written file and never calls `openPath` outside a click.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/summaries.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): save summary files"
```

### Task 14: Command stream client and job poller

**Files:**

- Create: `packages/companion/src/sse.ts`, `packages/companion/src/jobs/poller.ts`
- Modify: `packages/companion/src/main/index.ts` (start both after pairing; tray status `Connected` while the stream is open, `Offline` otherwise)
- Test: `packages/companion/src/sse.test.ts`

**Interfaces:**

- Consumes: `CompanionApi.events`, `CompanionApi.jobs` (Task 11); `reconnectDelayMs` (Task 12); `StateStore`; `CompanionEventSchema` (Task 1).
- Produces:

```ts
export function parseSse(
  chunks: AsyncIterable<Uint8Array>
): AsyncIterable<{ id: string | null; event: string | null; data: string }>
export function startCommandStream(d: {
  api: Pick<CompanionApi, 'events'>
  state: StateStore
  onEvent(e: CompanionEvent): void
  onStatus(open: boolean): void
}): { stop(): void }
export function startJobPoller(d: {
  api: Pick<CompanionApi, 'jobs'>
  onJobs(jobs: CompanionJob[]): void
  intervalMs?: number
}): { trigger(): void; stop(): void } // default 60000
```

- [ ] **Step 1: Write the failing test**

```ts
test('parseSse joins fields split across chunks and skips comments', async () => {
  const out = await Array.fromAsync(
    parseSse(
      chunksOf(['id: 7\nevent: job_av', 'ailable\ndata: {"type":"job_available","jobId":"j1"}\n\n: keepalive\n\n'])
    )
  )
  expect(out).toEqual([
    {
      id: '7',
      event: 'job_available',
      data: '{"type":"job_available","jobId":"j1"}'
    }
  ])
})
test('the command stream resumes with the last event id and stores it', async () => {
  const ids: number[] = []
  const state = new StateStore(tmpFile('{"lastEventId":6}'))
  const api = {
    events: async (last: number) => {
      ids.push(last)
      return sseResponse('id: 7\nevent: job_available\ndata: {"type":"job_available","jobId":"j1"}\n\n')
    }
  }
  const s = startCommandStream({
    api,
    state,
    onEvent: () => {},
    onStatus: () => {}
  })
  await Bun.sleep(1200)
  s.stop()
  expect(ids.slice(0, 2)).toEqual([6, 7])
  expect(state.get().lastEventId).toBe(7)
})
test('trigger polls at once; otherwise the poller waits for the interval', async () => {
  let polls = 0
  const p = startJobPoller({
    api: { jobs: async () => (polls++, []) },
    onJobs: () => {},
    intervalMs: 100
  })
  await Bun.sleep(20)
  expect(polls).toBe(1)
  p.trigger()
  await Bun.sleep(20)
  expect(polls).toBe(2)
  await Bun.sleep(100)
  p.stop()
  expect(polls).toBe(3)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/sse.test.ts`
Expected: FAIL with "Cannot find module './sse'"

- [ ] **Step 3: Implement `sse.ts`, `poller.ts` and the wiring**

Each event's `data` is parsed with `CompanionEventSchema` (unknown commands are dropped); `lastEventId` is stored after `onEvent` returns. On `job_available` the wiring calls `poller.trigger()`; on every stream (re)connect it calls `syncSummaries`. A `DeviceRevokedError` from either loop runs `handleRevoked`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/sse.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): follow commands and poll jobs"
```

### Task 15: Native transcription runner and keep-awake

**Files:**

- Create: `packages/companion/src/keep-awake.ts`, `packages/companion/src/jobs/whisper.ts`, `packages/companion/src/jobs/native-runner.ts`
- Modify: `packages/companion/src/main/index.ts` (poller `onJobs` feeds the runner; `Settings` window gains the whisper command, folder and model fields)
- Test: `packages/companion/src/jobs/native-runner.test.ts`

**Interfaces:**

- Consumes: `CompanionApi` (Task 11); `Settings`, `DesktopNotifier` (Task 10); `NativeJobPayload` (Task 1).
- Produces:

```ts
export interface PowerBlockerLike {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}
export class KeepAwake {
  constructor(blocker: PowerBlockerLike)
  acquire(reason: string): () => void
} // reference-counted; one OS request while held
export function buildWhisperArgv(template: string, vars: { audio: string; model: string; outDir: string }): string[]
export function whisperTimeoutMs(durationSec: number): number // max(30 minutes, 6 x duration)
export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { cwd: string; shell: false; windowsHide: true }
) => {
  exited: Promise<number>
  stdout(): string
  stderrTail(): string
  kill(): void
} // exited rejects on a spawn error
export function runWhisper(o: {
  argv: string[]
  cwd: string
  timeoutMs: number
  spawn: SpawnLike
}): Promise<{ ok: true } | { ok: false; error: string }>
export class NativeRunner {
  constructor(d: {
    api: CompanionApi
    settings: () => Settings
    jobsDir: string
    keepAwake: KeepAwake
    spawn: SpawnLike
    notifier: DesktopNotifier
    openSettings(): void
    progressMs?: number
    uploadRetryMs?: number
  }) // both default 60000
  offer(jobs: CompanionJob[]): void // claims one pending native job when idle
  readonly busy: boolean
}
```

- [ ] **Step 1: Write the failing test**

```ts
test('buildWhisperArgv keeps paths with spaces as one argument', () => {
  expect(
    buildWhisperArgv('uv run transcriber {audio} -m {model} -f txt,srt,json -o {outDir}', {
      audio: 'C:\\Users\\A B\\a.flac',
      model: 'medium',
      outDir: 'C:\\Users\\A B\\out'
    })
  ).toEqual([
    'uv',
    'run',
    'transcriber',
    'C:\\Users\\A B\\a.flac',
    '-m',
    'medium',
    '-f',
    'txt,srt,json',
    '-o',
    'C:\\Users\\A B\\out'
  ])
})
test('whisperTimeoutMs is at least 30 minutes and 6 times the audio', () => {
  expect(whisperTimeoutMs(60)).toBe(1_800_000)
  expect(whisperTimeoutMs(5400)).toBe(32_400_000)
})
test('runWhisper spawns hidden, without a shell, in the configured folder', async () => {
  const calls: unknown[][] = []
  await runWhisper({
    argv: ['uv', 'run', 'transcriber'],
    cwd: 'C:\\wt',
    timeoutMs: 1000,
    spawn: (c, a, o) => (calls.push([c, a, o]), okProcess())
  })
  expect(calls[0]).toEqual(['uv', ['run', 'transcriber'], { cwd: 'C:\\wt', shell: false, windowsHide: true }])
})
test('one job at a time: the runner claims the next job only when idle', async () => {
  const r = runnerWith({ whisper: slowProcess(50) })
  r.offer([pending('j1'), pending('j2')])
  r.offer([pending('j2')])
  await Bun.sleep(10)
  expect(fakeApi.claims).toEqual(['j1'])
  await Bun.sleep(100)
  r.offer([pending('j2')])
  await Bun.sleep(10)
  expect(fakeApi.claims).toEqual(['j1', 'j2'])
})
test('a successful job uploads txt, srt and json, then deletes the FLAC', async () => {
  const r = runnerWith({ whisper: writesOutputs() })
  r.offer([pending('j1')])
  await idle(r)
  expect(fakeApi.uploads).toEqual([{ jobId: 'j1', files: ['audio.txt', 'audio.srt', 'audio.json'] }])
  expect(existsSync(join(jobsDir, 'j1', 'audio.flac'))).toBe(false)
})
test('a failed upload keeps the FLAC and retries with progress calls in between', async () => {
  const r = runnerWith({
    whisper: writesOutputs(),
    uploadFailures: 1,
    progressMs: 10
  })
  r.offer([pending('j1')])
  await idle(r)
  expect(fakeApi.uploadAttempts).toBe(2)
  expect(fakeApi.flacPresentAtEachUpload).toEqual([true, true])
  expect(fakeApi.progressCalls).toBeGreaterThan(0)
})
test('a whisper failure reports the stderr tail and cleans up', async () => {
  const r = runnerWith({
    whisper: failingProcess(1, 'RuntimeError: CUDA out of memory')
  })
  r.offer([pending('j1')])
  await idle(r)
  expect(fakeApi.failures).toEqual([{ jobId: 'j1', error: 'RuntimeError: CUDA out of memory' }])
  expect(existsSync(join(jobsDir, 'j1'))).toBe(false)
})
test('a command that is not installed is reported, not thrown', async () => {
  const r = runnerWith({ whisper: spawnError('spawn uv ENOENT') })
  r.offer([pending('j1')])
  await idle(r)
  expect(fakeApi.failures).toEqual([{ jobId: 'j1', error: 'spawn uv ENOENT' }])
})
test('without a whisper folder the runner claims nothing and notifies once', async () => {
  const shown: { title: string; body: string }[] = []
  const r = runnerWith({ cwd: null, notifier: { show: (n) => shown.push(n) } })
  r.offer([pending('j1')])
  r.offer([pending('j1')])
  expect(fakeApi.claims).toEqual([])
  expect(shown).toEqual([
    expect.objectContaining({
      title: 'Set up native transcription',
      body: 'A meeting is waiting to be transcribed. Click to choose your whisper-transcriber folder.'
    })
  ])
})
test('the PC is kept awake through one OS request while jobs run', () => {
  const calls: string[] = []
  const k = new KeepAwake({
    start: (t) => (calls.push(`start ${t}`), 1),
    stop: (id) => calls.push(`stop ${id}`)
  })
  const a = k.acquire('j1')
  const b = k.acquire('local')
  a()
  a()
  b()
  expect(calls).toEqual(['start prevent-app-suspension', 'stop 1'])
})
test('the companion never changes power settings', async () => {
  const files = (await Array.fromAsync(new Bun.Glob('packages/companion/src/**/*.ts').scan())).filter(
    (f) => !f.endsWith('native-runner.test.ts')
  )
  for (const f of files) expect(await Bun.file(f).text()).not.toMatch(/powercfg/i)
})
```

`runnerWith` builds a `NativeRunner` over `fakeApi` (records `claims`, `uploads`, `uploadAttempts`, `flacPresentAtEachUpload`, `progressCalls`, `failures`; `downloadAudio` writes a 1000-byte `audio.flac`) with `uploadRetryMs: 10`; `okProcess()`, `slowProcess(ms)`, `writesOutputs()`, `failingProcess(code, stderr)` and `spawnError(message)` are `SpawnLike` fakes; `pending(id)` is a pending native `CompanionJob`; `idle(r)` waits until `r.busy` is false. The last test skips its own file, the only one that names the command.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/jobs/native-runner.test.ts`
Expected: FAIL with "Cannot find module './whisper'"

- [ ] **Step 3: Implement `keep-awake.ts`, `whisper.ts`, `native-runner.ts` and the wiring**

Per job, in order: `claim` (skip on `null`); `keepAwake.acquire(jobId)`; every `progressMs` call `progress`; `downloadAudio` to `<jobsDir>\<jobId>\audio.flac`; run `buildWhisperArgv(settings.whisper.command, { audio, model: settings.whisper.model, outDir: <jobsDir>\<jobId>\out })` in `settings.whisper.cwd` with `whisperTimeoutMs(payload.durationSec)`; expect `out\audio.txt`, `out\audio.srt` and `out\audio.json`; `uploadTranscript`, retrying every `uploadRetryMs` until it succeeds or the job is lost (404); then delete the job folder; finally release the keep-awake and stop progress calls. On a whisper failure, a spawn error (reported as its message, for example `spawn uv ENOENT`), a timeout or missing output, call `fail` with the last 2 KB of stderr (the server uses the first line) and delete the job folder. `buildWhisperArgv` splits the template on whitespace outside double quotes, then replaces `{audio}`, `{model}` and `{outDir}` inside each token. The "Set up native transcription" notification opens the Settings window on click and is shown once per companion start.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/jobs/native-runner.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): run native transcription jobs"
```

### Task 16: Milestone acceptance

**Files:**

- Create: `docs/acceptance/03-companion-and-native.md` (results of each check below, with date, build version and pass or fail)

**Interfaces:**

- Consumes: everything above, deployed with plan 01c's Compose stack, and a Windows 11 PC with whisper-transcriber installed (`uv run transcriber` works in its folder).

- [ ] **Step 1: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: all tests pass; no type errors

- [ ] **Step 2: Build and install**

Run `cd packages/companion && bun run dist`, copy `packages/companion/release/TolongMeeting Setup <version>.exe` to the test PC and install it (accept SmartScreen's "More info", "Run anyway" for the unsigned build). Pass: the tray icon appears, no window opens after a reboot (started with `--hidden`), and the Start menu shortcut exists.

- [ ] **Step 3: Pair and check the token's scope**

Pair the PC from the website's Devices page. Then create a second pairing code and redeem it by hand, `curl -X POST https://<tm-host>/api/companion/pair -H "Content-Type: application/json" -d '{"code":"<code>","deviceName":"curl"}'`, and with the returned token request with `curl -H "Authorization: Bearer <device-token>"`: `/api/companion/jobs` (200), a meeting page API under `/api/` (403), plan 01c's remote-view `forward_auth` endpoint (403), an export route (403), and another member's summary under `/api/companion/summaries/<occurrence-id>` (404). Pass: exactly those codes (design acceptance test "Isolation", for device tokens). Remove the "curl" device afterwards.

- [ ] **Step 4: Notifications and summary files**

Send a test ping from the Notifications page (normal), then a high-priority test ping. Run a short live-mode test meeting to completion. Pass: both pings appear as Windows notifications, the high one stays until dismissed; the summary file appears in `Documents\Meeting summaries` with the exact name `YYYY-MM-DD HHmm <entry name>.md`; nothing opens until the "Summary ready" notification is clicked, and the click opens the file in the default Markdown app. Repeat with the companion quit when the summary arrives and started 10 minutes later. Pass: the file is saved on start and its notification appears, without opening anything.

- [ ] **Step 5: Native mode end to end**

Schedule a 20-minute native-mode Zoom test lecture. Pass: after the end, the meeting page shows `transcribing`; the companion downloads the FLAC, `powercfg /requests` (read-only, in an administrator terminal) lists TolongMeeting under SYSTEM while whisper runs and not after; `powercfg /query` output is identical before and after; the transcript, summary and summary file arrive; `audio.flac` is gone from the occurrence directory on the server and from `%LOCALAPPDATA%\TolongMeeting\jobs\`.

- [ ] **Step 6: PC off and one ping**

Shut the PC down before a native-mode test meeting ends. Pass: about 2 minutes after the pipeline starts, the meeting page shows "Waiting for your PC" and exactly one normal-priority ping arrives; 15 minutes later there is still only one. Start the PC. Pass: the job is claimed within a minute of the companion starting, the occurrence returns to `transcribing` and completes. Then put the PC to sleep mid-job. Pass: about 5 minutes later the occurrence is back in `waiting_for_pc` with no new ping, and on wake the job completes.

- [ ] **Step 7: Failure and revocation**

Set the whisper command to `uv run nosuchtool {audio}` and run a native-mode test meeting. Pass: two attempts, then the occurrence is `failed` and one "Transcription failed on your PC" ping names the error. Revoke the PC on the Devices page. Pass: within a minute the "TolongMeeting is unpaired" notification appears, `%APPDATA%\TolongMeeting\secrets.json` no longer holds the device token, and clicking the notification opens the pairing window.

- [ ] **Step 8: Commit**

```bash
git add docs/acceptance/03-companion-and-native.md
git commit -m "docs: record companion acceptance results"
```
