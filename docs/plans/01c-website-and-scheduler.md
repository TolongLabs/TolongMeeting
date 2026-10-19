# Website and scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 1A/1B job-file worker into an unattended service for several TolongLabs members: a GitHub-gated website, a Postgres database, a scheduler that launches workers at T-60 through a restricted Docker gate, a heartbeat control channel with crash restarts, remote sign-in, retention and a Compose deployment.

**Architecture:** `packages/web` (Next.js App Router, run with Bun) serves the pages and the control API and owns the Drizzle schema in `packages/web/db/`, which `packages/scheduler` and `packages/pipeline` import as the shared server library. `tm-scheduler` expands timetables into occurrences 14 days ahead, runs pg-boss jobs, launches worker and sign-in containers through `docker-proxy` (a small allowlisting gate in front of the Docker socket), watches heartbeats and deletes old data; `tm-pipeline` consumes pipeline jobs. Every member-facing read and write in `packages/web` goes through one scope module, and secrets are sealed with AES-256-GCM under HKDF keys derived from the master key.

**Tech Stack:** TypeScript, Bun 1.x, Next.js (App Router), Drizzle ORM and drizzle-kit, Postgres 17, PGlite (tests), pg-boss, Better Auth (GitHub provider), Luxon, zod, noVNC, x11vnc, websockify, Caddy 2 (`forward_auth`), ntfy, Docker Compose, iptables.

**Spec:** `docs/PRD.md`, `docs/DESIGN.md` and `docs/TRD.md`.

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Tasks](#tasks)
    1.  [Task 1: Database schema and migrations](#task-1-database-schema-and-migrations)
    1.  [Task 2: Secret sealing and keys](#task-2-secret-sealing-and-keys)
    1.  [Task 3: Occurrence state machine](#task-3-occurrence-state-machine)
    1.  [Task 4: Member scope and isolation](#task-4-member-scope-and-isolation)
    1.  [Task 5: GitHub sign-in and organisation checks](#task-5-github-sign-in-and-organisation-checks)
    1.  [Task 6: Occurrence expansion and identity clashes](#task-6-occurrence-expansion-and-identity-clashes)
    1.  [Task 7: Notifications and ping copy](#task-7-notifications-and-ping-copy)
    1.  [Task 8: AI keys page](#task-8-ai-keys-page)
    1.  [Task 9: Accounts and My details pages](#task-9-accounts-and-my-details-pages)
    1.  [Task 10: Timetable page](#task-10-timetable-page)
    1.  [Task 11: Home and Admin pages](#task-11-home-and-admin-pages)
    1.  [Task 12: Meeting page](#task-12-meeting-page)
    1.  [Task 13: Docker socket gate](#task-13-docker-socket-gate)
    1.  [Task 14: Launcher and T-60 launch](#task-14-launcher-and-t-60-launch)
    1.  [Task 15: Heartbeat endpoint and crash monitor](#task-15-heartbeat-endpoint-and-crash-monitor)
    1.  [Task 16: Worker heartbeat and commands](#task-16-worker-heartbeat-and-commands)
    1.  [Task 17: Desk pause and sign-in container](#task-17-desk-pause-and-sign-in-container)
    1.  [Task 18: Remote sign-in](#task-18-remote-sign-in)
    1.  [Task 19: Pipeline consumer and artefacts](#task-19-pipeline-consumer-and-artefacts)
    1.  [Task 20: Retention and backups](#task-20-retention-and-backups)
    1.  [Task 21: Processes, Compose and worker network](#task-21-processes-compose-and-worker-network)
    1.  [Task 22: Milestone acceptance](#task-22-milestone-acceptance)

## Global Constraints

- **Runtimes**: Bun 1.x for `tm-web`, `tm-scheduler`, `tm-pipeline` and the Docker gate; the worker and the sign-in container run on Node 24 in the worker image.
- **Database**: Postgres 17; Drizzle schema and drizzle-kit migrations in `packages/web/db/`, imported by web, scheduler and pipeline through `packages/web/db/index.ts`; pg-boss keeps its own schema in the same database.
- **Sign-in**: GitHub only, through Better Auth with the `read:org` scope; membership of `GITHUB_ORG` is checked at every sign-in and daily, and sessions end when someone leaves the organisation. No public sign-up: an admin adds members. Admins don't see members' data in the app.
- **Isolation**: every member-facing read and write in `packages/web` goes through `packages/web/lib/scope.ts`; the only other files in `packages/web/app` and `packages/web/lib` that open the database are `lib/auth.ts` (Better Auth) and `lib/control.ts` (the token-authenticated worker and sign-in endpoints).
- **Secrets**: AES-256-GCM under keys derived with HKDF-SHA256 from the 32-byte master key in `TM_MASTER_KEY_FILE` (base64); per-identity profile keys, per-member column keys. Secrets are never logged, never in URL query strings and never in a worker container's environment.
- **Timings**: occurrences expanded 14 days ahead; worker launch at T-60; heartbeat every 5 seconds; 30 seconds without one is a crash; at most 3 restarts per occurrence; the remote view closes after 15 minutes idle; data deleted 30 days after the meeting, with a normal-priority ping 3 days before; nightly backups kept 7 days.
- **Capacity**: at most 2 server workers at once (`SERVER_WORKER_CAP = 2`, revised only from spike 6's report).
- **Containers**: started only through `DOCKER_PROXY_URL`, from image `tolongmeeting/worker:current`, with fixed mounts, `ShmSize` 2147483648 (`--shm-size=2g`) and network `tm-workers`.
- **Worker network**: deny `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fe80::/10` and other containers; allow public HTTPS and WebRTC ports, DNS to the two pinned resolvers, and the app's own API through Caddy.
- **Pings**: meeting passcodes never appear in ping text; screenshots are never attached; every 1C ping's wording is fixed in `packages/notify/src/messages.ts`.
- **Phasing**: only the `server` run location launches (plan 08 enables the others); chat link sources can't be saved yet (plan 02); native-mode occurrences stop at `waiting_for_pc` (plan 03); export buttons and Connections arrive with plan 07; plan 06 owns "Take over", so 1C's worker treats `take_over` as `leave_now`.
- **Copy and time**: plain British English; times are shown in the member's IANA time zone (default `Asia/Kuala_Lumpur`) as `Wed 21 Oct, 14:00`.
- **Contracts**: every name marked "adds to contracts" is copied into `docs/TRD.md` in the commit of the task that introduces it.

## Review Focus

- **Back-to-back sessions on one identity** (11:00 to 13:00 then 13:00 to 15:00): the meetings don't overlap but the workers' T-60 to end+30 windows do; the second session must still be attended, not skipped. Test in Task 14.
- **An entry edited or paused after its launch job was queued**: the old pg-boss job must do nothing rather than launch the wrong time. Tests in Tasks 6 and 14.
- **A heartbeat whose reply is lost**: the worker resends the same events; they must be stored once and the occurrence must not change state twice. Test in Task 15.
- **Entries that cross midnight or a daylight-saving change**: a 23:00 to 01:00 session ends the next day, and a London 10:00 session stays at 10:00 local after the clocks change. Tests in Task 6.
- **A worker that keeps heartbeating past its own hard stop**: it would hold one of the 2 server slots forever; the scheduler sends `stop` and then stops the container. Test in Task 15.

---

## Tasks

### Task 1: Database schema and migrations

**Files:**

- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/drizzle.config.ts`, `packages/web/db/schema.ts`, `packages/web/db/index.ts`, `packages/web/db/testing.ts`, `packages/web/db/migrate.ts`, `packages/web/db/migrations/` (generated), `packages/core/src/control.ts`, and the package skeletons `packages/scheduler/{package.json,tsconfig.json,src/index.ts}`
- Test: `packages/web/test/schema.test.ts` (against the shared Postgres on `TEST_DATABASE_URL`)

**Interfaces:**

- Consumes: `OccurrenceState`, `FormState`, `EventType`, `RunLocation`, `EntryType`, `TranscriptionMode`, `FormSource`, `FormProvider`, `TrustReason`, `SenderRole`, `LinkSource`, `JobConfig` from `packages/core` (architecture).
- Produces: `schema` (tables below); `type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>` (the node-postgres result type, so `db.execute` returns `{ rows }`), `closeDb()`; `getDb(): Db` (one node-postgres pool on `DATABASE_URL`); `createTestDb(): Promise<Db>` (a fresh, uniquely named database on `TEST_DATABASE_URL`, a real Postgres, with every migration applied; `dropTestDb(db)` and `dropAllTestDbs()` drop it); `seedMember(db: Db, opts?: { githubLogin?: string; role?: 'member' | 'admin'; full?: boolean }): Promise<Seeded>`, where `Seeded = { memberId: string; identityId: string; ids: Record<keyof typeof MEMBER_OWNED, string> }` (`full`, the default, adds one row to every member-owned table; `full: false` adds only an identity, its profile and a tested AI key); `MEMBER_OWNED` (record of every table with `memberId`); `pkOf(table): PgColumn`; `type ArtefactKind = 'recording' | 'summary' | 'transcript' | 'slides' | 'slides_json' | 'slide_image' | 'chat' | 'form_screenshot'`.
- Produces (adds to contracts), `packages/core/src/control.ts`: `ACCOUNT_KINDS = ['zoom', 'microsoft', 'google', 'whatsapp', 'discord', 'teams'] as const`, `type AccountKind`, `type AccountStatus = Partial<Record<AccountKind, { verifiedAt: string; signedIn: boolean }>>`; and the table `signin_sessions`.

Schema ("member_id" always means `uuid not null` referencing `members` with `on delete cascade`; every `id uuid` defaults to `gen_random_uuid()`; `created_at` and `updated_at` are `timestamptz not null default now()`):

```text
members            id; github_login text not null unique (stored lower-case); github_id bigint unique; auth_user_id text unique; display_name text not null; time_zone text not null default 'Asia/Kuala_Lumpur'; role text not null default 'member' check (member, admin); ntfy_topic text unique; ntfy_token_enc text; created_at
identities         id; member_id; name text not null; run_location text not null default 'server' check RunLocation; zoom_guest_name text not null; org_name text; org_email_domain text; created_at; unique (member_id, name)
profiles           identity_id uuid pk -> identities cascade; member_id; location text not null default 'server' check (server, local); latest_checkpoint text; checkpoint_at timestamptz; account_status jsonb not null default '{}' (AccountStatus); held_by text; held_since timestamptz
details            id; member_id; key text not null; value text not null; labels text[] not null default '{}'; position int not null default 0; unique (member_id, key)
mention_names      id; member_id; name text not null; unique index (member_id, lower(name))
timetable_entries  id; member_id; identity_id -> identities restrict; name text not null; type text check EntryType; repeat jsonb not null (RepeatRule, Task 6); start_time time not null; end_time time not null; link jsonb not null (LinkSource); trusted_senders text[] not null default '{}'; transcription text check TranscriptionMode; form_details jsonb not null default '{}'; attendance_keywords text[] not null default '{}'; paused boolean not null default false; created_at; updated_at
occurrences        id; member_id; entry_id -> timetable_entries set null; identity_id -> identities cascade; entry_name text not null; entry_type text not null; transcription text not null; scheduled_start timestamptz not null; scheduled_end timestamptz not null; actual_start timestamptz; actual_end timestamptz; state text not null default 'scheduled' check OccurrenceState; state_reason text; attempt int not null default 0; restarts int not null default 0; entry_snapshot jsonb (JobConfig['entry'], set at launch); link_used text; pasted_link text; container_name text; control_token_hash text; last_heartbeat_at timestamptz; recording boolean not null default false; participants int; pending_commands text[] not null default '{}'; delete_after timestamptz not null; deletion_warned_at timestamptz; created_at; unique (entry_id, scheduled_start); index (state); index (identity_id, scheduled_start); index (delete_after)
events             id bigserial pk; occurrence_id -> occurrences cascade; member_id; attempt int not null; at timestamptz not null; type text not null check EventType; data jsonb not null; data_hash text not null (sha256 of the canonical JSON of data); unique (occurrence_id, attempt, at, type, data_hash)
forms              id; occurrence_id -> occurrences cascade; member_id; form_key text not null; url text not null; final_url text; provider text; source text not null check FormSource; sender text; sender_role text; trust_reason text; state text not null check FormState; seen_at timestamptz not null; submitted_at timestamptz; fields_filled text[] not null default '{}'; result text; updated_at; unique (occurrence_id, form_key)
artefacts          id; occurrence_id -> occurrences cascade; member_id; kind text not null check ArtefactKind; path text not null (relative to the occurrence directory); bytes bigint not null; created_at; unique (occurrence_id, path)
ai_keys            member_id uuid pk -> members cascade; dashscope_key_enc text not null; workspace_id text; modelscope_key_enc text; test_ok boolean not null default false; test_error text; tested_at timestamptz; modelscope_test_ok boolean; updated_at
connections        id; member_id; kind text check (google, github, notion); token_enc text not null; settings jsonb not null default '{}'; created_at; unique (member_id, kind)
device_tokens      id; member_id; name text not null; token_hash text not null unique; created_at; last_used_at timestamptz; revoked_at timestamptz
signin_sessions    id; member_id; identity_id -> identities cascade; mode text not null check (worker, container); occurrence_id -> occurrences set null; upstream text; control_token_hash text; state text not null default 'starting' check (starting, ready, ended); done_requested boolean not null default false; last_heartbeat_at timestamptz; started_at timestamptz not null default now(); ended_at timestamptz; end_reason text
```

Secret columns (`members.ntfy_token_enc`, `ai_keys.dashscope_key_enc`, `ai_keys.modelscope_key_enc`, `connections.token_enc`) hold only `sealColumn` output (Task 2).

- [x] **Step 1: Write the failing test**

```ts
// packages/web/test/schema.test.ts (the shipped file also covers each constraint and the foreign-key actions)
const TABLES = [
  'ai_keys',
  'artefacts',
  'connections',
  'details',
  'device_tokens',
  'events',
  'forms',
  'identities',
  'members',
  'mention_names',
  'occurrences',
  'profiles',
  'signin_sessions',
  'timetable_entries'
]

test('migrations create every table', async () => {
  const db = await createTestDb()
  const { rows } = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`)
  expect(rows.map((r) => r.table_name).sort()).toEqual(TABLES)
})

test('every table but members has a non-null member_id', async () => {
  const db = await createTestDb()
  const { rows } = await db.execute(
    sql`select table_name from information_schema.columns where column_name = 'member_id' and is_nullable = 'NO'`
  )
  expect(rows.map((r) => r.table_name).sort()).toEqual(TABLES.filter((t) => t !== 'members'))
})

test('an occurrence is unique per entry and start', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  await expect(db.insert(occurrences).values({ ...o, id: undefined })).rejects.toThrow()
})

test('a repeated event is stored once', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  const e = {
    occurrenceId: a.ids.occurrences,
    memberId: a.memberId,
    attempt: 1,
    at: new Date('2026-10-21T06:00:00Z'),
    type: 'joined',
    data: {},
    dataHash: 'h'
  }
  await db.insert(events).values(e).onConflictDoNothing()
  await db.insert(events).values(e).onConflictDoNothing()
  expect(await db.$count(events, eq(events.dataHash, 'h'))).toBe(1)
})

test('an unknown occurrence state is rejected', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  await expect(
    db
      .update(occurrences)
      .set({ state: 'bogus' as never })
      .where(eq(occurrences.id, a.ids.occurrences))
  ).rejects.toThrow()
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/test/schema.test.ts`

Expected: FAIL with `Cannot find module '../db/testing'`.

- [x] **Step 3: Implement the schema in `packages/web/db/schema.ts` and generate the migration**

Write each table with `pgTable`, with check constraints built from runtime lists such as `const OCCURRENCE_STATES = [...] as const satisfies readonly OccurrenceState[]`, plus a compile-time check that `Exclude<OccurrenceState, (typeof OCCURRENCE_STATES)[number]>` is `never` (same for `FormState`, `EventType`, `RunLocation`). Type the jsonb columns with `$type<...>()`. Then run `bunx drizzle-kit generate --config packages/web/drizzle.config.ts --name init`. `createTestDb` creates a uniquely named database on `TEST_DATABASE_URL` and runs `runMigrations` (`drizzle-orm/node-postgres/migrator` with `migrationsFolder: new URL('./migrations', import.meta.url).pathname`). Generate with `bun run --cwd packages/web db:generate -- --name init`.

- [x] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:tmtest@127.0.0.1:55440/postgres bun test packages/web/test/schema.test.ts && bun run typecheck`

Expected: PASS, `0 fail`; typecheck exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/web packages/scheduler packages/core/src/control.ts packages/core/package.json bun.lock
git commit -m "feat(web): add database schema"
```

### Task 2: Secret sealing and keys

**Files:**

- Create: `packages/core/src/secrets.ts`, `packages/web/db/secrets.ts`, `packages/web/test/no-log.ts`, `packages/worker/src/profile/key.ts`
- Modify: `packages/worker/src/profile/keys.ts` (`deriveProfileKey` delegates to core `profileKey`). The `run.ts` swap to `loadProfileKey` moves to Task 16 (C20).
- Test: `packages/core/test/secrets.test.ts`, `packages/web/test/secrets.test.ts`, `packages/worker/test/profile-key.test.ts`

**Interfaces:**

- Consumes: 1A's `checkpointProfile(dir: string, out: string, key: Buffer)`.
- Produces (adds to contracts), `packages/core/src/secrets.ts`: `deriveKey(master: Buffer, info: string): Buffer` (HKDF-SHA256, salt `tolongmeeting/v1`, 32 bytes); `profileKey(master: Buffer, identityId: string): Buffer` (info `profile:<identityId>`); `memberKey(master: Buffer, memberId: string): Buffer` (info `member:<memberId>`); `sealSecret(key: Buffer, plaintext: string, aad: string): string` (AES-256-GCM, random 12-byte IV, output `v1.<iv>.<ciphertext>.<tag>` in base64url); `openSecret(key: Buffer, sealed: string, aad: string): string`, throwing `SecretError`.
- Produces, `packages/web/db/secrets.ts`: `loadMasterKey(file = process.env.TM_MASTER_KEY_FILE): Buffer` (throws `MasterKeyError`); `type SecretColumn = 'members.ntfy_token' | 'ai_keys.dashscope_key' | 'ai_keys.modelscope_key' | 'connections.token'`; `sealColumn(master: Buffer, memberId: string, column: SecretColumn, plaintext: string): string` and `openColumn(master: Buffer, memberId: string, column: SecretColumn, sealed: string): string`, both with AAD `<column>:<memberId>`.
- Produces, `packages/web/test/no-log.ts`: `expectNotLogged(secret: string, fn: () => Promise<unknown>): Promise<void>` (captures `console.*`, `process.stdout.write` and `process.stderr.write` while `fn` runs, and fails if any output contains `secret`).
- Produces (adds to contracts), `packages/worker/src/profile/key.ts`: `loadProfileKey(identityId: string): Buffer`, which returns the 32-byte base64 key in the file named by the new variable `TM_PROFILE_KEY_FILE` when it is set (the launcher sets it, Task 13), and otherwise `profileKey(master from TM_MASTER_KEY_FILE, identityId)`, as 1A runs.

- [x] **Step 1: Write the failing tests**

```ts
// packages/core/src/secrets.test.ts
const master = Buffer.alloc(32)
const id = '00000000-0000-0000-0000-000000000001'

test('keys are HKDF-SHA256 of the master key', () => {
  expect(profileKey(master, id).toString('hex')).toBe(
    'e2ca8b1047006e313ae1b906af0d4ee3bfc7aadd6de5804f6c613baa3051f7c7'
  )
  expect(memberKey(master, id).toString('hex')).toBe('a346d0e1646a9feab8a63dbc7a2592db49d0c456080a22a7bae8ae5cb3b903ad')
})

test('sealed secrets round-trip and never repeat', () => {
  const k = memberKey(master, id)
  const aad = `ai_keys.dashscope_key:${id}`
  const a = sealSecret(k, 'sk-test', aad)
  expect(a).toMatch(/^v1\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/)
  expect(a).not.toContain('sk-test')
  expect(sealSecret(k, 'sk-test', aad)).not.toBe(a)
  expect(openSecret(k, a, aad)).toBe('sk-test')
})

test('a wrong key, a wrong AAD or a changed byte throws SecretError', () => {
  const k = memberKey(master, id)
  const a = sealSecret(k, 'sk-test', 'x')
  expect(() => openSecret(k, a, 'y')).toThrow(SecretError)
  expect(() => openSecret(profileKey(master, id), a, 'x')).toThrow(SecretError)
  expect(() => openSecret(k, a.slice(0, -2) + (a.endsWith('A') ? 'BB' : 'AA'), 'x')).toThrow(SecretError)
})
```

```ts
// packages/web/db/secrets.test.ts
test('a master key that is not 32 bytes is refused without echoing it', async () => {
  const f = join(tmpdir(), 'short.key')
  await Bun.write(f, 'c2hvcnQ=')
  expect(() => loadMasterKey(f)).toThrow('TM_MASTER_KEY_FILE must hold 32 bytes, base64')
  try {
    loadMasterKey(f)
  } catch (e) {
    expect(String(e)).not.toContain('c2hvcnQ')
  }
})

test('a sealed column only opens for its member and column', () => {
  const s = sealColumn(Buffer.alloc(32), 'm1', 'ai_keys.dashscope_key', 'sk-test')
  expect(openColumn(Buffer.alloc(32), 'm1', 'ai_keys.dashscope_key', s)).toBe('sk-test')
  expect(() => openColumn(Buffer.alloc(32), 'm2', 'ai_keys.dashscope_key', s)).toThrow()
  expect(() => openColumn(Buffer.alloc(32), 'm1', 'members.ntfy_token', s)).toThrow()
})
```

```ts
// packages/worker/src/profile/key.test.ts
test('loadProfileKey prefers TM_PROFILE_KEY_FILE over deriving from the master key', async () => {
  const key = Buffer.alloc(32, 7)
  const f = join(tmpdir(), 'profile.key')
  await Bun.write(f, key.toString('base64'))
  process.env.TM_PROFILE_KEY_FILE = f
  expect(loadProfileKey('i1').equals(key)).toBe(true)
  delete process.env.TM_PROFILE_KEY_FILE
  const m = join(tmpdir(), 'master.key')
  await Bun.write(m, Buffer.alloc(32).toString('base64'))
  process.env.TM_MASTER_KEY_FILE = m
  expect(loadProfileKey('i1').equals(profileKey(Buffer.alloc(32), 'i1'))).toBe(true)
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/secrets.test.ts packages/web/db/secrets.test.ts packages/worker/src/profile/key.test.ts`

Expected: FAIL with `Cannot find module './secrets'`.

- [x] **Step 3: Implement the three modules**

Use `node:crypto` (`hkdfSync`, `createCipheriv('aes-256-gcm')`). `SecretError` and `MasterKeyError` carry fixed messages only, never input bytes. Replace the key that 1A's `run.ts` passes to `checkpointProfile` with `loadProfileKey(cfg.identity.id)`.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/secrets.test.ts packages/web/db/secrets.test.ts packages/worker/src/profile/key.test.ts`

Expected: PASS, `6 pass, 0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/secrets* packages/web/db/secrets* packages/web/test/no-log.ts packages/worker/src/profile packages/worker/src/run.ts
git commit -m "feat(core): seal secrets with HKDF keys"
```

### Task 3: Occurrence state machine

**Files:**

- Create: `packages/core/src/occurrence-machine.ts`, `packages/core/src/passcode.ts`, `packages/web/db/transitions.ts`
- Test: `packages/core/test/occurrence-machine.test.ts`, `packages/core/test/passcode.test.ts`, `packages/web/test/transitions.test.ts` (tests live in `test/`, not beside the source)

**Interfaces:**

- Consumes: `OccurrenceState` (architecture); `IllegalTransition` (1A, exported from `packages/core` beside `nextFormState`); `Db`, `schema` (Task 1).
- Produces, `packages/core/src/occurrence-machine.ts`: `type WorkerState = 'starting' | 'verifying_accounts' | 'waiting_for_signin' | 'watching_for_link' | 'joining' | 'in_lobby' | 'in_meeting' | 'leaving' | 'uploading'`; `type OccurrenceTrigger` (below); `WORKER_STATES: ReadonlySet<WorkerState>`; `ACTIVE_STATES` (`WORKER_STATES` plus `restarting`: the states that hold an identity and a server slot); `nextOccurrenceState(from: OccurrenceState, event: OccurrenceTrigger): OccurrenceState` (throws `IllegalTransition`); `triggerFor(from: OccurrenceState, to: OccurrenceState): OccurrenceTrigger | null`.
- Produces (adds to contracts): `stripPasscode(url: string): string` in `packages/core/src/passcode.ts`.
- Produces, `packages/web/db/transitions.ts`: `applyTrigger(db: Db, occurrenceId: string, trigger: OccurrenceTrigger, opts?: { reason?: string; recordEvent?: boolean }): Promise<{ from: OccurrenceState; to: OccurrenceState; restarts: number; knocks: number }>` (the counts are the post-trigger values, so the caller can `fail` after 3 restarts and stop knocking after 2). It locks the row (`for update`), writes the new state and `state_reason`, and records a `state` event `{ from, to, trigger, reason }` unless `recordEvent` is false. Migration `0001_occurrence_resume_and_knocks` adds `occurrences.resume_state` (nullable `OccurrenceState`) and `occurrences.knocks` (int, default 0). In the same locked transaction, `crash` stores the pre-crash state in `resume_state` and adds 1 to `restarts` (a crash while already `restarting` also adds 1, keeps `resume_state` and records no state event); `resume:<s>` throws `IllegalTransition` unless `s` equals `resume_state`, then clears it; `knock_again` adds 1 to `knocks` and records no state event. On entering any state outside `ACTIVE_STATES` and `scheduled` it applies `stripPasscode` to `link_used`, `pasted_link` and `entry_snapshot.link.url`. An illegal trigger throws and writes nothing.

```ts
export type OccurrenceTrigger =
  | 'launch'
  | 'skip_capacity'
  | 'skip_identity_clash'
  | 'skip_pc_offline'
  | 'worker_up'
  | 'signin_needed'
  | 'signed_in'
  | 'accounts_ok'
  | 'link_found'
  | 'link_timeout'
  | 'lobby'
  | 'knock_again'
  | 'admitted'
  | 'denied'
  | 'meeting_over'
  | 'left'
  | 'uploaded'
  | 'wait_for_pc'
  | 'transcript_ready'
  | 'summary_done'
  | 'crash'
  | `resume:${WorkerState}`
  | 'member_left'
  | 'fail'
  | 'delete'
```

Transitions (the design's diagram, plus `joining -> in_meeting` for meetings without a lobby, and `restarting -> crash` so a restart that never heartbeats counts again):

```text
scheduled            launch -> starting
starting             skip_capacity -> skipped_capacity; skip_identity_clash -> skipped_identity_clash; skip_pc_offline -> skipped_pc_offline; worker_up -> verifying_accounts
verifying_accounts   signin_needed -> waiting_for_signin; accounts_ok -> watching_for_link
waiting_for_signin   signed_in -> verifying_accounts
watching_for_link    link_found -> joining; link_timeout -> no_link
joining              lobby -> in_lobby; admitted -> in_meeting
in_lobby             knock_again -> in_lobby; admitted -> in_meeting; denied -> denied
in_meeting           meeting_over -> leaving
leaving              left -> uploading
uploading            uploaded -> transcribing
transcribing         transcript_ready -> post_processing; wait_for_pc -> waiting_for_pc
waiting_for_pc       transcript_ready -> post_processing
post_processing      summary_done -> completed
ACTIVE_STATES        crash -> restarting; member_left -> left_by_member
restarting           resume:<s> -> s, for every WorkerState s
all but deleted, failed                     fail -> failed
all outside ACTIVE_STATES, except deleted   delete -> deleted
```

`stripPasscode` removes the query parameters `pwd` and `passcode` on any host, and `p` on `teams.microsoft.com`, `*.teams.microsoft.com` and `teams.live.com`; it returns `''` for a string that doesn't parse as a URL. Names match in any case, and only the matching pairs are cut from the raw query string, so the rest keeps its encoding.

- [x] **Step 1: Write the failing tests**

```ts
// packages/core/test/occurrence-machine.test.ts
test('the main line runs from scheduled to completed', () => {
  const path: [OccurrenceTrigger, OccurrenceState][] = [
    ['launch', 'starting'],
    ['worker_up', 'verifying_accounts'],
    ['accounts_ok', 'watching_for_link'],
    ['link_found', 'joining'],
    ['lobby', 'in_lobby'],
    ['admitted', 'in_meeting'],
    ['meeting_over', 'leaving'],
    ['left', 'uploading'],
    ['uploaded', 'transcribing'],
    ['transcript_ready', 'post_processing'],
    ['summary_done', 'completed']
  ]
  let s: OccurrenceState = 'scheduled'
  for (const [t, want] of path) expect((s = nextOccurrenceState(s, t))).toBe(want)
})

test('side exits', () => {
  expect(nextOccurrenceState('verifying_accounts', 'signin_needed')).toBe('waiting_for_signin')
  expect(nextOccurrenceState('waiting_for_signin', 'signed_in')).toBe('verifying_accounts')
  expect(nextOccurrenceState('watching_for_link', 'link_timeout')).toBe('no_link')
  expect(nextOccurrenceState('in_lobby', 'knock_again')).toBe('in_lobby')
  expect(nextOccurrenceState('in_lobby', 'denied')).toBe('denied')
  expect(nextOccurrenceState('in_meeting', 'crash')).toBe('restarting')
  expect(nextOccurrenceState('restarting', 'resume:in_meeting')).toBe('in_meeting')
  expect(nextOccurrenceState('restarting', 'crash')).toBe('restarting')
  expect(nextOccurrenceState('joining', 'member_left')).toBe('left_by_member')
  expect(nextOccurrenceState('starting', 'skip_capacity')).toBe('skipped_capacity')
  expect(nextOccurrenceState('transcribing', 'wait_for_pc')).toBe('waiting_for_pc')
  expect(nextOccurrenceState('post_processing', 'fail')).toBe('failed')
  expect(nextOccurrenceState('completed', 'delete')).toBe('deleted')
})

test('illegal moves throw', () => {
  expect(() => nextOccurrenceState('scheduled', 'admitted')).toThrow(IllegalTransition)
  expect(() => nextOccurrenceState('in_meeting', 'delete')).toThrow(IllegalTransition)
  expect(() => nextOccurrenceState('deleted', 'fail')).toThrow(IllegalTransition)
  expect(() => nextOccurrenceState('completed', 'crash')).toThrow(IllegalTransition)
})

test('triggerFor finds the trigger between two states', () => {
  expect(triggerFor('verifying_accounts', 'watching_for_link')).toBe('accounts_ok')
  expect(triggerFor('restarting', 'starting')).toBe('resume:starting')
  expect(triggerFor('uploading', 'transcribing')).toBe('uploaded')
  expect(triggerFor('in_meeting', 'completed')).toBeNull()
})
```

```ts
// packages/core/test/passcode.test.ts
test('passcodes are stripped from meeting links', () => {
  expect(stripPasscode('https://example.zoom.us/j/00000000000?pwd=PASSCODE')).toBe(
    'https://example.zoom.us/j/00000000000'
  )
  expect(stripPasscode('https://teams.microsoft.com/meet/00000000?p=PASSCODE')).toBe(
    'https://teams.microsoft.com/meet/00000000'
  )
  expect(stripPasscode('https://example.com/x?p=1')).toBe('https://example.com/x?p=1')
  expect(stripPasscode('not a url')).toBe('')
})
```

```ts
// packages/web/test/transitions.test.ts
test('a transition writes the state and a state event', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  expect(await applyTrigger(db, a.ids.occurrences, 'launch')).toEqual({
    from: 'scheduled',
    to: 'starting'
  })
  const [ev] = await db.select().from(events).where(eq(events.occurrenceId, a.ids.occurrences))
  expect(ev.data).toEqual({
    from: 'scheduled',
    to: 'starting',
    trigger: 'launch'
  })
})

test('leaving the active states strips passcodes', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  await db
    .update(occurrences)
    .set({
      state: 'uploading',
      linkUsed: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
    })
    .where(eq(occurrences.id, a.ids.occurrences))
  await applyTrigger(db, a.ids.occurrences, 'uploaded')
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(o.linkUsed).toBe('https://example.zoom.us/j/00000000000')
})

test('an illegal trigger changes nothing', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  await expect(applyTrigger(db, a.ids.occurrences, 'admitted')).rejects.toThrow(IllegalTransition)
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(o.state).toBe('scheduled')
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/occurrence-machine.test.ts packages/core/test/passcode.test.ts packages/web/test/transitions.test.ts`

Expected: FAIL with `Cannot find module './occurrence-machine'`.

- [x] **Step 3: Implement the machine, `stripPasscode` and `applyTrigger`**

Hold the transitions above as one table (`Record<OccurrenceState, Partial<Record<OccurrenceTrigger, OccurrenceState>>>` plus the three group rules), so that `nextOccurrenceState` and `triggerFor` read the same data.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/occurrence-machine.test.ts packages/core/test/passcode.test.ts packages/web/test/transitions.test.ts`

Expected: PASS, `12 pass, 0 fail` (the three files together).

- [x] **Step 5: Commit**

```bash
git add packages/core/src/occurrence-machine* packages/core/src/passcode* packages/web/db/transitions*
git commit -m "feat(core): add occurrence state machine"
```

### Task 4: Member scope and isolation

**Files:**

- Create: `packages/web/lib/scope.ts`
- Test: `packages/web/test/scope.test.ts`, `packages/web/test/no-direct-db.test.ts` (under `test/` per COMMON.md)

**Interfaces:**

- Consumes: `Db`, `getDb`, `schema`, `MEMBER_OWNED`, `pkOf`, `createTestDb`, `seedMember` (Task 1).
- Produces: `createScope(db: Db, memberId: string): MemberScope`; `scopeForAuthUser(authUserId: string): Promise<MemberScope | null>` (the only way pages and routes get a scope; it calls `getDb()` itself); `type MemberOwnedTable` (any table in `MEMBER_OWNED`).

```ts
export interface MemberScope {
  readonly memberId: string
  me(): Promise<MemberRow>
  updateMe(set: Partial<Pick<MemberRow, 'displayName' | 'timeZone' | 'ntfyTopic' | 'ntfyTokenEnc'>>): Promise<void>
  select<T extends MemberOwnedTable>(table: T, where?: SQL): Promise<T['$inferSelect'][]>
  insert<T extends MemberOwnedTable>(table: T, values: Omit<T['$inferInsert'], 'memberId'>): Promise<T['$inferSelect']>
  update<T extends MemberOwnedTable>(table: T, set: Partial<T['$inferInsert']>, where: SQL): Promise<number>
  remove<T extends MemberOwnedTable>(table: T, where: SQL): Promise<number>
  transaction<R>(fn: (s: MemberScope) => Promise<R>): Promise<R>
  artefactFile(occurrenceId: string, relPath: string): Promise<string | null>
}
```

Every method adds `member_id = memberId` to its `where` (the caller's `where` is wrapped as `(where)` first, so a bare `or` can't escape the filter), forces `memberId` on insert and drops `memberId` from an update's `set`. `updateMe` keeps only its four keys at runtime. `artefactFile` returns `<resolved TM_DATA_ROOT>/occurrences/<occurrenceId>/<relPath>` only when `occurrenceId` is a UUID, the resolved path is inside that occurrence directory and an `artefacts` row with that member, occurrence and path exists; otherwise `null`. The serving route must also `realpath` the file, because a symlink passes the lexical check.

Isolation also holds in the database: every member-owned child references its parent with a composite `(parent_id, member_id)` foreign key (parents `identities`, `timetable_entries` and `occurrences` carry `unique (id, member_id)`), so inserting or updating a child with another member's parent fails even through raw `db`. The `no-direct-db` guard matches the db module with or without an extension, dynamic `import(` and `require(`, raw drivers (`drizzle-orm/node-postgres`, `postgres-js`, `bun-sql`, `pg`, `postgres`, `Bun.sql`), and scans `.ts/.tsx/.js/.mjs/.cjs` in every directory of `packages/web` except `db/`, `test/` and `lib/scope.ts`, `lib/auth.ts`, `lib/control.ts`. Later tasks add `authScope` (Task 5) and `adminScope` (Task 11) to this file, both taking `db: Db = getDb()` so routes never call `getDb` themselves, and member-limited helpers to `MemberScope`.

- [x] **Step 1: Write the failing tests**

```ts
// packages/web/test/scope.test.ts
for (const [name, table] of Object.entries(MEMBER_OWNED)) {
  test(`${name}: one member can't read or delete another member's rows`, async () => {
    const db = await createTestDb()
    const a = await seedMember(db)
    const b = await seedMember(db)
    const sb = createScope(db, b.memberId)
    expect((await sb.select(table)).every((r) => r.memberId === b.memberId)).toBe(true)
    expect(await sb.remove(table, eq(pkOf(table), a.ids[name]))).toBe(0)
    expect(await db.$count(table, eq(pkOf(table), a.ids[name]))).toBe(1)
  })
}

test("an update can't touch or move another member's row", async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  const b = await seedMember(db)
  const sb = createScope(db, b.memberId)
  expect(await sb.update(identities, { name: 'Taken' }, eq(identities.id, a.identityId))).toBe(0)
  await sb.update(identities, { memberId: a.memberId, name: 'Mine' } as never, eq(identities.id, b.identityId))
  const [row] = await db.select().from(identities).where(eq(identities.id, b.identityId))
  expect(row).toMatchObject({ memberId: b.memberId, name: 'Mine' })
})

test("an insert is always stored under the scope's member", async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  const b = await seedMember(db)
  const row = await createScope(db, b.memberId).insert(mentionNames, {
    name: 'Short Name',
    memberId: a.memberId
  } as never)
  expect(row.memberId).toBe(b.memberId)
})

test("artefact files resolve only for the owner's registered paths", async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  const b = await seedMember(db)
  const [art] = await db.select().from(artefacts).where(eq(artefacts.id, a.ids.artefacts))
  expect(await createScope(db, a.memberId).artefactFile(art.occurrenceId, art.path)).toEndWith(
    `/occurrences/${art.occurrenceId}/${art.path}`
  )
  expect(await createScope(db, b.memberId).artefactFile(art.occurrenceId, art.path)).toBeNull()
  expect(await createScope(db, a.memberId).artefactFile(art.occurrenceId, '../../etc/passwd')).toBeNull()
})
```

```ts
// packages/web/test/no-direct-db.test.ts
test('only scope.ts, auth.ts and control.ts open the database in packages/web', async () => {
  const files = await Array.fromAsync(new Bun.Glob('{app,lib}/**/*.{ts,tsx}').scan({ cwd: 'packages/web' }))
  const offenders: string[] = []
  for (const f of files) {
    if (/^lib\/(scope|auth|control)\.ts$|\.test\.tsx?$/.test(f)) continue
    const text = await Bun.file(`packages/web/${f}`).text()
    if (/\bgetDb\s*\(|from ['"][./]*db(\/index)?['"]/.test(text)) offenders.push(f)
  }
  expect(offenders).toEqual([])
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/test/scope.test.ts packages/web/test/no-direct-db.test.ts`

Expected: FAIL with `Cannot find module './scope'`.

- [x] **Step 3: Implement `createScope` and `scopeForAuthUser` in `packages/web/lib/scope.ts`**

Pages and routes import tables from `packages/web/db/schema.ts` for `where` clauses, never `packages/web/db/index.ts`.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/test/scope.test.ts packages/web/test/no-direct-db.test.ts`

Expected: PASS, `0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/web/lib/scope.ts packages/web/test/scope.test.ts packages/web/test/no-direct-db.test.ts
git commit -m "feat(web): add member scope"
```

### Task 5: GitHub sign-in and organisation checks

**Files:**

- Create: `packages/web/lib/auth.ts`, `packages/web/lib/github.ts`, `packages/web/lib/authorise.ts`, `packages/web/lib/session.ts`, `packages/web/app/api/auth/[...all]/route.ts`, `packages/web/app/sign-in/page.tsx`, `packages/web/db/auth-schema.ts` (generated), `packages/web/scripts/add-member.ts`, `packages/scheduler/package.json`, `packages/scheduler/src/org-check.ts`
- Modify: `packages/web/db/schema.ts` (foreign key from `members.auth_user_id` to `auth_user.id`, on delete set null), `packages/web/db/testing.ts` (`seedAuthUser`, `seedLinkedMember`), `packages/web/lib/scope.ts` (`authScope`), `packages/web/db/schema.test.ts` (table list)
- Test: `packages/web/lib/authorise.test.ts`, `packages/scheduler/src/org-check.test.ts`

**Interfaces:**

- Consumes: `deriveKey`, `loadMasterKey` (Task 2); `scopeForAuthUser` (Task 4).
- Produces (adds to contracts): Better Auth tables `auth_user`, `auth_session`, `auth_account`, `auth_verification`, generated with `bunx @better-auth/cli generate --config packages/web/lib/auth.ts --output packages/web/db/auth-schema.ts`.
- Produces: `interface GitHubApi { user(token: string): Promise<{ id: number; login: string }>; orgMembership(token: string, org: string): Promise<'active' | 'pending' | 'none'> }`; `githubApi(fetchFn = fetch): GitHubApi` (`GET https://api.github.com/user` and `GET https://api.github.com/user/memberships/orgs/{org}` with `Authorization: Bearer`, `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`; 403 or 404 means `'none'`; 401 throws `GitHubTokenError`).
- Produces: `authScope(db: Db = getDb()): AuthScope` with `githubToken(authUserId: string): Promise<string | null>`, `memberForGithub(githubId: number, login: string): Promise<{ id: string } | null>` (match on `github_id`, else on lower-cased `github_login` where `github_id` is null), `linkMember(memberId: string, githubId: number, authUserId: string): Promise<void>`, `linkedMembers(): Promise<{ memberId: string; authUserId: string }[]>`, `endSessions(authUserId: string): Promise<void>`.
- Produces: `authoriseSession(deps: { github: GitHubApi; auth: AuthScope; org: string }, authUserId: string): Promise<void>`, which throws `APIError('FORBIDDEN', { message: 'Not an active TolongLabs member. Ask an admin to add you.' })`; `checkMemberships(deps: { github: GitHubApi; auth: AuthScope; org: string }): Promise<{ ended: string[] }>` (member ids whose sessions ended); `requireMember(): Promise<MemberScope>` and `requireAdmin(): Promise<MemberScope>` (redirect to `/sign-in` without a session or member, and to `/` for a non-admin).

`auth.ts` configures Better Auth with `baseURL: TM_PUBLIC_URL`, `secret: deriveKey(loadMasterKey(), 'better-auth').toString('base64')`, the Drizzle adapter (`provider: 'pg'`, model names `auth_user`, `auth_session`, `auth_account`, `auth_verification`), `socialProviders.github` with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `scope: ['read:org']`, and `databaseHooks.session.create.before` calling `authoriseSession(..., session.userId)`. The sign-in page has one "Sign in with GitHub" button and shows the refusal text when sign-in fails. `add-member.ts` bootstraps the first admin: `bun run packages/web/scripts/add-member.ts --login <github-login> --name "<display name>" [--tz <IANA zone>] [--admin]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/authorise.test.ts
const gh = (m: 'active' | 'pending' | 'none', user = { id: 42, login: 'Octo-Member' }): GitHubApi => ({
  user: async () => user,
  orgMembership: async () => m
})
const deps = (db: Db, m: 'active' | 'pending' | 'none', user?: { id: number; login: string }) => ({
  github: gh(m, user),
  auth: authScope(db),
  org: 'tolonglabs'
})

test('an active organisation member added by an admin is allowed and linked', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, {
    githubLogin: 'octo-member',
    full: false
  })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await authoriseSession(deps(db, 'active'), authUserId)
  const [m] = await db.select().from(members).where(eq(members.id, memberId))
  expect(m).toMatchObject({ githubId: 42, authUserId })
})

test('a pending membership is refused', async () => {
  const db = await createTestDb()
  await seedMember(db, { githubLogin: 'octo-member', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'pending'), authUserId)).rejects.toThrow('Not an active TolongLabs member')
})

test('an organisation member nobody added is refused', async () => {
  const db = await createTestDb()
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'active'), authUserId)).rejects.toThrow('Not an active TolongLabs member')
})

test('a renamed GitHub login still matches by id', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, {
    githubLogin: 'old-name',
    full: false
  })
  await db.update(members).set({ githubId: 42 }).where(eq(members.id, memberId))
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'active', { id: 42, login: 'new-name' }), authUserId)).resolves.toBeUndefined()
})
```

```ts
// packages/scheduler/src/org-check.test.ts
test('the daily check ends the sessions of members who left or revoked the app', async () => {
  const db = await createTestDb()
  const left = await seedLinkedMember(db, 'gho_left') // member + auth user + link + one auth_session
  const revoked = await seedLinkedMember(db, 'gho_revoked')
  const stays = await seedLinkedMember(db, 'gho_stays')
  const github: GitHubApi = {
    user: async (t) => {
      if (t === 'gho_revoked') throw new GitHubTokenError()
      return { id: 1, login: 'x' }
    },
    orgMembership: async (t) => (t === 'gho_left' ? 'none' : 'active')
  }
  const { ended } = await checkMemberships({
    github,
    auth: authScope(db),
    org: 'tolonglabs'
  })
  expect(ended.sort()).toEqual([left.memberId, revoked.memberId].sort())
  expect(await db.$count(authSession, eq(authSession.userId, stays.authUserId))).toBe(1)
  expect(await db.$count(authSession, eq(authSession.userId, left.authUserId))).toBe(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/authorise.test.ts packages/scheduler/src/org-check.test.ts`

Expected: FAIL with `Cannot find module './authorise'`.

- [ ] **Step 3: Implement the modules, then generate the auth schema and its migration**

Run the Better Auth generator, then `bunx drizzle-kit generate --config packages/web/drizzle.config.ts --name auth`. Add the four `auth_*` tables to the `TABLES` list in `schema.test.ts`, and exclude them, like `members`, from the `member_id` check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/authorise.test.ts packages/scheduler/src/org-check.test.ts packages/web/db/schema.test.ts && bun run typecheck`

Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web packages/scheduler
git commit -m "feat(web): add GitHub sign-in with org check"
```

### Task 6: Occurrence expansion and identity clashes

**Files:**

- Create: `packages/core/src/timetable.ts`, `packages/core/src/schedule.ts`, `packages/web/db/queues.ts`, `packages/web/db/occurrences.ts`
- Modify: `packages/web/db/testing.ts` (`FakeQueue`, `withEntry`; both are in testing.ts, not queues.ts), `packages/web/lib/scope.ts` (`MemberScope.syncOccurrences`, `MemberScope.identityClashes`)
- Test: `packages/core/test/schedule.test.ts`, `packages/web/test/occurrences.test.ts`

**Interfaces:**

- Consumes: `Db`, `schema` (Task 1); `ACTIVE_STATES` (Task 3).
- Produces (adds to contracts), `packages/core/src/timetable.ts`: `type RepeatRule = { kind: 'once'; date: string } | { kind: 'weekly'; days: (1 | 2 | 3 | 4 | 5 | 6 | 7)[]; from: string }` (ISO weekdays, 1 is Monday; dates `YYYY-MM-DD`) and `RepeatRuleSchema`.
- Produces (adds to contracts), `packages/core/src/schedule.ts`: `expandEntry(e: { repeat: RepeatRule; startTime: string; endTime: string }, timeZone: string, now: Date, horizonDays = 14): { start: Date; end: Date }[]` (slots with `now < start < now + horizon`; an end written at or before the start falls on the next day, decided on the `HH:MM` strings before the instants are resolved; local times through Luxon; a time in a spring-forward gap shifts forward by the gap length, and if that pushes the start to or past the end the end moves by the same amount, so the slot never becomes 24 hours); `findClashes(slots: { id: string; start: Date; end: Date; rank: number }[]): { winner: string; loser: string }[]` (slots clash when `a.start < b.end && b.start < a.end`; the earlier start wins, then the lower `rank`, which is the entry's creation time in milliseconds); `formatWhen(d: Date, timeZone: string): string` (`ccc d MMM, HH:mm` with fixed three-letter English names, so September is `Sep` whatever the locale data says); `formatDay(d: Date, timeZone: string): string` (`ccc d MMM`).
- Produces (adds to contracts), `packages/web/db/queues.ts`: `QUEUES = { expand: 'expand', launch: 'launch', pipeline: 'pipeline', signinStart: 'signin-start', deleteOccurrence: 'delete-occurrence', retention: 'retention', backup: 'backup', orgCheck: 'org-check' } as const`; `type QueueName`; `interface Queue { send(name: QueueName, data: Record<string, unknown>, opts?: { startAfter?: Date; singletonKey?: string; db?: QueueDb }): Promise<string | null> }` (`db` is pg-boss's per-call connection; `queueDbOf(tx)` wraps a Drizzle transaction's client so a job commits or rolls back with the rows written beside it; `singletonKey` is informational on a standard queue, it does not deduplicate); `bossQueue(boss: PgBoss): Queue`; `FakeQueue` (records `sent: { name, data, opts }[]`).
- Produces, `packages/web/db/occurrences.ts`: `syncOccurrences(db: Db, queue: Queue, now: Date, memberId?: string): Promise<{ created: number; removed: number }>`; `identityClashes(db: Db, identityId: string, from: Date, to: Date): Promise<{ winner: OccurrenceRow; loser: OccurrenceRow }[]>` (ignores `skipped_*`, `failed` and `deleted` occurrences).

`syncOccurrences` covers members whose `ai_keys.test_ok` is true. For each unpaused entry it expands slots in the member's time zone and inserts the missing occurrences (`on conflict do nothing`) with `entry_name`, `entry_type`, `transcription` and `delete_after = scheduled_end + 30 days`; refreshes those three columns on future `scheduled` occurrences; deletes future `scheduled` occurrences that no longer match a slot of an unpaused entry; and for each created occurrence sends `launch` with data `{ occurrenceId, scheduledStart }` (ISO), `startAfter` at the start minus 60 minutes (or now, if that has passed) and `singletonKey` `launch:<occurrenceId>:<scheduledStart>`, sent through the sync transaction's connection (`db: queueDbOf(tx)`) so the occurrence rows and their jobs commit or roll back together. Only `scheduled` rows are ever hard-deleted, and no machine edge returns to `scheduled`, so no events, forms or artefacts are lost. The launcher (Task 14) treats a missing occurrence row or a `scheduledStart` that differs from the job's as a stale job.

- [x] **Step 1: Write the failing tests**

```ts
// packages/core/test/schedule.test.ts
const now = new Date('2026-10-20T00:00:00Z')

test('a weekly entry expands 14 days ahead in the member time zone', () => {
  const slots = expandEntry(
    {
      repeat: { kind: 'weekly', days: [1, 3], from: '2026-10-01' },
      startTime: '14:00',
      endTime: '16:00'
    },
    'Asia/Kuala_Lumpur',
    now
  )
  expect(slots.map((s) => s.start.toISOString())).toEqual([
    '2026-10-21T06:00:00.000Z',
    '2026-10-26T06:00:00.000Z',
    '2026-10-28T06:00:00.000Z',
    '2026-11-02T06:00:00.000Z'
  ])
  expect(slots[0].end.toISOString()).toBe('2026-10-21T08:00:00.000Z')
})

test('expansion keeps local time across a daylight-saving change', () => {
  const slots = expandEntry(
    {
      repeat: { kind: 'weekly', days: [1], from: '2026-10-19' },
      startTime: '10:00',
      endTime: '11:00'
    },
    'Europe/London',
    new Date('2026-10-18T00:00:00Z')
  )
  expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-10-19T09:00:00.000Z', '2026-10-26T10:00:00.000Z'])
})

test('an end before the start is on the next day', () => {
  const [s] = expandEntry(
    {
      repeat: { kind: 'once', date: '2026-10-23' },
      startTime: '23:00',
      endTime: '01:00'
    },
    'Asia/Kuala_Lumpur',
    now
  )
  expect([s.start.toISOString(), s.end.toISOString()]).toEqual(['2026-10-23T15:00:00.000Z', '2026-10-23T17:00:00.000Z'])
})

test('past and out-of-horizon slots are left out', () => {
  const once = (date: string) =>
    expandEntry({ repeat: { kind: 'once', date }, startTime: '10:00', endTime: '11:00' }, 'Asia/Kuala_Lumpur', now)
  expect(once('2026-10-19')).toEqual([])
  expect(once('2026-11-03')).toEqual([])
})

test('the earlier start wins a clash, ties go to the older entry, touching slots do not clash', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 21, h))
  expect(
    findClashes([
      { id: 'b', start: t(7), end: t(9), rank: 1 },
      { id: 'a', start: t(6), end: t(8), rank: 2 }
    ])
  ).toEqual([{ winner: 'a', loser: 'b' }])
  expect(
    findClashes([
      { id: 'x', start: t(6), end: t(8), rank: 2 },
      { id: 'y', start: t(6), end: t(8), rank: 1 }
    ])
  ).toEqual([{ winner: 'y', loser: 'x' }])
  expect(
    findClashes([
      { id: 'p', start: t(6), end: t(8), rank: 1 },
      { id: 'q', start: t(8), end: t(10), rank: 2 }
    ])
  ).toEqual([])
})

test('times are shown in the member time zone', () => {
  expect(formatWhen(new Date('2026-10-21T06:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('Wed 21 Oct, 14:00')
  expect(formatDay(new Date('2026-11-20T08:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('Fri 20 Nov')
})
```

```ts
// packages/web/test/occurrences.test.ts
const now = new Date('2026-10-20T00:00:00Z')
const WEDNESDAY_14 = {
  repeat: { kind: 'weekly', days: [3], from: '2026-10-01' },
  startTime: '14:00',
  endTime: '16:00'
} as const

test('sync creates occurrences once and queues launches at T-60', async () => {
  const { db, memberId, q } = await withEntry(WEDNESDAY_14) // seedMember(full: false) plus one entry and a FakeQueue
  expect(await syncOccurrences(db, q, now)).toEqual({ created: 2, removed: 0 })
  expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
  expect(q.sent[0]).toEqual({
    name: 'launch',
    data: {
      occurrenceId: expect.any(String),
      scheduledStart: '2026-10-21T06:00:00.000Z'
    },
    opts: {
      startAfter: new Date('2026-10-21T05:00:00.000Z'),
      singletonKey: expect.stringMatching(/^launch:.+:2026-10-21T06:00:00\.000Z$/),
      db: expect.anything()
    }
  })
  const [o] = await db
    .select()
    .from(occurrences)
    .where(eq(occurrences.memberId, memberId))
    .orderBy(occurrences.scheduledStart)
  expect(o.deleteAfter.toISOString()).toBe('2026-11-20T08:00:00.000Z')
})

test('pausing an entry removes its future scheduled occurrences', async () => {
  const { db, entryId, q } = await withEntry(WEDNESDAY_14)
  await syncOccurrences(db, q, now)
  await db.update(timetableEntries).set({ paused: true }).where(eq(timetableEntries.id, entryId))
  expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 2 })
})

test('moving an entry to 15:00 replaces its scheduled occurrences', async () => {
  const { db, entryId, q } = await withEntry(WEDNESDAY_14)
  await syncOccurrences(db, q, now)
  await db
    .update(timetableEntries)
    .set({ startTime: '15:00', endTime: '17:00' })
    .where(eq(timetableEntries.id, entryId))
  expect(await syncOccurrences(db, q, now)).toEqual({ created: 2, removed: 2 })
})

test('a member without a working AI key gets no occurrences', async () => {
  const { db, memberId, q } = await withEntry(WEDNESDAY_14)
  await db.update(aiKeys).set({ testOk: false }).where(eq(aiKeys.memberId, memberId))
  expect(await syncOccurrences(db, q, now)).toEqual({ created: 0, removed: 0 })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/test/schedule.test.ts packages/web/test/occurrences.test.ts`

Expected: FAIL with `Cannot find module './schedule'`.

- [x] **Step 3: Implement the modules**

Add `syncOccurrences(queue, now)` and `identityClashes(identityId, from, to)` to `MemberScope`, both limited to the scope's member.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/test/schedule.test.ts packages/web/test/occurrences.test.ts`

Expected: PASS, `10 pass, 0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/timetable.ts packages/core/src/schedule.ts packages/core/test/schedule.test.ts packages/web/db packages/web/lib/scope.ts packages/web/test/occurrences.test.ts packages/web/test/queues.test.ts
git commit -m "feat(web): expand timetable into occurrences"
```

### Task 7: Notifications and ping copy

**Files:**

- Create: `packages/notify/src/messages.ts`, `packages/web/db/notifier.ts`, `packages/web/lib/ntfy-admin.ts`, `packages/web/app/notifications/page.tsx`, `packages/web/app/notifications/actions.ts`
- Modify: `packages/web/db/testing.ts` (`withNtfy`, `fakeFetch`)
- Test: `packages/notify/src/messages.test.ts`, `packages/web/db/notifier.test.ts`, `packages/web/lib/ntfy-admin.test.ts`

**Interfaces:**

- Consumes: `Ping`, `PingAction`, `NtfyConfig`, `sendPing` (architecture, `packages/notify`); `sealColumn`, `openColumn`, `expectNotLogged` (Task 2); `MemberScope` (Task 4).
- Produces (adds to contracts): `pings` in `packages/notify/src/messages.ts`, one function per row of the copy table below, each returning a `Ping`.
- Produces, `packages/web/db/notifier.ts`: `interface Notifier { notify(memberId: string, ping: Ping): Promise<void> }`; `memberNotifier(db: Db, master: Buffer, ntfyUrl: string, send = sendPing): Notifier` (loads the member's topic, opens the token, sends; on any error it logs `ping failed: <title>` and returns); `FakeNotifier` (records `sent: { memberId, ping }[]`).
- Produces, `packages/web/lib/ntfy-admin.ts`: `interface NtfyAdmin { addUser(username: string, password: string): Promise<void>; allow(username: string, topic: string): Promise<void>; createToken(username: string, password: string): Promise<string>; deleteUser(username: string): Promise<void> }`; `ntfyAdmin(url: string, adminToken: string, fetchFn = fetch): NtfyAdmin`; `ntfyUsername(memberId: string): string` (`tm-<memberId>`); `ensureNtfy(scope: MemberScope, admin: NtfyAdmin, master: Buffer): Promise<{ topic: string }>`; `sendTestPing(scope: MemberScope, notifier: Notifier): Promise<void>`.

ntfy's admin API: `POST /v1/users {username, password}`, `PUT /v1/users/access {username, topic, permission: 'read-write'}` and `DELETE /v1/users {username}`, each with `Authorization: Bearer <NTFY_ADMIN_TOKEN>`; then `POST /v1/account/token` with Basic auth as the new user and body `{ label: 'TolongMeeting', expires: 0 }` (a token that never expires). `ensureNtfy` is idempotent: a member who has a topic gets it back; otherwise it creates the user with a random 32-byte password that is never stored, grants a new topic `tm-` plus 24 random characters from `a-z2-7`, creates the token and stores it sealed as `members.ntfy_token`. Each member's topic is readable and writable only with their own token, so workers publish with the member's token and the admin token never leaves `tm-web`.

The Notifications page calls `ensureNtfy` on load. It shows the server URL (`NTFY_URL`), the topic and, behind a "Show token" button, the token, with steps for the ntfy phone app (add a subscription on another server, with the access token) and for the desktop (the ntfy web app at `NTFY_URL` until plan 03's companion app), and a "Send a test ping" button.

Ping copy (`<when>` is `formatWhen` and `<deleteOn>` is `formatDay`, in the member's time zone; action labels are exact):

| Function                                                                | Priority | Title                             | Message                                                                                                                                            | Actions                             |
| ----------------------------------------------------------------------- | -------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `notificationsTest()`                                                   | default  | `TolongMeeting test`              | `Notifications work. Meeting pings will arrive here.`                                                                                              | none                                |
| `identityClashSaved({ loser, winner, when, identity, timetableUrl })`   | high     | `Timetable clash on <identity>`   | `<loser> at <when> overlaps <winner> on the same identity, so <loser> won't be attended. Change a time or pick another identity.`                  | `Open timetable`                    |
| `identityClashSkipped({ entry, when, winner, identity, timetableUrl })` | high     | `Skipped: <entry>`                | `<entry> at <when> overlaps <winner>, which uses the same identity (<identity>), so the bot won't attend it.`                                      | `Open timetable`                    |
| `capacityClash({ entry, when, identity, accountsUrl })`                 | high     | `Skipped: <entry> (server full)`  | `Two meetings are already running on the server, so the bot won't attend <entry> at <when>. To run it, switch the <identity> identity to your PC.` | `Open accounts`                     |
| `workerRestarted({ entry, n, meetingUrl })`                             | high     | `Restarting: <entry>`             | `The bot stopped responding and is rejoining from its last checkpoint (restart <n> of 3).`                                                         | `Open meeting page`                 |
| `workerFailed({ entry, reason, meetingUrl })`                           | high     | `Failed: <entry>`                 | `The bot stopped and won't retry (<reason>). Anything it recorded is on the meeting page.`                                                         | `Open meeting page`                 |
| `deletionSoon({ entry, when, deleteOn, meetingUrl })`                   | default  | `Deleting in 3 days: <entry>`     | `<entry> (<when>) will be deleted from the server on <deleteOn>. Export anything you want to keep before then.`                                    | `Open meeting page`                 |
| `waitingForPc({ entry, meetingUrl })`                                   | default  | `Waiting for your PC: <entry>`    | `Turn on your PC with the companion app to transcribe <entry>.`                                                                                    | `Open meeting page`                 |
| `aiKeyProblem({ entry, status, meetingUrl, aiKeysUrl })`                | high     | `Summary needs your key: <entry>` | `DashScope refused your key (<status>). Everything is kept; fix the key on the AI keys page, then press Re-run on the meeting page.`               | `Open AI keys`, `Open meeting page` |
| `pipelineFailed({ entry, meetingUrl })`                                 | high     | `Summary failed: <entry>`         | `Post-processing failed. The recording, chat and transcript are kept on the meeting page.`                                                         | `Open meeting page`                 |

`workerFailed` takes one of these reasons: `it crashed 3 times`, `it couldn't start`, `it ran past the hard stop`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/notify/src/messages.test.ts
test('capacity clash copy', () => {
  expect(
    pings.capacityClash({
      entry: 'Data Mining',
      when: 'Wed 21 Oct, 14:00',
      identity: 'University',
      accountsUrl: 'https://tm.example/accounts'
    })
  ).toEqual({
    title: 'Skipped: Data Mining (server full)',
    priority: 'high',
    message:
      "Two meetings are already running on the server, so the bot won't attend Data Mining at Wed 21 Oct, 14:00. To run it, switch the University identity to your PC.",
    actions: [{ label: 'Open accounts', url: 'https://tm.example/accounts' }]
  })
})

test.each(COPY_CASES)('%s matches the copy table', (_name, ping, expected) => expect(ping).toEqual(expected)) // one case per row of the table
```

```ts
// packages/web/lib/ntfy-admin.test.ts
test('ensureNtfy creates a user, grants one topic and stores a sealed token, once', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': { token: 'tk_test' } }) // records "METHOD path AuthScheme" and JSON bodies
  const admin = ntfyAdmin('https://ntfy.tm.example', 'tk_admin', fetchFn)
  const scope = createScope(db, memberId)
  const { topic } = await ensureNtfy(scope, admin, Buffer.alloc(32))
  expect(topic).toMatch(/^tm-[a-z2-7]{24}$/)
  expect(fetchFn.calls).toEqual([
    'POST /v1/users Bearer',
    'PUT /v1/users/access Bearer',
    'POST /v1/account/token Basic'
  ])
  expect(fetchFn.bodies[1]).toEqual({
    username: `tm-${memberId}`,
    topic,
    permission: 'read-write'
  })
  expect(fetchFn.bodies[2]).toEqual({ label: 'TolongMeeting', expires: 0 })
  const me = await scope.me()
  expect(openColumn(Buffer.alloc(32), memberId, 'members.ntfy_token', me.ntfyTokenEnc!)).toBe('tk_test')
  await ensureNtfy(scope, admin, Buffer.alloc(32))
  expect(fetchFn.calls).toHaveLength(3)
})
```

```ts
// packages/web/db/notifier.test.ts
test('notify sends with the member topic and token', async () => {
  const { db, memberId } = await withNtfy('tk_test') // seedMember plus a topic and a sealed token
  const sent: NtfyConfig[] = []
  await memberNotifier(db, Buffer.alloc(32), 'https://ntfy.tm.example', async (cfg) => {
    sent.push(cfg)
  }).notify(memberId, pings.notificationsTest())
  expect(sent[0]).toEqual({
    url: 'https://ntfy.tm.example',
    topic: expect.stringMatching(/^tm-/),
    token: 'tk_test'
  })
})

test("a failing ntfy doesn't throw and doesn't log the token", async () => {
  const { db, memberId } = await withNtfy('tk_test')
  const n = memberNotifier(db, Buffer.alloc(32), 'https://ntfy.tm.example', async () => {
    throw new Error('500 tk_test')
  })
  await expectNotLogged('tk_test', () => n.notify(memberId, pings.notificationsTest()))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/notify/src/messages.test.ts packages/web/db/notifier.test.ts packages/web/lib/ntfy-admin.test.ts`

Expected: FAIL with `Cannot find module './messages'`.

- [ ] **Step 3: Implement the copy, the notifier, the ntfy admin client and the page**

The notifier's error log names the ping title only and never prints the error, whose text can carry the token.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/notify/src/messages.test.ts packages/web/db/notifier.test.ts packages/web/lib/ntfy-admin.test.ts`

Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add packages/notify/src/messages* packages/web/db packages/web/lib/ntfy-admin* packages/web/app/notifications
git commit -m "feat(web): provision ntfy and ping copy"
```

### Task 8: AI keys page

> Non-UI parts only. The page (`app/ai-keys/page.tsx`, its copy and the `'use server'` wrappers that call `requireMember()`) is deferred at the Figma gate. Tests live in `packages/web/test/` (COMMON), not beside the sources.

**Files:**

- Create: `packages/web/db/job-config.ts`, `packages/web/lib/ai-keys.ts`, `packages/web/app/ai-keys/page.tsx`, `packages/web/app/ai-keys/actions.ts`
- Test: `packages/web/test/job-config.test.ts`, `packages/web/test/ai-keys.test.ts`

**Interfaces:**

- Consumes: `AiConfig`, `chatText`, `AiKeyError` (architecture, `packages/ai`); `sealColumn`, `openColumn`, `expectNotLogged` (Task 2); `MemberScope` (Task 4).
- Produces, `packages/web/db/job-config.ts`: `DEFAULT_MODELS = { summary: 'qwen3.7-plus', vision: 'qwen3-vl-plus', formMatch: 'qwen-flash', asr: 'qwen3-asr-flash-realtime' }`; `aiConfigFor(k: { dashscopeKey: string; workspaceId: string | null }): AiConfig`.
- Produces, `packages/web/lib/ai-keys.ts`: `MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1'`; `AiKeysInputSchema` (`dashscopeKey`: 8 to 200 characters, no whitespace; `workspaceId`: optional, `/^[A-Za-z0-9-]{3,64}$/`; `modelscopeKey`: optional, 8 to 200 characters, no whitespace); `type KeyTestResult = { ok: true } | { ok: false; error: string }`; `interface KeyTester { dashscope(cfg: AiConfig): Promise<KeyTestResult>; modelscope(key: string): Promise<KeyTestResult> }`; `keyTester(chat = chatText, fetchFn = fetch): KeyTester`; `saveAiKeys(scope: MemberScope, input: unknown, deps: { master: Buffer; tester: KeyTester; now: Date }): Promise<KeyTestResult>` (validates, seals both keys, tests, stores `test_ok`, `test_error`, `tested_at`, `modelscope_test_ok`); `testAiKeys(scope: MemberScope, deps: { master: Buffer; tester: KeyTester; now: Date }): Promise<KeyTestResult>`; `hasWorkingKey(scope: MemberScope): Promise<boolean>` (`test_ok` is true).

Endpoints: without a Workspace ID, `baseUrl` is `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` and `asrUrl` is `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime`; with Workspace ID `W`, `https://W.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` and `wss://W.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime`. The DashScope test is `chatText(cfg, 'qwen-flash', [{ role: 'user', content: 'Reply with OK.' }], 10_000)`; the ModelScope test is `GET ${MODELSCOPE_BASE_URL}/models` with `Authorization: Bearer`. Test errors come from this fixed table and never from the thrown error's text:

| Result                    | Stored `test_error`                                                               |
| ------------------------- | --------------------------------------------------------------------------------- |
| `AiKeyError` 401          | `DashScope rejected the key. Check it is a Singapore (international) region key.` |
| `AiKeyError` 402          | `The DashScope account is out of credit.`                                         |
| `AiKeyError` 429          | `DashScope is rate-limiting this key or its quota is used up.`                    |
| anything else             | `Could not reach DashScope. Try again in a minute.`                               |
| ModelScope 401 or 403     | `ModelScope rejected the key.`                                                    |
| ModelScope, anything else | `Could not reach ModelScope.`                                                     |

Page copy (exact):

- **Region**: `Use a key from Alibaba Cloud Model Studio's Singapore (international) region. Keys only work in the region they were created in, so a Beijing key is rejected.`
- **Workspace ID**: `Optional. With it, calls go to your workspace endpoint, which Alibaba recommends for production.`
- **Data use**: `Transcripts, slides and form questions are sent to Alibaba Cloud on your own key. Alibaba keeps prompts and responses for up to 30 days and doesn't use business inputs to train its models without consent (policy updated 1 October 2026).`
- **Required key**: `You can't schedule meetings until this key passes the test. Native-mode entries need it too, for summaries.`
- **ModelScope**: `Optional. Stored and tested only; it isn't used for live speech or as the only route for form matching.`

The page never shows a saved key back; it shows "Saved" with the last test time and result, and a "Test again" button.

- [x] **Step 1: Write the failing tests**

```ts
// packages/web/db/job-config.test.ts
test('AI config uses the Singapore endpoints', () => {
  expect(aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: null })).toEqual({
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-test',
    asrUrl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
    models: DEFAULT_MODELS
  })
  expect(aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: 'ws-abc123' })).toMatchObject({
    baseUrl: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    asrUrl: 'wss://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime'
  })
})
```

```ts
// packages/web/lib/ai-keys.test.ts
const ok: KeyTester = {
  dashscope: async () => ({ ok: true }),
  modelscope: async () => ({ ok: true })
}

test('a Workspace ID must be a plain identifier', () => {
  expect(
    AiKeysInputSchema.safeParse({
      dashscopeKey: 'sk-test-1234',
      workspaceId: 'evil.example/x'
    }).success
  ).toBe(false)
})

test('saving seals the key and records a passing test', async () => {
  const { db, memberId } = await seedBare() // seedMember(full: false) without an ai_keys row
  const scope = createScope(db, memberId)
  expect(
    await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234' }, { master: Buffer.alloc(32), tester: ok, now })
  ).toEqual({ ok: true })
  const [row] = await scope.select(aiKeys)
  expect(row.dashscopeKeyEnc).toMatch(/^v1\./)
  expect(row.dashscopeKeyEnc).not.toContain('sk-test-1234')
  expect(await hasWorkingKey(scope)).toBe(true)
})

test('a rejected key is recorded with the region hint', async () => {
  const { db, memberId } = await seedBare()
  const scope = createScope(db, memberId)
  const tester = keyTester(async () => {
    throw keyError(401)
  }) // keyError(n): an AiKeyError with status n
  const r = await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234' }, { master: Buffer.alloc(32), tester, now })
  expect(r).toEqual({
    ok: false,
    error: 'DashScope rejected the key. Check it is a Singapore (international) region key.'
  })
  expect(await hasWorkingKey(scope)).toBe(false)
})

test('the key is never logged', async () => {
  const { db, memberId } = await seedBare()
  const tester = keyTester(async () => {
    throw new Error('boom sk-secret-123456')
  })
  await expectNotLogged('sk-secret-123456', () =>
    saveAiKeys(
      createScope(db, memberId),
      { dashscopeKey: 'sk-secret-123456' },
      { master: Buffer.alloc(32), tester, now }
    )
  )
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/db/job-config.test.ts packages/web/lib/ai-keys.test.ts`

Expected: FAIL with `Cannot find module './job-config'`.

- [ ] **Step 3: Implement `aiConfigFor`, the key functions and the page**

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/db/job-config.test.ts packages/web/lib/ai-keys.test.ts`

Expected: PASS, `5 pass, 0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/web/db/job-config* packages/web/lib/ai-keys* packages/web/app/ai-keys
git commit -m "feat(web): add AI keys page"
```

### Task 9: Accounts and My details pages

**Files:**

- Create: `packages/web/lib/identities.ts`, `packages/web/lib/details.ts`, `packages/web/app/accounts/page.tsx`, `packages/web/app/accounts/actions.ts`, `packages/web/app/details/page.tsx`, `packages/web/app/details/actions.ts`
- Test: `packages/web/lib/identities.test.ts`, `packages/web/lib/details.test.ts`

**Deferred (Figma gate):** the two pages (`app/accounts/page.tsx`, `app/details/page.tsx`) and their markup wait for an approved design in Figma (`DESIGN.md` first). Step 3 stays open until they land. The actions files are plain functions until `requireMember()` (Task 5) exists. Tests live in `packages/web/test/` (COMMON.md), not beside the modules.

**Interfaces:**

- Consumes: `MemberScope` (Task 4); `ACCOUNT_KINDS`, `AccountKind` (Task 1); `SavedDetail`, `RunLocation` (architecture).
- Produces, `packages/web/lib/identities.ts`: `IdentityInputSchema` (`name` 1 to 40 characters; `runLocation: RunLocation`, refined to `'server'` with the message `Only "Server" is available until run locations are added.`; `zoomGuestName` 1 to 64 characters); `createIdentity(scope: MemberScope, input: unknown): Promise<IdentityRow>` (also creates its `profiles` row); `updateIdentity(scope: MemberScope, id: string, input: unknown): Promise<void>`; `deleteIdentity(scope: MemberScope, id: string): Promise<void>` (throws `InUseError('This identity has timetable entries.')` or `InUseError('This identity is in use by a meeting or a sign-in.')` when `profiles.held_by` is set); `accountStatus(scope: MemberScope, identityId: string): Promise<{ kind: AccountKind; label: string; verifiedAt: string | null; signedIn: boolean | null }[]>` (in `ACCOUNT_KINDS` order, labels `Zoom`, `Microsoft`, `Google`, `WhatsApp Web`, `Discord`, `Teams`); `class InUseError extends Error`.
- Produces, `packages/web/lib/details.ts`: `BUILTIN_DETAILS = [{ key: 'full_name', label: 'Full name as registered' }, { key: 'student_id', label: 'Student ID' }, { key: 'university_email', label: 'University email' }, { key: 'programme', label: 'Programme' }]`; `DetailsInputSchema` (`details`: array of `{ key: /^[a-z0-9_]{1,40}$/, value: 1 to 200 characters, labels: at most 10, each 1 to 120 characters, unique ignoring case }` with unique keys, and `university_email`'s value an email address; `mentionNames`: at most 20, each 1 to 60 characters, unique ignoring case); `saveDetails(scope: MemberScope, input: unknown): Promise<void>` (replaces all `details` and `mention_names` rows in one transaction, `position` in input order); `loadDetails(scope: MemberScope): Promise<{ details: SavedDetail[]; mentionNames: string[] }>`.

The Accounts page lists the member's identities, each with its settings form (run location select showing all three locations with the two non-server ones disabled and labelled "available later", Zoom guest display name defaulting to the member's display name), its account status, and a "Sign in" button that opens `/accounts/<identityId>/signin` (Task 18). The My details page shows the four built-in values first, then custom pairs, each with editable label variants, then the names the member answers to.

- [x] **Step 1: Write the failing tests**

```ts
// packages/web/lib/identities.test.ts
test('creating an identity creates its profile', async () => {
  const { scope } = await bare() // createScope over seedMember(full: false)
  const id = await createIdentity(scope, {
    name: 'Work',
    runLocation: 'server',
    zoomGuestName: 'A Member'
  })
  expect(await scope.select(profiles, eq(profiles.identityId, id.id))).toHaveLength(1)
})

test('only the server run location is accepted for now', () => {
  expect(
    IdentityInputSchema.safeParse({
      name: 'Home',
      runLocation: 'local',
      zoomGuestName: 'A'
    }).error?.issues[0].message
  ).toBe('Only "Server" is available until run locations are added.')
})

test("an identity in use can't be deleted", async () => {
  const { scope, identityId } = await bare()
  await scope.update(profiles, { heldBy: 'occ:x' }, eq(profiles.identityId, identityId))
  await expect(deleteIdentity(scope, identityId)).rejects.toThrow('This identity is in use by a meeting or a sign-in.')
})

test('account status lists every account in order', async () => {
  const { scope, identityId } = await bare()
  await scope.update(
    profiles,
    {
      accountStatus: {
        zoom: { verifiedAt: '2026-10-21T05:01:00Z', signedIn: true }
      }
    },
    eq(profiles.identityId, identityId)
  )
  const s = await accountStatus(scope, identityId)
  expect(s.map((x) => x.label)).toEqual(['Zoom', 'Microsoft', 'Google', 'WhatsApp Web', 'Discord', 'Teams'])
  expect(s[0]).toEqual({
    kind: 'zoom',
    label: 'Zoom',
    verifiedAt: '2026-10-21T05:01:00Z',
    signedIn: true
  })
  expect(s[1].verifiedAt).toBeNull()
})
```

```ts
// packages/web/lib/details.test.ts
test('details and mention names round-trip with label variants', async () => {
  const { scope } = await bare()
  await saveDetails(scope, {
    details: [
      {
        key: 'student_id',
        value: 'S0000000',
        labels: ['Matric No.', 'No. Matrik']
      }
    ],
    mentionNames: ['Short Name', 'S0000000']
  })
  expect(await loadDetails(scope)).toEqual({
    details: [
      {
        key: 'student_id',
        value: 'S0000000',
        labels: ['Matric No.', 'No. Matrik']
      }
    ],
    mentionNames: ['Short Name', 'S0000000']
  })
})

test('duplicate labels and a malformed university email are refused', () => {
  expect(
    DetailsInputSchema.safeParse({
      details: [
        {
          key: 'student_id',
          value: 'S1',
          labels: ['Matric No.', 'matric no.']
        }
      ],
      mentionNames: []
    }).success
  ).toBe(false)
  expect(
    DetailsInputSchema.safeParse({
      details: [{ key: 'university_email', value: 'not-an-email', labels: [] }],
      mentionNames: []
    }).success
  ).toBe(false)
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/identities.test.ts packages/web/lib/details.test.ts`

Expected: FAIL with `Cannot find module './identities'`.

- [ ] **Step 3: Implement the two modules and the two pages**

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/identities.test.ts packages/web/lib/details.test.ts && bun run typecheck`

Expected: PASS, `6 pass, 0 fail`; typecheck exits 0.

- [x] **Step 5: Commit**

```bash
git add packages/web/lib/identities* packages/web/lib/details* packages/web/app/accounts packages/web/app/details
git commit -m "feat(web): add accounts and details pages"
```

### Task 10: Timetable page

**Files:**

- Create: `packages/web/lib/timetable.ts`, `packages/web/lib/queue.ts`, `packages/web/app/timetable/page.tsx`, `packages/web/app/timetable/[id]/page.tsx`, `packages/web/app/timetable/actions.ts`
- Test: `packages/web/lib/timetable.test.ts`

**Interfaces:**

- Consumes: `RepeatRuleSchema`, `formatWhen` (Task 6); `Queue`, `QUEUES` (Task 6); `MemberScope.syncOccurrences`, `MemberScope.identityClashes` (Task 6); `Notifier`, `pings.identityClashSaved`, `ensureNtfy` (Task 7); `hasWorkingKey` (Task 8); `InUseError` (Task 9); `ACTIVE_STATES` (Task 3); `LinkSource` (architecture).
- Produces: `getQueue(): Promise<Queue>` in `packages/web/lib/queue.ts` (a send-only pg-boss instance with `supervise: false` and `schedule: false`); `EntryInputSchema` (fields below); `class NoWorkingKeyError extends Error` (message `Add a working DashScope key on the AI keys page before scheduling meetings.`); `saveEntry(scope: MemberScope, input: unknown, deps: EntryDeps): Promise<{ entryId: string; clashes: { loser: string; winner: string; when: string }[] }>`; `setPaused(scope: MemberScope, entryId: string, paused: boolean, deps: EntryDeps): Promise<void>`; `deleteEntry(scope: MemberScope, entryId: string, deps: EntryDeps): Promise<void>`; `type EntryDeps = { queue: Queue; notifier: Notifier; ensureNtfy: () => Promise<void>; now: Date; publicUrl: string }`; `RECORDING_NOTICE`, `EMPLOYER_NOTICE`.

`EntryInputSchema`, the design's timetable fields exactly:

- `id`: optional uuid (absent when creating);
- `name`: 1 to 100 characters;
- `type`: `'lecture' | 'work'`;
- `repeat`: `RepeatRule` (one-off date, or weekly days from a date);
- `start`, `end`: `HH:MM` in the member's time zone;
- `identityId`: one of the member's identities (which sets where it runs);
- `link`: `LinkSource`; `fixed` needs an `https:` URL; `chat` is checked by `ChatLinkSchema` (Discord: `https://discord.com/channels/...`; Teams: `https://teams.microsoft.com/...`; WhatsApp: an exact chat name of 1 to 100 characters) and then refused in 1C with `Watching a chat arrives with link watchers.` (plan 02 removes this refinement and adds its ban-risk notice); `paste` means "I'll paste it";
- `trustedSenders`: up to 10 display names of 1 to 100 characters (lectures only);
- `transcription`: `'live' | 'native'`, defaulting to `live` for lectures and `native` for work meetings;
- `formDetails`: `{ course_code?: string; section?: string; lecturer?: string }`, each 1 to 100 characters (lectures only);
- `attendanceKeywords`: up to 20 words of 1 to 60 characters (lectures only);
- `paused`: boolean, default false.

For `type: 'work'` the schema empties `trustedSenders`, `formDetails` and `attendanceKeywords`, and the form hides them. Notices (exact):

- `RECORDING_NOTICE` (shown on the create form): `TolongMeeting records this meeting, including other participants' names and messages, and keeps it for 30 days. Check that recording and automated attendance are allowed here; that's your responsibility.`
- `EMPLOYER_NOTICE` (shown for work meetings, next to the transcription choice): `Live transcription sends the meeting audio to Alibaba Cloud on your key. Check that your employer allows cloud AI processing of work meetings before choosing it.`

`saveEntry` checks `hasWorkingKey` (else `NoWorkingKeyError`), runs `deps.ensureNtfy()`, checks that the identity is the member's (else a not-found error), writes the entry, calls `scope.syncOccurrences(deps.queue, deps.now)`, then looks for clashes on that identity over the next 14 days. If any involve this entry's occurrences, it sends one `pings.identityClashSaved` (the first clash) and returns all of them for the form to show. `deleteEntry` throws `InUseError('This entry has a meeting in progress.')` while one of its occurrences is in `ACTIVE_STATES`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/timetable.test.ts
const base = {
  name: 'Data Mining',
  type: 'lecture',
  repeat: { kind: 'weekly', days: [3], from: '2026-10-01' },
  start: '14:00',
  end: '16:00',
  link: {
    kind: 'fixed',
    url: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
  },
  trustedSenders: ['Lecturer Name'],
  formDetails: {
    course_code: 'ABC1234',
    section: '1',
    lecturer: 'Lecturer Name'
  },
  attendanceKeywords: ['kehadiran']
}

test('lectures default to live and work meetings to native, without lecture-only fields', () => {
  expect(EntryInputSchema.parse({ ...base, identityId: ID }).transcription).toBe('live')
  expect(EntryInputSchema.parse({ ...base, identityId: ID, type: 'work' })).toMatchObject({
    transcription: 'native',
    trustedSenders: [],
    formDetails: {},
    attendanceKeywords: []
  })
})

test('a chat link source is refused until link watchers exist', () => {
  const r = EntryInputSchema.safeParse({
    ...base,
    identityId: ID,
    link: { kind: 'chat', app: 'whatsapp', chat: 'Class group' }
  })
  expect(r.error?.issues[0].message).toBe('Watching a chat arrives with link watchers.')
  expect(ChatLinkSchema.safeParse({ kind: 'chat', app: 'discord', chat: 'general' }).success).toBe(false)
  expect(
    ChatLinkSchema.safeParse({
      kind: 'chat',
      app: 'whatsapp',
      chat: 'Class group'
    }).success
  ).toBe(true)
})

test('saving needs a working AI key', async () => {
  const { scope, identityId, deps } = await withoutKey()
  await expect(saveEntry(scope, { ...base, identityId }, deps)).rejects.toThrow(NoWorkingKeyError)
})

test('a clashing entry is saved, pinged once and reported', async () => {
  const { scope, identityId, deps } = await bareWithDeps() // working key, FakeQueue, FakeNotifier, now 2026-10-20T00:00Z
  await saveEntry(scope, { ...base, identityId }, deps)
  const r = await saveEntry(scope, { ...base, name: 'Statistics', identityId, start: '15:00', end: '17:00' }, deps)
  expect(r.clashes[0]).toEqual({
    loser: 'Statistics',
    winner: 'Data Mining',
    when: 'Wed 21 Oct, 15:00'
  })
  expect(deps.notifier.sent.map((s) => s.ping.title)).toEqual(['Timetable clash on University'])
})

test("an entry with a meeting in progress can't be deleted", async () => {
  const { scope, identityId, deps } = await bareWithDeps()
  const { entryId } = await saveEntry(scope, { ...base, identityId }, deps)
  await scope.update(occurrences, { state: 'in_meeting' }, eq(occurrences.entryId, entryId))
  await expect(deleteEntry(scope, entryId, deps)).rejects.toThrow('This entry has a meeting in progress.')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/timetable.test.ts`

Expected: FAIL with `Cannot find module './timetable'`.

- [ ] **Step 3: Implement the schema, the actions, the queue helper and the pages**

The list page shows each entry with its next occurrence (`formatWhen`), its identity and a pause toggle; the edit page is one form over `EntryInputSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/timetable.test.ts && bun run typecheck`

Expected: PASS, `5 pass, 0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/timetable* packages/web/lib/queue.ts packages/web/app/timetable
git commit -m "feat(web): add timetable page"
```

### Task 11: Home and Admin pages

**Files:**

- Create: `packages/web/lib/home.ts`, `packages/web/lib/admin.ts`, `packages/web/app/layout.tsx`, `packages/web/app/page.tsx`, `packages/web/app/admin/page.tsx`, `packages/web/app/admin/actions.ts`
- Modify: `packages/web/lib/scope.ts` (`adminScope`)
- Test: `packages/web/lib/home.test.ts`, `packages/web/lib/admin.test.ts`

**Interfaces:**

- Consumes: `MemberScope` (Task 4); `requireMember`, `requireAdmin` (Task 5); `ACTIVE_STATES` (Task 3); `NtfyAdmin`, `ntfyUsername` (Task 7); `hasWorkingKey` (Task 8).
- Produces: `homeData(scope: MemberScope, now: Date): Promise<HomeData>`, where `HomeData = { upcoming: OccurrenceCard[]; inProgress: OccurrenceCard[]; recent: (OccurrenceCard & { doNext: string | null })[]; warnings: HomeWarning[]; deletingSoon: OccurrenceCard[] }`, `OccurrenceCard = { id: string; name: string; when: string; state: OccurrenceState }` and `HomeWarning = { kind: 'no_ai_key' | 'ai_key_failing' | 'ntfy_not_set_up' | 'account_signed_out'; identity?: string; account?: AccountKind }`.
- Produces: `adminScope(db: Db = getDb()): AdminScope` with `listMembers(): Promise<{ id: string; githubLogin: string; displayName: string; role: 'member' | 'admin'; timeZone: string; createdAt: Date }[]>`, `addMember(input: { githubLogin: string; displayName: string; timeZone: string; role: 'member' | 'admin' }): Promise<string>`, `setRole(id: string, role: 'member' | 'admin'): Promise<void>`, `removeMember(id: string, ntfy: NtfyAdmin): Promise<void>`; `class MemberBusyError extends Error`; `class LastAdminError extends Error`.

`homeData` rules: `upcoming` is `scheduled` occurrences in the next 14 days, earliest first, at most 10; `inProgress` is occurrences in `ACTIVE_STATES` or in `transcribing`, `waiting_for_pc` or `post_processing`, with their state; `recent` is the last 5 `completed` occurrences with a summary artefact, and `doNext` is the first line of that file starting with `Do next:`; `deletingSoon` is non-deleted occurrences outside `ACTIVE_STATES` whose `delete_after` is within 3 days; `warnings` lists a missing or failing AI key, a missing ntfy topic, and every profile account whose status has `signedIn: false`. The layout's navigation links Home, Timetable, Accounts, My details, Notifications, AI keys, and Admin for admins.

`removeMember` throws `MemberBusyError` while one of the member's occurrences is in `ACTIVE_STATES` or a sign-in session isn't ended, and `LastAdminError` for the last admin (so does `setRole` when it would demote the last admin). Otherwise it deletes the member's ntfy user (`ntfyUsername`), then the member row, which cascades to all their rows; their files on disk go in the next retention run (Task 20 removes directories without a database row). The admin page lists members with exactly the columns of `listMembers` and has add, role and remove controls; it never reads member-owned tables.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/home.test.ts
test('home groups upcoming, running, recent and expiring meetings', async () => {
  const { scope, ids } = await homeFixture() // occurrences: scheduled 2026-10-21T06:00Z, in_meeting, completed with a summary file whose third line is "Do next: Submit lab 3 (due Fri 23 Oct, 23:59)", completed with delete_after 2026-10-22T00:00Z; a profile with zoom signedIn false; no ntfy topic
  const h = await homeData(scope, new Date('2026-10-20T00:00:00Z'))
  expect(h.upcoming.map((o) => o.when)).toEqual(['Wed 21 Oct, 14:00'])
  expect(h.inProgress.map((o) => o.state)).toEqual(['in_meeting'])
  expect(h.recent[0].doNext).toBe('Do next: Submit lab 3 (due Fri 23 Oct, 23:59)')
  expect(h.deletingSoon.map((o) => o.id)).toEqual([ids.expiring])
  expect(h.warnings).toEqual(
    expect.arrayContaining([
      { kind: 'ntfy_not_set_up' },
      { kind: 'account_signed_out', identity: 'University', account: 'zoom' }
    ])
  )
})
```

```ts
// packages/web/lib/admin.test.ts
test("admins list members without the members' data", async () => {
  const db = await createTestDb()
  await seedMember(db)
  const [m] = await adminScope(db).listMembers()
  expect(Object.keys(m).sort()).toEqual(['createdAt', 'displayName', 'githubLogin', 'id', 'role', 'timeZone'])
})

test("a member with a meeting in progress can't be removed", async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  await db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, a.ids.occurrences))
  await expect(adminScope(db).removeMember(a.memberId, fakeNtfyAdmin())).rejects.toThrow(MemberBusyError)
})

test('removing a member deletes their rows and their ntfy user', async () => {
  const db = await createTestDb()
  await seedMember(db, { role: 'admin' })
  const a = await seedMember(db)
  const ntfy = fakeNtfyAdmin()
  await adminScope(db).removeMember(a.memberId, ntfy)
  expect(ntfy.deleted).toEqual([`tm-${a.memberId}`])
  expect(await db.$count(occurrences, eq(occurrences.memberId, a.memberId))).toBe(0)
})

test("the last admin can't be removed or demoted", async () => {
  const db = await createTestDb()
  const admin = await seedMember(db, { role: 'admin' })
  await expect(adminScope(db).removeMember(admin.memberId, fakeNtfyAdmin())).rejects.toThrow(LastAdminError)
  await expect(adminScope(db).setRole(admin.memberId, 'member')).rejects.toThrow(LastAdminError)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/home.test.ts packages/web/lib/admin.test.ts`

Expected: FAIL with `Cannot find module './home'`.

- [ ] **Step 3: Implement `homeData`, `adminScope`, the layout and the two pages**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/home.test.ts packages/web/lib/admin.test.ts && bun run typecheck`

Expected: PASS, `5 pass, 0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/home* packages/web/lib/admin* packages/web/lib/scope.ts packages/web/app/layout.tsx packages/web/app/page.tsx packages/web/app/admin
git commit -m "feat(web): add home and admin pages"
```

### Task 12: Meeting page

**Files:**

- Create: `packages/web/lib/meeting.ts`, `packages/web/lib/files.ts`, `packages/web/app/meetings/[id]/page.tsx`, `packages/web/app/meetings/[id]/actions.ts`, `packages/web/app/meetings/[id]/player.tsx`, `packages/web/app/api/meetings/[id]/files/[...path]/route.ts`
- Test: `packages/web/lib/meeting.test.ts`, `packages/web/lib/files.test.ts`

**Interfaces:**

- Consumes: `MemberScope` (Task 4); `ACTIVE_STATES`, `WORKER_STATES` (Task 3); `Queue`, `QUEUES` (Task 6); `InUseError` (Task 9); the data directory layout (architecture); `slides/slides.json` as written by 1A's pipeline (one entry per slide: number, image path, text).
- Produces: `meetingData(scope: MemberScope, occurrenceId: string): Promise<MeetingView | null>`, where `MeetingView = { occurrence: OccurrenceCard & { stateReason: string | null; transcription: TranscriptionMode }; summaryMd: string | null; forms: FormView[]; transcript: TranscriptLine[]; slides: { n: number; imageUrl: string; text: string }[]; chatMd: string | null; events: { at: string; type: EventType; data: Record<string, unknown> }[]; videoUrl: string | null }` and `FormView = { seenAt: string; source: FormSource; sender: string | null; trustReason: TrustReason | null; fieldsFilled: string[]; state: FormState; result: string | null; screenshotUrls: string[] }`; `parseTranscript(md: string): TranscriptLine[]` with `TranscriptLine = { seconds: number | null; text: string }`; `serveFile(absPath: string, range: string | null): Promise<Response>`; actions `makeBotLeave(scope: MemberScope, id: string): Promise<void>`, `pasteLink(scope: MemberScope, id: string, url: string): Promise<void>`, `requestDeleteNow(scope: MemberScope, id: string, queue: Queue): Promise<void>`, `rerunPipeline(scope: MemberScope, id: string, queue: Queue): Promise<void>`.

File URLs are `/api/meetings/<id>/files/<relPath>`; the route resolves them only through `scope.artefactFile` and answers 404 otherwise. `serveFile` sets `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes` and the content type from the extension, and answers `Range: bytes=a-b` with 206 and `Content-Range`, or 416 with `Content-Range: bytes */<size>`. Screenshots of a form are its `form_screenshot` artefacts under `forms/<form_key>/`. The page shows, top to bottom: the summary; the attendance record; the video (`recording/meeting.mp4`) beside the transcript, whose timestamps seek the video (`player.tsx`, a client component); slides; chat; the event log; and the actions.

Action rules: `makeBotLeave` appends `leave_now` to `pending_commands` only while the occurrence is in `ACTIVE_STATES`, else `InUseError('The bot is not in this meeting.')`; `pasteLink` needs an `https:` URL and a state of `scheduled`, `starting`, `verifying_accounts`, `waiting_for_signin` or `watching_for_link`, and sets `pasted_link`; `requestDeleteNow` throws `InUseError('Make the bot leave before deleting this meeting.')` in `ACTIVE_STATES`, and otherwise sets `state_reason` to `deleting` and sends `delete-occurrence` with `{ occurrenceId }` (the scheduler deletes, Task 20); `rerunPipeline` works only in `post_processing` with `state_reason` `ai_key_error`, and sends `pipeline` with `{ occurrenceId }`. Export buttons are plan 07's.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/meeting.test.ts
test('transcript timestamps become seconds; notes keep no time', () => {
  expect(
    parseTranscript(
      '[00:01:05] Good evening, everyone.\n\n_Recording gap: 00:20:00 to 00:21:30_\n[01:02:03] Next slide.'
    )
  ).toEqual([
    { seconds: 65, text: 'Good evening, everyone.' },
    { seconds: null, text: '_Recording gap: 00:20:00 to 00:21:30_' },
    { seconds: 3723, text: 'Next slide.' }
  ])
})

test("another member's meeting is not found", async () => {
  const { db, a, b } = await twoMembers()
  expect(await meetingData(createScope(db, b.memberId), a.ids.occurrences)).toBeNull()
})

test('the attendance record shows each form with its own screenshots', async () => {
  const { scope, occurrenceId } = await meetingFixture() // forms f1 (submitted) and f2 (untrusted); artefacts forms/f1/filled.png and forms/f1/confirmation.png
  const v = await meetingData(scope, occurrenceId)
  expect(v!.forms.map((f) => [f.state, f.screenshotUrls.length])).toEqual([
    ['submitted', 2],
    ['untrusted', 0]
  ])
})

test('actions follow the occurrence state', async () => {
  const { scope, occurrenceId, queue } = await meetingFixture()
  await scope.update(occurrences, { state: 'in_meeting' }, eq(occurrences.id, occurrenceId))
  await makeBotLeave(scope, occurrenceId)
  await expect(pasteLink(scope, occurrenceId, 'https://example.zoom.us/j/00000000000')).rejects.toThrow()
  await expect(requestDeleteNow(scope, occurrenceId, queue)).rejects.toThrow(
    'Make the bot leave before deleting this meeting.'
  )
  const [o] = await scope.select(occurrences, eq(occurrences.id, occurrenceId))
  expect(o.pendingCommands).toEqual(['leave_now'])
  await scope.update(occurrences, { state: 'completed' }, eq(occurrences.id, occurrenceId))
  await requestDeleteNow(scope, occurrenceId, queue)
  expect(queue.sent).toEqual([{ name: 'delete-occurrence', data: { occurrenceId }, opts: undefined }])
})
```

```ts
// packages/web/lib/files.test.ts
test('a range request returns 206 with the slice', async () => {
  const p = join(tmpdir(), 'v.mp4')
  await Bun.write(p, new Uint8Array(1000))
  const r = await serveFile(p, 'bytes=0-99')
  expect(r.status).toBe(206)
  expect(r.headers.get('content-range')).toBe('bytes 0-99/1000')
  expect(r.headers.get('cache-control')).toBe('private, no-store')
  expect((await r.arrayBuffer()).byteLength).toBe(100)
})

test('no range returns the whole file; a bad range returns 416', async () => {
  const p = join(tmpdir(), 'v.mp4')
  await Bun.write(p, new Uint8Array(1000))
  expect((await serveFile(p, null)).status).toBe(200)
  const bad = await serveFile(p, 'bytes=2000-')
  expect([bad.status, bad.headers.get('content-range')]).toEqual([416, 'bytes */1000'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/meeting.test.ts packages/web/lib/files.test.ts`

Expected: FAIL with `Cannot find module './meeting'`.

- [ ] **Step 3: Implement the loader, the file server, the actions, the route and the page**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/meeting.test.ts packages/web/lib/files.test.ts && bun run typecheck`

Expected: PASS, `6 pass, 0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web/lib/meeting* packages/web/lib/files* packages/web/app/meetings packages/web/app/api/meetings
git commit -m "feat(web): add meeting page"
```

### Task 13: Docker socket gate

**Files:**

- Create: `packages/scheduler/src/container-spec.ts`, `packages/scheduler/src/docker-gate/validate.ts`, `packages/scheduler/src/docker-gate/main.ts`
- Modify: `packages/core/src/control.ts` (`SpecEnv`)
- Test: `packages/scheduler/test/container-spec.test.ts`, `packages/scheduler/test/docker-gate-validate.test.ts`, `packages/scheduler/test/docker-gate.test.ts`

The design asks the proxy to block privileged mode, other images and other mounts. `tecnativa/docker-socket-proxy` filters by endpoint only and can't read request bodies, so 1C runs this small gate as the compose service `docker-proxy` instead.

**Interfaces:**

- Produces (adds to contracts): `type SpecEnv = { dataRoot: string; profileRoot: string; publicUrl: string; ntfyUrl: string }` in `packages/core/src/control.ts` (shared by the scheduler, `packages/web/db` and the pipeline); `WORKER_IMAGE = 'tolongmeeting/worker:current'`; `WORKER_NETWORK = 'tm-workers'`; `CADDY_WORKER_IP = '172.30.0.2'`; `containerSpec(p: SpecParams): CreateBody`, where `SpecParams = { kind: 'worker'; occurrenceId: string; attempt: number; identityId: string; env: SpecEnv } | { kind: 'signin'; sessionId: string; identityId: string; env: SpecEnv }`; `containerName(p: SpecParams): string` (`tm-worker-<occurrenceId>-a<attempt>` or `tm-signin-<sessionId>`); `jobFileBase(p: SpecParams): string` (`<profileRoot>/<identityId>/job/<containerName>`).
- Produces: `validateRequest(r: { method: string; path: string; body: unknown }, cfg: GateConfig /* = SpecEnv */): { ok: true; kind: 'ping' | 'create' | 'start' | 'stop' | 'inspect'; id?: string } | { ok: false; reason: string }`; `main.ts` serves `:2375` through `serveGate` (`Bun.serve` with `maxRequestBodySize` 65536, `development` false and an error handler that answers a bare 502 when Docker is unreachable or inspect JSON is bad), forwards allowed requests to `/var/run/docker.sock` (`fetch(..., { unix })`), and before `start`, `stop` or `inspect` inspects the target itself and refuses any container unless `tm.role` is `worker` or `signin`, `Config.Image` is `WORKER_IMAGE`, `HostConfig.Privileged` is not true and its name matches the role's name pattern; it then acts on the full id and sends no client body. The gate reads `TM_DATA_ROOT`, `TM_PROFILE_ROOT`, `TM_PUBLIC_URL` and `NTFY_URL`.

The worker body (`<...>` are filled from `SpecParams`; the sign-in body differs only as noted after it):

```json
{
  "Image": "tolongmeeting/worker:current",
  "Cmd": ["--job", "<profileRoot>/<identityId>/job/<name>.json"],
  "Env": [
    "TM_DATA_ROOT=<dataRoot>",
    "TM_PROFILE_ROOT=<profileRoot>",
    "TM_PROFILE_KEY_FILE=<profileRoot>/<identityId>/job/<name>.key",
    "TM_PUBLIC_URL=<publicUrl>"
  ],
  "Labels": {
    "tm.role": "worker",
    "tm.occurrence": "<occurrenceId>",
    "tm.attempt": "<attempt>"
  },
  "HostConfig": {
    "Binds": [
      "<dataRoot>/occurrences/<occurrenceId>:<dataRoot>/occurrences/<occurrenceId>",
      "<profileRoot>/<identityId>:<profileRoot>/<identityId>",
      "<profileRoot>/.machine-ids/<identityId>:/etc/machine-id:ro"
    ],
    "ShmSize": 2147483648,
    "NetworkMode": "tm-workers",
    "Dns": ["1.1.1.1", "8.8.8.8"],
    "ExtraHosts": ["<host of publicUrl>:172.30.0.2", "<host of ntfyUrl>:172.30.0.2"],
    "Sysctls": { "net.ipv6.conf.all.disable_ipv6": "1" },
    "Memory": 5368709120,
    "NanoCpus": 3500000000,
    "AutoRemove": true
  }
}
```

The machine-id file sits in `<profileRoot>/.machine-ids/`, a tree no container mounts, so a compromised container can't plant a symlink there for the next launch to bind-mount; Task 14's launcher must `lstat` it before every create and require a regular file with link count 1, else recreate it (temp file in that directory, `chmod 644`, `mv -f`; directory mode 755). The sign-in body uses `"Cmd": ["--signin", "<profileRoot>/<identityId>/job/<name>.json"]`, labels `tm.role: signin` and `tm.session`, no `TM_DATA_ROOT` and only the profile bind, with `Memory` 2147483648 and `NanoCpus` 1000000000. Binds keep host paths inside the container, so `JobConfig.dataDir` and `profileDir` are the host paths (`<dataRoot>/occurrences/<occurrenceId>` and `<profileRoot>/<identityId>/work`), as in architecture's layout. `Memory` and `NanoCpus` follow spike 6's report.

Gate rules: paths may carry a `/v1.41` to `/v1.51` prefix (any other version is refused). Allowed: `GET /_ping`; `POST /containers/create?name=<name>`; `POST /containers/<id>/start`; `POST /containers/<id>/stop` (optional `?t=N`); `GET /containers/<id>/json`. Anything else gets 403 with `endpoint not allowed`. A create body must have only the keys `Image`, `Cmd`, `Env`, `Labels`, `HostConfig`; `Image` equal to `WORKER_IMAGE`; a role label of `worker` or `signin` that agrees with the name pattern and with `Cmd[0]`; `Cmd[1]` under `<profileRoot>/<uuid>/job/`; `Env` names only from the four above; `HostConfig` keys only from the body above, with `Binds` exactly the role's binds (source equals target, uuids only, no options), `NetworkMode` `tm-workers`, `ShmSize` 2147483648, `Dns` as above, and `Sysctls` exactly the IPv6 one. The gate rebuilds the whole body from its own `GateConfig` (roots, `publicUrl`, `ntfyUrl`) and the name, and the request must equal it: `TM_PUBLIC_URL`, `ExtraHosts` and every other value are not free.

- [x] **Step 1: Write the failing tests**

```ts
// packages/scheduler/src/docker-gate/validate.test.ts
const cfg = {
  dataRoot: '/srv/tolongmeeting/data',
  profileRoot: '/srv/tolongmeeting/profiles'
}
const env = {
  ...cfg,
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example'
}
const occ = '11111111-1111-4111-8111-111111111111'
const idn = '22222222-2222-4222-8222-222222222222'
const spec = {
  kind: 'worker',
  occurrenceId: occ,
  attempt: 1,
  identityId: idn,
  env
} as const
const create = (body: unknown) =>
  validateRequest(
    {
      method: 'POST',
      path: `/v1.47/containers/create?name=${containerName(spec)}`,
      body
    },
    cfg
  )

test('the fixed worker and sign-in specs pass', () => {
  expect(create(containerSpec(spec))).toEqual({ ok: true, kind: 'create' })
  const s = { kind: 'signin', sessionId: occ, identityId: idn, env } as const
  expect(
    validateRequest(
      {
        method: 'POST',
        path: `/containers/create?name=${containerName(s)}`,
        body: containerSpec(s)
      },
      cfg
    )
  ).toEqual({ ok: true, kind: 'create' })
})

test.each([
  ['privileged', (b: any) => (b.HostConfig.Privileged = true)],
  ['another image', (b: any) => (b.Image = 'alpine')],
  ['an extra bind', (b: any) => b.HostConfig.Binds.push('/:/host')],
  ['a bind outside the roots', (b: any) => (b.HostConfig.Binds[0] = '/etc:/etc')],
  ['added capabilities', (b: any) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
  ['the host network', (b: any) => (b.HostConfig.NetworkMode = 'host')],
  ['a device', (b: any) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }])],
  ['a secret in the environment', (b: any) => b.Env.push('TM_MASTER_KEY_FILE=/run/secrets/tm_master_key')],
  ['a smaller shm', (b: any) => (b.HostConfig.ShmSize = 67108864)]
])('a create with %s is refused', (_n, mutate) => {
  const b = structuredClone(containerSpec(spec))
  mutate(b)
  expect(create(b).ok).toBe(false)
})

test.each([
  ['POST', `/containers/${occ}/exec`],
  ['GET', `/containers/${occ}/archive`],
  ['PUT', `/containers/${occ}/archive`],
  ['DELETE', `/containers/${occ}`],
  ['POST', '/images/create'],
  ['POST', '/build'],
  ['GET', '/containers/json']
])('%s %s is refused', (method, path) => {
  expect(validateRequest({ method, path, body: null }, cfg)).toEqual({
    ok: false,
    reason: 'endpoint not allowed'
  })
})
```

```ts
// packages/scheduler/src/container-spec.test.ts
test('the worker spec keeps host paths, the shm size and no secrets in its environment', () => {
  const b = containerSpec(spec)
  expect(b.HostConfig.Binds).toEqual([
    `/srv/tolongmeeting/data/occurrences/${occ}:/srv/tolongmeeting/data/occurrences/${occ}`,
    `/srv/tolongmeeting/profiles/${idn}:/srv/tolongmeeting/profiles/${idn}`
  ])
  expect(b.HostConfig.ShmSize).toBe(2147483648)
  expect(b.HostConfig.ExtraHosts).toEqual(['tm.example:172.30.0.2', 'ntfy.tm.example:172.30.0.2'])
  expect(b.Env.some((e) => /KEY=|TOKEN=|SECRET=/.test(e))).toBe(false)
  expect(containerName(spec)).toBe(`tm-worker-${occ}-a1`)
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `bun test packages/scheduler/test`

Expected: FAIL with `Cannot find module './container-spec'`.

- [x] **Step 3: Implement `containerSpec`, `validateRequest` and the gate server**

The gate logs method, path and the refusal reason, never bodies.

- [x] **Step 4: Run tests to verify they pass**

Run: `bun test packages/scheduler/test`

Expected: PASS, `0 fail`.

- [x] **Step 5: Commit**

```bash
git add packages/scheduler
git commit -m "feat(scheduler): add docker socket gate"
```

### Task 14: Launcher and T-60 launch

**Files:**

- Create: `packages/scheduler/src/docker.ts`, `packages/scheduler/src/locks.ts`, `packages/scheduler/src/job-files.ts`, `packages/scheduler/src/launch.ts`
- Modify: `packages/web/db/job-config.ts` (`buildEntrySnapshot`, `loadJobConfig`)
- Test: `packages/scheduler/src/locks.test.ts`, `packages/scheduler/src/job-files.test.ts`, `packages/web/db/job-config.test.ts`, `packages/scheduler/src/launch.test.ts`

**Interfaces:**

- Consumes: `JobConfig`, `JobConfigSchema` (architecture); `profileKey`, `openColumn` (Task 2); `applyTrigger`, `ACTIVE_STATES` (Task 3); `findClashes`, `formatWhen`, `Queue` (Task 6); `Notifier`, `pings` (Task 7); `aiConfigFor` (Task 8); `containerSpec`, `containerName`, `jobFileBase`, `validateRequest` (Task 13).
- Produces: `interface DockerClient { create(name: string, body: CreateBody): Promise<string>; start(id: string): Promise<void>; stop(id: string, timeoutS: number): Promise<void>; inspect(id: string): Promise<{ running: boolean } | null> }`; `dockerClient(baseUrl: string): DockerClient` (over `DOCKER_PROXY_URL`; 404 on inspect is `null`); `FakeDocker` (records `created`, `started`, `stopped`; `inspect` answers from a settable map).
- Produces: `acquireProfile(db: Db, identityId: string, holder: string): Promise<boolean>` (one conditional `update ... where held_by is null`); `releaseProfile(db: Db, identityId: string, holder: string): Promise<void>` (only if `held_by = holder`); holders are `occ:<occurrenceId>` and `signin:<sessionId>`.
- Produces: `writeJobFiles(base: string, job: object, key: Buffer): Promise<{ jobPath: string; keyPath: string }>` (`<base>.json` and `<base>.key`, mode 0600, directory 0700); `removeJobFiles(base: string): Promise<void>`.
- Produces, `packages/web/db/job-config.ts`: `buildEntrySnapshot(db: Db, occurrenceId: string): Promise<JobConfig['entry']>` (from the timetable entry, with `start` and `end` as ISO strings with the member's offset, such as `2026-10-21T14:00:00+08:00`, and `link` replaced by `{ kind: 'fixed', url: pasted_link }` when a link was pasted); `loadJobConfig(db: Db, master: Buffer, occurrenceId: string, opts: { attempt: number; control: { url: string; token: string } | null; env: SpecEnv }): Promise<JobConfig>` (from `entry_snapshot`; identity; member with `details` and `mentionNames`; `ai` from `aiConfigFor` over the opened key; `ntfy` `{ url: env.ntfyUrl, topic, token }`; `dataDir` and `profileDir` as host paths).
- Produces: `SERVER_WORKER_CAP = 2`; `type LaunchDeps = { db: Db; queue: Queue; docker: DockerClient; notifier: Notifier; master: Buffer; env: SpecEnv }`; `launchOccurrence(deps: LaunchDeps, job: { occurrenceId: string; scheduledStart: string }, now: Date): Promise<'launched' | 'stale' | 'deferred' | 'skipped_identity_clash' | 'skipped_capacity' | 'failed'>`; `startAttempt(deps: LaunchDeps, occurrenceId: string, attempt: number, now: Date): Promise<void>`.

`launchOccurrence`, inside one transaction holding `pg_advisory_xact_lock(4242)`:

1. If the occurrence is gone, isn't `scheduled`, or its `scheduled_start` differs from `job.scheduledStart`, return `stale`.
2. Run `findClashes` over this identity's occurrences that overlap it and aren't `skipped_*`, `failed` or `deleted`; if this one loses, apply `launch` then `skip_identity_clash`, send `pings.identityClashSkipped`, return `skipped_identity_clash`.
3. If the identity's `run_location` isn't `server`, apply `launch` then `fail` with reason `run_location_unavailable` and return `failed` (plan 08 replaces this step).
4. If `profiles.held_by` is set: for `signin:<id>`, set that session's `done_requested`; for `occ:<id>` (a back-to-back meeting on the same identity), append `stop` to that occurrence's `pending_commands` once `now` has reached this occurrence's `scheduled_start`. Then re-send `launch` with the same data, `startAfter` now plus 15 seconds and no singleton key, and return `deferred`.
5. If the occurrences in `ACTIVE_STATES` already number `SERVER_WORKER_CAP`, apply `launch` then `skip_capacity`, send `pings.capacityClash`, return `skipped_capacity`.
6. Acquire the profile as `occ:<id>`, store `entry_snapshot = buildEntrySnapshot(...)` and `link_used` (fixed or pasted link), apply `launch`, then `startAttempt(deps, id, 1, now)`; return `launched`.

`startAttempt` makes a control token `<attempt>.<32 random bytes, base64url>`, stores its sha256 hex in `control_token_hash`, writes the `JobConfig` (control URL `<publicUrl>/api/control`) and `profileKey(master, identityId)` with `writeJobFiles(jobFileBase(spec), ...)`, creates and starts the container from `containerSpec`, and sets `attempt`, `container_name` and `last_heartbeat_at = now`. If Docker refuses, it applies `fail` with reason `launch_failed`, releases the profile, sends `pings.workerFailed` with `it couldn't start`, and `launchOccurrence` returns `failed`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/scheduler/src/launch.test.ts
test('a due occurrence launches with a private job file and a hashed token', async () => {
  const f = await launchFixture() // one scheduled occurrence at 2026-10-21T06:00Z, FakeDocker, FakeQueue, FakeNotifier, temp roots
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  const o = await f.occurrence()
  expect(o).toMatchObject({
    state: 'starting',
    attempt: 1,
    containerName: `tm-worker-${f.id}-a1`
  })
  expect(
    validateRequest(
      {
        method: 'POST',
        path: `/containers/create?name=${o.containerName}`,
        body: f.docker.created[0].body
      },
      f.cfg
    ).ok
  ).toBe(true)
  const jobPath = `${f.env.profileRoot}/${f.identityId}/job/${o.containerName}.json`
  expect((await stat(jobPath)).mode & 0o777).toBe(0o600)
  const job = JobConfigSchema.parse(await Bun.file(jobPath).json())
  expect(job.control!.url).toBe('https://tm.example/api/control')
  expect(sha256hex(job.control!.token)).toBe(o.controlTokenHash)
  expect(await f.heldBy()).toBe(`occ:${f.id}`)
})

test('a stale launch job does nothing', async () => {
  const f = await launchFixture()
  expect(await launchOccurrence(f.deps, { ...f.job, scheduledStart: '2026-10-21T07:00:00.000Z' }, f.tMinus60)).toBe(
    'stale'
  )
  expect(f.docker.created).toEqual([])
})

test('the later of two clashing occurrences is skipped with a ping', async () => {
  const f = await launchFixture({
    clashWith: { start: '2026-10-21T05:30:00Z', end: '2026-10-21T07:00:00Z' }
  })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('skipped_identity_clash')
  expect(f.notifier.sent[0].ping.title).toBe('Skipped: Data Mining')
})

test('a third server worker is skipped with a capacity ping', async () => {
  const f = await launchFixture({ activeElsewhere: 2 })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('skipped_capacity')
  expect(f.notifier.sent[0].ping.title).toBe('Skipped: Data Mining (server full)')
})

test('back-to-back occurrences on one identity wait for the earlier worker', async () => {
  // Review Focus
  const f = await launchFixture({
    earlierHolding: { end: '2026-10-21T06:00:00Z', state: 'in_meeting' }
  })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('deferred')
  expect(f.queue.sent.at(-1)).toMatchObject({
    name: 'launch',
    data: f.job,
    opts: { startAfter: new Date(f.tMinus60.getTime() + 15_000) }
  })
  expect((await f.earlier()).pendingCommands).toEqual([])
  expect(await launchOccurrence(f.deps, f.job, new Date('2026-10-21T06:00:00Z'))).toBe('deferred')
  expect((await f.earlier()).pendingCommands).toEqual(['stop'])
})

test('an identity held by a sign-in is asked to finish first', async () => {
  const f = await launchFixture({ signinHolding: true })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('deferred')
  expect((await f.signinSession()).doneRequested).toBe(true)
})

test('a pasted link becomes the job link', async () => {
  const f = await launchFixture({
    link: { kind: 'paste' },
    pasted: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
  })
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  expect((await f.job0()).entry.link).toEqual({
    kind: 'fixed',
    url: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
  })
})

test("a container that can't be created fails the occurrence and pings", async () => {
  const f = await launchFixture({ dockerFails: true })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({
    state: 'failed',
    stateReason: 'launch_failed'
  })
  expect(await f.heldBy()).toBeNull()
  expect(f.notifier.sent[0].ping.message).toContain("it couldn't start")
})
```

```ts
// packages/scheduler/src/locks.test.ts
test('a profile has one holder at a time', async () => {
  const { db, identityId } = await bareDb()
  expect(await acquireProfile(db, identityId, 'occ:a')).toBe(true)
  expect(await acquireProfile(db, identityId, 'signin:b')).toBe(false)
  await releaseProfile(db, identityId, 'signin:b')
  expect(await acquireProfile(db, identityId, 'signin:b')).toBe(false)
  await releaseProfile(db, identityId, 'occ:a')
  expect(await acquireProfile(db, identityId, 'signin:b')).toBe(true)
})
```

```ts
// packages/web/db/job-config.test.ts (added)
test('the entry snapshot carries local start and end times with the offset', async () => {
  const { db, occurrenceId } = await scheduledOccurrence() // Wednesday 14:00 to 16:00, Asia/Kuala_Lumpur
  expect(await buildEntrySnapshot(db, occurrenceId)).toMatchObject({
    start: '2026-10-21T14:00:00+08:00',
    end: '2026-10-21T16:00:00+08:00',
    timeZone: 'Asia/Kuala_Lumpur'
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/scheduler/src/launch.test.ts packages/scheduler/src/locks.test.ts packages/scheduler/src/job-files.test.ts packages/web/db/job-config.test.ts`

Expected: FAIL with `Cannot find module './launch'`.

- [ ] **Step 3: Implement the Docker client, locks, job files, the job-config builders and the launch**

`job-files.test.ts` checks the 0600 mode and that `removeJobFiles` deletes both files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/scheduler/src/launch.test.ts packages/scheduler/src/locks.test.ts packages/scheduler/src/job-files.test.ts packages/web/db/job-config.test.ts`

Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src packages/web/db/job-config*
git commit -m "feat(scheduler): launch workers at T-60"
```

### Task 15: Heartbeat endpoint and crash monitor

**Files:**

- Create: `packages/web/lib/control.ts`, `packages/web/app/api/control/heartbeat/route.ts`, `packages/scheduler/src/monitor.ts`
- Modify: `packages/core/src/types.ts` (`HeartbeatReply`), `packages/core/src/control.ts` (`HeartbeatSchema` and event data shapes)
- Test: `packages/web/lib/control.test.ts`, `packages/scheduler/src/monitor.test.ts`

**Interfaces:**

- Consumes: `Heartbeat`, `HeartbeatReply`, `MeetingEvent`, `ControlCommand` (architecture); `applyTrigger`, `triggerFor`, `WORKER_STATES`, `ACTIVE_STATES` (Task 3); `Queue`, `QUEUES` (Task 6); `pings` (Task 7); `LaunchDeps`, `startAttempt`, `releaseProfile`, `removeJobFiles`, `jobFileBase` (Tasks 13 and 14); 1A/1B's `form` events, whose `data` is the `FormRecord` (1A: the pinged candidate) with `formId`, `url`, `finalUrl`, `provider`, `source`, `sender`, `senderRole`, `trustReason`, `state`, `seenAt`, `submittedAt`, `fieldsFilled`, `result` (missing fields are stored as null).
- Changes contract: `HeartbeatReply` gains `link: string | null`, the pasted link the worker must use (the website's override of watched links).
- Produces (adds to contracts), `packages/core/src/control.ts`: `HeartbeatSchema` (zod for `Heartbeat`, at most 500 events); `type StateEventData = { state: OccurrenceState }` (a worker `state` event for each change of state); `type AccountCheckData = { account: AccountKind; signedIn: boolean }` (a worker `state` event after each account check).
- Produces: `controlDeps(): Promise<{ db: Db; queue: Queue }>` (calls `getDb()` and `getQueue()`; routes pass it on and never open the database themselves); `handleHeartbeat(deps: { db: Db; queue: Queue; now: Date }, authorization: string | null, body: unknown): Promise<{ status: 200 | 400 | 401 | 410; body: HeartbeatReply | { error: string } }>`; `HEARTBEAT_TIMEOUT_MS = 30_000`; `MAX_RESTARTS = 3`; `STOP_AFTER_END_MS = 35 * 60_000`; `KILL_AFTER_END_MS = 45 * 60_000`; `monitorTick(deps: LaunchDeps, now: Date): Promise<{ restarted: string[]; failed: string[]; released: string[] }>`; `restartOccurrence(deps: LaunchDeps, occurrenceId: string, now: Date): Promise<void>`.

`handleHeartbeat`, in one transaction:

1. Parse `Bearer <attempt>.<random>`, load the occurrence by `body.occurrenceId` and compare sha256 hashes. A match for an older attempt than the stored one answers 410 with `{ ackedEvents: 0, commands: ['stop'], link: null }`; any other mismatch answers 401; a body that fails `HeartbeatSchema` or exceeds 1 MB answers 400.
2. Insert the events with `data_hash` and `on conflict do nothing`; `ackedEvents` is `events.length` (stored now or before).
3. Apply each `state` event's `data.state` in order with `applyTrigger(..., triggerFor(current, next), { recordEvent: false })`, then reconcile `body.state` the same way. A pair with no trigger, or an `IllegalTransition`, adds an `error` event `{ reason: 'illegal_transition', from, to }` and leaves the state alone.
4. Side effects: `AccountCheckData` events update `profiles.account_status[account]` to `{ verifiedAt: event.at, signedIn }`; `form` events upsert `forms` on `(occurrence_id, form_key = data.formId)`; entering `in_meeting` sets `actual_start`; entering `leaving` sets `actual_end`; reaching `transcribing` sends `pipeline` with `{ occurrenceId }`; Task 18 adds the sign-in events.
5. Update `last_heartbeat_at`, `recording` and `participants`; take and clear `pending_commands`.
6. Reply `{ ackedEvents, commands, link: pasted_link }`.

`monitorTick`, every 5 seconds from the scheduler:

- **Crash**: an occurrence in `ACTIVE_STATES` whose `last_heartbeat_at` is more than 30 seconds old crashed. Before `scheduled_end` plus 30 minutes and with `restarts < 3`, `restartOccurrence` applies `crash`, stops the old container (5-second timeout), increments `restarts`, calls `startAttempt(attempt + 1)` and sends `pings.workerRestarted` with `n = restarts`. Otherwise it applies `fail` (reason `worker_unresponsive`), stops the container, releases the profile and sends `pings.workerFailed` with `it crashed 3 times`.
- **Hard stop** (Review Focus): an occurrence still in `WORKER_STATES` at `scheduled_end + 35 minutes` gets `stop` appended once; at `+45 minutes` its container is stopped, `fail` is applied with reason `overran_hard_stop`, and `pings.workerFailed` goes out with `it ran past the hard stop`.
- **Exit**: an occurrence outside `ACTIVE_STATES` that still has `container_name`, whose container `inspect` returns `null` or not running, gets `container_name` cleared, its profile released, and `profiles.latest_checkpoint` and `checkpoint_at` set from the newest file in `<profileRoot>/<identityId>/checkpoints/`.
- **Job files**: the current attempt's job files are removed once `last_heartbeat_at` is later than the launch, or 120 seconds after the launch.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/control.test.ts
const ev = (type: EventType, data: object, at = '2026-10-21T05:00:05.000Z'): MeetingEvent => ({
  occurrenceId: ID,
  attempt: 1,
  at,
  type,
  data: data as Record<string, unknown>
})

test('a heartbeat stores events once, drains commands and returns the pasted link', async () => {
  // Review Focus
  const f = await controlFixture({
    state: 'starting',
    token: '1.abc',
    pendingCommands: ['leave_now'],
    pastedLink: 'https://example.zoom.us/j/00000000000'
  })
  const hb = {
    occurrenceId: f.id,
    attempt: 1,
    state: 'verifying_accounts',
    recording: false,
    participants: null,
    events: [ev('state', { state: 'verifying_accounts' })]
  }
  expect(await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)).toEqual({
    status: 200,
    body: {
      ackedEvents: 1,
      commands: ['leave_now'],
      link: 'https://example.zoom.us/j/00000000000'
    }
  })
  expect(await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)).toEqual({
    status: 200,
    body: {
      ackedEvents: 1,
      commands: [],
      link: 'https://example.zoom.us/j/00000000000'
    }
  })
  expect(await f.eventCount()).toBe(1)
  expect((await f.occurrence()).state).toBe('verifying_accounts')
})

test('state events are applied in order', async () => {
  const f = await controlFixture({
    state: 'verifying_accounts',
    token: '1.abc'
  })
  const events = [
    ev('state', { state: 'watching_for_link' }, '2026-10-21T05:00:01.000Z'),
    ev('state', { state: 'joining' }, '2026-10-21T05:00:02.000Z')
  ]
  await handleHeartbeat(f.deps, 'Bearer 1.abc', {
    occurrenceId: f.id,
    attempt: 1,
    state: 'joining',
    recording: false,
    participants: null,
    events
  })
  expect((await f.occurrence()).state).toBe('joining')
})

test('an illegal reported state is logged, not applied', async () => {
  const f = await controlFixture({
    state: 'verifying_accounts',
    token: '1.abc'
  })
  await handleHeartbeat(f.deps, 'Bearer 1.abc', {
    occurrenceId: f.id,
    attempt: 1,
    state: 'completed',
    recording: false,
    participants: null,
    events: []
  })
  expect((await f.occurrence()).state).toBe('verifying_accounts')
  expect(await f.lastEvent()).toMatchObject({
    type: 'error',
    data: {
      reason: 'illegal_transition',
      from: 'verifying_accounts',
      to: 'completed'
    }
  })
})

test('a superseded attempt is told to stop and a wrong token is refused', async () => {
  const f = await controlFixture({
    state: 'in_meeting',
    attempt: 2,
    token: '2.new'
  })
  const hb = {
    occurrenceId: f.id,
    attempt: 1,
    state: 'in_meeting',
    recording: true,
    participants: 30,
    events: []
  }
  expect(await handleHeartbeat(f.deps, 'Bearer 1.old', hb)).toEqual({
    status: 410,
    body: { ackedEvents: 0, commands: ['stop'], link: null }
  })
  expect((await handleHeartbeat(f.deps, 'Bearer 2.wrong', { ...hb, attempt: 2 })).status).toBe(401)
})

test('reaching transcribing queues the pipeline', async () => {
  const f = await controlFixture({ state: 'uploading', token: '1.abc' })
  await handleHeartbeat(f.deps, 'Bearer 1.abc', {
    occurrenceId: f.id,
    attempt: 1,
    state: 'transcribing',
    recording: false,
    participants: null,
    events: []
  })
  expect(f.queue.sent).toEqual([{ name: 'pipeline', data: { occurrenceId: f.id }, opts: undefined }])
})

test('account checks and form events are recorded', async () => {
  const f = await controlFixture({ state: 'in_meeting', token: '1.abc' })
  const events = [
    ev('state', { account: 'zoom', signedIn: false }),
    ev(
      'form',
      {
        formId: 'f1',
        url: 'https://forms.gle/x',
        finalUrl: 'https://docs.google.com/forms/d/e/x/viewform',
        provider: 'google',
        source: 'qr',
        state: 'submitted',
        fieldsFilled: ['full_name'],
        seenAt: '2026-10-21T06:30:00Z'
      },
      '2026-10-21T06:31:00.000Z'
    )
  ]
  await handleHeartbeat(f.deps, 'Bearer 1.abc', {
    occurrenceId: f.id,
    attempt: 1,
    state: 'in_meeting',
    recording: true,
    participants: 30,
    events
  })
  expect((await f.profile()).accountStatus.zoom).toEqual({
    verifiedAt: '2026-10-21T05:00:05.000Z',
    signedIn: false
  })
  expect(await f.form('f1')).toMatchObject({
    state: 'submitted',
    source: 'qr',
    fieldsFilled: ['full_name']
  })
})
```

```ts
// packages/scheduler/src/monitor.test.ts
const now = new Date('2026-10-21T06:30:00Z')

test('30 seconds without a heartbeat restarts the worker as attempt 2 with a ping', async () => {
  const f = await monitorFixture({
    state: 'in_meeting',
    lastHeartbeat: new Date(now.getTime() - 31_000),
    attempt: 1,
    restarts: 0
  })
  expect((await monitorTick(f.deps, now)).restarted).toEqual([f.id])
  expect(await f.occurrence()).toMatchObject({
    state: 'restarting',
    attempt: 2,
    restarts: 1
  })
  expect(f.docker.stopped).toEqual([`tm-worker-${f.id}-a1`])
  expect(f.docker.created.at(-1)!.name).toBe(`tm-worker-${f.id}-a2`)
  expect(f.notifier.sent[0].ping).toMatchObject({
    title: 'Restarting: Data Mining',
    message: expect.stringContaining('restart 1 of 3')
  })
})

test('29 seconds is not a crash', async () => {
  const f = await monitorFixture({
    state: 'in_meeting',
    lastHeartbeat: new Date(now.getTime() - 29_000)
  })
  expect((await monitorTick(f.deps, now)).restarted).toEqual([])
})

test('a crash after 3 restarts fails the occurrence', async () => {
  const f = await monitorFixture({
    state: 'in_meeting',
    lastHeartbeat: new Date(now.getTime() - 31_000),
    attempt: 4,
    restarts: 3
  })
  expect((await monitorTick(f.deps, now)).failed).toEqual([f.id])
  expect(await f.occurrence()).toMatchObject({
    state: 'failed',
    stateReason: 'worker_unresponsive'
  })
  expect(await f.heldBy()).toBeNull()
})

test('a worker past its hard stop is told to stop, then stopped', async () => {
  // Review Focus
  const f = await monitorFixture({
    state: 'in_meeting',
    end: new Date('2026-10-21T08:00:00Z'),
    freshHeartbeats: true
  })
  await monitorTick(f.deps, new Date('2026-10-21T08:36:00Z'))
  expect((await f.occurrence()).pendingCommands).toEqual(['stop'])
  await monitorTick(f.deps, new Date('2026-10-21T08:46:00Z'))
  expect(await f.occurrence()).toMatchObject({
    state: 'failed',
    stateReason: 'overran_hard_stop'
  })
  expect(f.docker.stopped).toContain(`tm-worker-${f.id}-a1`)
})

test('a finished container releases the identity and records the newest checkpoint', async () => {
  const f = await monitorFixture({
    state: 'transcribing',
    containerGone: true,
    checkpoints: ['20261021T060000Z.tar.enc', '20261021T060500Z.tar.enc']
  })
  expect((await monitorTick(f.deps, now)).released).toEqual([f.id])
  expect(await f.heldBy()).toBeNull()
  expect((await f.profile()).latestCheckpoint).toEndWith('/checkpoints/20261021T060500Z.tar.enc')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/control.test.ts packages/scheduler/src/monitor.test.ts`

Expected: FAIL with `Cannot find module './control'`.

- [ ] **Step 3: Implement the contract change, `handleHeartbeat`, the route and `monitorTick`**

The route reads `Authorization`, rejects bodies over 1 MB by `Content-Length`, and returns `Response.json(body, { status })`. Neither module logs tokens, links or event data.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/control.test.ts packages/scheduler/src/monitor.test.ts && bun run typecheck`

Expected: PASS, `11 pass, 0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/web/lib/control* packages/web/app/api/control packages/scheduler/src/monitor*
git commit -m "feat: add heartbeat endpoint and monitor"
```

### Task 16: Worker heartbeat and commands

**Files:**

- Create: `packages/worker/src/control/outbox.ts`, `packages/worker/src/control/heartbeat.ts`, `packages/worker/src/control/commands.ts`, `packages/worker/src/control/link-override.ts`, `packages/worker/src/control/links.ts`, `packages/worker/src/forms/handled.ts`
- Modify: `packages/worker/src/profile/profile.ts` (`restoreCheckpoint`, `latestCheckpoint`), `packages/worker/src/run.ts`
- Test: `packages/worker/src/control/heartbeat.test.ts`, `packages/worker/src/control/commands.test.ts`, `packages/worker/src/forms/handled.test.ts`, `packages/worker/src/profile/profile.test.ts`

**Interfaces:**

- Consumes: `JobConfig`, `Heartbeat`, `HeartbeatReply` (with `link`, Task 15), `MeetingEvent`, `ControlCommand`, `StateEventData` (Task 15); 1A's `runOccurrence`, `checkpointProfile`, `prepareProfile`, `PlatformAdapter.leave`; 1A's `Stopper`; `loadProfileKey` (Task 2).
- Changes contract: `startHeartbeat(cfg: JobConfig, getStatus: () => Heartbeat, onReply: (reply: HeartbeatReply) => void, opts?: { intervalMs?: number; fetchFn?: typeof fetch }): Stopper`. Architecture's signature had no reply callback, which the worker needs for acks, commands and the pasted link.
- Produces: `class EventOutbox { push(e: MeetingEvent): void; pending(max = 500): MeetingEvent[]; ack(n: number): void }`; `dispatchCommands(cmds: ControlCommand[], h: { leave(): Promise<void>; stop(): Promise<void>; pause(): Promise<void>; resume(): Promise<void> }): Promise<void>` (in order; `leave_now` and `take_over` both call `h.leave` once per batch until plan 06; `stop` calls `h.stop`; `pause_for_signin` and `resume_after_signin` call `h.pause` and `h.resume`); `class LinkOverride { offer(url: string | null): void; current(): string | null; next(): Promise<string> }` (`next` resolves on the first new non-null URL); `siteLinks(cfg: JobConfig): { meetingPage: string; signIn: string } | null` (from `TM_PUBLIC_URL`: `/meetings/<occurrenceId>` and `/accounts/<identityId>/signin`; null when the variable is unset, as in 1A); `loadHandledForms(dataDir: string): Promise<Set<string>>` (the `finalUrl`, else `url`, of every `forms/*/record.json`); `latestCheckpoint(checkpointsDir: string): Promise<string | null>` (the greatest `<timestamp>.tar.enc` name); `restoreCheckpoint(checkpointPath: string, dir: string, key: Buffer): Promise<void>` (the inverse of 1A's `checkpointProfile`: decrypts and unpacks into an emptied `dir`).

`startHeartbeat` posts to `<control.url>/heartbeat` with `Authorization: Bearer <control.token>` every 5000 ms, with a 4000 ms timeout and never two requests at once. A 410 reply is passed on as `{ ackedEvents: 0, commands: ['stop'], link: null }`; network errors and 5xx keep the events for the next tick; a 401 stops the timer and logs `heartbeat refused`. It returns a no-op `Stopper` when `cfg.control` is null.

`run.ts` changes:

- Start the heartbeat first, reporting `starting`; `getStatus` returns the current state, recording flag, participant count and `outbox.pending()`; `onReply` calls `outbox.ack`, `linkOverride.offer(reply.link)` and `dispatchCommands`.
- Every event 1A appends to `events.jsonl` also goes to `outbox.push`; every change of state emits a `state` event with `StateEventData`, and every account check an `AccountCheckData` event.
- When `cfg.attempt > 1`, restore `latestCheckpoint(<profileRoot>/<identityId>/checkpoints)` into `cfg.profileDir` with `loadProfileKey` before 1A's `prepareProfile`, and seed the meeting's form de-duplication set from `loadHandledForms(cfg.dataDir)`, so a restarted worker never submits a form twice. The occurrence directory is the same host directory across attempts.
- In `watching_for_link`, race 1A's link sources with `linkOverride.next()`; a pasted link wins until joining starts.
- `leave`: `adapter.leave(stage)`, report `left_by_member`, then 1A's normal finish (stop recording, join segments, checkpoint). `stop`: report `leaving` and take the same finish as a meeting end. After the finish, report `transcribing` in a last heartbeat (the worker's "my part is done" marker), then exit 0.
- Pings: the joined ping gets the action `Open meeting page`, and the expired-account ping `Sign in again`, from `siteLinks`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/control/heartbeat.test.ts
test('heartbeats carry the bearer token and pass replies on', async () => {
  const seen: Request[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push(req)
      return Response.json({
        ackedEvents: 1,
        commands: ['leave_now'],
        link: null
      })
    }
  })
  const replies: HeartbeatReply[] = []
  const stop = startHeartbeat(
    cfgWith({
      url: `http://localhost:${server.port}/api/control`,
      token: '1.abc'
    }),
    () => status([ev1]),
    (r) => replies.push(r),
    { intervalMs: 50 }
  )
  await Bun.sleep(130)
  stop()
  server.stop()
  expect(seen.length).toBeGreaterThanOrEqual(2)
  expect(new URL(seen[0].url).pathname).toBe('/api/control/heartbeat')
  expect(seen[0].headers.get('authorization')).toBe('Bearer 1.abc')
  expect(replies[0]).toEqual({
    ackedEvents: 1,
    commands: ['leave_now'],
    link: null
  })
})

test('410 becomes a stop command; no control channel means no requests', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: 410 })
  })
  const replies: HeartbeatReply[] = []
  const stop = startHeartbeat(
    cfgWith({
      url: `http://localhost:${server.port}/api/control`,
      token: '1.abc'
    }),
    () => status([]),
    (r) => replies.push(r),
    { intervalMs: 50 }
  )
  await Bun.sleep(80)
  stop()
  server.stop()
  expect(replies[0]).toEqual({
    ackedEvents: 0,
    commands: ['stop'],
    link: null
  })
  const fetchFn = mock(fetch)
  startHeartbeat(
    cfgWith(null),
    () => status([]),
    () => {},
    { intervalMs: 10, fetchFn }
  )()
  expect(fetchFn).not.toHaveBeenCalled()
})

test('the outbox acknowledges from the front', () => {
  const o = new EventOutbox()
  ;[e1, e2, e3].forEach((e) => o.push(e))
  expect(o.pending(2)).toEqual([e1, e2])
  o.ack(2)
  expect(o.pending()).toEqual([e3])
})
```

```ts
// packages/worker/src/control/commands.test.ts
test('commands run in order and leave runs once per batch', async () => {
  const calls: string[] = []
  const h = {
    leave: async () => void calls.push('leave'),
    stop: async () => void calls.push('stop'),
    pause: async () => void calls.push('pause'),
    resume: async () => void calls.push('resume')
  }
  await dispatchCommands(['pause_for_signin', 'leave_now', 'take_over', 'resume_after_signin'], h)
  expect(calls).toEqual(['pause', 'leave', 'resume'])
})
```

```ts
// packages/worker/src/profile/profile.test.ts (added)
test('a checkpoint restores into an empty directory', async () => {
  const { dir, out, key } = await profileWith({
    'Default/Cookies': 'c',
    'Default/Cache/x': 'big',
    'Local State': '{}'
  })
  await checkpointProfile(dir, out, key)
  const target = await mkdtemp(join(tmpdir(), 'restore-'))
  await restoreCheckpoint(out, target, key)
  expect(await listFiles(target)).toEqual(['Default/Cookies', 'Local State'])
  await expect(restoreCheckpoint(out, target, Buffer.alloc(32, 9))).rejects.toThrow()
})

test('the latest checkpoint is the newest timestamp', async () => {
  const d = await dirWith(['20261021T060000Z.tar.enc', '20261021T060500Z.tar.enc', 'notes.txt'])
  expect(await latestCheckpoint(d)).toBe(join(d, '20261021T060500Z.tar.enc'))
})
```

```ts
// packages/worker/src/forms/handled.test.ts
test('forms recorded by earlier attempts are handled', async () => {
  const dir = await dataDirWith({
    'forms/f1/record.json': {
      finalUrl: 'https://docs.google.com/forms/d/e/a/viewform'
    },
    'forms/f2/record.json': { url: 'https://forms.office.com/r/b' }
  })
  expect(await loadHandledForms(dir)).toEqual(
    new Set(['https://docs.google.com/forms/d/e/a/viewform', 'https://forms.office.com/r/b'])
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/control packages/worker/src/forms/handled.test.ts packages/worker/src/profile/profile.test.ts`

Expected: FAIL with `Cannot find module './heartbeat'`.

- [ ] **Step 3: Implement the modules and wire `run.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/control packages/worker/src/forms/handled.test.ts packages/worker/src/profile/profile.test.ts && bun run typecheck`

Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src
git commit -m "feat(worker): add heartbeat and commands"
```

### Task 17: Desk pause and sign-in container

**Files:**

- Create: `packages/worker/src/control/vnc.ts`, `packages/worker/src/control/desk-pause.ts`, `packages/worker/src/signin/run-signin.ts`, `packages/worker/src/signin/main.ts`
- Modify: `packages/core/src/control.ts` (sign-in types), `packages/worker/src/run.ts`, `docker/worker/Dockerfile`, `docker/worker/entrypoint.sh`
- Test: `packages/worker/src/control/vnc.test.ts`, `packages/worker/src/control/desk-pause.test.ts`, `packages/worker/src/signin/run-signin.test.ts`

**Interfaces:**

- Consumes: 1A's `startScreen(): Promise<Screen>` (display name and desk rectangle), `launchBrowser(profileDir, screen)`, `checkpointProfile`, `Rect`, `Stopper`; `loadProfileKey` (Task 2); `dispatchCommands` handlers (Task 16); 1B's `FormContext`, whose `awaiting_signin` wait this task supplies.
- Produces (adds to contracts), `packages/core/src/control.ts`: `type SigninJob = { sessionId: string; identityId: string; profileDir: string; checkpointsDir: string; control: { url: string; token: string } }`; `type SigninHeartbeat = { sessionId: string; idleMs: number; ended: boolean; reason?: 'done' | 'idle' | 'error' }`; `type SigninReply = { commands: ControlCommand[] }`; `type SigninEventData = { signin: 'paused' | 'resumed'; reason?: 'command' | 'idle' }`; zod schemas for the first three.
- Produces: `vncArgs(display: string, desk: Rect): { x11vnc: string[]; websockify: string[] }`; `startVnc(display: string, desk: Rect): Promise<Stopper>`; `idleMs(display: string): Promise<number>` (runs `xprintidle`; noVNC input arrives as X input, while Playwright's CDP input does not); `IDLE_CLOSE_MS = 900_000`; `SIGNIN_START_URLS = ['https://zoom.us/signin', 'https://login.microsoftonline.com/', 'https://accounts.google.com/', 'https://web.whatsapp.com/', 'https://discord.com/login', 'https://teams.microsoft.com/']`.
- Produces: `class DeskPause` with `constructor(deps: DeskPauseDeps, clock?: { now(): number; every(ms: number, fn: () => void): Stopper })`, `pause(): Promise<void>`, `resume(reason: 'command' | 'idle'): Promise<void>`, `whenOpen(): Promise<void>`, `nextResume(): Promise<'command' | 'idle'>`, `readonly paused: boolean`; `type DeskPauseDeps = { startVnc(): Promise<Stopper>; idleMs(): Promise<number>; openTabs(urls: string[]): Promise<() => Promise<void>>; checkpoint(): Promise<void>; emit(data: SigninEventData): void }`.
- Produces: `runSignin(job: SigninJob, deps: SigninDeps): Promise<void>` with `SigninDeps = { openDesk(): Promise<{ openTabs(urls: string[]): Promise<void>; close(): Promise<void> }>; startVnc(): Promise<Stopper>; idleMs(): Promise<number>; checkpoint(): Promise<void>; post(hb: SigninHeartbeat): Promise<SigninReply>; clock: { every(ms: number, fn: () => void): Stopper } }`.

`DeskPause.pause` (idempotent) starts the VNC, opens `SIGNIN_START_URLS` in new desk tabs and emits `{ signin: 'paused' }`, then checks `idleMs()` every 10 seconds; at 900 000 ms or more it calls `resume('idle')`. `resume` stops the VNC, closes the tabs it opened, checkpoints the profile, emits `{ signin: 'resumed', reason }` and releases `whenOpen` and `nextResume` waiters. In `run.ts`: the `pause` and `resume` command handlers call `DeskPause`; every desk action (1B's form handling, and plan 02's watchers) first awaits `deskPause.whenOpen()`; 1B's `awaiting_signin` wait is `deskPause.nextResume()`; and an expired account at verification reports `waiting_for_signin`, sends the "Sign in again" ping, awaits `nextResume()` until the join deadline (T-5) and then verifies again. Recording and stage loops never wait on the desk.

`runSignin` opens the desk window with `SIGNIN_START_URLS`, starts the VNC, and every 5 seconds posts `{ sessionId, idleMs, ended: false }` to `<control.url>/signin`. A reply containing `stop` ends with reason `done`; 900 000 ms idle ends with `idle`. Ending closes the browser, checkpoints the profile, posts `{ sessionId, idleMs, ended: true, reason }` and returns; `main.ts` then exits 0.

Image and entrypoint changes:

```sh
# docker/worker/Dockerfile: added to the apt-get install line
x11vnc websockify xprintidle
# docker/worker/entrypoint.sh: before the existing --job branch
if [ "$1" = "--signin" ]; then exec node /app/dist/signin.js "$2"; fi
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/control/vnc.test.ts
test('the VNC view is clipped to the desk and bound to localhost', () => {
  expect(vncArgs(':99', { x: 1920, y: 0, width: 1920, height: 1080 })).toEqual({
    x11vnc: [
      '-display',
      ':99',
      '-clip',
      '1920x1080+1920+0',
      '-rfbport',
      '5900',
      '-localhost',
      '-nopw',
      '-forever',
      '-shared',
      '-noxdamage',
      '-quiet'
    ],
    websockify: ['0.0.0.0:6080', 'localhost:5900']
  })
})
```

```ts
// packages/worker/src/control/desk-pause.test.ts
test('the desk pauses for sign-in and resumes after 15 minutes idle', async () => {
  const f = deskFixture() // fake deps and clock; f.idle sets what idleMs() returns; f.tick() runs the 10-second check
  await f.pause.pause()
  expect(f.events).toEqual([{ signin: 'paused' }])
  expect(f.openedTabs).toEqual(SIGNIN_START_URLS)
  f.idle = 899_999
  await f.tick()
  expect(f.pause.paused).toBe(true)
  f.idle = 900_000
  await f.tick()
  expect(f.pause.paused).toBe(false)
  expect(f.events.at(-1)).toEqual({ signin: 'resumed', reason: 'idle' })
  expect([f.vncStopped, f.tabsClosed, f.checkpoints]).toEqual([1, 1, 1])
})

test('a resume command releases the waiting desk actions', async () => {
  const f = deskFixture()
  await f.pause.pause()
  const waiting = f.pause.whenOpen()
  const next = f.pause.nextResume()
  await f.pause.resume('command')
  await waiting
  expect(await next).toBe('command')
})
```

```ts
// packages/worker/src/signin/run-signin.test.ts
test('Done stops the sign-in container after a checkpoint', async () => {
  const f = signinFixture({
    replies: [{ commands: [] }, { commands: ['stop'] }]
  })
  await runSignin(f.job, f.deps)
  expect(f.order).toEqual([
    'openDesk',
    'openTabs',
    'startVnc',
    'post',
    'post',
    'close',
    'checkpoint',
    'post:ended:done'
  ])
})

test('15 idle minutes end the session', async () => {
  const f = signinFixture({ replies: [{ commands: [] }], idle: 900_000 })
  await runSignin(f.job, f.deps)
  expect(f.posts.at(-1)).toEqual({
    sessionId: f.job.sessionId,
    idleMs: 900_000,
    ended: true,
    reason: 'idle'
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/control/vnc.test.ts packages/worker/src/control/desk-pause.test.ts packages/worker/src/signin/run-signin.test.ts`

Expected: FAIL with `Cannot find module './vnc'`.

- [ ] **Step 3: Implement the modules, wire `run.ts`, and change the image and entrypoint**

- [ ] **Step 4: Run tests to verify they pass, and build the image**

Run: `bun test packages/worker/src/control packages/worker/src/signin && docker build -f docker/worker/Dockerfile -t tolongmeeting/worker:current . && docker run --rm --entrypoint sh tolongmeeting/worker:current -c 'command -v x11vnc websockify xprintidle'`

Expected: PASS, `0 fail`; the image builds and the last command prints three paths.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/control.ts packages/worker/src docker/worker
git commit -m "feat(worker): add desk pause and sign-in"
```

### Task 18: Remote sign-in

**Files:**

- Create: `packages/web/lib/signin.ts`, `packages/web/app/api/vnc/authorize/route.ts`, `packages/web/app/api/control/signin/route.ts`, `packages/web/app/accounts/[identityId]/signin/page.tsx`, `packages/web/app/accounts/[identityId]/signin/viewer.tsx`, `packages/scheduler/src/signin.ts`
- Modify: `packages/web/lib/control.ts` (sign-in events, `authoriseVnc`, `handleSigninHeartbeat`), `packages/scheduler/src/monitor.ts` (silent sessions)
- Test: `packages/web/lib/signin.test.ts`, `packages/scheduler/src/signin.test.ts`, `packages/scheduler/src/monitor.test.ts`

**Interfaces:**

- Consumes: `MemberScope` (Task 4); `auth` (Task 5); `Queue`, `QUEUES` (Task 6); `ACTIVE_STATES`, `WORKER_STATES` (Task 3); `SigninJob`, `SigninHeartbeat`, `SigninReply`, `SigninEventData` (Task 17); `LaunchDeps`, `acquireProfile`, `releaseProfile`, `writeJobFiles`, `containerSpec`, `containerName`, `jobFileBase`, `profileKey` (Tasks 2, 13 and 14); `handleHeartbeat` (Task 15).
- Produces, `packages/web/lib/signin.ts`: `startSignin(scope: MemberScope, identityId: string, deps: { queue: Queue }): Promise<{ sessionId: string; mode: 'worker' | 'container' }>`; `finishSignin(scope: MemberScope, sessionId: string): Promise<void>`; `signinStatus(scope: MemberScope, sessionId: string): Promise<'starting' | 'ready' | 'ended'>`.
- Produces, `packages/web/lib/control.ts`: `authoriseVnc(deps: { db: Db; getSession(h: Headers): Promise<{ userId: string } | null> }, headers: Headers): Promise<{ status: 200; upstream: string } | { status: 401 | 403 }>`; `handleSigninHeartbeat(deps: { db: Db; now: Date }, authorization: string | null, body: unknown): Promise<{ status: 200 | 400 | 401; body: SigninReply | { error: string } }>`.
- Produces, `packages/scheduler/src/signin.ts`: `startSigninContainer(deps: LaunchDeps, sessionId: string, now: Date): Promise<'started' | 'worker' | 'ended'>` (the `signin-start` job handler).

Flow:

- **A worker holds the identity** (`profiles.held_by` is `occ:<id>` and that occurrence is in `WORKER_STATES`): `startSignin` creates a `worker` session with `upstream` `tm-worker-<occurrenceId>-a<attempt>:6080` and appends `pause_for_signin` to the occurrence's `pending_commands`. The session becomes `ready` when the worker's `{ signin: 'paused' }` event arrives through `handleHeartbeat`, and `ended` (reason `idle` or `done`) on `{ signin: 'resumed' }`. `finishSignin` appends `resume_after_signin`.
- **Otherwise**: `startSignin` creates a `container` session and sends `signin-start` with `{ sessionId }`. `startSigninContainer` acquires the profile as `signin:<sessionId>`; if a worker took it meanwhile, it switches the session to worker mode as above and returns `worker`. Otherwise it writes the `SigninJob` (control URL `<publicUrl>/api/control`, token `s.<32 random bytes, base64url>`, hashed into `control_token_hash`) and the profile key with `writeJobFiles`, starts `tm-signin-<sessionId>` from `containerSpec({ kind: 'signin', ... })` and sets `upstream` to `tm-signin-<sessionId>:6080`. The first sign-in heartbeat makes the session `ready`; `finishSignin` sets `done_requested`, so the next reply carries `stop`; a heartbeat with `ended: true` ends the session, and the monitor releases the profile once the container is gone.
- A second `startSignin` for the same identity returns the session that isn't ended.
- **Monitor**: a session with no heartbeat (container mode) or no worker heartbeat (worker mode) for 30 seconds is ended with reason `lost`; a container session's container is stopped and its profile released.
- **`authoriseVnc`**: `X-Forwarded-Uri` must match `^/vnc/<uuid>/`; no Better Auth session gives 401; a session row of another member, or one that isn't `ready`, gives 403; otherwise 200 with header `X-Vnc-Upstream: <upstream>`, where `upstream` must match `^tm-(worker|signin)-[0-9a-f-]+(-a\d+)?:6080$`. The route returns an empty body with that status and header.
- **Page**: `/accounts/<identityId>/signin` starts or reuses a session, polls `signinStatus` every 2 seconds, then mounts noVNC's `RFB` (package `@novnc/novnc`) on `wss://<host>/vnc/<sessionId>/websockify` with `scaleViewport`. Beside the view it lists what to sign in to (Zoom, Microsoft, Google, WhatsApp Web by scanning the code with the phone, Discord, Teams), the note `This view shows only the unrecorded side of the bot's screen. It closes after 15 minutes without input.`, and a "Done" button calling `finishSignin`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/lib/signin.test.ts
test('with no worker running, sign-in asks the scheduler for a container', async () => {
  const f = await signinFixture()
  const r = await startSignin(f.scope, f.identityId, { queue: f.queue })
  expect(r.mode).toBe('container')
  expect(f.queue.sent).toEqual([{ name: 'signin-start', data: { sessionId: r.sessionId }, opts: undefined }])
  expect((await startSignin(f.scope, f.identityId, { queue: f.queue })).sessionId).toBe(r.sessionId)
})

test('with a worker running, sign-in pauses it and attaches to its desk', async () => {
  const f = await signinFixture({
    workerHolding: { state: 'in_meeting', attempt: 2 }
  })
  const r = await startSignin(f.scope, f.identityId, { queue: f.queue })
  expect(r.mode).toBe('worker')
  expect((await f.occurrence()).pendingCommands).toEqual(['pause_for_signin'])
  expect(await f.session(r.sessionId)).toMatchObject({
    state: 'starting',
    upstream: `tm-worker-${f.occurrenceId}-a2:6080`
  })
  await f.heartbeatWithEvent({ signin: 'paused' })
  expect(await signinStatus(f.scope, r.sessionId)).toBe('ready')
  await finishSignin(f.scope, r.sessionId)
  expect((await f.occurrence()).pendingCommands).toEqual(['resume_after_signin'])
  await f.heartbeatWithEvent({ signin: 'resumed', reason: 'command' })
  expect(await signinStatus(f.scope, r.sessionId)).toBe('ended')
})

test('forward auth lets only the owner reach a ready session', async () => {
  const f = await signinFixture({ readySession: true })
  const h = new Headers({
    'x-forwarded-uri': `/vnc/${f.sessionId}/websockify`
  })
  const as = (userId: string | null) => ({
    db: f.db,
    getSession: async () => (userId ? { userId } : null)
  })
  expect(await authoriseVnc(as(f.ownerAuthUserId), h)).toEqual({
    status: 200,
    upstream: `tm-signin-${f.sessionId}:6080`
  })
  expect(await authoriseVnc(as(f.otherAuthUserId), h)).toEqual({ status: 403 })
  expect(await authoriseVnc(as(null), h)).toEqual({ status: 401 })
  expect(await authoriseVnc(as(f.ownerAuthUserId), new Headers({ 'x-forwarded-uri': '/vnc/../admin' }))).toEqual({
    status: 403
  })
})

test('the sign-in heartbeat returns stop after Done and ends on the last beat', async () => {
  const f = await signinFixture({ readySession: true, token: 's.abc' })
  await finishSignin(f.scope, f.sessionId)
  expect(
    await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.abc', {
      sessionId: f.sessionId,
      idleMs: 1000,
      ended: false
    })
  ).toEqual({ status: 200, body: { commands: ['stop'] } })
  await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.abc', {
    sessionId: f.sessionId,
    idleMs: 1000,
    ended: true,
    reason: 'done'
  })
  expect(await f.session(f.sessionId)).toMatchObject({
    state: 'ended',
    endReason: 'done'
  })
  expect(
    (
      await handleSigninHeartbeat({ db: f.db, now: f.now }, 'Bearer s.wrong', {
        sessionId: f.sessionId,
        idleMs: 0,
        ended: false
      })
    ).status
  ).toBe(401)
})
```

```ts
// packages/scheduler/src/signin.test.ts
test('a sign-in container gets the identity profile and nothing else', async () => {
  const f = await signinLaunchFixture()
  expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('started')
  const c = f.docker.created[0]
  expect(c.name).toBe(`tm-signin-${f.sessionId}`)
  expect(c.body.HostConfig.Binds).toEqual([`${f.env.profileRoot}/${f.identityId}:${f.env.profileRoot}/${f.identityId}`])
  expect(
    validateRequest(
      {
        method: 'POST',
        path: `/containers/create?name=${c.name}`,
        body: c.body
      },
      f.cfg
    ).ok
  ).toBe(true)
  expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
})

test('a worker that took the identity meanwhile gets the session instead', async () => {
  const f = await signinLaunchFixture({ workerHolding: true })
  expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('worker')
  expect(f.docker.created).toEqual([])
})
```

```ts
// packages/scheduler/src/monitor.test.ts (added)
test('a sign-in session silent for 30 seconds is ended and its container stopped', async () => {
  const f = await monitorFixture({
    signinSession: {
      mode: 'container',
      lastHeartbeat: new Date(now.getTime() - 31_000)
    }
  })
  await monitorTick(f.deps, now)
  expect(await f.signinSession()).toMatchObject({
    state: 'ended',
    endReason: 'lost'
  })
  expect(f.docker.stopped).toEqual([`tm-signin-${f.sessionId}`])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/lib/signin.test.ts packages/scheduler/src/signin.test.ts packages/scheduler/src/monitor.test.ts`

Expected: FAIL with `Cannot find module './signin'`.

- [ ] **Step 3: Implement the sign-in functions, the two routes, the page and viewer, and the scheduler handler**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/lib/signin.test.ts packages/scheduler/src/signin.test.ts packages/scheduler/src/monitor.test.ts && bun run typecheck`

Expected: PASS, `0 fail`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web packages/scheduler/src
git commit -m "feat: add remote sign-in through noVNC"
```

### Task 19: Pipeline consumer and artefacts

**Files:**

- Create: `packages/pipeline/src/consumer.ts`, `packages/pipeline/src/consumer-main.ts`, `packages/pipeline/src/remux.ts`, `packages/web/db/artefacts.ts`
- Modify: `packages/scheduler/src/monitor.ts` (register artefacts when a container of a terminal occurrence is gone)
- Test: `packages/pipeline/src/consumer.test.ts`, `packages/pipeline/src/remux.test.ts`, `packages/web/db/artefacts.test.ts`

**Interfaces:**

- Consumes: `runPipeline(cfg: JobConfig): Promise<PipelineResult>`, `AiKeyError` (architecture); `applyTrigger` (Task 3); `Notifier`, `pings` (Task 7); `loadJobConfig` (Task 14); `ArtefactKind` (Task 1).
- Produces (adds to contracts): `recording/meeting.mp4` in the data directory layout, a stream copy of `recording/meeting.mkv` with `+faststart` for the browser player; the `.mkv` is deleted once the copy checks out.
- Produces: `remuxArgs(dir: string): string[]`; `remuxRecording(dir: string): Promise<void>` (runs `ffmpeg` with `remuxArgs`, compares `ffprobe` durations of the two files to within 1 second, then deletes `meeting.mkv`; does nothing if `meeting.mkv` is missing); `registerArtefacts(db: Db, occ: { id: string; memberId: string }, dir: string): Promise<number>` (idempotent upsert on `(occurrence_id, path)`); `handlePipelineJob(deps: PipelineDeps, occurrenceId: string): Promise<'waiting_for_pc' | 'completed' | 'key_error' | 'failed' | 'stale'>` with `PipelineDeps = { db: Db; notifier: Notifier; master: Buffer; env: SpecEnv; run: (cfg: JobConfig) => Promise<PipelineResult>; remux: (dir: string) => Promise<void> }`.

`registerArtefacts` rules (paths relative to the occurrence directory; anything else is ignored):

```text
recording/meeting.mp4                          recording
out/<YYYY-MM-DD HHmm name>.md                  summary
out/transcript.md                              transcript
out/slides.md                                  slides
slides/slides.json                             slides_json
slides/NN.webp                                 slide_image
out/chat.md                                    chat
forms/<formId>/filled.png, confirmation.png    form_screenshot
```

`handlePipelineJob`: in `transcribing`, a `native` occurrence applies `wait_for_pc`, sends `pings.waitingForPc` and returns `waiting_for_pc` (plan 03 continues it); a `live` one applies `transcript_ready`. Then, in `post_processing` (including a re-run with `state_reason` `ai_key_error`, which it clears), it builds the config with `loadJobConfig(..., { attempt, control: null, env })`, so `dataDir` is the host path; runs `deps.run(cfg)`, then `deps.remux(cfg.dataDir)` and `registerArtefacts`, and applies `summary_done` (`completed`). An `AiKeyError` keeps the state, sets `state_reason` `ai_key_error`, sends `pings.aiKeyProblem` with the status and returns `key_error`. Any other error applies `fail` (reason `pipeline_error`), registers the artefacts that exist, sends `pings.pipelineFailed` and returns `failed`. Any other starting state returns `stale`. `consumer-main.ts` runs `boss.work('pipeline', { localConcurrency: 1 }, ...)`, so only one heavy job runs at a time.

The monitor (Task 15) calls `registerArtefacts` when it clears the container of an occurrence in `no_link`, `denied`, `left_by_member` or `failed`, so their recordings and form screenshots show on the meeting page.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pipeline/src/consumer.test.ts
test('live mode runs the pipeline, remuxes the recording and completes', async () => {
  const f = await pipelineFixture({
    state: 'transcribing',
    transcription: 'live'
  })
  expect(await handlePipelineJob(f.deps, f.id)).toBe('completed')
  expect(f.runCfg!.dataDir).toBe(`${f.env.dataRoot}/occurrences/${f.id}`)
  expect(f.runCfg!.control).toBeNull()
  expect(f.remuxed).toEqual([f.runCfg!.dataDir])
  expect((await f.occurrence()).state).toBe('completed')
})

test('native mode waits for the PC with one ping', async () => {
  const f = await pipelineFixture({
    state: 'transcribing',
    transcription: 'native'
  })
  expect(await handlePipelineJob(f.deps, f.id)).toBe('waiting_for_pc')
  expect(await handlePipelineJob(f.deps, f.id)).toBe('stale')
  expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Waiting for your PC: Data Mining'])
})

test('a rejected key keeps everything and a re-run completes', async () => {
  const f = await pipelineFixture({
    state: 'transcribing',
    transcription: 'live',
    runFails: [keyError(401)]
  })
  expect(await handlePipelineJob(f.deps, f.id)).toBe('key_error')
  expect(await f.occurrence()).toMatchObject({
    state: 'post_processing',
    stateReason: 'ai_key_error'
  })
  expect(f.notifier.sent[0].ping.title).toBe('Summary needs your key: Data Mining')
  expect(await handlePipelineJob(f.deps, f.id)).toBe('completed')
  expect((await f.occurrence()).stateReason).toBeNull()
})

test('other failures fail the occurrence with a ping', async () => {
  const f = await pipelineFixture({
    state: 'transcribing',
    transcription: 'live',
    runFails: [new Error('disk full')]
  })
  expect(await handlePipelineJob(f.deps, f.id)).toBe('failed')
  expect(f.notifier.sent[0].ping.title).toBe('Summary failed: Data Mining')
})
```

```ts
// packages/web/db/artefacts.test.ts
test('the data directory is classified once', async () => {
  const f = await artefactFixture([
    'recording/meeting.mp4',
    'out/2026-10-21 1400 Data Mining.md',
    'out/transcript.md',
    'out/slides.md',
    'out/chat.md',
    'slides/slides.json',
    'slides/01.webp',
    'forms/f1/filled.png',
    'forms/f1/confirmation.png',
    'frames/0001_140000.png',
    'chat.jsonl'
  ])
  expect(await registerArtefacts(f.db, f.occ, f.dir)).toBe(9)
  expect(await registerArtefacts(f.db, f.occ, f.dir)).toBe(9)
  expect(await f.kinds()).toEqual({
    chat: 1,
    form_screenshot: 2,
    recording: 1,
    slide_image: 1,
    slides: 1,
    slides_json: 1,
    summary: 1,
    transcript: 1
  })
})
```

```ts
// packages/pipeline/src/remux.test.ts
test('the recording is copied into a fast-start MP4', () => {
  expect(remuxArgs('/d')).toEqual([
    '-y',
    '-i',
    '/d/recording/meeting.mkv',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '/d/recording/meeting.mp4'
  ])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/pipeline/src/consumer.test.ts packages/pipeline/src/remux.test.ts packages/web/db/artefacts.test.ts`

Expected: FAIL with `Cannot find module './consumer'`.

- [ ] **Step 3: Implement the consumer, the remux, `registerArtefacts`, the consumer entry point and the monitor change**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/pipeline/src packages/web/db/artefacts.test.ts packages/scheduler/src/monitor.test.ts`

Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src packages/web/db/artefacts* packages/scheduler/src/monitor.ts
git commit -m "feat(pipeline): consume pipeline jobs"
```

### Task 20: Retention and backups

**Files:**

- Create: `packages/scheduler/src/retention.ts`, `packages/scheduler/src/backup.ts`
- Test: `packages/scheduler/src/retention.test.ts`, `packages/scheduler/src/backup.test.ts`

**Interfaces:**

- Consumes: `applyTrigger`, `ACTIVE_STATES` (Task 3); `formatWhen`, `formatDay` (Task 6); `Notifier`, `pings.deletionSoon` (Task 7); `LaunchDeps` (Task 14).
- Produces: `retentionTick(deps: LaunchDeps, now: Date): Promise<{ warned: number; deleted: number; orphansRemoved: number; checkpointsPruned: number }>`; `deleteOccurrenceData(deps: LaunchDeps, occurrenceId: string, now: Date): Promise<void>` (also the `delete-occurrence` job handler for "delete now"); `KEEP_CHECKPOINTS = 3`; `backupCommands(p: { date: string; databaseUrl: string; remote: string; workDir: string; checkpoints: { identityId: string; path: string }[] }): string[][]`; `runBackup(deps: LaunchDeps & { remote: string; databaseUrl: string }, now: Date): Promise<void>`.
- Produces (adds to contracts): environment variable `TM_BACKUP_REMOTE` (scheduler: an rclone remote path, configured as an rclone `crypt` remote so copies are encrypted off the server) and `RCLONE_CONFIG` (scheduler: path of the rclone configuration secret).

`retentionTick`, hourly:

- **Warning**: occurrences outside `ACTIVE_STATES`, not `deleted`, with `delete_after - 3 days <= now < delete_after` and no `deletion_warned_at` get `pings.deletionSoon` (normal priority) and `deletion_warned_at = now`.
- **Deletion**: the same set with `delete_after <= now` goes through `deleteOccurrenceData`: remove `<dataRoot>/occurrences/<id>/` recursively; delete the occurrence's `forms`, `artefacts` and `events` rows; apply `delete` (reason `expired`, or `member` for "delete now"), which records the one remaining event; set `link_used`, `pasted_link`, `entry_snapshot`, `container_name` and `control_token_hash` to null. The occurrence row stays as a `deleted` tombstone with its entry name and times.
- **Orphans**: directories under `<dataRoot>/occurrences/` without an occurrence row, or whose row is `deleted`, and directories under `<profileRoot>/` without an identity row are removed (this is how a removed member's or identity's files go).
- **Checkpoints**: only the `KEEP_CHECKPOINTS` newest `*.tar.enc` files stay in each `<profileRoot>/<identityId>/checkpoints/`.

`runBackup`, nightly: run `backupCommands` in order with `Bun.spawn`, logging each step's first word and exit code only (never the arguments, which hold the database URL), then remove the local dump. The checkpoints are each identity's newest.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/scheduler/src/retention.test.ts
const now = new Date('2026-11-17T08:00:00Z')

test('a meeting 3 days from deletion gets one warning ping', async () => {
  const f = await retentionFixture({
    state: 'completed',
    deleteAfter: new Date('2026-11-20T08:00:00Z')
  })
  expect((await retentionTick(f.deps, now)).warned).toBe(1)
  expect((await retentionTick(f.deps, now)).warned).toBe(0)
  expect(f.notifier.sent[0].ping).toMatchObject({
    title: 'Deleting in 3 days: Data Mining',
    priority: 'default',
    message:
      'Data Mining (Wed 21 Oct, 14:00) will be deleted from the server on Fri 20 Nov. Export anything you want to keep before then.'
  })
})

test('a meeting past its deletion time is gone from disk and database', async () => {
  const f = await retentionFixture({
    state: 'completed',
    deleteAfter: new Date(now.getTime() - 1000),
    files: ['recording/meeting.mp4', 'forms/f1/filled.png'],
    withRows: true
  })
  expect((await retentionTick(f.deps, now)).deleted).toBe(1)
  expect(await exists(f.dir)).toBe(false)
  expect([await f.count(forms), await f.count(artefacts)]).toEqual([0, 0])
  expect((await f.events()).map((e) => e.data.to)).toEqual(['deleted'])
  expect(await f.occurrence()).toMatchObject({
    state: 'deleted',
    linkUsed: null,
    entrySnapshot: null
  })
})

test('a meeting in progress is never deleted', async () => {
  const f = await retentionFixture({
    state: 'in_meeting',
    deleteAfter: new Date(now.getTime() - 1000)
  })
  expect((await retentionTick(f.deps, now)).deleted).toBe(0)
})

test('orphaned directories go and only 3 checkpoints stay', async () => {
  const f = await retentionFixture({
    orphanOccurrenceDir: true,
    orphanProfileDir: true,
    checkpoints: ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z'].map(
      (t) => `${t}.tar.enc`
    )
  })
  expect(await retentionTick(f.deps, now)).toMatchObject({
    orphansRemoved: 2,
    checkpointsPruned: 1
  })
  expect(await f.checkpointNames()).toEqual([
    '20261102T000000Z.tar.enc',
    '20261103T000000Z.tar.enc',
    '20261104T000000Z.tar.enc'
  ])
})
```

```ts
// packages/scheduler/src/backup.test.ts
test('backups dump the database, copy checkpoints and expire copies older than 7 days', () => {
  expect(
    backupCommands({
      date: '2026-10-21',
      databaseUrl: 'postgres://tm@postgres/tm',
      remote: 'tm-backup:',
      workDir: '/tmp/tm-backup',
      checkpoints: [
        {
          identityId: 'i1',
          path: '/srv/tolongmeeting/profiles/i1/checkpoints/20261021T060500Z.tar.enc'
        }
      ]
    })
  ).toEqual([
    ['pg_dump', '--format=custom', '--dbname=postgres://tm@postgres/tm', '--file=/tmp/tm-backup/2026-10-21/db.dump'],
    ['rclone', 'copyto', '/tmp/tm-backup/2026-10-21/db.dump', 'tm-backup:2026-10-21/db.dump'],
    [
      'rclone',
      'copyto',
      '/srv/tolongmeeting/profiles/i1/checkpoints/20261021T060500Z.tar.enc',
      'tm-backup:2026-10-21/profiles/i1.tar.enc'
    ],
    ['rclone', 'delete', '--min-age', '7d', 'tm-backup:'],
    ['rclone', 'rmdirs', '--leave-root', 'tm-backup:']
  ])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/scheduler/src/retention.test.ts packages/scheduler/src/backup.test.ts`

Expected: FAIL with `Cannot find module './retention'`.

- [ ] **Step 3: Implement retention and backups**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/scheduler/src/retention.test.ts packages/scheduler/src/backup.test.ts`

Expected: PASS, `5 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src/retention* packages/scheduler/src/backup*
git commit -m "feat(scheduler): add retention and backups"
```

### Task 21: Processes, Compose and worker network

**Files:**

- Create: `packages/scheduler/src/jobs.ts`, `packages/scheduler/src/main.ts`, `packages/web/app/api/health/route.ts`, `docker/compose.yaml`, `docker/caddy/Caddyfile`, `docker/app/Dockerfile`, `docker/firewall/worker-egress.sh`, `docker/firewall/tm-worker-egress.service`, `docker/firewall/check-egress.sh`, `.env.example`
- Test: `packages/scheduler/src/jobs.test.ts`, `packages/web/test/env-example.test.ts`

**Interfaces:**

- Consumes: every job handler from Tasks 5, 6, 14, 15, 18, 19 and 20; `QUEUES` (Task 6); `WORKER_IMAGE`, `CADDY_WORKER_IP` (Task 13).
- Produces: `registerJobs(boss: BossLike, h: JobHandlers): Promise<void>`, where `BossLike = { createQueue(name: string): Promise<void>; schedule(name: string, cron: string, data: object, opts: { tz: string }): Promise<void>; work(name: string, opts: { localConcurrency: number }, handler: (jobs: { data: any }[]) => Promise<void>): Promise<string> }` and `JobHandlers = Record<'expand' | 'launch' | 'signinStart' | 'deleteOccurrence' | 'retention' | 'backup' | 'orgCheck', (data: any) => Promise<void>>`.
- Produces (adds to contracts): compose services `caddy`, `web`, `scheduler`, `pipeline`, `postgres`, `ntfy`, `docker-proxy` and the build-only `worker`; networks `app`, `gate` and `tm-workers`; the environment variable `POSTGRES_PASSWORD` (compose only); the use of `TM_DATA_ROOT` by `web` (read-only, for serving artefacts), of `NTFY_URL` by `scheduler` and `pipeline`, and of `GITHUB_ORG` by `scheduler` (daily check).

`main.ts` reads the environment, loads the master key, starts pg-boss on `DATABASE_URL`, calls `registerJobs`, runs `syncOccurrences` once, and runs `monitorTick` every 5 seconds, skipping a tick while the previous one runs; `main.ts --run <queue>` instead runs that queue's handler once and exits (the acceptance steps use it). Every job's `localConcurrency` is 1. Schedules, all `tz: 'UTC'`: `expand` `0 * * * *`, `retention` `7 * * * *`, `org-check` `30 18 * * *` (02:30 in Malaysia), `backup` `0 19 * * *` (03:00 in Malaysia). `pipeline` is created here but worked by `tm-pipeline`. `/api/health` answers `200 ok` after a `select 1`.

`docker/compose.yaml` (key lines; run as `docker compose -f docker/compose.yaml --env-file .env ...`; host paths are the same inside containers so the gate's bind sources are host paths):

```yaml
name: tolongmeeting
services:
  caddy:
    image: caddy:2
    ports: ['80:80', '443:443', '443:443/udp']
    environment: [TM_PUBLIC_URL, NTFY_URL]
    volumes: ['./caddy/Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data']
    networks: { app: {}, tm-workers: { ipv4_address: 172.30.0.2 } }
  web:
    build: { context: .., dockerfile: docker/app/Dockerfile, target: web }
    env_file: ../.env
    environment: { TM_MASTER_KEY_FILE: /run/secrets/tm_master_key }
    secrets: [tm_master_key]
    volumes: ['${TM_DATA_ROOT}:${TM_DATA_ROOT}:ro']
    networks: [app]
  scheduler:
    build: { context: .., dockerfile: docker/app/Dockerfile, target: scheduler }
    env_file: ../.env
    environment:
      {
        TM_MASTER_KEY_FILE: /run/secrets/tm_master_key,
        DOCKER_PROXY_URL: 'http://docker-proxy:2375',
        RCLONE_CONFIG: /run/secrets/rclone_conf
      }
    secrets: [tm_master_key, rclone_conf]
    volumes: ['${TM_DATA_ROOT}:${TM_DATA_ROOT}', '${TM_PROFILE_ROOT}:${TM_PROFILE_ROOT}']
    networks: [app, gate]
    depends_on: [postgres, docker-proxy]
  pipeline:
    image: tolongmeeting/worker:current
    entrypoint: ['bun', 'run', 'packages/pipeline/src/consumer-main.ts']
    env_file: ../.env
    environment: { TM_MASTER_KEY_FILE: /run/secrets/tm_master_key }
    secrets: [tm_master_key]
    volumes: ['${TM_DATA_ROOT}:${TM_DATA_ROOT}']
    networks: [app]
    depends_on: [scheduler]
  postgres:
    image: postgres:17
    environment: { POSTGRES_USER: tm, POSTGRES_DB: tm, POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}' }
    volumes: ['pg-data:/var/lib/postgresql/data']
    networks: [app]
  ntfy:
    image: binwiederhier/ntfy:v2.14.0
    command: serve
    environment:
      {
        NTFY_BASE_URL: '${NTFY_URL}',
        NTFY_AUTH_FILE: /var/lib/ntfy/user.db,
        NTFY_AUTH_DEFAULT_ACCESS: deny-all,
        NTFY_BEHIND_PROXY: 'true',
        NTFY_CACHE_FILE: /var/lib/ntfy/cache.db
      }
    volumes: ['ntfy-data:/var/lib/ntfy']
    networks: [app]
  docker-proxy:
    build: { context: .., dockerfile: docker/app/Dockerfile, target: gate }
    environment: [TM_DATA_ROOT, TM_PROFILE_ROOT, TM_PUBLIC_URL, NTFY_URL]
    volumes: ['/var/run/docker.sock:/var/run/docker.sock']
    networks: [gate]
  worker:
    profiles: [build]
    image: tolongmeeting/worker:current
    build: { context: .., dockerfile: docker/worker/Dockerfile }
networks:
  app: {}
  gate: { internal: true }
  tm-workers:
    name: tm-workers
    driver_opts: { com.docker.network.bridge.name: tm-workers0, com.docker.network.bridge.enable_icc: 'false' }
    ipam: { config: [{ subnet: 172.30.0.0/24 }] }
secrets:
  tm_master_key: { file: /srv/tolongmeeting/secrets/master.key }
  rclone_conf: { file: /srv/tolongmeeting/secrets/rclone.conf }
volumes: { caddy-data: {}, pg-data: {}, ntfy-data: {} }
```

The `pipeline` service reuses the worker image, which already holds Bun, ffmpeg and 1A's pipeline dependencies. The ntfy tag is pinned and moves only with a passing test ping; ntfy attachments stay off unless spike 8 allowed them.

`docker/caddy/Caddyfile`:

```caddyfile
{$TM_PUBLIC_URL} {
	handle /vnc/* {
		request_header -X-Vnc-Upstream
		forward_auth web:3000 {
			uri /api/vnc/authorize
			copy_headers X-Vnc-Upstream
		}
		reverse_proxy {http.request.header.X-Vnc-Upstream}
	}
	handle {
		encode zstd gzip
		reverse_proxy web:3000
	}
}

{$NTFY_URL} {
	reverse_proxy ntfy:80
}
```

`docker/app/Dockerfile` (key lines): base `oven/bun:1` with `bun install --frozen-lockfile`; target `web` runs `bun run --cwd packages/web build` and `CMD ["bun", "--bun", "--cwd", "packages/web", "next", "start", "-p", "3000"]`; target `scheduler` adds `apt-get install -y postgresql-client-17 rclone` and `CMD ["bun", "run", "packages/scheduler/src/main.ts"]`; target `gate` runs `CMD ["bun", "run", "packages/scheduler/src/docker-gate/main.ts"]`.

`docker/firewall/worker-egress.sh`, run at boot after Docker by `tm-worker-egress.service` (`Type=oneshot`, `After=docker.service`, `Requires=docker.service`, `RemainAfterExit=yes`):

```sh
#!/bin/sh
# Egress rules for the tm-workers network: bridge tm-workers0, 172.30.0.0/24, Caddy at 172.30.0.2.
set -eu
BR=tm-workers0
CADDY=172.30.0.2
iptables -N TM-WORKERS 2>/dev/null || iptables -F TM-WORKERS
iptables -C DOCKER-USER -i "$BR" -j TM-WORKERS 2>/dev/null || iptables -I DOCKER-USER -i "$BR" -j TM-WORKERS
iptables -C INPUT -i "$BR" -j DROP 2>/dev/null || iptables -I INPUT -i "$BR" -j DROP   # nothing on the host itself
iptables -A TM-WORKERS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A TM-WORKERS -s "$CADDY" -p tcp --dport 6080 -j ACCEPT                       # Caddy to a worker's noVNC
iptables -A TM-WORKERS -d "$CADDY" -p tcp --dport 443 -j ACCEPT                        # workers to the app API and ntfy
iptables -A TM-WORKERS -d 1.1.1.1,8.8.8.8 -p udp --dport 53 -j RETURN
iptables -A TM-WORKERS -d 1.1.1.1,8.8.8.8 -p tcp --dport 53 -j RETURN
# Private ranges (other containers included), link-local and cloud metadata. 100.64.0.0/10 covers metadata services such as Alibaba Cloud's 100.100.100.200.
iptables -A TM-WORKERS -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10 -j DROP
iptables -A TM-WORKERS -p tcp -m multiport --dports 443,8801:8810 -j RETURN            # HTTPS, Zoom media over TCP
iptables -A TM-WORKERS -p udp -m multiport --dports 443,3478:3481,8801:8810,19302:19309 -j RETURN   # QUIC, TURN, Zoom, Meet
iptables -A TM-WORKERS -j DROP
```

IPv6 (and so `fe80::/10`) is off inside every worker through the `Sysctls` entry of Task 13's spec. `check-egress.sh <public host>` runs `curlimages/curl` on `tm-workers` with the worker's DNS, extra host and sysctl, and prints `ok` or `FAIL` per probe from curl's exit code (0 reachable, 28 dropped): reachable `https://example.com/` and `https://<public host>/api/health`; dropped `http://169.254.169.254/`, `http://100.100.100.200/`, `http://10.0.0.1/`, `http://192.168.0.1/`, `http://172.30.0.1:22/` (the host), `http://172.30.0.2:80/` and `http://example.com/` (port 80). It exits 1 if any probe fails.

`.env.example`:

```ini
# Every variable is set on the server in .env; values are never committed.
# Root of occurrence directories, e.g. /srv/tolongmeeting/data
TM_DATA_ROOT=
# Root of identity profiles on the encrypted volume, e.g. /srv/tolongmeeting/profiles
TM_PROFILE_ROOT=
# Set by compose to the Docker secret /run/secrets/tm_master_key (32 bytes, base64)
TM_MASTER_KEY_FILE=
# Worker selector maps; the image default is /app/config/selectors
TM_SELECTORS_DIR=
# The website's base URL, e.g. https://tm.example
TM_PUBLIC_URL=
# postgres://tm:<password>@postgres:5432/tm
DATABASE_URL=
POSTGRES_PASSWORD=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_ORG=
# Set by compose to http://docker-proxy:2375
DOCKER_PROXY_URL=
# ntfy base URL, e.g. https://ntfy.tm.example, and the ntfy admin user's token
NTFY_URL=
NTFY_ADMIN_TOKEN=
# rclone crypt remote for nightly backups, e.g. tm-backup:
TM_BACKUP_REMOTE=
# TM_PROFILE_KEY_FILE is set per container by the launcher, never here.
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/scheduler/src/jobs.test.ts
test('the scheduler registers its queues, schedules and workers', async () => {
  const boss = new FakeBoss()
  await registerJobs(boss, noopHandlers())
  expect(boss.queues.sort()).toEqual([
    'backup',
    'delete-occurrence',
    'expand',
    'launch',
    'org-check',
    'pipeline',
    'retention',
    'signin-start'
  ])
  expect(boss.schedules).toEqual([
    { name: 'expand', cron: '0 * * * *', tz: 'UTC' },
    { name: 'retention', cron: '7 * * * *', tz: 'UTC' },
    { name: 'org-check', cron: '30 18 * * *', tz: 'UTC' },
    { name: 'backup', cron: '0 19 * * *', tz: 'UTC' }
  ])
  expect(boss.workers.sort()).toEqual([
    'backup',
    'delete-occurrence',
    'expand',
    'launch',
    'org-check',
    'retention',
    'signin-start'
  ])
})
```

```ts
// packages/web/test/env-example.test.ts
test('.env.example names every variable and holds no values', async () => {
  const lines = (await Bun.file('.env.example').text()).split('\n').filter((l) => l && !l.startsWith('#'))
  expect(lines.map((l) => l.split('=')[0]).sort()).toEqual([
    'DATABASE_URL',
    'DOCKER_PROXY_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_ORG',
    'NTFY_ADMIN_TOKEN',
    'NTFY_URL',
    'POSTGRES_PASSWORD',
    'TM_BACKUP_REMOTE',
    'TM_DATA_ROOT',
    'TM_MASTER_KEY_FILE',
    'TM_PROFILE_ROOT',
    'TM_PUBLIC_URL',
    'TM_SELECTORS_DIR'
  ])
  expect(lines.every((l) => l.endsWith('='))).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/scheduler/src/jobs.test.ts packages/web/test/env-example.test.ts`

Expected: FAIL with `Cannot find module './jobs'`.

- [ ] **Step 3: Write the processes and the deployment files**

- [ ] **Step 4: Run tests and validate the deployment files**

Run: `bun test packages/scheduler/src/jobs.test.ts packages/web/test/env-example.test.ts && docker compose -f docker/compose.yaml --env-file .env config --quiet && docker run --rm -e TM_PUBLIC_URL=https://tm.example -e NTFY_URL=https://ntfy.tm.example -v "$PWD/docker/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sh -n docker/firewall/worker-egress.sh && sh -n docker/firewall/check-egress.sh && docker compose -f docker/compose.yaml --env-file .env build`

Expected: PASS, `2 pass, 0 fail`; compose prints nothing and exits 0 (with a local `.env` filled with example values); Caddy prints `Valid configuration`; both shell checks exit 0; every image builds.

- [ ] **Step 5: Commit**

```bash
git add packages/scheduler/src/jobs* packages/scheduler/src/main.ts packages/web/app/api/health packages/web/test/env-example.test.ts docker .env.example
git commit -m "feat: add compose deployment"
```

### Task 22: Milestone acceptance

**Files:**

- Modify: `docs/plans/01c-website-and-scheduler.md` (tick the boxes and note results)

This task proves the 01c exit criteria (a member signs in, adds an identity and an entry, signs in to accounts through the remote view, and the scheduler runs the occurrence unattended) and the design's crash, isolation and retention acceptance tests, on the Singapore server with real accounts. Use two test members (A and B), both in the TolongLabs GitHub organisation, a Zoom test meeting hosted from a free account (under 40 minutes), and placeholders such as `<meeting-id>` in any notes.

- [ ] **Step 1: Deploy**

Procedure: put `TM_PROFILE_ROOT` on a LUKS-encrypted volume mounted at `/srv/tolongmeeting/profiles`; create the master key with `openssl rand -base64 32 > /srv/tolongmeeting/secrets/master.key` (mode 0400) and the rclone `crypt` remote in `/srv/tolongmeeting/secrets/rclone.conf`; create a GitHub OAuth app with callback `<TM_PUBLIC_URL>/api/auth/callback/github`; fill `.env`; run `docker compose -f docker/compose.yaml --env-file .env --profile build build`, then `up -d`; create the ntfy admin with `docker compose exec ntfy ntfy user add --role=admin tm-admin` and `ntfy token add tm-admin`, put the token in `NTFY_ADMIN_TOKEN` and restart `web`; enable `tm-worker-egress.service`; add A as admin with `add-member.ts` and B as a member from the Admin page.

Pass: `docker compose ps` shows every service running; `docker/firewall/check-egress.sh <public host>` prints only `ok` lines and exits 0; from the scheduler container (`docker compose exec scheduler bun -e ...`), a `fetch` of `http://docker-proxy:2375/containers/json` and a create with `"Privileged": true` both get 403.

- [ ] **Step 2: Exit criteria walkthrough (member A)**

Procedure: A signs in with GitHub; sets up Notifications and presses the test button; saves and tests a DashScope key; adds the identity "University" (server); opens Sign in, signs in to Zoom (and to the form provider) in the remote view, and presses Done; adds a one-off lecture entry starting 70 minutes from now with a fixed Zoom link of the test meeting; then leaves the website alone. At T-10, the host starts the meeting; at T+20, the host ends it.

Pass: the test ping arrives; the entry can't be saved before the key passes; after Done, `profiles.checkpoint_at` is set and the sign-in container is gone; at T-60 the occurrence moves to `starting` and on through `in_meeting` (the meeting page's event log shows each state); the "joined" ping arrives; within 60 seconds of the end the state reaches `transcribing`, and within 10 minutes `completed` with the summary ping; the meeting page shows the summary, attendance record, transcript (timestamps seek the video), slides, chat and event log; `link_used` no longer contains the passcode.

- [ ] **Step 3: Sign-in during a meeting**

Procedure: during a second test meeting, A opens Sign in for "University", signs out of and back in to the form provider in the view, presses Done; in a third, A opens the view and leaves it idle.

Pass: the worker shows `pause_for_signin` and `resume_after_signin` events and a checkpoint; the view shows only the desk (1920x1080, right half); `recording/meeting.mp4` shows no sign-in page at any point; the idle view closes 15 minutes after the last input and the worker resumes on its own (`{ signin: 'resumed', reason: 'idle' }`).

- [ ] **Step 4: Crash (design acceptance test "Crash")**

Procedure: 10 minutes into a test lecture that includes a trusted QR attendance form shown before the crash, run `docker kill tm-worker-<occurrenceId>-a1` on the server.

Pass: within 30 to 35 seconds the occurrence is `restarting` and the "Restarting" ping arrives; `tm-worker-<occurrenceId>-a2` restores the newest checkpoint and is back `in_meeting` within 2 minutes of the kill; the joined recording has one short gap noted in the event log; the form record shows one submission only; a later normal end completes the occurrence.

- [ ] **Step 5: Isolation (design acceptance test "Isolation")**

Procedure: signed in as B, request A's pages and APIs by id: `/meetings/<A occurrence id>`, `/api/meetings/<A occurrence id>/files/recording/meeting.mp4`, `/timetable/<A entry id>`, `/accounts/<A identity id>/signin`, `/vnc/<A sign-in session id>/websockify`; post a heartbeat for A's occurrence with B's own control token; subscribe to A's ntfy topic with B's token (`curl -H "Authorization: Bearer <B token>" <NTFY_URL>/<A topic>/json?poll=1`). As admin A, open the Admin page.

Pass: every page and file returns 404, the VNC request 403, the heartbeat 401 and ntfy 403; the Admin page shows only names, logins, roles, time zones and dates.

- [ ] **Step 6: Retention (design acceptance test "Retention")**

Procedure: on a completed test occurrence, set `delete_after` to now plus 2 days and run `docker compose exec scheduler bun run packages/scheduler/src/main.ts --run retention`; then set it to now minus 1 minute and run it again; then run `--run backup`, and with `rclone touch --timestamp <9 days ago> <remote>old/x` plus another `backup` check expiry.

Pass: the "Deleting in 3 days" ping arrives once; afterwards the occurrence directory is gone, the database holds only the `deleted` tombstone and its one event, and the meeting page says it was deleted; `rclone lsf <remote>` shows the new dated backup and no object older than 7 days.

- [ ] **Step 7: Organisation check**

Procedure: remove B from the GitHub organisation, then run `--run org-check` the same way.

Pass: B's open browser session is signed out on the next request, and signing in again shows `Not an active TolongLabs member. Ask an admin to add you.`

- [ ] **Step 8: Commit**

```bash
git add docs/plans/01c-website-and-scheduler.md
git commit -m "docs: tick milestone 1C acceptance"
```
