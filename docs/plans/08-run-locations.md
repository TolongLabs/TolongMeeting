# Run locations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each identity run somewhere other than the server: on the member's PC (local mode, through the companion app and Docker Desktop), or on the server with its traffic leaving through the member's home connection (a Tailscale exit node).

**Architecture:** Local mode: at T-60 the scheduler hands a `local_run` companion job to the PC bound to the identity. The companion runs the same worker image in Docker Desktop, keeps the identity's profile only on the PC as encrypted checkpoints under a key held in `safeStorage`, passes secrets through short-lived files, relays heartbeats and commands through a loopback relay, and after the meeting uploads the artefacts (in native mode it first extracts the FLAC and transcribes locally), after which the server's pipeline continues as usual. Home route: for `server_via_home` identities the scheduler starts a Tailscale sidecar container per worker with `--exit-node` set to the member's home device, and runs the worker in the sidecar's network namespace; a setup page enrols the home device with a single-use tagged key.

**Tech Stack:** Docker Desktop (WSL 2 backend) and the Docker CLI, Electron, `node:http`, iptables, Tailscale (pinned `tailscale/tailscale` image, API v2 through an OAuth client), x11vnc and noVNC (from plan 01c), Next.js, Drizzle, pg-boss.

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

**Order:** Spike 1 can move this plan to right after 01c, if university sign-ins fail from the server; plan 03 then moves with it, because local mode runs inside the companion app. The home-route tasks (11 to 13) need only plan 01c.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Tasks](#tasks)
    1.  [Task 1: Run-location settings](#task-1-run-location-settings)
    1.  [Task 2: Local run dispatch](#task-2-local-run-dispatch)
    1.  [Task 3: Local run endpoints](#task-3-local-run-endpoints)
    1.  [Task 4: Docker driver and preflight](#task-4-docker-driver-and-preflight)
    1.  [Task 5: Local profile vault and short-lived files](#task-5-local-profile-vault-and-short-lived-files)
    1.  [Task 6: Heartbeat relay](#task-6-heartbeat-relay)
    1.  [Task 7: Egress rules](#task-7-egress-rules)
    1.  [Task 8: Local worker lifecycle](#task-8-local-worker-lifecycle)
    1.  [Task 9: After a local meeting](#task-9-after-a-local-meeting)
    1.  [Task 10: Local sign-in view](#task-10-local-sign-in-view)
    1.  [Task 11: Home device enrolment](#task-11-home-device-enrolment)
    1.  [Task 12: Home route check at T-60](#task-12-home-route-check-at-t-60)
    1.  [Task 13: Home route sidecar](#task-13-home-route-sidecar)
    1.  [Task 14: Milestone acceptance](#task-14-milestone-acceptance)

## Global Constraints

- **Run locations** (decision 39): per identity, `server` (default), `server_via_home` or `local` (`RunLocation`); spike 1's report sets each member's defaults.
- **Local mode**: the companion runs the same worker image through Docker Desktop. Nothing appears on the member's desktop and no keyboard or mouse input is involved; every child process starts with `windowsHide: true` and no shell.
- **Local profile**: lives only on the PC as encrypted checkpoints (the same scheme as the server: plan 01c's `profileKey(localKey, identityId)` from `packages/core/src/secrets.ts`, with the PC's 32-byte local key in place of the master key) and is never uploaded. `profiles.location` is `local` for such identities. The device token can't download server profiles, so switching an identity to My PC means signing in again on the PC, and the server's copy is deleted.
- **Short-lived files**: the identity's profile key (32 bytes, base64, in the file named by plan 01c's `TM_PROFILE_KEY_FILE`, which `loadProfileKey` reads) and the job file holding the AI key and saved details reach a container only as files in a per-run folder mounted read-only at `/run/tm`. The companion deletes them once that attempt's first heartbeat arrives, or 120 seconds after the container starts. They are never environment variables or command-line arguments.
- **Native mode on the PC**: 48 kHz mono FLAC is extracted on the PC; only artefacts and transcripts are uploaded; the FLAC is deleted once the transcript is uploaded.
- **PC off**: if the bound PC is asleep or off at T-60 (not seen for 90 seconds, or no claim within 120 seconds), the occurrence becomes `skipped_pc_offline` and the member gets a high-priority ping straight away.
- **Memory**: Docker Desktop needs about 4 GB for a worker; the companion checks it before the first local run and before each run. A native transcription job never runs at the same time as a local worker (ASR-02).
- **Control**: the worker's 5-second heartbeat and its commands go through the companion; the relay and noVNC listen on `127.0.0.1` only, and the home network never accepts incoming connections.
- **Network**: local and home-route workers are blocked from `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `fe80::/10` and `fc00::/7`, as on the server, except the companion's relay port.
- **Home route**: worker traffic leaves through the member's Tailscale exit node and never falls back to the server's own address. If the exit node is offline at T-60, the member gets a high-priority ping.
- **Secrets and URLs**: keys and tokens are never logged and never put in the app's URL query strings.
- **From plan 01c, by name**: as listed in plan 03 (`Db`, `createTestDb`, `seedMember`, `applyTrigger` with its `skip_pc_offline`, `crash` and `fail` triggers, `packages/web/app/`, `packages/web/lib/`, `packages/web/lib/scope.ts`, `packages/notify/src/messages.ts`, where this plan's ping copy goes too), plus the `profiles` table (`location` `server` or `local`), `profileKey` and `loadProfileKey` with `TM_PROFILE_KEY_FILE`, `ACTIVE_STATES`, the worker image `tolongmeeting/worker:current` and the worker network `tm-workers`.
- **From plan 01c, by role** (use 01c's names and keep these signatures): `enqueuePipeline`, `scheduleJob`, `memberNtfy`, `meetingUrl`, `requireMember` (as in plan 03); `handleHeartbeat(db: Db, hb: Heartbeat): Promise<HeartbeatReply>` (the worker heartbeat endpoint's handler); `pingRestart(db: Db, occurrenceId: string, attempt: number): Promise<void>` and `pingWorkerFailed(db: Db, occurrenceId: string, reason: string): Promise<void>`; `buildJobConfig(db: Db, occurrenceId: string, attempt: number): Promise<JobConfig>`; `launchWorker(cfg: JobConfig, opts?: { networkMode?: string }): Promise<void>` (this plan adds `opts`); `allowCreate(body: unknown): boolean` (the docker-proxy create policy); the T-60 start handler, the server capacity count and the heartbeat-timeout monitor in `packages/scheduler/src/`; the worker image's sign-in mode (`tm-worker --signin`) and noVNC port `6080`; the Accounts and identity settings pages.
- **Plan 03 names**: `CompanionApi`, `SecretStore`, `StateStore`, `Settings`, `KeepAwake`, `NativeRunner`, `buildWhisperArgv`, `runWhisper`, `whisperTimeoutMs`, `SpawnLike`, `DesktopNotifier`, `withDevice`, `DeviceAuth`, `createCompanionJob`, `emitCompanionEvent`, `listCompanionEvents`, `listJobsForDevice`, `claimJob`, `completeJob`, `getClaimedJob`, `getJob`, `releaseExpiredLeases`, `revokeDevice`, `reportFailure`, `shortDate`, `seedCompanionFixture`.
- **Database tests**: as in plan 03, on `createTestDb()`.

## Review Focus

- **Docker Desktop not running at T-60**, common after a restart: a high-priority ping straight away, retries every 30 seconds, and the run starts if Docker comes up before T-10; otherwise the occurrence fails with that reason (Tasks 3 and 8).
- **Signing in on the PC while a local run starts or runs**: never two Chromes on one profile. The view attaches to the running worker's desk with automation paused, and an open sign-in container is stopped and checkpointed before a run starts (Tasks 8 and 10).
- **PC sleeps or loses the network mid-upload**: the upload resumes from the last byte the server holds, the occurrence isn't failed, and the companion picks the upload up again after a restart (Tasks 2 and 9).
- **A crash leaves a decrypted profile volume on the PC**: on the next start the companion checkpoints it and removes it (Task 5).
- **The bound PC is revoked**: the identity never quietly runs on the server; at T-60 it becomes `skipped_pc_offline` with a ping that says no PC is paired (Tasks 1 and 2).

## Tasks

### Task 1: Run-location settings

**Files:**

- Modify: `packages/core/src/companion.ts` (local-run contracts); `packages/web/db/companion.ts` (column `identities.local_device_id`, three queries, a migration); `packages/web/lib/companion/tokens.ts` (`revokeDevice` clears bindings); plan 01c's identity settings page (run-location choice and PC picker)
- Create: `packages/web/lib/run-locations/settings.ts`, `packages/web/app/api/identities/[id]/run-location/route.ts`, `packages/web/app/api/companion/identities/route.ts`, `packages/scheduler/src/profile-delete.ts`
- Modify: `.env.example` (`TM_WORKER_IMAGE_REF`)
- Test: `packages/core/src/companion.test.ts`, `packages/web/lib/run-locations/settings.test.ts`, `packages/scheduler/src/profile-delete.test.ts`

**Interfaces:**

- Consumes: plan 03's companion contracts and tables; `emitCompanionEvent`, `scheduleJob`.
- Produces (adds to contracts): environment variable `TM_WORKER_IMAGE_REF` (web and scheduler: the registry reference of the worker image PCs pull, for example `ghcr.io/<org>/tolongmeeting-worker:<version>`, the same build the server runs); and:

```ts
// packages/core/src/companion.ts
export type CompanionJobKind = 'native_transcription' | 'local_run'
export interface LocalRunPayload {
  occurrenceId: string
  identityId: string
  identityName: string
  image: string
  job: JobConfig
} // job.ai.apiKey '', job.member.details [], job.ntfy.token '', job.control null
export type CompanionJob = {
  id: string
  state: CompanionJobState
  occurrenceId: string
  attempts: number
} & ({ kind: 'native_transcription'; payload: NativeJobPayload } | { kind: 'local_run'; payload: LocalRunPayload })
export type CompanionCommand =
  | { type: 'job_available'; jobId: string }
  | { type: 'open_signin'; identityId: string }
  | { type: 'local_identities_changed' }
export interface LocalSecrets {
  apiKey: string
  details: SavedDetail[]
}
export type PreflightReason = 'ok' | 'docker_unavailable' | 'docker_memory_low' | 'image_unavailable'
export interface PreflightReport {
  reason: PreflightReason
  dockerMemBytes: number | null
}
export const MIN_DOCKER_MEM_BYTES = 4_026_531_840 // 3.75 GiB: a 4 GB Docker Desktop allotment reports about 3.8 GiB
export const DEVICE_ONLINE_WINDOW_MS = 90_000
export const LOCAL_HEARTBEAT_TIMEOUT_MS = 120_000
export function shortTime(iso: string, timeZone: string): string // '14:00'

// packages/web/db/companion.ts
export function isDeviceOnline(db: Db, deviceId: string, now?: Date): Promise<boolean>
export function deviceName(db: Db, deviceId: string): Promise<string | null>
export function listLocalIdentities(db: Db, device: DeviceAuth): Promise<{ id: string; name: string }[]>

// packages/web/lib/run-locations/settings.ts
export type RunLocationChoice =
  { location: 'server' } | { location: 'server_via_home' } | { location: 'local'; deviceId: string }
export function setRunLocation(
  db: Db,
  memberId: string,
  identityId: string,
  choice: RunLocationChoice
): Promise<{ ok: true } | { ok: false; error: 'device_not_found' }> // Task 11 adds 'home_route_not_set_up'

// packages/scheduler/src/profile-delete.ts, pg-boss queue 'profile-delete'
export function deleteServerProfile(identityId: string, profileRoot?: string): Promise<void> // default $TM_PROFILE_ROOT
```

- Routes (adds to contracts): `PUT /api/identities/<id>/run-location` (member session, body `RunLocationChoice`); `GET /api/companion/identities` (device token) answers `{ identities: { id: string; name: string }[]; image: string }`, where `image` is `TM_WORKER_IMAGE_REF`.

- [ ] **Step 1: Write the failing tests**

```ts
// companion.test.ts (added)
test('shortTime and the memory floor', () => {
  expect(shortTime('2026-10-21T14:00:00+08:00', 'Asia/Kuala_Lumpur')).toBe('14:00')
  expect(MIN_DOCKER_MEM_BYTES).toBe(3.75 * 1024 ** 3)
})

// settings.test.ts
test("My PC needs one of the member's own unrevoked devices", async () => {
  expect(
    await setRunLocation(db, memberA, identityA, {
      location: 'local',
      deviceId: f.b1.deviceId
    })
  ).toEqual({ ok: false, error: 'device_not_found' })
  expect(
    await setRunLocation(db, memberA, identityA, {
      location: 'local',
      deviceId: f.a1.deviceId
    })
  ).toEqual({ ok: true })
})
test('switching to My PC deletes the server profile and tells that PC', async () => {
  await setRunLocation(db, memberA, identityA, {
    location: 'local',
    deviceId: f.a1.deviceId
  })
  expect(scheduled).toContainEqual(['profile-delete', { identityId: identityA }, 0])
  expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.command)).toContainEqual({
    type: 'local_identities_changed'
  })
  expect(await listLocalIdentities(db, f.a1)).toEqual([{ id: identityA, name: 'University' }])
  expect(await listLocalIdentities(db, f.a2)).toEqual([])
})
test('revoking the PC clears the binding but leaves the identity on My PC', async () => {
  await setRunLocation(db, memberA, identityA, {
    location: 'local',
    deviceId: f.a1.deviceId
  })
  await revokeDevice(db, memberA, f.a1.deviceId)
  expect(await identityRow(identityA)).toMatchObject({
    runLocation: 'local',
    localDeviceId: null
  })
})
test('a device counts as online for 90 seconds after it was last seen', async () => {
  await touchDevice(f.a1.deviceId, t0)
  expect(await isDeviceOnline(db, f.a1.deviceId, plus(90_000))).toBe(true)
  expect(await isDeviceOnline(db, f.a1.deviceId, plus(90_001))).toBe(false)
})

// profile-delete.test.ts
test('deleteServerProfile removes only that identity', async () => {
  const root = await profileRootWith(['u1/work/Default/Cookies', 'u1/checkpoints/1.tar.enc', 'u2/work/x'])
  await deleteServerProfile('u1', root)
  expect(existsSync(join(root, 'u1'))).toBe(false)
  expect(existsSync(join(root, 'u2/work/x'))).toBe(true)
})
```

`scheduled` records `scheduleJob` calls (through `mock.module`); `identityRow`, `touchDevice` and `profileRootWith` are local helpers; `t0` and `plus` are as in plan 03.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/companion.test.ts packages/web/lib/run-locations packages/scheduler/src/profile-delete.test.ts`
Expected: FAIL with "Export named 'shortTime' not found" and missing modules

- [ ] **Step 3: Implement the contracts, the column and queries, `setRunLocation`, the routes, `deleteServerProfile` and the settings page**

`setRunLocation` writes `identities.run_location`, `identities.local_device_id` (null unless `local`) and `profiles.location` (`local` for My PC, else `server`); moving to `local` schedules `profile-delete` and emits `local_identities_changed` to the chosen device; moving away from `local` emits it to the previously bound device. The settings page warns before switching to My PC: "The server's copy of this identity's sign-ins will be deleted. You'll sign in again on <PC name>." and, for My PC, links to Docker Desktop's install page and says a PC needs about 4 GB free for Docker. `revokeDevice` sets `local_device_id = NULL` on the member's identities bound to the device, in the same transaction. Register the `profile-delete` handler in plan 01c's scheduler queue setup.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/companion.test.ts packages/web/lib/run-locations packages/scheduler/src/profile-delete.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/web packages/scheduler/src/profile-delete.ts packages/scheduler/src/profile-delete.test.ts .env.example
git commit -m "feat(web): choose where an identity runs"
```

### Task 2: Local run dispatch

**Files:**

- Create: `packages/scheduler/src/local/dispatch.ts`, `packages/web/lib/companion/local.ts`, `packages/web/app/api/companion/jobs/[id]/secrets/route.ts`, `packages/web/app/api/companion/jobs/[id]/release/route.ts`
- Modify: `packages/notify/src/messages.ts` (the two "PC offline" pings); `packages/web/db/companion.ts` (`releaseJob`; `releaseExpiredLeases` skips `local_run` jobs); plan 01c's T-60 start handler (branch on `RunLocation`), server capacity count (counts only `server` and `server_via_home`) and heartbeat-timeout monitor (for local runs it calls `localHeartbeatTimeout`, never relaunches, and on `pc_lost` applies `fail` with reason `pc_lost` and calls `pingWorkerFailed`)
- Test: `packages/scheduler/src/local/dispatch.test.ts`, `packages/web/lib/companion/local.test.ts`

**Interfaces:**

- Consumes: Task 1 contracts, queries and `TM_WORKER_IMAGE_REF`; `createCompanionJob`, `emitCompanionEvent`, `getJob`, `claimJob` (plan 03); `buildJobConfig` and the other plan 01c roles.
- Produces (adds to contracts): pg-boss queues `local-claim-check` and `local-start-check`; and:

```ts
export interface LocalDeps {
  sendPing: typeof sendPing
  transition: typeof applyTrigger
  fail(occurrenceId: string, reason: string): Promise<void>
  schedule: typeof scheduleJob
  memberNtfy: typeof memberNtfy
  meetingUrl: typeof meetingUrl
} // fail = applyTrigger(…, 'fail', { reason }) then pingWorkerFailed
export function toLocalPayload(cfg: JobConfig, identityName: string, image: string): LocalRunPayload
export function startLocalRun(
  db: Db,
  cfg: JobConfig,
  deps: LocalDeps,
  now?: Date
): Promise<'offered' | 'skipped_pc_offline'>
export function checkLocalClaim(
  db: Db,
  jobId: string,
  deps: LocalDeps,
  now?: Date
): Promise<'claimed' | 'skipped_pc_offline'> // runs at offer + 120 s
export function checkLocalStart(db: Db, jobId: string, deps: LocalDeps, now?: Date): Promise<'running' | 'failed'> // runs at T-10
export function localHeartbeatTimeout(state: OccurrenceState, silentForMs: number): 'none' | 'pc_lost' // used by plan 01c's monitor for local runs
export function localSecrets(db: Db, device: DeviceAuth, jobId: string, now?: Date): Promise<LocalSecrets | null>
export function releaseJob(db: Db, device: DeviceAuth, jobId: string): Promise<boolean> // claimed -> pending, attempts unchanged
```

- Routes (adds to contracts): `GET /api/companion/jobs/<id>/secrets` (200 `LocalSecrets` with `Cache-Control: no-store`; 404 outside the active window or for any other job); `POST /api/companion/jobs/<id>/release` (204).

- [ ] **Step 1: Write the failing tests**

```ts
// dispatch.test.ts. Entry "Data Mining", 14:00 to 16:00 Asia/Kuala_Lumpur, identity "University" bound to f.a1 named "DESKTOP-ABC"; T-60 is 13:00.
test('toLocalPayload strips every secret and the control block', () => {
  const p = toLocalPayload(cfgA, 'University', 'ghcr.io/tl/tolongmeeting-worker:1.0.0')
  expect(p.job.ai.apiKey).toBe('')
  expect(p.job.member.details).toEqual([])
  expect(p.job.ntfy.token).toBe('')
  expect(p.job.control).toBeNull()
  expect(JSON.stringify(p)).not.toContain(cfgA.ai.apiKey)
})
test('an online PC gets the job, an announcement and a claim check at 120 s', async () => {
  await touchDevice(f.a1.deviceId, at('12:59:30'))
  expect(await startLocalRun(db, cfgA, deps, at('13:00'))).toBe('offered')
  const jobs = await listJobsForDevice(db, f.a1)
  expect(jobs).toContainEqual(expect.objectContaining({ kind: 'local_run', occurrenceId: f.occA }))
  expect(await listJobsForDevice(db, f.a2)).toEqual([])
  expect(deps.scheduled).toContainEqual(['local-claim-check', { jobId: jobs[0].id }, 120])
  expect(deps.scheduled).toContainEqual(['local-start-check', { jobId: jobs[0].id }, 3000])
})
test('a PC not seen for 90 seconds is skipped with an immediate high-priority ping', async () => {
  await touchDevice(f.a1.deviceId, at('12:58:00'))
  expect(await startLocalRun(db, cfgA, deps, at('13:00'))).toBe('skipped_pc_offline')
  expect(deps.transitions).toEqual([[f.occA, 'skip_pc_offline']])
  expect(deps.pings).toEqual([
    {
      title: 'Your PC is offline',
      message: "Data Mining (14:00) runs on DESKTOP-ABC, which is asleep or off, so the bot won't join.",
      priority: 'high',
      actions: [{ label: 'Open meeting page', url: deps.meetingUrl(f.occA) }]
    }
  ])
})
test('an identity without a paired PC is skipped with its own message', async () => {
  await clearBinding(identityA)
  await startLocalRun(db, cfgA, deps, at('13:00'))
  expect(deps.pings[0].message).toBe(
    "Data Mining (14:00) runs on My PC, but no PC is paired for University, so the bot won't join."
  )
})
test('an unclaimed offer is cancelled and skipped after 120 s', async () => {
  await touchDevice(f.a1.deviceId, at('13:00'))
  await startLocalRun(db, cfgA, deps, at('13:00'))
  const [job] = await listJobsForDevice(db, f.a1)
  expect(await checkLocalClaim(db, job.id, deps, at('13:02'))).toBe('skipped_pc_offline')
  expect((await getJob(db, job.id))?.state).toBe('cancelled')
})
test('no heartbeat by T-10 fails the run with the last preflight reason', async () => {
  const job = await claimedLocalRun(f.a1, { error: 'docker_unavailable' })
  expect(await checkLocalStart(db, job, deps, at('13:50'))).toBe('failed')
  expect(deps.failed).toEqual([[f.occA, 'docker_unavailable']])
  expect((await getJob(db, job))?.state).toBe('failed')
})
test('a local run times out after 120 s of silence, but never once it is uploading', () => {
  expect(localHeartbeatTimeout('in_meeting', 119_999)).toBe('none')
  expect(localHeartbeatTimeout('in_meeting', 120_001)).toBe('pc_lost')
  expect(localHeartbeatTimeout('uploading', 36_000_000)).toBe('none')
  expect(localHeartbeatTimeout('transcribing', 36_000_000)).toBe('none')
})

// local.test.ts
test('secrets go only to the PC holding an active local run', async () => {
  const id = await claimedLocalRun(f.a1)
  expect(await localSecrets(db, f.a1, id, at('12:49'))).toBeNull() // before start - 70 min
  expect(await localSecrets(db, f.a1, id, at('13:00'))).toEqual({
    apiKey: memberAKey,
    details: memberADetails
  })
  expect(await localSecrets(db, f.a1, id, at('16:31'))).toBeNull() // after end + 30 min
  expect(await localSecrets(db, f.a2, id, at('13:00'))).toBeNull()
  expect(await localSecrets(db, f.b1, id, at('13:00'))).toBeNull()
})
test('local runs keep their claim when the lease lapses; release keeps the attempt count', async () => {
  const id = await claimedLocalRun(f.a1)
  expect(await releaseExpiredLeases(db, at('18:00'))).not.toContain(id)
  const native = await claimedNativeJob(f.a1)
  expect(await releaseJob(db, f.a1, native)).toBe(true)
  expect((await getJob(db, native))?.attempts).toBe(0)
})
```

`at('HH:mm[:ss]')` is that time on 21 October 2026 in Kuala Lumpur; `deps` records `pings`, `transitions`, `failed` and `scheduled`; `claimedLocalRun(device, { error? })` creates and claims a `local_run` job, setting its `error` column.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/scheduler/src/local packages/web/lib/companion/local.test.ts`
Expected: FAIL with "Cannot find module './dispatch'" and "Cannot find module './local'"

- [ ] **Step 3: Implement dispatch, the secrets and release routes, and the plan 01c hooks**

`startLocalRun`: identity lock and clash rules have already run (plan 01c). If the identity has no bound device, or `isDeviceOnline` is false, apply `skip_pc_offline` and ping as above; otherwise create the job with `targetDeviceId`, payload `toLocalPayload(cfg, identityName, process.env.TM_WORKER_IMAGE_REF)`, emit `job_available` to that device, and schedule `local-claim-check` after 120 seconds and `local-start-check` at T-10. `checkLocalClaim` cancels a still-`pending` job and applies `skip_pc_offline` with the same ping. `checkLocalStart` fails the occurrence and marks the job `failed` when the occurrence is still `starting` at T-10, with the job's `error` or `pc_lost`; the companion then gets 404s and stops retrying. `localHeartbeatTimeout` answers `pc_lost` only for states before `uploading` and after `LOCAL_HEARTBEAT_TIMEOUT_MS`. `localSecrets` reads the AI key and saved details the way `buildJobConfig` does, only for a `local_run` job this device holds, between the entry's start minus 70 minutes and its end plus 30 minutes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/scheduler/src/local packages/web/lib/companion/local.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src packages/web packages/notify/src/messages.ts
git commit -m "feat(scheduler): offer local runs to the PC"
```

### Task 3: Local run endpoints

**Files:**

- Create: `packages/web/lib/companion/local-runs.ts`, `packages/web/app/api/companion/jobs/[id]/heartbeat/route.ts`, `packages/web/app/api/companion/jobs/[id]/preflight/route.ts`, `packages/web/app/api/companion/jobs/[id]/files/[...path]/route.ts`, `packages/web/app/api/companion/jobs/[id]/complete/route.ts`
- Modify: `packages/web/lib/companion/native.ts` (`reportFailure` on a `local_run` job applies `fail` with the given reason and calls `pingWorkerFailed`, without a retry); `packages/notify/src/messages.ts` (the three Docker pings)
- Test: `packages/web/lib/companion/local-runs.test.ts`

**Interfaces:**

- Consumes: `getClaimedJob`, `completeJob` (plan 03); `withDevice`; `applyTrigger`, `handleHeartbeat`, `pingRestart`, `pingWorkerFailed`, `enqueuePipeline` (plan 01c); `shortTime` (Task 1).
- Produces:

```ts
export const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024
export function isUploadPath(relPath: string): boolean
export function relayHeartbeat(db: Db, device: DeviceAuth, jobId: string, hb: Heartbeat): Promise<HeartbeatReply | null>
export function recordPreflight(db: Db, device: DeviceAuth, jobId: string, r: PreflightReport): Promise<void>
export function uploadOffset(db: Db, device: DeviceAuth, jobId: string, relPath: string): Promise<number | null>
export function appendUpload(
  db: Db,
  device: DeviceAuth,
  jobId: string,
  relPath: string,
  contentRange: string,
  body: ReadableStream<Uint8Array>
): Promise<{ status: 204 | 400 | 404 | 409; offset: number }>
export function completeLocalRun(
  db: Db,
  device: DeviceAuth,
  jobId: string
): Promise<{ ok: true } | { ok: false; missing: string[] }>
```

- Routes (adds to contracts): `POST .../heartbeat` (body `Heartbeat`, answers `HeartbeatReply`); `POST .../preflight` (body `PreflightReport`, 204); `HEAD .../files/<path>` (header `Upload-Offset`); `PUT .../files/<path>` (header `Content-Range: bytes <start>-<end>/<total>`, 204, or 409 with `Upload-Offset`); `POST .../complete` (204, or 400 with `{ missing }`). All under `/api/companion/jobs/<id>/`, for the device holding that `local_run` job.

- [ ] **Step 1: Write the failing test**

```ts
test.each([
  ['recording/meeting.mkv', true],
  ['recording/attempt_2_seg_014.mkv', true],
  ['frames/0007_141502.png', true],
  ['chat.jsonl', true],
  ['events.jsonl', true],
  ['forms/f1/record.json', true],
  ['forms/f1/filled.png', true],
  ['transcript/live.jsonl', true],
  ['transcript/native/audio.srt', true],
  ['audio.flac', false],
  ['../other/events.jsonl', false],
  ['forms/../../x.json', false],
  ['/etc/passwd', false],
  ['recording\\meeting.mkv', false],
  ['profiles/u1/work/Cookies', false]
])('isUploadPath(%s) is %p', (p, ok) => expect(isUploadPath(p)).toBe(ok))

test('a heartbeat is passed to the heartbeat handler only for the run this PC holds', async () => {
  const id = await claimedLocalRun(f.a1)
  expect(await relayHeartbeat(db, f.a1, id, hb(f.occA, 'in_meeting'))).toEqual({
    ackedEvents: 0,
    commands: []
  })
  expect(await relayHeartbeat(db, f.a1, id, hb(f.occB, 'in_meeting'))).toBeNull()
  expect(await relayHeartbeat(db, f.a2, id, hb(f.occA, 'in_meeting'))).toBeNull()
})
test('entering restarting sends the restart ping once', async () => {
  const id = await claimedLocalRun(f.a1)
  await relayHeartbeat(db, f.a1, id, hb(f.occA, 'in_meeting'))
  await relayHeartbeat(db, f.a1, id, {
    ...hb(f.occA, 'restarting'),
    attempt: 2
  })
  await relayHeartbeat(db, f.a1, id, {
    ...hb(f.occA, 'restarting'),
    attempt: 2
  })
  expect(restartPings).toEqual([[f.occA, 2]])
})
test('Docker not running pings once; low memory fails the run', async () => {
  const id = await claimedLocalRun(f.a1)
  await recordPreflight(db, f.a1, id, {
    reason: 'docker_unavailable',
    dockerMemBytes: null
  })
  await recordPreflight(db, f.a1, id, {
    reason: 'docker_unavailable',
    dockerMemBytes: null
  })
  expect(pings).toEqual([
    expect.objectContaining({
      title: 'Start Docker Desktop',
      priority: 'high',
      message: "Data Mining (14:00) runs on DESKTOP-ABC, but Docker Desktop isn't running. Start it before 13:50."
    })
  ])
  const id2 = await claimedLocalRun(f.a1)
  await recordPreflight(db, f.a1, id2, {
    reason: 'docker_memory_low',
    dockerMemBytes: 2 * 1024 ** 3
  })
  expect(triggers).toContainEqual([f.occA, 'fail', { reason: 'docker_memory_low' }])
  expect(pings.at(-1)).toMatchObject({
    title: 'Docker Desktop needs more memory',
    message:
      "Data Mining (14:00) can't run on DESKTOP-ABC: Docker Desktop has 2.0 GB and a meeting needs about 4 GB. Set memory=4GB or more under [wsl2] in %UserProfile%\\.wslconfig, then restart Docker Desktop."
  })
})
test('uploads resume at the server offset and refuse gaps', async () => {
  const id = await claimedLocalRun(f.a1)
  expect(await uploadOffset(db, f.a1, id, 'chat.jsonl')).toBe(0)
  expect((await appendUpload(db, f.a1, id, 'chat.jsonl', 'bytes 0-9/20', bytes(10))).status).toBe(204)
  expect(await appendUpload(db, f.a1, id, 'chat.jsonl', 'bytes 15-19/20', bytes(5))).toEqual({
    status: 409,
    offset: 10
  })
  expect((await appendUpload(db, f.a1, id, 'chat.jsonl', 'bytes 10-19/20', bytes(10))).status).toBe(204)
  expect(Bun.file(join(occDirA, 'chat.jsonl')).size).toBe(20)
  expect((await appendUpload(db, f.a1, id, 'audio.flac', 'bytes 0-9/10', bytes(10))).status).toBe(400)
})
test('complete needs events.jsonl, and the native transcript when there is a recording in native mode', async () => {
  const id = await claimedLocalRun(f.a1, { transcription: 'native' })
  await uploaded(id, ['events.jsonl', 'recording/meeting.mkv'])
  expect(await completeLocalRun(db, f.a1, id)).toEqual({
    ok: false,
    missing: ['transcript/native/audio.txt', 'transcript/native/audio.srt', 'transcript/native/audio.json']
  })
  await uploaded(id, ['transcript/native/audio.txt', 'transcript/native/audio.srt', 'transcript/native/audio.json'])
  expect(await completeLocalRun(db, f.a1, id)).toEqual({ ok: true })
  expect(enqueued).toEqual([f.occA])
})
```

The fixture is Task 2's (entry "Data Mining" at 14:00, PC "DESKTOP-ABC"). `hb(occurrenceId, state)` builds a `Heartbeat` with attempt 1, `recording: true`, `participants: 12`, no events; `applyTrigger` (recording `triggers`), `handleHeartbeat`, `pingRestart`, `pingWorkerFailed`, `enqueuePipeline` and `sendPing` are replaced by recorders through `mock.module`; `uploaded(id, paths)` uploads small files.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/lib/companion/local-runs.test.ts`
Expected: FAIL with "Cannot find module './local-runs'"

- [ ] **Step 3: Implement `local-runs.ts`, the routes and the `reportFailure` branch**

`isUploadPath` accepts exactly these patterns and nothing with `..`, a backslash or a leading slash:

```text
^recording/meeting\.mkv$
^recording/attempt_\d+_seg_\d{3}\.mkv$
^frames/\d{4}_\d{6}\.png$
^(chat|events)\.jsonl$
^forms/[A-Za-z0-9_-]+/(record\.json|filled\.png|confirmation\.png)$
^transcript/live\.jsonl$
^transcript/native/audio\.(txt|srt|json)$
```

Uploads append to `<path>.part` under `$TM_DATA_ROOT/occurrences/<occurrenceId>/` and rename when `end + 1 === total`; a chunk over `UPLOAD_CHUNK_MAX_BYTES` is a 400. `relayHeartbeat` reads the occurrence's state before calling `handleHeartbeat` and calls `pingRestart` when it changes into `restarting`. `recordPreflight`: `ok` clears the job's `error`; `docker_unavailable` and `image_unavailable` store it and ping only when it differs from the stored `error`; `docker_memory_low` marks the job `failed`, calls `applyTrigger(db, occurrenceId, 'fail', { reason: 'docker_memory_low' })` and pings. The three pings' copy goes into `packages/notify/src/messages.ts`. The image ping reads: title `Can't get the meeting worker`, message `<Entry name> (<HH:mm>) can't start on <PC name>: Docker couldn't download the TolongMeeting worker. Run docker login ghcr.io with your GitHub account; the PC tries again every 30 seconds.` All three pings are high priority with the "Open meeting page" action. GB in the memory message is `bytes / 1024 ** 3` to one decimal. `completeLocalRun` calls `completeJob` and `enqueuePipeline`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/lib/companion/local-runs.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib packages/web/app packages/notify/src/messages.ts
git commit -m "feat(web): relay and upload for local runs"
```

### Task 4: Docker driver and preflight

**Files:**

- Create: `packages/companion/src/local/docker.ts`, `packages/companion/src/local/preflight.ts`
- Modify: `packages/companion/src/api.ts` (`identities(): Promise<{ identities: { id: string; name: string }[]; image: string }>`, `preflight(jobId, r)`); `packages/companion/src/main/index.ts` (on start and on `local_identities_changed`: fetch identities, update the tray, run `checkBeforeFirstRun`)
- Test: `packages/companion/src/local/preflight.test.ts`

**Interfaces:**

- Consumes: `SpawnLike` (plan 03, Task 15); `PreflightReport`, `MIN_DOCKER_MEM_BYTES` (Task 1); `DesktopNotifier`.
- Produces:

```ts
export interface DockerLike {
  info(): Promise<{ memTotal: number } | null> // null when the daemon isn't reachable
  imagePresent(ref: string): Promise<boolean>
  pull(ref: string): Promise<boolean>
  run(args: string[]): Promise<string> // the whole argument list, starting with 'run'; resolves stdout once docker exits (the container id with -d)
  wait(name: string): Promise<number> // exit code
  stop(name: string, timeoutSec: number): Promise<void>
  rm(name: string): Promise<void>
  volumeRm(name: string): Promise<void>
  volumes(prefix: string): Promise<string[]>
  running(): Promise<{ name: string; identityId: string | null }[]> // from the label tm.identity
  port(name: string, containerPort: number): Promise<number | null> // published host port
  ensureNetwork(name: string): Promise<void>
}
export function dockerCli(spawn: SpawnLike): DockerLike
export function preflight(docker: DockerLike, imageRef: string): Promise<PreflightReport>
export function checkBeforeFirstRun(d: {
  docker: DockerLike
  imageRef: string
  notifier: DesktopNotifier
}): Promise<PreflightReport>
```

- [ ] **Step 1: Write the failing test**

```ts
test('preflight: unavailable, low memory, missing image, ok', async () => {
  expect(await preflight(fakeDocker({ info: null }), REF)).toEqual({
    reason: 'docker_unavailable',
    dockerMemBytes: null
  })
  expect(await preflight(fakeDocker({ memTotal: MIN_DOCKER_MEM_BYTES - 1 }), REF)).toEqual({
    reason: 'docker_memory_low',
    dockerMemBytes: MIN_DOCKER_MEM_BYTES - 1
  })
  expect(
    await preflight(
      fakeDocker({
        memTotal: MIN_DOCKER_MEM_BYTES,
        image: false,
        pullOk: false
      }),
      REF
    )
  ).toMatchObject({ reason: 'image_unavailable' })
  expect(await preflight(fakeDocker({ memTotal: 8 * 1024 ** 3, image: false, pullOk: true }), REF)).toMatchObject({
    reason: 'ok'
  })
})
test('dockerCli asks for the memory as JSON, hidden and without a shell', async () => {
  const calls: unknown[][] = []
  await dockerCli((c, a, o) => (calls.push([c, a, o]), processPrinting('4100000000\n'))).info()
  expect(calls[0]).toEqual([
    'docker',
    ['info', '--format', '{{json .MemTotal}}'],
    expect.objectContaining({ shell: false, windowsHide: true })
  ])
})
test('checkBeforeFirstRun explains low memory in a notification', async () => {
  const shown: { title: string; body: string }[] = []
  await checkBeforeFirstRun({
    docker: fakeDocker({ memTotal: 2 * 1024 ** 3 }),
    imageRef: REF,
    notifier: { show: (n) => shown.push(n) }
  })
  expect(shown).toEqual([
    expect.objectContaining({
      title: 'Docker Desktop needs more memory',
      body: 'Docker Desktop has 2.0 GB; local meetings need about 4 GB. Set memory=4GB or more under [wsl2] in %UserProfile%\\.wslconfig, then restart Docker Desktop.'
    })
  ])
})
```

`REF` is `ghcr.io/tl/tolongmeeting-worker:1.0.0`; `fakeDocker` answers from its options; `processPrinting(text)` is a `SpawnLike` result that prints `text` and exits 0.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/local/preflight.test.ts`
Expected: FAIL with "Cannot find module './preflight'"

- [ ] **Step 3: Implement `docker.ts`, `preflight.ts` and the wiring**

`preflight` checks in order: `info()` (null means `docker_unavailable`), `memTotal >= MIN_DOCKER_MEM_BYTES`, then `imagePresent(ref)` or `pull(ref)`. `checkBeforeFirstRun` shows a notification only for `docker_memory_low` (above), `docker_unavailable` (title `Start Docker Desktop`, body `TolongMeeting runs meetings on this PC through Docker Desktop. Start it, and turn on "Start Docker Desktop when you sign in".`) or `image_unavailable` (title `Can't get the meeting worker`, body `Run docker login ghcr.io with your GitHub account, then restart TolongMeeting.`); clicking any of them does nothing beyond closing it. At bind time the image reference comes from `api.identities()`, so the first pull happens long before the first run; at run time it comes from the job's payload. Every `docker` call goes through `SpawnLike` with `windowsHide: true` and no shell.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/local/preflight.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): check Docker before local runs"
```

### Task 5: Local profile vault and short-lived files

**Files:**

- Create: `packages/companion/src/local/vault.ts`, `packages/companion/src/local/ephemeral.ts`
- Modify: `packages/companion/src/secrets.ts` (`SecretName` adds `'profileKey'`); `packages/worker/src/profile/key.ts` (add `profileKeyOnce`); `packages/worker/src/run.ts` (call `profileKeyOnce` before the first heartbeat and use it for every checkpoint, in place of plan 01c's `loadProfileKey` call); `packages/worker/src/profile/profile.ts` (add `restoreProfile` unless plan 01c already exports it there); the worker CLI entry from plan 01a (`tm-worker`): restore the newest checkpoint when `work/` is empty, and add `--checkpoint-only <identityId>` (checkpoint `work/` and exit 0)
- Test: `packages/companion/src/local/vault.test.ts`, `packages/worker/src/profile/key.test.ts`, `packages/worker/src/profile/restore.test.ts`

**Interfaces:**

- Consumes: `SecretStore` (plan 03); `DockerLike` (Task 4); `checkpointProfile(dir, out, key)` (architecture); `profileKey` and `loadProfileKey` (plan 01c).
- Produces:

```ts
// companion
export interface LocalPaths {
  root: string
  data: string
  runs: string
  profiles: string
} // %LOCALAPPDATA%\TolongMeeting and its data, runs, profiles folders
export function localPaths(localAppData: string): LocalPaths
export function ensureProfileKey(secrets: SecretStore): Promise<Buffer> // the PC's local key: 32 random bytes, created once
export function identityKeyFile(localKey: Buffer, identityId: string): string // base64 of profileKey(localKey, identityId), the content of /run/tm/profile.key
export function profileVolume(identityId: string): string // 'tm-profile-<identityId>'
export function checkpointsDir(p: LocalPaths, identityId: string): string // <profiles>\<identityId>\checkpoints
export function writeEphemeral(
  dir: string,
  files: Record<string, string | Buffer>
): Promise<{ dir: string; remove(): Promise<void> }>
export function removeAfterFirstHeartbeat(
  e: { remove(): Promise<void> },
  firstHeartbeat: Promise<void>,
  maxMs?: number
): Promise<void> // default 120000
export function recoverStaleVolumes(d: {
  docker: DockerLike
  checkpoint(identityId: string): Promise<void>
}): Promise<string[]>
// worker
export function profileKeyOnce(identityId: string): Buffer // loadProfileKey on the first call, then the cached buffer
export function restoreProfile(archive: string, dir: string, key: Buffer): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

```ts
// vault.test.ts
test('the profile key is 32 bytes, made once, and kept only in the SecretStore', async () => {
  const secrets = new SecretStore(tmpFile(), fakeSafe(true))
  const k1 = await ensureProfileKey(secrets)
  expect(k1.length).toBe(32)
  expect((await ensureProfileKey(secrets)).equals(k1)).toBe(true)
})
test('short-lived files go after the first heartbeat, or after 120 s at most', async () => {
  const e = await writeEphemeral(tmpDir(), {
    'job.json': '{}',
    'profile.key': 'a2V5'
  })
  let beat!: () => void
  const done = removeAfterFirstHeartbeat(e, new Promise<void>((r) => (beat = r)), 1000)
  expect(existsSync(join(e.dir, 'profile.key'))).toBe(true)
  beat()
  await done
  expect(existsSync(e.dir)).toBe(false)
  const e2 = await writeEphemeral(tmpDir(), { 'profile.key': 'a2V5' })
  await removeAfterFirstHeartbeat(e2, new Promise(() => {}), 20)
  expect(existsSync(e2.dir)).toBe(false)
})
test('a stale profile volume is checkpointed, then removed; a volume in use is left alone', async () => {
  const docker = fakeDocker({
    volumes: ['tm-profile-u1', 'tm-profile-u2'],
    running: [{ name: 'tm-run-o1-1', identityId: 'u1' }]
  })
  const checkpointed: string[] = []
  expect(
    await recoverStaleVolumes({
      docker,
      checkpoint: async (id) => {
        checkpointed.push(id)
      }
    })
  ).toEqual(['u2'])
  expect(checkpointed).toEqual(['u2'])
  expect(docker.removedVolumes).toEqual(['tm-profile-u2'])
})
test('the key file holds the per-identity key derived from the local key', () => {
  expect(
    Buffer.from(identityKeyFile(Buffer.alloc(32), 'i1'), 'base64').equals(profileKey(Buffer.alloc(32), 'i1'))
  ).toBe(true)
})

// key.test.ts (added case)
test('profileKeyOnce reads the key file once, so the companion can delete it', async () => {
  const f = join(tmpdir(), 'once.key')
  await Bun.write(f, Buffer.alloc(32, 7).toString('base64'))
  process.env.TM_PROFILE_KEY_FILE = f
  const k = profileKeyOnce('i1')
  rmSync(f)
  expect(profileKeyOnce('i1').equals(k)).toBe(true)
  expect(k.equals(Buffer.alloc(32, 7))).toBe(true)
  delete process.env.TM_PROFILE_KEY_FILE
})

// restore.test.ts
test('restoreProfile brings back what checkpointProfile saved', async () => {
  const work = await dirWith({
    'Default/Cookies': 'c',
    'Default/Local Storage/leveldb/000003.log': 'l'
  })
  const key = Buffer.alloc(32, 1)
  const archive = await checkpointProfile(work, tmpDir(), key)
  const restored = tmpDir()
  await restoreProfile(archive, restored, key)
  expect(await Bun.file(join(restored, 'Default/Cookies')).text()).toBe('c')
})
```

`dirWith` writes a temporary folder; `fakeDocker` is Task 4's, recording `removedVolumes`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/companion/src/local/vault.test.ts packages/worker/src/profile`
Expected: FAIL with "Cannot find module './vault'" and "Export named 'profileKeyOnce' not found"

- [ ] **Step 3: Implement the vault, the short-lived files, `profileKeyOnce`, `restoreProfile` and the CLI changes**

`writeEphemeral` creates `<runs>\<random>\` and writes each file with owner-only permissions; `remove` deletes the folder and ignores a missing one. `recoverStaleVolumes` treats a `tm-profile-<id>` volume as stale when no running container carries the label `tm.identity=<id>`. On the PC the worker's checkpoints go to the bind-mounted `checkpointsDir`; `restoreProfile` picks the newest `<timestamp>.tar.enc` there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/companion/src/local/vault.test.ts packages/worker/src/profile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src packages/worker/src
git commit -m "feat(companion): keep local profiles encrypted"
```

### Task 6: Heartbeat relay

**Files:**

- Create: `packages/companion/src/local/relay.ts`
- Modify: none; `api.ts` (03 Task 11) satisfies the local `RelayApi`. `serverHeartbeatApi` in `relay.ts` is the https-only upstream (`redirect: 'error'`, device token in `Authorization`)
- Test: `packages/companion/test/relay.test.ts`

**Interfaces:**

- Consumes: `Heartbeat`, `HeartbeatReply`, `ControlCommand` (core); `CompanionApi`.
- Produces:

```ts
export interface Relay {
  port: number
  token: string // 32 random bytes, base64url, per run
  containerUrl: string // http://host.docker.internal:<port> (origin only: the worker adds /heartbeat and /signin, R8)
  firstHeartbeat(attempt: number): Promise<void>
  lastHeartbeatAt(): number | null // epoch ms
  inject(c: ControlCommand): void // delivered in the next reply, once
  synthetic(hb: Heartbeat): Promise<HeartbeatReply>
  close(): Promise<void>
}
export function startRelay(d: {
  api: Pick<CompanionApi, 'heartbeat'>
  jobId: string
  occurrenceId: string
}): Promise<Relay>
```

- [x] **Step 1: Write the failing test**

```ts
test('the relay listens on 127.0.0.1 only', async () => {
  const r = await startRelay({
    api: replying([]),
    jobId: 'j1',
    occurrenceId: 'o1'
  })
  expect(addressOf(r)).toBe('127.0.0.1')
  expect(r.containerUrl).toBe(`http://host.docker.internal:${r.port}/heartbeat`)
  await r.close()
})
test('a wrong token is a 401 and is not forwarded', async () => {
  const api = replying([])
  const r = await startRelay({ api, jobId: 'j1', occurrenceId: 'o1' })
  expect((await post(r, 'nope', hb('o1'))).status).toBe(401)
  expect(api.sent).toEqual([])
  await r.close()
})
test('heartbeats are forwarded and injected commands are added once', async () => {
  const r = await startRelay({
    api: replying(['leave_now']),
    jobId: 'j1',
    occurrenceId: 'o1'
  })
  r.inject('pause_for_signin')
  expect(await (await post(r, r.token, hb('o1'))).json()).toEqual({
    ackedEvents: 0,
    commands: ['leave_now', 'pause_for_signin']
  })
  expect(await (await post(r, r.token, hb('o1'))).json()).toEqual({
    ackedEvents: 0,
    commands: ['leave_now']
  })
  await r.close()
})
test('a heartbeat for another occurrence is a 400', async () => {
  const r = await startRelay({
    api: replying([]),
    jobId: 'j1',
    occurrenceId: 'o1'
  })
  expect((await post(r, r.token, hb('o2'))).status).toBe(400)
  await r.close()
})
test('when the server is unreachable the relay answers a fixed 502 and keeps injected commands', async () => {
  const api = failingThenReplying([])
  const r = await startRelay({ api, jobId: 'j1', occurrenceId: 'o1' })
  r.inject('resume_after_signin')
  expect((await post(r, r.token, hb('o1'))).status).toBe(503)
  expect((await (await post(r, r.token, hb('o1'))).json()).commands).toEqual(['resume_after_signin'])
  await r.close()
})
test("firstHeartbeat(attempt) resolves on that attempt's first heartbeat", async () => {
  const r = await startRelay({
    api: replying([]),
    jobId: 'j1',
    occurrenceId: 'o1'
  })
  const first = r.firstHeartbeat(2)
  await post(r, r.token, { ...hb('o1'), attempt: 2 })
  await first
  expect(r.lastHeartbeatAt()).not.toBeNull()
  await r.close()
})
```

`replying(commands)` is a fake `api.heartbeat` that records `sent` and answers `{ ackedEvents: 0, commands }`; `post(relay, token, body)` posts to `http://127.0.0.1:<port>/heartbeat` with the bearer token.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/test/relay.test.ts`
Expected: FAIL with "Cannot find module './relay'"

- [x] **Step 3: Implement `relay.ts` with `node:http` and the API method**

Listen on `127.0.0.1` port `0`; accept only `POST /heartbeat` with `Authorization: Bearer <token>` and a body that parses as `Heartbeat` for this occurrence; forward through `api.heartbeat`; append injected commands not already in the reply and clear them only after a 200 reply reaches the worker. The worker's heartbeat client (plan 01c's `startHeartbeat`) posts `Heartbeat` JSON to `control.url` with `Authorization: Bearer <control.token>` and reads a `HeartbeatReply`, so it needs no change.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/test/relay.test.ts`
Expected: PASS (35 tests)

- [x] **Step 5: Commit**

```bash
git add packages/companion/src/local/relay.ts packages/companion/test/relay.test.ts
git commit -m "feat(companion): relay worker heartbeats"
```

**Built as (security rulings):** bind host is loopback or a private Docker bridge IP only (`isAllowedBindHost`); `POST /heartbeat` and, with an `onSignin` handler, `POST /signin` only, everything else a fixed 404; the token is compared in constant time after hashing and is never logged; bodies are capped at 1 MB (heartbeat) and 16 KB (sign-in), server replies at 64 KB; an unreachable or refusing server is a fixed 502.

### Task 7: Egress rules

**Files:**

- Create: `docker/egress/deny-private.sh`
- Modify: `docker/worker/Dockerfile` (install `iptables`; copy the script to `/usr/local/bin/deny-private.sh`, mode 0755)
- Test: `test/deny-private.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `deny-private.sh [--print] [--out-iface <iface>] [--allow-tcp <host-or-ip>:<port>]... [--hold]`, used by the local network holder (Task 8) and the home-route sidecar (Task 13). Names are resolved with `getent ahostsv4`; `--print` prints the commands instead of running them and doesn't resolve names; `--hold` ends with `exec sleep infinity`. The rules live in the chain `TM-DENY-PRIVATE`, filled in one `iptables-restore --noflush` transaction (and `ip6tables-restore`), hooked from `OUTPUT` only afterwards and read back (rule count, last rule, hook first), as `docker/firewall/worker-egress.sh` does; any failure exits non-zero before `--hold`. Order: `--allow-tcp` accepts, replies (`ESTABLISHED,RELATED`), loopback (`-o lo`, left out with `--out-iface`), then a REJECT per range: the server firewall's IPv4 list (adds `0.0.0.0/8`, `127.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/3`) and the IPv6 `::/128`, `fe80::/10`, `fc00::/7`, `fec0::/10`, `::ffff:0:0/96`, `64:ff9b::/96`, `ff00::/8`. IPv6 is skipped only when ip6tables is unavailable and `net.ipv6.conf.all.disable_ipv6` is 1.

- [x] **Step 1: Write the failing test**

The test (`test/deny-private.test.ts`) covers: `--print` order (relay accepted before the first REJECT), the ranges equal `worker-egress.sh`'s `DENY`, `--out-iface` prefixes every rule, host names are printed unresolved, bad arguments fail; and with real iptables in `unshare -Urn`: both families applied, a re-run leaves the same rules, a re-run with other options replaces the relay rule, an unresolvable name leaves no chain or hook, the IPv6 skip rule, and `--hold`.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test test/deny-private.test.ts`
Expected: FAIL (bash: docker/egress/deny-private.sh: No such file or directory)

- [x] **Step 3: Write `deny-private.sh` (`set -eu`, POSIX `sh`-compatible so it runs on Alpine and Debian) and update the worker Dockerfile**

- [x] **Step 4: Run test to verify it passes**

Run: `bun test test/deny-private.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add docker/egress docker/worker/Dockerfile
git commit -m "feat(docker): add private-range egress rules"
```

### Task 8: Local worker lifecycle

**Files:**

- Create: `packages/companion/src/local/containers.ts`, `packages/companion/src/local/run.ts`
- Modify: `packages/companion/src/api.ts` (`secrets(jobId)`, `release(jobId)`); `packages/companion/src/jobs/native-runner.ts` (`pause(): Promise<void>` stops whisper and releases the current job; `resume(): void`); `packages/companion/src/jobs/poller.ts` consumer in `main/index.ts` (`local_run` jobs go to `LocalRunner`, native jobs to `NativeRunner`; on start, `recoverStaleVolumes`)
- Test: `packages/companion/src/local/run.test.ts`

**Interfaces:**

- Consumes: Tasks 4 to 7; `KeepAwake`, `NativeRunner`, `CompanionApi`, `SecretStore`, `StateStore` (plan 03).
- Produces:

```ts
export const LOCAL_NETWORK = 'tm-local'
export const MAX_LOCAL_ATTEMPTS = 4 // the first run and up to 3 restarts
export const SILENCE_RESTART_MS = 30_000
export interface RunMounts {
  dataDir: string
  checkpointsDir: string
  ephemeralDir: string
}
export function holderName(scope: string): string // 'tm-net-<scope>'
export function signinName(identityId: string): string // 'tm-signin-<identityId>'
export function holderArgs(o: { scope: string; identityId: string; image: string; allowTcp: string[] }): string[]
export function workerArgs(o: {
  occurrenceId: string
  identityId: string
  attempt: number
  image: string
  mounts: RunMounts
}): string[]
export function checkpointArgs(o: { identityId: string; image: string; mounts: Omit<RunMounts, 'dataDir'> }): string[]
export function localJobConfig(
  p: LocalRunPayload,
  s: LocalSecrets,
  ntfy: NtfyConfig,
  relay: { containerUrl: string; token: string },
  attempt: number
): JobConfig
export class LocalRunner {
  constructor(d: {
    api: CompanionApi
    docker: DockerLike
    secrets: SecretStore
    state: StateStore
    paths: LocalPaths
    keepAwake: KeepAwake
    native: NativeRunner
    ntfy: () => Promise<NtfyConfig>
    after: (job: CompanionJob, dataDir: string, outcome: 'ended' | 'crashed') => Promise<void>
    preflightRetryMs?: number
  }) // default 30000
  run(job: CompanionJob): Promise<void>
  activeIdentity(): string | null
  inject(identityId: string, c: ControlCommand): boolean
  noVncPort(identityId: string): number | null
}
```

- [ ] **Step 1: Write the failing test**

```ts
const mounts = {
  dataDir: 'C:\\TM\\data',
  checkpointsDir: 'C:\\TM\\profiles\\u1\\checkpoints',
  ephemeralDir: 'C:\\TM\\runs\\r1'
}

test('the worker gets paths, never secrets, and no extra capabilities', () => {
  const a = workerArgs({
    occurrenceId: 'o1',
    identityId: 'u1',
    attempt: 2,
    image: REF,
    mounts
  })
  expect(a).toEqual(
    expect.arrayContaining([
      '--name',
      'tm-run-o1-2',
      '--label',
      'tm.identity=u1',
      '--shm-size=2g',
      '--network',
      'container:tm-net-o1',
      '-v',
      'tm-profile-u1:/tm/profiles/u1/work',
      '-v',
      'C:\\TM\\profiles\\u1\\checkpoints:/tm/profiles/u1/checkpoints',
      '-v',
      'C:\\TM\\data:/tm/data',
      '-v',
      'C:\\TM\\runs\\r1:/run/tm:ro',
      '-e',
      'TM_DATA_ROOT=/tm/data',
      '-e',
      'TM_PROFILE_ROOT=/tm/profiles',
      '-e',
      'TM_PROFILE_KEY_FILE=/run/tm/profile.key'
    ])
  )
  expect(a.filter((x, i) => a[i - 1] === '-e')).toEqual([
    'TM_DATA_ROOT=/tm/data',
    'TM_PROFILE_ROOT=/tm/profiles',
    'TM_PROFILE_KEY_FILE=/run/tm/profile.key'
  ])
  expect(a.join(' ')).not.toMatch(/--cap-add|--privileged|-p /)
  expect(a.slice(a.indexOf(REF) + 1)).toEqual(['tm-worker', '--job', '/run/tm/job.json'])
})
test('the holder owns the network rules and publishes noVNC on 127.0.0.1 only', () => {
  const a = holderArgs({
    scope: 'o1',
    identityId: 'u1',
    image: REF,
    allowTcp: ['host.docker.internal:41234']
  })
  expect(a).toEqual(
    expect.arrayContaining([
      '--name',
      'tm-net-o1',
      '--network',
      'tm-local',
      '--cap-add',
      'NET_ADMIN',
      '--user',
      '0',
      '-p',
      '127.0.0.1::6080'
    ])
  )
  expect(a.slice(a.indexOf(REF) + 1)).toEqual([
    'deny-private.sh',
    '--allow-tcp',
    'host.docker.internal:41234',
    '--hold'
  ])
})
test('localJobConfig fills secrets, the relay and container paths', () => {
  const cfg = localJobConfig(
    payload,
    { apiKey: 'sk-x', details },
    ntfy,
    {
      containerUrl: 'http://host.docker.internal:41234/heartbeat',
      token: 'rt'
    },
    2
  )
  expect(cfg).toMatchObject({
    attempt: 2,
    ai: { apiKey: 'sk-x' },
    ntfy,
    control: {
      url: 'http://host.docker.internal:41234/heartbeat',
      token: 'rt'
    },
    dataDir: '/tm/data/occurrences/o1',
    profileDir: '/tm/profiles/u1/work'
  })
  expect(cfg.member.details).toEqual(details)
})
test('a run: claim, preflight, secrets, holder, worker, files gone after the first heartbeat', async () => {
  const r = runnerWith()
  await r.run(localJob)
  expect(log).toEqual([
    'claim',
    'preflight ok',
    'secrets',
    'pause native',
    'keep awake',
    'run tm-net-o1',
    'run tm-run-o1-1',
    'first heartbeat 1',
    'ephemeral removed',
    'exit 0',
    'rm tm-net-o1',
    'volume rm tm-profile-u1',
    'after ended',
    'release keep awake',
    'resume native'
  ])
})
test('Docker not running: reported, retried every 30 s, and the run starts once it is up', async () => {
  const r = runnerWith({
    infoSequence: [null, null, { memTotal: 8 * 1024 ** 3 }],
    preflightRetryMs: 10
  })
  await r.run(localJob)
  expect(api.preflights.map((p) => p.reason)).toEqual(['docker_unavailable', 'docker_unavailable', 'ok'])
  expect(log).toContain('run tm-run-o1-1')
})
test('low memory reports and stops before any container starts', async () => {
  const r = runnerWith({ memTotal: 2 * 1024 ** 3 })
  await r.run(localJob)
  expect(api.preflights.map((p) => p.reason)).toEqual(['docker_memory_low'])
  expect(log.some((l) => l.startsWith('run '))).toBe(false)
})
test('a crash restarts the worker as the next attempt with fresh files, reporting restarting', async () => {
  const r = runnerWith({ exitCodes: [137, 0] })
  await r.run(localJob)
  expect(log).toEqual(
    expect.arrayContaining(['run tm-run-o1-1', 'synthetic restarting 2', 'run tm-run-o1-2', 'first heartbeat 2'])
  )
  expect(ephemeralWrites).toBe(2)
})
test('30 s without a heartbeat counts as a crash', async () => {
  const r = runnerWith({
    silentAfterFirst: true,
    exitCodes: [null, 0],
    silenceMs: 20
  })
  await r.run(localJob)
  expect(log).toEqual(expect.arrayContaining(['stop tm-run-o1-1', 'run tm-run-o1-2']))
})
test('after the third restart fails, the profile is checkpointed and the outputs go on as crashed', async () => {
  const r = runnerWith({ exitCodes: [1, 1, 1, 1] })
  await r.run(localJob)
  expect(log.filter((l) => l.startsWith('run tm-run-o1-'))).toHaveLength(4)
  expect(log).toEqual(expect.arrayContaining(['checkpoint u1', 'after crashed']))
  expect(log.indexOf('checkpoint u1')).toBeLessThan(log.indexOf('volume rm tm-profile-u1'))
})
test('an open sign-in container for the identity is stopped and checkpointed before the run', async () => {
  const r = runnerWith({
    running: [{ name: 'tm-signin-u1', identityId: 'u1' }]
  })
  await r.run(localJob)
  expect(log.indexOf('stop tm-signin-u1')).toBeLessThan(log.indexOf('run tm-run-o1-1'))
})
```

`runnerWith(opts)` builds a `LocalRunner` over fakes that append to `log` (`DockerLike`, relay, `KeepAwake`, `NativeRunner`, `after`) and an `api` fake recording `preflights` and `failures`; `localJob` is a claimed `local_run` job for occurrence `o1`, identity `u1`; `REF`, `payload`, `details` and `ntfy` are fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/local/run.test.ts`
Expected: FAIL with "Cannot find module './containers'"

- [ ] **Step 3: Implement `containers.ts`, `run.ts` and the wiring**

`LocalRunner.run`, in order:

1.  `claim`, then `preflight(docker, payload.image)` and `api.preflight`; on a transient reason retry every `preflightRetryMs` until `ok` or the server cancels the job (404); on `docker_memory_low` stop.
1.  `api.secrets`; `native.pause()`; `keepAwake.acquire(occurrenceId)`; stop an open `signinName(identityId)` container with `docker stop -t 60` (its sign-in mode checkpoints on stop) and remove its holder.
1.  `ensureNetwork(LOCAL_NETWORK)`; start the relay; run the holder with `allowTcp: ['host.docker.internal:<relay port>']`.
1.  For each attempt up to `MAX_LOCAL_ATTEMPTS`: write `job.json` (`localJobConfig`) and `profile.key` (`identityKeyFile(await ensureProfileKey(secrets), identityId)`) with `writeEphemeral`; run the worker; `removeAfterFirstHeartbeat` with `relay.firstHeartbeat(attempt)`; wait for exit or `SILENCE_RESTART_MS` without heartbeats (then `docker stop -t 10`). Exit code 0 ends the loop. Otherwise, while attempts remain, send `relay.synthetic({ state: 'restarting', attempt: attempt + 1, recording: false, participants: null, events: [] })` every 5 seconds until the next attempt's first heartbeat.
1.  If the last attempt didn't exit 0, run `checkpointArgs` first, so the profile keeps what the crashed worker saw. Remove the holder, `volumeRm(profileVolume(identityId))`, close the relay, run `after(job, dataDir, outcome)` (Task 9, with `crashed` when the last attempt didn't exit 0), release the keep-awake, `native.resume()`.

Containers are created with `docker run -d`; `workerArgs` is `run -d --name tm-run-<occurrenceId>-<attempt> --label tm.identity=<identityId> --shm-size=2g --network container:tm-net-<occurrenceId>`, the four `-v` mounts and three `-e` paths above, the image, then `tm-worker --job /run/tm/job.json`. `checkpointArgs` runs the image with the profile volume, checkpoints mount and a short-lived `/run/tm` folder, `--network none` and `tm-worker --checkpoint-only <identityId>`; it backs `recoverStaleVolumes`' `checkpoint`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/local/run.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): run meeting workers locally"
```

### Task 9: After a local meeting

**Files:**

- Create: `packages/companion/src/local/upload.ts`, `packages/companion/src/local/after.ts`
- Modify: `packages/companion/src/api.ts` (`uploadOffset(jobId, relPath)`, `uploadChunk(jobId, relPath, start, total, bytes)`, `complete(jobId)`); `packages/companion/src/main/index.ts` (on start, resume `finishLocalRun` for `local_run` jobs this PC holds whose local data exists and whose containers are gone)
- Test: `packages/companion/src/local/after.test.ts`

**Interfaces:**

- Consumes: `buildWhisperArgv`, `runWhisper`, `whisperTimeoutMs` (plan 03); `CompanionApi.heartbeat` (Task 6); `DockerLike`; `isUploadPath` patterns (Task 3).
- Produces:

```ts
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024
export function uploadSet(occDir: string): Promise<string[]> // relative POSIX paths
export function uploadFile(api: CompanionApi, jobId: string, occDir: string, relPath: string): Promise<void>
export function flacArgs(o: { image: string; dataDir: string; occurrenceId: string }): string[]
export function finishLocalRun(
  d: {
    api: CompanionApi
    docker: DockerLike
    settings: () => Settings
    spawn: SpawnLike
    report(state: 'uploading' | 'transcribing'): Promise<void>
    retryMs?: number
  },
  job: CompanionJob,
  dataDir: string,
  outcome: 'ended' | 'crashed'
): Promise<void> // retryMs default 60000
```

- [ ] **Step 1: Write the failing test**

```ts
test('the upload set skips the FLAC, and segments once meeting.mkv exists', async () => {
  const occ = await occWith([
    'events.jsonl',
    'chat.jsonl',
    'audio.flac',
    'recording/meeting.mkv',
    'recording/attempt_1_seg_000.mkv',
    'frames/0001_140002.png',
    'transcript/native/audio.json'
  ])
  expect((await uploadSet(occ)).sort()).toEqual([
    'chat.jsonl',
    'events.jsonl',
    'frames/0001_140002.png',
    'recording/meeting.mkv'
  ])
  const noJoin = await occWith(['events.jsonl', 'recording/attempt_1_seg_000.mkv'])
  expect(await uploadSet(noJoin)).toContain('recording/attempt_1_seg_000.mkv')
})
test('uploadFile resumes from the server offset in 16 MiB chunks', async () => {
  const occ = await occWithSized('recording/meeting.mkv', 40 * 1024 * 1024)
  const api = uploadApi({ offset: 16 * 1024 * 1024 })
  await uploadFile(api, 'j1', occ, 'recording/meeting.mkv')
  expect(api.ranges).toEqual(['bytes 16777216-33554431/41943040', 'bytes 33554432-41943039/41943040'])
})
test('the FLAC is extracted with the worker image, offline', () => {
  expect(flacArgs({ image: REF, dataDir: 'C:\\TM\\data', occurrenceId: 'o1' })).toEqual([
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    'C:\\TM\\data:/tm/data',
    REF,
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    '/tm/data/occurrences/o1/recording/meeting.mkv',
    '-map',
    '0:a',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'flac',
    '/tm/data/occurrences/o1/audio.flac'
  ])
})
test('native: upload, transcribe on the PC, upload the transcript, complete, then clean up', async () => {
  const { d, occ, log } = afterFixture({ transcription: 'native' })
  await finishLocalRun(d, nativeLocalJob, dataDir, 'ended')
  expect(log).toEqual([
    'report uploading',
    'upload events.jsonl',
    'upload recording/meeting.mkv',
    'report transcribing',
    'docker flac',
    'whisper',
    'upload transcript/native/audio.txt',
    'upload transcript/native/audio.srt',
    'upload transcript/native/audio.json',
    'complete'
  ])
  expect(existsSync(occ)).toBe(false)
})
test('a failed complete keeps the local data and retries', async () => {
  const { d, occ, log } = afterFixture({
    transcription: 'live',
    completeFailures: 1,
    retryMs: 10
  })
  await finishLocalRun(d, liveLocalJob, dataDir, 'ended')
  expect(log.filter((l) => l === 'complete')).toHaveLength(2)
  expect(existsSync(occ)).toBe(false)
})
test('a crashed run uploads what exists, reports worker_crashed and cleans up, without transcribing', async () => {
  const { d, occ, log } = afterFixture({ transcription: 'native' })
  await finishLocalRun(d, nativeLocalJob, dataDir, 'crashed')
  expect(log).toEqual([
    'report uploading',
    'upload events.jsonl',
    'upload recording/meeting.mkv',
    'fail worker_crashed'
  ])
  expect(existsSync(occ)).toBe(false)
})
```

`occWith(paths)` and `occWithSized(path, bytes)` build an occurrence folder; `uploadApi({ offset })` answers `uploadOffset` with `offset` and records each chunk's `Content-Range`; `afterFixture` returns fakes that append to `log`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/companion/src/local/after.test.ts`
Expected: FAIL with "Cannot find module './upload'"

- [ ] **Step 3: Implement `upload.ts`, `after.ts`, the API methods and the resume on start**

`uploadSet` returns every file under the occurrence folder that matches Task 3's patterns, except `transcript/native/*` (sent after transcription) and, when `recording/meeting.mkv` exists, the attempt segments. `finishLocalRun`: `report('uploading')`, upload the set; in native mode with a recording, `report('transcribing')`, extract the FLAC (`docker.run(flacArgs(...))`), run whisper exactly as plan 03's runner does (outputs copied to `transcript/native/audio.txt|srt|json`), upload those three, delete `audio.flac`; then `complete`. With outcome `crashed` it uploads the set, then calls `api.fail(jobId, 'worker_crashed')` instead of transcribing and completing, so the meeting page keeps the partial recording and chat. Retry any failed request every `retryMs`; delete the occurrence folder only after `complete` (or that `fail`) succeeds. Whisper gets two tries, as in plan 03; after the second failure the companion calls `api.fail(jobId, 'native_transcription_failed')` and deletes the folder, since the recording is already on the server. `report(state)` sends `api.heartbeat(jobId, { occurrenceId, attempt: <last attempt>, state, recording: false, participants: null, events: [] })` directly, so it also works after the relay has closed or the companion has restarted.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/companion/src/local/after.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src
git commit -m "feat(companion): upload local meeting outputs"
```

### Task 10: Local sign-in view

**Files:**

- Create: `packages/companion/src/local/signin.ts`, `packages/companion/src/renderer/signin.html`, `packages/web/app/api/identities/[id]/open-signin/route.ts`
- Modify: `docker/worker/entrypoint.sh` (when `TM_VNC_PASSWORD_FILE` is set, start x11vnc with `-passwdfile $TM_VNC_PASSWORD_FILE`, which x11vnc reads once at start); `packages/companion/src/local/containers.ts` and `run.ts` (each attempt also writes `vnc.pass` to the short-lived folder, and `workerArgs` adds `-e TM_VNC_PASSWORD_FILE=/run/tm/vnc.pass`); `packages/companion/src/local/run.test.ts` (the expected `-e` list gains that fourth entry); plan 01c's Accounts page (for a My PC identity the "Sign in" button calls `open-signin`); `packages/companion/src/main/tray.ts` (one `Sign in to <identity name>` item per local identity); `main/index.ts` (`open_signin` events)
- Test: `packages/companion/src/local/signin.test.ts`, `packages/web/app/api/identities/open-signin.test.ts`

**Interfaces:**

- Consumes: `LocalRunner.activeIdentity`, `inject`, `noVncPort`, `holderArgs`, `signinName` (Task 8); vault and short-lived files (Task 5); `emitCompanionEvent`, `isDeviceOnline`.
- Produces:

```ts
export function signinArgs(o: { identityId: string; image: string; mounts: Omit<RunMounts, 'dataDir'> }): string[]
export function vncUrl(port: number, password: string): string // http://127.0.0.1:<port>/vnc.html#autoconnect=1&resize=scale&password=<password>
export function isAllowedSigninUrl(url: string, port: number): boolean
export class SigninController {
  constructor(d: {
    runner: LocalRunner
    docker: DockerLike
    secrets: SecretStore
    paths: LocalPaths
    imageRef: () => string
    openWindow(url: string, onDone: () => void): void
  })
  open(identityId: string): Promise<void>
  done(identityId: string): Promise<void>
}
```

- Route (adds to contracts): `POST /api/identities/<id>/open-signin` (member session) answers `{ opened: true, pcName }` or `{ opened: false, reason: 'pc_offline' | 'not_local' }`.

- [ ] **Step 1: Write the failing tests**

```ts
// signin.test.ts
test('during a local run the view attaches to the worker desk and pauses automation', async () => {
  const c = controllerWith({ activeIdentity: 'u1', noVncPort: 49152 })
  await c.open('u1')
  expect(injected).toEqual([['u1', 'pause_for_signin']])
  expect(opened[0]).toStartWith('http://127.0.0.1:49152/vnc.html#')
  expect(log.some((l) => l.startsWith('run '))).toBe(false)
  await c.done('u1')
  expect(injected.at(-1)).toEqual(['u1', 'resume_after_signin'])
})
test('otherwise a sign-in container starts, and Done checkpoints and removes it', async () => {
  const c = controllerWith({ activeIdentity: null })
  await c.open('u1')
  expect(log).toEqual(['run tm-net-signin-u1', 'run tm-signin-u1'])
  await c.done('u1')
  expect(log.slice(2)).toEqual(['stop tm-signin-u1 60', 'rm tm-net-signin-u1', 'volume rm tm-profile-u1'])
})
test('the VNC password travels in the URL fragment, never the query', () => {
  const u = new URL(vncUrl(49152, 'pw'))
  expect(u.search).toBe('')
  expect(u.hash).toContain('password=pw')
})
test('the window stays on the loopback noVNC page', () => {
  expect(isAllowedSigninUrl('http://127.0.0.1:49152/vnc.html#x', 49152)).toBe(true)
  expect(isAllowedSigninUrl('http://127.0.0.1:49153/', 49152)).toBe(false)
  expect(isAllowedSigninUrl('https://login.microsoftonline.com/', 49152)).toBe(false)
})

// open-signin.test.ts
test('open-signin reaches only the bound PC', async () => {
  await bindLocal(identityA, f.a1)
  await touchDevice(f.a1.deviceId, new Date())
  expect(await (await POST(sessionReq(memberA), params(identityA))).json()).toEqual({
    opened: true,
    pcName: 'DESKTOP-ABC'
  })
  expect((await listCompanionEvents(db, f.a1, 0)).map((e) => e.command)).toContainEqual({
    type: 'open_signin',
    identityId: identityA
  })
  expect(await listCompanionEvents(db, f.a2, 0)).toEqual([])
})
test('open-signin explains an offline PC or a server identity', async () => {
  await bindLocal(identityA, f.a1)
  expect(await (await POST(sessionReq(memberA), params(identityA))).json()).toEqual({
    opened: false,
    reason: 'pc_offline'
  })
  expect(await (await POST(sessionReq(memberA), params(identityServer))).json()).toEqual({
    opened: false,
    reason: 'not_local'
  })
})
```

`controllerWith` builds a `SigninController` over fakes recording `injected`, `opened` and `log`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/companion/src/local/signin.test.ts packages/web/app/api/identities/open-signin.test.ts`
Expected: FAIL with "Cannot find module './signin'" and a missing route

- [ ] **Step 3: Implement the controller, the window, the route and the entrypoint change**

The sign-in container is `run -d --name tm-signin-<identityId> --label tm.identity=<identityId> --shm-size=2g --network container:tm-net-signin-<identityId>`, the profile volume, checkpoints and a short-lived `/run/tm` (with `profile.key` and `vnc.pass`), the three path variables plus `TM_VNC_PASSWORD_FILE`, then `tm-worker --signin`. Its holder is `holderArgs({ scope: 'signin-<identityId>', allowTcp: [] })`. The VNC password is 24 random base64url characters per session, held in memory for `vncUrl`. The window (`signin.html`, toolbar with a single `Done` button) is a `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; `will-navigate` and `setWindowOpenHandler` refuse any URL that fails `isAllowedSigninUrl`. It opens only on a tray click or an `open_signin` event, both started by the member. During a run, `noVncPort` is the host port Docker published for the run's holder. The Accounts page shows "Opened on <PC name>" or "Your PC <PC name> is offline".

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/companion/src/local/signin.test.ts packages/web/app/api/identities/open-signin.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/companion/src packages/web/app docker/worker/entrypoint.sh
git commit -m "feat(companion): sign in to local identities"
```

### Task 11: Home device enrolment

**Files:**

- Create: `packages/web/db/home-route.ts` (table `home_exit_nodes`, the Tailscale client, status), `packages/web/app/settings/home-route/page.tsx`, `packages/web/app/api/home-route/key/route.ts`, `packages/web/app/api/home-route/check/route.ts`, `config/tailscale/policy.json`
- Modify: `packages/web/db/index.ts`; `packages/web/db/schema.test.ts` and `MEMBER_OWNED` (plan 01c: `home_exit_nodes` joins the table list); `packages/web/lib/run-locations/settings.ts` (`server_via_home` needs a `ready` home node, else `home_route_not_set_up`); `.env.example`; a drizzle-kit migration
- Test: `packages/web/db/home-route.test.ts`

**Interfaces:**

- Consumes: `requireMember`, `setRunLocation` (Task 1).
- Produces (adds to contracts): environment variables `TM_TAILSCALE_CLIENT_ID`, `TM_TAILSCALE_CLIENT_SECRET` and `TM_TAILSCALE_TAILNET` (default `-`), used by web and scheduler; table `home_exit_nodes` (`member_id` primary key, `node_id`, `hostname`, `ipv4`, `checked_at`); and:

```ts
export interface TailscaleConfig {
  clientId: string
  clientSecret: string
  tailnet: string
}
export interface TailscaleDevice {
  nodeId: string
  hostname: string
  addresses: string[]
  tags: string[]
  connectedToControl: boolean
  enabledRoutes: string[]
}
export class TailscaleApi {
  constructor(cfg: TailscaleConfig, f?: typeof fetch)
  createAuthKey(o: { tags: string[]; ephemeral: boolean; expirySeconds: number; description: string }): Promise<string>
  devices(): Promise<TailscaleDevice[]>
}
export type HomeRouteStatus = 'ready' | 'offline' | 'not_exit_node' | 'not_enrolled'
export function homeHostname(memberId: string): string // 'tm-home-' + the first 8 hex characters of the member id
export function enrolKey(api: TailscaleApi, memberId: string): Promise<{ key: string; hostname: string }>
export function checkHomeRoute(
  db: Db,
  api: TailscaleApi,
  memberId: string,
  now?: Date
): Promise<{ status: HomeRouteStatus; hostname: string; ipv4: string | null }>
```

- [ ] **Step 1: Write the failing test**

```ts
test('the OAuth token is fetched once and keys are single-use, pre-authorised and tagged', async () => {
  const seen: Request[] = []
  const api = new TailscaleApi({ clientId: 'id', clientSecret: 'sec', tailnet: '-' }, tsFake(seen))
  const { key, hostname } = await enrolKey(api, '1a2b3c4d-0000-4000-8000-000000000000')
  await api.devices()
  expect(seen.filter((r) => r.url.endsWith('/api/v2/oauth/token'))).toHaveLength(1)
  const create = seen.find((r) => r.url.endsWith('/api/v2/tailnet/-/keys'))!
  expect(await create.clone().json()).toEqual({
    capabilities: {
      devices: {
        create: {
          reusable: false,
          ephemeral: false,
          preauthorized: true,
          tags: ['tag:tm-home']
        }
      }
    },
    expirySeconds: 3600,
    description: 'tm-home 1a2b3c4d'
  })
  expect(key).toStartWith('tskey-auth-')
  expect(hostname).toBe('tm-home-1a2b3c4d')
})
test.each([
  [{ connectedToControl: true, enabledRoutes: ['0.0.0.0/0', '::/0'] }, 'ready'],
  [{ connectedToControl: false, enabledRoutes: ['0.0.0.0/0', '::/0'] }, 'offline'],
  [{ connectedToControl: true, enabledRoutes: [] }, 'not_exit_node']
])('checkHomeRoute(%o) is %s', async (dev, status) => {
  const api = apiWithDevices([
    {
      nodeId: 'n1',
      hostname: 'tm-home-1a2b3c4d',
      addresses: ['100.101.102.103', 'fd7a::1'],
      tags: ['tag:tm-home'],
      ...dev
    }
  ])
  expect((await checkHomeRoute(db, api, memberA)).status).toBe(status)
})
test("another member's device or an untagged one never counts", async () => {
  const api = apiWithDevices([
    {
      nodeId: 'n2',
      hostname: 'tm-home-99999999',
      addresses: ['100.1.1.1'],
      tags: ['tag:tm-home'],
      connectedToControl: true,
      enabledRoutes: ['0.0.0.0/0', '::/0']
    },
    {
      nodeId: 'n3',
      hostname: 'tm-home-1a2b3c4d',
      addresses: ['100.1.1.2'],
      tags: [],
      connectedToControl: true,
      enabledRoutes: ['0.0.0.0/0', '::/0']
    }
  ])
  expect((await checkHomeRoute(db, api, memberA)).status).toBe('not_enrolled')
})
test('a ready node is stored with its IPv4 address', async () => {
  await checkHomeRoute(db, readyApi, memberA, t0)
  expect(await homeNodeRow(memberA)).toMatchObject({
    nodeId: 'n1',
    hostname: 'tm-home-1a2b3c4d',
    ipv4: '100.101.102.103',
    checkedAt: t0
  })
})
test('server through home needs a ready node', async () => {
  expect(
    await setRunLocation(db, memberB, identityB, {
      location: 'server_via_home'
    })
  ).toEqual({ ok: false, error: 'home_route_not_set_up' })
})
test('the tailnet policy: workers reach only the internet; home devices reach nothing; home exit nodes are approved', async () => {
  const p = await Bun.file('config/tailscale/policy.json').json()
  expect(p.acls).toEqual([{ action: 'accept', src: ['tag:tm-worker'], dst: ['autogroup:internet:*'] }])
  expect(p.autoApprovers).toEqual({ exitNode: ['tag:tm-home'] })
  expect(Object.keys(p.tagOwners).sort()).toEqual(['tag:tm-home', 'tag:tm-worker'])
})
```

`memberA`'s id starts with `1a2b3c4d`; `tsFake(seen)` answers the token, key and device endpoints and records requests; `apiWithDevices(list)` and `readyApi` return a `TailscaleApi` over such a fake.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/db/home-route.test.ts`
Expected: FAIL with "Cannot find module './home-route'"

- [ ] **Step 3: Implement the client, status, routes, policy file and setup page**

The token is `POST https://api.tailscale.com/api/v2/oauth/token` (`grant_type=client_credentials`, form-encoded), cached until 60 seconds before `expires_in`; keys are `POST /api/v2/tailnet/{tailnet}/keys`; devices are `GET /api/v2/tailnet/{tailnet}/devices?fields=all`. A device matches a member when it has `tag:tm-home` and `hostname === homeHostname(memberId)`; `ready` needs `connectedToControl` and both `0.0.0.0/0` and `::/0` in `enabledRoutes`. An admin applies `config/tailscale/policy.json` to the TolongLabs tailnet once and creates the OAuth client with the `auth_keys` and `devices:core` scopes and both tags. The key route (`POST /api/home-route/key`) shows the key once and never stores it. The setup page (`/settings/home-route`) shows this guide, with the member's hostname filled in:

```text
Your bot can join through your home internet connection, so your university and work sign-ins come from your usual address.

1. Pick a device that stays on at home during your meetings: a desktop PC, a mini PC or a Raspberry Pi, plugged in and on your home network. A phone or a laptop that sleeps won't do. If the device already uses Tailscale for another network, use a different one: a device joins one Tailscale network at a time.
2. Install Tailscale from https://tailscale.com/download.
3. Press "Create setup key". The key works once, within an hour.
4. Run the command for your device:
   Windows (administrator terminal): tailscale up --auth-key=<key> --hostname=<hostname> --advertise-exit-node --unattended
   Linux: sudo sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1, add both settings to /etc/sysctl.d/99-tailscale.conf, then sudo tailscale up --auth-key=<key> --hostname=<hostname> --advertise-exit-node
   macOS: tailscale up --auth-key=<key> --hostname=<hostname> --advertise-exit-node
5. Set the device never to sleep while it's plugged in.
6. Press "Check". It says "Ready" when the device is online and sharing its connection.

Only your bot's traffic goes through this device, and only during your meetings. TolongMeeting can't reach other devices on your home network, and your other devices aren't affected.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/db/home-route.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web config/tailscale .env.example
git commit -m "feat(web): enrol a home exit node"
```

### Task 12: Home route check at T-60

**Files:**

- Create: `packages/scheduler/src/home-route/check.ts`
- Modify: plan 01c's T-60 start handler (`server_via_home` calls `startViaHome`); register the `home-route-recheck` queue; `packages/notify/src/messages.ts` (the "Home connection offline" ping)
- Test: `packages/scheduler/src/home-route/check.test.ts`

**Interfaces:**

- Consumes: `checkHomeRoute`, `TailscaleApi` (Task 11); `LocalDeps` (Task 2); `shortTime` (Task 1); `launchViaHome` and `HomeRouteUnavailable` (Task 13, injected).
- Produces (adds to contracts): pg-boss queue `home-route-recheck`; and:

```ts
export interface HomeDeps extends LocalDeps {
  api: TailscaleApi
  launchViaHome(cfg: JobConfig, exitNodeIp: string): Promise<void>
}
export function startViaHome(
  db: Db,
  cfg: JobConfig,
  deps: HomeDeps,
  now?: Date
): Promise<'launched' | 'waiting' | 'failed'>
```

- [ ] **Step 1: Write the failing test**

```ts
test('a ready exit node launches the worker through it', async () => {
  expect(await startViaHome(db, cfgHome, deps({ status: 'ready', ipv4: '100.101.102.103' }), at('13:00'))).toBe(
    'launched'
  )
  expect(launched).toEqual([[cfgHome.occurrenceId, '100.101.102.103']])
})
test('an offline exit node pings once at T-60 and rechecks every minute', async () => {
  const d = deps({ status: 'offline', ipv4: null })
  expect(await startViaHome(db, cfgHome, d, at('13:00'))).toBe('waiting')
  expect(await startViaHome(db, cfgHome, d, at('13:01'))).toBe('waiting')
  expect(d.pings).toEqual([
    {
      title: 'Home connection offline',
      message:
        "Data Mining (14:00) runs through your home device tm-home-1a2b3c4d, which isn't online. Turn it on before 13:50, or the bot won't join.",
      priority: 'high',
      actions: [{ label: 'Open meeting page', url: d.meetingUrl(cfgHome.occurrenceId) }]
    }
  ])
  expect(d.scheduled).toEqual([
    ['home-route-recheck', { occurrenceId: cfgHome.occurrenceId }, 60],
    ['home-route-recheck', { occurrenceId: cfgHome.occurrenceId }, 60]
  ])
})
test('still offline at T-10 fails the occurrence; never a launch without the exit node', async () => {
  const d = deps({ status: 'offline', ipv4: null })
  expect(await startViaHome(db, cfgHome, d, at('13:50'))).toBe('failed')
  expect(d.failed).toEqual([[cfgHome.occurrenceId, 'home_exit_node_offline']])
  expect(launched).toEqual([])
})
test('a tunnel that does not come up counts as offline', async () => {
  const d = deps({
    status: 'ready',
    ipv4: '100.101.102.103',
    launchThrows: new HomeRouteUnavailable()
  })
  expect(await startViaHome(db, cfgHome, d, at('13:00'))).toBe('waiting')
  expect(d.pings[0].title).toBe('Home connection offline')
})
```

`deps({ status, ipv4, launchThrows? })` fakes `checkHomeRoute` through the injected API and records `pings`, `failed`, `scheduled` and `launched`; `cfgHome` is the "Data Mining" entry for an identity of member A set to `server_via_home`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/scheduler/src/home-route/check.test.ts`
Expected: FAIL with "Cannot find module './check'"

- [ ] **Step 3: Implement `startViaHome` and the hooks**

The ping goes out once per occurrence (recorded as an `alert` event with `{ kind: 'home_route_offline' }`; no ping when one exists). Reason phrases: `offline` "isn't online", `not_exit_node` "isn't sharing its connection", `not_enrolled` "isn't set up". From T-10 on, `deps.fail(occurrenceId, 'home_exit_node_offline')`, which also sends plan 01c's worker-failed ping. The `home-route-recheck` handler rebuilds the `JobConfig` with `buildJobConfig` and calls `startViaHome` again.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/scheduler/src/home-route/check.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src packages/notify/src/messages.ts
git commit -m "feat(scheduler): check the home route at T-60"
```

### Task 13: Home route sidecar

**Files:**

- Create: `docker/home-route/Dockerfile`, `docker/home-route/start.sh`, `packages/scheduler/src/home-route/sidecar.ts`
- Modify: `docker/worker/versions.env` (`TAILSCALE_VERSION`, set to the current stable release and changed only with a passing acceptance run); `docker/compose.yaml` (build `tm-home-route:${TAILSCALE_VERSION}`); plan 01c's docker-proxy create policy (`allowCreate`); plan 01c's `launchWorker` (`opts.networkMode`), its restart path (reuse a healthy sidecar, else start a new one) and its worker-exit handler (stop `tm-home-<occurrenceId>`)
- Test: `packages/scheduler/src/home-route/sidecar.test.ts`

**Interfaces:**

- Consumes: `TailscaleApi` (Task 11); `deny-private.sh` (Task 7); `launchWorker`, `allowCreate` and plan 01c's Docker API client for `DOCKER_PROXY_URL`.
- Produces:

```ts
export const HOME_ROUTE_IMAGE = 'tm-home-route'
export class HomeRouteUnavailable extends Error {}
export function sidecarName(occurrenceId: string): string // 'tm-home-<occurrenceId>'
export function sidecarCreateBody(o: {
  occurrenceId: string
  authKey: string
  exitNodeIp: string
  tailscaleVersion: string
  network: string
}): Record<string, unknown>
export function launchViaHome(
  cfg: JobConfig,
  exitNodeIp: string,
  d: {
    api: TailscaleApi
    docker: {
      create(name: string, body: unknown): Promise<void>
      start(name: string): Promise<void>
      healthy(name: string): Promise<boolean>
      stop(name: string): Promise<void>
    }
    launchWorker: typeof launchWorker
    network: string
    tailscaleVersion: string
    healthTimeoutMs?: number
  }
): Promise<void> // healthTimeoutMs default 60000
```

- [ ] **Step 1: Write the failing test**

```ts
test('the sidecar body: kernel networking, in-memory state, the exit node and nothing else', () => {
  const b = sidecarCreateBody({
    occurrenceId: 'o1',
    authKey: 'tskey-auth-x',
    exitNodeIp: '100.101.102.103',
    tailscaleVersion: '1.90.0',
    network: 'tm-workers'
  }) as any
  expect(b.Image).toBe('tm-home-route:1.90.0')
  expect(b.Env).toEqual([
    'TS_AUTHKEY=tskey-auth-x',
    'TS_HOSTNAME=tm-worker-o1',
    'TS_USERSPACE=false',
    'TS_TAILSCALED_EXTRA_ARGS=--state=mem:',
    'TS_EXTRA_ARGS=--exit-node=100.101.102.103 --exit-node-allow-lan-access=true --accept-dns=false --advertise-tags=tag:tm-worker'
  ])
  expect(b.HostConfig).toEqual({
    CapAdd: ['NET_ADMIN'],
    Devices: [
      {
        PathOnHost: '/dev/net/tun',
        PathInContainer: '/dev/net/tun',
        CgroupPermissions: 'rwm'
      }
    ],
    NetworkMode: 'tm-workers',
    AutoRemove: true
  })
  expect(b.Healthcheck.Test).toEqual(['CMD', 'test', '-f', '/tmp/tm-ready'])
})
test('launchViaHome mints an ephemeral worker key, waits for the tunnel, then joins the worker to it', async () => {
  const d = sidecarDeps({ healthyAfter: 2 })
  await launchViaHome(cfgHome, '100.101.102.103', d)
  expect(d.keys).toEqual([
    {
      tags: ['tag:tm-worker'],
      ephemeral: true,
      expirySeconds: 600,
      description: `tm-worker ${cfgHome.occurrenceId}`
    }
  ])
  expect(d.workerLaunches).toEqual([{ networkMode: `container:tm-home-${cfgHome.occurrenceId}` }])
})
test('a tunnel that is not healthy in time is removed and reported', async () => {
  const d = sidecarDeps({ healthyAfter: Infinity, healthTimeoutMs: 20 })
  await expect(launchViaHome(cfgHome, '100.101.102.103', d)).rejects.toBeInstanceOf(HomeRouteUnavailable)
  expect(d.stopped).toEqual([`tm-home-${cfgHome.occurrenceId}`])
  expect(d.workerLaunches).toEqual([])
})
test('the proxy allows the sidecar exactly as built, and nothing more', () => {
  const ok = sidecarCreateBody({
    occurrenceId: 'o1',
    authKey: 'k',
    exitNodeIp: '100.1.1.1',
    tailscaleVersion: '1.90.0',
    network: 'tm-workers'
  }) as any
  expect(allowCreate(ok)).toBe(true)
  expect(allowCreate({ ...ok, HostConfig: { ...ok.HostConfig, Privileged: true } })).toBe(false)
  expect(
    allowCreate({
      ...ok,
      HostConfig: { ...ok.HostConfig, Binds: ['/:/host'] }
    })
  ).toBe(false)
  expect(
    allowCreate({
      ...ok,
      HostConfig: { ...ok.HostConfig, CapAdd: ['NET_ADMIN', 'SYS_ADMIN'] }
    })
  ).toBe(false)
  expect(
    allowCreate({
      ...workerCreateBody,
      HostConfig: { ...workerCreateBody.HostConfig, CapAdd: ['NET_ADMIN'] }
    })
  ).toBe(false)
})
```

`sidecarDeps` records `keys`, `workerLaunches` and `stopped`, and reports the sidecar healthy after `healthyAfter` polls; `workerCreateBody` is plan 01c's worker create body fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/scheduler/src/home-route/sidecar.test.ts`
Expected: FAIL with "Cannot find module './sidecar'"

- [ ] **Step 3: Implement the image, the start script, `sidecar.ts` and the plan 01c changes**

`docker/home-route/Dockerfile`:

```dockerfile
ARG TAILSCALE_VERSION
FROM tailscale/tailscale:v${TAILSCALE_VERSION}
RUN apk add --no-cache jq
COPY docker/egress/deny-private.sh /usr/local/bin/deny-private.sh
COPY docker/home-route/start.sh /usr/local/bin/start.sh
ENTRYPOINT ["/usr/local/bin/start.sh"]
```

`start.sh`: run `deny-private.sh --out-iface tailscale0` first, so no tunnelled packet reaches a private range; start `containerboot` in the background; poll `tailscale status --json` every second and write `/tmp/tm-ready` once `.BackendState == "Running"` and `.ExitNodeStatus.Online == true`; then wait on `containerboot`. Tailscale drops traffic rather than falling back when the exit node goes away, so a mid-meeting outage shows up as plan 01c's dropped-meeting handling, never as traffic from the server's address. `launchViaHome`: mint a key with `createAuthKey({ tags: ['tag:tm-worker'], ephemeral: true, expirySeconds: 600, description: 'tm-worker <occurrenceId>' })` (reusable false and pre-authorised are fixed in the client for worker keys), create and start `sidecarName(occurrenceId)`, poll `healthy` every second until `healthTimeoutMs`, then `launchWorker(cfg, { networkMode: 'container:tm-home-<occurrenceId>' })`. The key sits in the sidecar's environment; it is single-use, ephemeral and expires in 10 minutes, and only the scheduler can reach the Docker API to read it. `allowCreate` accepts `tm-home-route:<TAILSCALE_VERSION>` only with exactly this `HostConfig`, and still refuses `CapAdd` on the worker image.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/scheduler/src/home-route/sidecar.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add docker/home-route docker/worker/versions.env docker/compose.yaml packages/scheduler/src
git commit -m "feat(scheduler): route workers via home exit node"
```

### Task 14: Milestone acceptance

**Files:**

- Create: `docs/acceptance/08-run-locations.md` (results of each check below, with date, versions and pass or fail)

**Interfaces:**

- Consumes: everything above, plans 01c and 03 deployed; a Windows 11 PC with Docker Desktop (WSL 2 backend) and the companion paired; a home device for the home route; the worker image pushed with `docker tag <local worker image> $TM_WORKER_IMAGE_REF && docker push $TM_WORKER_IMAGE_REF`.

- [ ] **Step 1: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: all tests pass; no type errors

- [ ] **Step 2: Bind an identity to the PC**

On the PC run `docker login ghcr.io`. Set the "University" identity to My PC on the website. Pass: `$TM_PROFILE_ROOT/<identityId>/` is gone on the server within a minute; the companion pulls the image. Set `memory=2GB` under `[wsl2]` in `%UserProfile%\.wslconfig`, restart Docker Desktop and rebind. Pass: the "Docker Desktop needs more memory" notification appears. Restore `memory=4GB` or more.

- [ ] **Step 3: Sign in on the PC**

From the tray, "Sign in to University"; sign in to Zoom, Microsoft and Google; press Done. Pass: a checkpoint appears under `%LOCALAPPDATA%\TolongMeeting\profiles\<identityId>\checkpoints\`; `docker volume ls` shows no `tm-profile-*`; `docker ps` shows nothing; the server holds no profile for the identity.

- [ ] **Step 4: A local live-mode lecture**

Run the design's "Form fixture" test lecture on a Zoom test meeting with this identity. Pass, besides that acceptance test: nothing appears on the desktop at any point; `docker inspect tm-run-<occurrence-id>-1 --format "{{json .Config.Env}}"` shows only the three path variables (and `TM_VNC_PASSWORD_FILE`); the run folder under `%LOCALAPPDATA%\TolongMeeting\runs\` is empty within 2 minutes of the start; `powercfg /requests` (read-only, administrator terminal) lists TolongMeeting; `docker run --rm --network container:tm-net-<occurrence-id> curlimages/curl -m 5 http://<home-router-ip>` fails and `-m 5 https://example.com` succeeds; the summary arrives and the local occurrence folder is removed after the upload.

- [ ] **Step 5: Commands, crash and sign-in during a run**

In a second local test meeting: press "Make the bot leave" (pass: the bot leaves within 15 seconds; design test "Take over" with the Take over button in a third meeting); in another, `docker kill tm-run-<occurrence-id>-1` mid-meeting (pass: design test "Crash": rejoin within 2 minutes as attempt 2, one restart ping, no repeat form submission); in another, press "Sign in" on the website during the meeting (pass: the window opens on the PC showing only the desk, the recording never shows it, and Done resumes automation; design test "Expired session" for local mode).

- [ ] **Step 6: Native mode on the PC**

Run a native-mode local test lecture. Pass: `audio.flac` never appears on the server; the transcript and summary arrive; the local occurrence folder and FLAC are gone afterwards.

- [ ] **Step 7: PC off, Docker off, upload interrupted**

Put the PC to sleep before T-60 of a local occurrence. Pass: `skipped_pc_offline` and the "Your PC is offline" ping within a minute of T-60. Quit Docker Desktop before T-60 of another. Pass: the "Start Docker Desktop" ping arrives once; after starting Docker at T-30 the bot joins. In a third, turn Wi-Fi off for 5 minutes during the upload. Pass: the upload resumes and the summary arrives; the occurrence never shows `failed`.

- [ ] **Step 8: Home route**

Follow the setup page's guide on a home device; set the "Work" identity to Server through home. During a test meeting, on the server as an admin run `docker run --rm --network container:tm-home-<occurrence-id> curlimages/curl -s https://ifconfig.me`. Pass: it prints the home public address; the work sign-in check at T-60 passes; `curl -m 5 http://<home-router-ip>` from the same namespace fails. Turn the home device off before T-60 of another occurrence. Pass: one "Home connection offline" ping at T-60; turning it on before T-10 lets the bot join. Leave it off for a third. Pass: the occurrence fails at T-10 with `home_exit_node_offline` and the bot never joins from the server's address.

- [ ] **Step 9: Isolation**

As member B, request member A's local run with B's device token: `/api/companion/jobs/<job-id>/secrets`, `/heartbeat`, `/files/events.jsonl`. Pass: 404 for each (design test "Isolation").

- [ ] **Step 10: Commit**

```bash
git add docs/acceptance/08-run-locations.md
git commit -m "docs: record run-location acceptance"
```
