# Recorder and pings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hand-written job file (`JobConfig`) makes the worker image attend one Zoom meeting as the member, record only the stage, store chat, catch form links (QR and chat) and ping them to the member, transcribe live, and deliver a lecture summary through ntfy, with no website or scheduler.

**Architecture:** A Bun-workspaces monorepo. Pure logic (types, job schema, form state machine, trust and link rules, keyframe maths, summary rendering) lives in `packages/core` and the modules that own it, with `bun test` unit tests. The worker (`packages/worker`, Node 24, Playwright, pinned Chrome on Xvfb 3840x1080 with a recorded stage and an unrecorded desk) runs `runOccurrence` from `tm-worker --job`; then `tm-pipeline --job` turns `transcript/live.jsonl`, kept frames and `chat.jsonl` into `out/` files and the "summary ready" ping. Zoom DOM behaviour is tested against static HTML fixtures; behaviour only real meetings prove is in the final acceptance task.

**Tech Stack:** Bun 1.x, TypeScript (strict), zod, Node 24, Playwright and Playwright Test, Google Chrome (pinned), Xvfb, openbox, PulseAudio, ffmpeg, x11vnc (profile seeding), sharp, zxing-wasm, `ws`, `tar`, self-hosted ntfy, DashScope (OpenAI-compatible chat and `qwen3-asr-flash-realtime` WebSocket).

**Spec:** `docs/app-design/2026-10-20-meeting-bot-design.md` plus `docs/plans/architecture.md`

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Tasks](#tasks)
    1.  [Task 1: Monorepo scaffold and tooling](#task-1-monorepo-scaffold-and-tooling)
    1.  [Task 2: Core types, job schema and form machine](#task-2-core-types-job-schema-and-form-machine)
    1.  [Task 3: Ntfy client and ping copy](#task-3-ntfy-client-and-ping-copy)
    1.  [Task 4: AI chat client](#task-4-ai-chat-client)
    1.  [Task 5: Real-time speech stream](#task-5-real-time-speech-stream)
    1.  [Task 6: Worker image](#task-6-worker-image)
    1.  [Task 7: Screen and browser launch](#task-7-screen-and-browser-launch)
    1.  [Task 8: Profile preparation and checkpoints](#task-8-profile-preparation-and-checkpoints)
    1.  [Task 9: Recorder](#task-9-recorder)
    1.  [Task 10: Audio source, frame loop and health alerts](#task-10-audio-source-frame-loop-and-health-alerts)
    1.  [Task 11: QR decoding](#task-11-qr-decoding)
    1.  [Task 12: Form links and trust](#task-12-form-links-and-trust)
    1.  [Task 13: Zoom adapter join and admission](#task-13-zoom-adapter-join-and-admission)
    1.  [Task 14: Zoom adapter in-meeting signals](#task-14-zoom-adapter-in-meeting-signals)
    1.  [Task 15: Chat capture](#task-15-chat-capture)
    1.  [Task 16: Form pings](#task-16-form-pings)
    1.  [Task 17: Live transcription in the worker](#task-17-live-transcription-in-the-worker)
    1.  [Task 18: Occurrence run and tm-worker CLI](#task-18-occurrence-run-and-tm-worker-cli)
    1.  [Task 19: Transcript and chat documents](#task-19-transcript-and-chat-documents)
    1.  [Task 20: Slides](#task-20-slides)
    1.  [Task 21: Lecture summary and tm-pipeline CLI](#task-21-lecture-summary-and-tm-pipeline-cli)
    1.  [Task 22: Milestone acceptance](#task-22-milestone-acceptance)

## Global Constraints

- Names, paths, types, functions and environment variables are exactly those in `docs/plans/architecture.md`; anything new is listed in a task's Interfaces block as "adds to contracts" and added to `architecture.md` in that task's commit.
- Runtimes: Bun 1.x for everything except the worker, which runs on Node 24 and is built with `bun build --target=node`.
- TypeScript strict everywhere; zod validates the job file, every model JSON reply and every selector map.
- Spike outputs this plan reads: spike 2 (`docker/worker/versions.env`, Chrome flags, desk-muting method, Zoom DOM texts), spike 3 (QR decoder choice), spike 5 (ASR event names and model), spike 6 (ffmpeg preset), spike 8 (summary attachments). If a spike report contradicts this plan, fix the plan in the same commit as the code.
- The worker never clicks microphone, camera, chat input, reactions, share or record controls, never types in a meeting, and never synthesises OS-level keyboard or mouse input (no `xdotool`).
- Notices are acknowledged only through the allowlist `OK`, `Got it`; every click is logged as a `notice_dismissed` event.
- Screen: Xvfb 3840x1080; stage `{ x: 0, y: 0, width: 1920, height: 1080 }`; desk `{ x: 1920, y: 0, width: 1920, height: 1080 }`; only the stage is recorded, scanned for QR codes and used for slides.
- Recording: stage only, 1920x1080, 15 frames per second, H.264, AAC, wall-clock timestamps, 5-minute Matroska segments `recording/attempt_<N>_seg_<NNN>.mkv`, joined into `recording/meeting.mkv` at the end.
- Timings: join from T-10, frames every 2 seconds, chat sweeps every 10 minutes, profile checkpoints every 5 minutes, hard stop at the scheduled end plus 30 minutes.
- Forms: only final URLs on `docs.google.com/forms`, `forms.gle`, `forms.office.com` or `forms.microsoft.com` count; at most 5 redirects, no cookies, 5 seconds; a QR code counts after 2 consecutive frames; each form once per meeting; every form ping within 30 seconds of first sight.
- In 1A the bot never opens or submits a form: trusted form links are pinged for one-tap manual submission; untrusted ones get "form seen, not submitted".
- Pings: high priority for form, alert and sign-in pings; normal for "joined" and "summary ready"; meeting links and passcodes never appear in ping text.
- Secrets (AI key, ntfy token, master key, profile key) are never logged, printed or put in URL query strings; logs and events redact `pwd=` values and tokens, and keep only host and path of URLs.
- AI calls send `enable_thinking: false`; models come from `cfg.ai.models` (defaults `qwen3.7-plus`, `qwen3-vl-plus`, `qwen-flash`, `qwen3-asr-flash-realtime`).
- Summary: two steps (uncapped inventory, then render), source priority slide > lecturer chat > speech, at most 5 items per section with the rest under "More deadlines", no preamble or recap, file `YYYY-MM-DD HHmm <entry name>.md` in the entry's time zone.
- Commits: conventional commits, header at most 50 characters, one task per commit or less.

## Review Focus

- Zoom link variants (vanity subdomains, links without `pwd`, `#success` fragments, links already on `/wc/`, personal `/my/` links, look-alike hosts such as `zoom.us.example.com`): each must become the `/wc/join/` URL or be refused with a ping, never open the launcher page. Test added to Task 13.
- The same form posted in different shapes (a `forms.gle` short link, the long `viewform` URL with `usp=` and pre-filled `entry.` parameters, a Safe Links wrapper): the member must get one ping, not three. Test added to Task 12.
- A host who never admits the bot, or who ends the meeting while the bot is still in the lobby: the bot must stop at the deadline, ping once and still checkpoint the profile. Test added to Task 18.
- ffmpeg dying mid-meeting (killed by memory pressure or a pulse hiccup): recording must resume in the next segment number within seconds and the gap must be logged, not silently lost. Test added to Task 9.
- A container clock in UTC while the entry is in `Asia/Kuala_Lumpur`, and entry names with `/`, `:` or Malay text: the summary file name and template dates must use the entry's time zone and a safe file name. Test added to Task 21.

## Tasks

### Task 1: Monorepo scaffold and tooling

> **Done differently**: the workspace setup was copied from `TolongLabs/sdp-hack` instead (see [architecture](architecture.md#tooling-and-conventions)): `tsconfig.json`, `.prettierrc.json`, `commitlint.config.mjs`, scripts `lint` and `lint:fix` in place of `format`, and the `test/core-pure.test.ts` guardrail in place of `scripts/repo.test.ts`. The package skeletons, `.env.example`, `scripts/build-worker-image.sh` and the `build:worker`, `image:worker`, `tm-worker` and `tm-pipeline` scripts are as below.

**Files:**

- Create: `package.json`, `tsconfig.base.json`, `.prettierrc`, `.prettierignore`, `commitlint.config.js`, `.husky/pre-commit`, `.husky/commit-msg`, `.env.example`, `.gitignore`, `scripts/build-worker-image.sh`
- Create: `packages/{core,ai,notify,worker,pipeline}/package.json`, `packages/{core,ai,notify,worker,pipeline}/tsconfig.json`, `packages/{core,ai,notify,worker,pipeline}/src/index.ts`
- Test: `scripts/repo.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (adds to contracts): workspace package names `@tm/core`, `@tm/ai`, `@tm/notify`, `@tm/worker`, `@tm/pipeline`; root scripts `test`, `typecheck`, `format`, `build:worker`, `image:worker`, `tm-worker`, `tm-pipeline`.

- [x] **Step 1: Write the failing test**

```ts
// scripts/repo.test.ts
import { test, expect } from 'bun:test'
const read = (p: string) => Bun.file(p).text()

test('env example lists every architecture variable with no value', async () => {
  const lines = (await read('.env.example'))
    .trim()
    .split('\n')
    .filter((l) => !l.startsWith('#'))
  expect(lines).toEqual([
    'TM_DATA_ROOT=',
    'TM_PROFILE_ROOT=',
    'TM_MASTER_KEY_FILE=',
    'TM_SELECTORS_DIR=',
    'TM_PUBLIC_URL=',
    'DATABASE_URL=',
    'GITHUB_CLIENT_ID=',
    'GITHUB_CLIENT_SECRET=',
    'GITHUB_ORG=',
    'DOCKER_PROXY_URL=',
    'NTFY_URL=',
    'NTFY_ADMIN_TOKEN='
  ])
})

test('workspaces, scripts and package names', async () => {
  const root = JSON.parse(await read('package.json'))
  expect(root.workspaces).toEqual(['packages/*'])
  for (const s of ['test', 'typecheck', 'format', 'build:worker', 'image:worker', 'tm-worker', 'tm-pipeline'])
    expect(root.scripts[s]).toBeString()
  for (const p of ['core', 'ai', 'notify', 'worker', 'pipeline']) {
    const pkg = JSON.parse(await read(`packages/${p}/package.json`))
    expect(pkg.name).toBe(`@tm/${p}`)
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit -p tsconfig.json')
  }
})

test('commitlint caps the header at 50 characters', async () => {
  const cfg = (await import('../commitlint.config.js')).default
  expect(cfg.extends).toEqual(['@commitlint/config-conventional'])
  expect(cfg.rules['header-max-length']).toEqual([2, 'always', 50])
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test scripts/repo.test.ts`
Expected: FAIL with "ENOENT" for `.env.example`.

- [x] **Step 3: Implement the scaffold**

Root `package.json`: `"private": true`, `"workspaces": ["packages/*"]`, `"type": "module"`, scripts `test: bun test`, `typecheck: bun run --filter '*' typecheck`, `format: bunx prettier --write .`, `build:worker: bun build packages/worker/src/cli.ts --target=node --outdir packages/worker/dist --external playwright --external sharp --external zxing-wasm`, `image:worker: sh scripts/build-worker-image.sh`, `tm-worker: node packages/worker/dist/cli.js`, `tm-pipeline: bun packages/pipeline/src/cli.ts`, `prepare: husky`, and `"lint-staged": { "*.{ts,js,json,md,yaml,yml}": "prettier --write" }`. Dev dependencies: `typescript`, `prettier`, `husky`, `lint-staged`, `@commitlint/cli`, `@commitlint/config-conventional`, `@types/bun`, `zod` at the root for all packages. `tsconfig.base.json`: `strict: true`, `target: "ES2023"`, `module: "ESNext"`, `moduleResolution: "bundler"`, `noUncheckedIndexedAccess: true`, `skipLibCheck: true`. `.prettierrc` is `{}`; `.prettierignore` lists `dist`, `bun.lock`, `test-results` and `packages/worker/test/fixtures`. `.husky/pre-commit` runs `bunx lint-staged`; `.husky/commit-msg` runs `bunx --no -- commitlint --edit "$1"`. `.gitignore`: `node_modules`, `dist`, `.env`, `data/`, `test-results/`. `packages/worker/package.json` sets `"engines": { "node": ">=24" }` and its tsconfig adds `"types": ["node"]`. `scripts/build-worker-image.sh`:

```bash
#!/bin/sh
set -eu
docker build $(grep -v '^#' docker/worker/versions.env | sed 's/^/--build-arg=/') -f docker/worker/Dockerfile -t tm-worker:dev .
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun install && bun test scripts/repo.test.ts && bun run typecheck`
Expected: 3 pass, typecheck exits 0. Then `printf 'feat: %s\n' "$(printf 'x%.0s' $(seq 1 46))" | bunx commitlint` exits 1 with "header must not be longer than 50 characters".

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold bun workspaces and tooling"
```

### Task 2: Core types, job schema and form machine

**Files:**

- Create: `packages/core/src/types.ts`, `packages/core/src/job.ts`, `packages/core/src/form-machine.ts`, `packages/core/src/time.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/job.test.ts`, `packages/core/src/form-machine.test.ts`, `packages/core/src/time.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: every type in architecture "Core types", verbatim, plus `JobConfig`, `LinkSource`, `JobConfigSchema`, `FormTrigger`, `nextFormState`.
- Produces (adds to contracts):
  - `ChatMessage.replyTo: string | null` (key of the parent message for a thread reply);
  - `JobConfig.identity.formProviders: FormProvider[]` (the providers this identity is signed in to, checked before lectures);
  - `AiConfig` and `NtfyConfig` interfaces and their zod schemas are declared in `packages/core/src/job.ts`; `@tm/ai` and `@tm/notify` re-export them, so the architecture's import sites still hold;
  - `parseJob(json: unknown): JobConfig` (throws `JobError` whose message lists issue paths only, never values);
  - `class IllegalTransition extends Error` (message `${from} --${trigger}-->`);
  - `formatOffset(ms: number): string` (`HH:MM:SS`), `localParts(at: Date | string, timeZone: string): { date: string; hhmm: string; hhmmss: string; weekday: string; dayMonthYear: string }` (`2026-10-21`, `2000`, `200000`, `Wed`, `21 Oct 2026`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/form-machine.test.ts
import { test, expect } from 'bun:test'
import { nextFormState, IllegalTransition } from './form-machine'

test('1A path to a manual-submission ping', () => {
  expect(nextFormState('detected', 'resolve')).toBe('resolving')
  expect(nextFormState('resolving', 'resolved')).toBe('checking_trust')
  expect(nextFormState('checking_trust', 'manual_only')).toBe('needs_member')
  expect(nextFormState('checking_trust', 'untrusted')).toBe('untrusted')
  for (const s of ['detected', 'resolving', 'checking_trust'] as const) expect(nextFormState(s, 'fail')).toBe('failed')
})

test('terminal states accept no trigger', () => {
  for (const s of ['untrusted', 'needs_member', 'failed'] as const)
    expect(() => nextFormState(s, 'fail')).toThrow(IllegalTransition)
  expect(() => nextFormState('detected', 'resolved')).toThrow('detected --resolved-->')
})
```

```ts
// packages/core/src/job.test.ts (fixture: a complete valid job object `validJob` built in the test file)
test('valid job parses; bad values are reported by path only', () => {
  expect(parseJob(validJob).entry.timeZone).toBe('Asia/Kuala_Lumpur')
  const bad = {
    ...validJob,
    ai: { ...validJob.ai, apiKey: '' },
    entry: { ...validJob.entry, timeZone: 'Mars/Base' }
  }
  expect(() => parseJob(bad)).toThrow(/ai\.apiKey.*entry\.timeZone|entry\.timeZone.*ai\.apiKey/s)
  try {
    parseJob({
      ...validJob,
      ai: { ...validJob.ai, baseUrl: 'sk-secret-value' }
    })
  } catch (e) {
    expect(String(e)).not.toContain('sk-secret-value')
  }
})
test('end after start, safe occurrence id, absolute dirs, wss asr url', () => {
  expect(() =>
    parseJob({
      ...validJob,
      entry: { ...validJob.entry, end: validJob.entry.start }
    })
  ).toThrow('entry.end')
  expect(() => parseJob({ ...validJob, occurrenceId: '../x' })).toThrow('occurrenceId')
  expect(() => parseJob({ ...validJob, dataDir: 'rel/dir' })).toThrow('dataDir')
  expect(() => parseJob({ ...validJob, ai: { ...validJob.ai, asrUrl: 'https://x' } })).toThrow('ai.asrUrl')
})
```

```ts
// packages/core/src/time.test.ts
test('offsets and local parts', () => {
  expect(formatOffset(3_723_400)).toBe('01:02:03')
  expect(localParts('2026-10-21T12:00:00Z', 'Asia/Kuala_Lumpur')).toEqual({
    date: '2026-10-21',
    hhmm: '2000',
    hhmmss: '200000',
    weekday: 'Wed',
    dayMonthYear: '21 Oct 2026'
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core`
Expected: FAIL with "Cannot find module './form-machine'".

- [ ] **Step 3: Implement**

`types.ts` copies architecture "Core types" verbatim and adds `replyTo: string | null` to `ChatMessage`. `job.ts`: `JobConfigSchema` per the architecture's `JobConfig` with these rules: `occurrenceId` matches `^[A-Za-z0-9_-]{1,64}$`; `attempt` integer at least 1; `start` and `end` are `z.string().datetime({ offset: true })` with `end > start`; `timeZone` accepted only if `new Intl.DateTimeFormat('en', { timeZone })` doesn't throw; `link` is a discriminated union on `kind`; `ai.baseUrl` is a URL, `ai.apiKey` non-empty, `ai.asrUrl` starts with `wss://`; `ntfy.url` is a URL, `topic` and `token` non-empty; `dataDir` and `profileDir` absolute; `identity.zoomGuestName` non-empty; `identity.formProviders` an array of `'google' | 'microsoft'`; `control` nullable. `form-machine.ts`:

```ts
export type FormTrigger = 'resolve' | 'resolved' | 'untrusted' | 'manual_only' | 'fail'
// 1A table. Plan 01b adds 'trusted' (checking_trust -> opening) and the later triggers; it does not change these rows.
const table: Partial<Record<FormState, Partial<Record<FormTrigger, FormState>>>> = {
  detected: { resolve: 'resolving', fail: 'failed' },
  resolving: { resolved: 'checking_trust', fail: 'failed' },
  checking_trust: {
    untrusted: 'untrusted',
    manual_only: 'needs_member',
    fail: 'failed'
  }
}
```

`time.ts` uses `Intl.DateTimeFormat` with the given `timeZone` (never the process zone).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core docs/plans/architecture.md
git commit -m "feat(core): add types, job schema, form machine"
```

### Task 3: Ntfy client and ping copy

**Files:**

- Create: `packages/notify/src/ntfy.ts`, `packages/notify/src/messages.ts`
- Modify: `packages/notify/src/index.ts`, `packages/notify/package.json` (depends on `@tm/core`)
- Test: `packages/notify/src/ntfy.test.ts`, `packages/notify/src/messages.test.ts`

**Interfaces:**

- Consumes: `NtfyConfig`, `ResolvedForm`, `FormCandidate`, `TrustReason` from `@tm/core`.
- Produces: `sendPing(cfg: NtfyConfig, ping: Ping): Promise<void>`, `Ping`, `PingAction`, re-exported `NtfyConfig`.
- Produces (adds to contracts): `class PingError extends Error { status: number | null }`; `type AlertKind = 'black_frames' | 'frozen_silent' | 'dropped' | 'rejoin_failed' | 'removed' | 'breakout' | 'lobby_denied' | 'not_admitted' | 'join_failed' | 'zoom_signin' | 'devices_on' | 'no_audio' | 'signin_forms' | 'ai_key' | 'recording_gap'`; builders `joinedPing`, `formToSubmitPing`, `formNotSubmittedPing`, `linkUncheckedPing`, `alertPing`, `summaryReadyPing`, `summaryFailedPing` with the signatures below.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/notify/src/ntfy.test.ts: a Bun.serve fake records each request
test('JSON publish with bearer token, priority and view actions', async () => {
  await sendPing(cfg, {
    title: 'Joined: Data Mining',
    message: 'm',
    priority: 'high',
    actions: [{ label: 'Open form', url: 'https://forms.gle/<form-id>' }]
  })
  const r = fake.requests[0]
  expect(r.method).toBe('POST')
  expect(r.path).toBe('/')
  expect(r.headers.authorization).toBe('Bearer tk_test')
  expect(r.json).toEqual({
    topic: 'member-topic',
    title: 'Joined: Data Mining',
    message: 'm',
    priority: 4,
    actions: [
      {
        action: 'view',
        label: 'Open form',
        url: 'https://forms.gle/<form-id>',
        clear: false
      }
    ]
  })
})
test('attachment is a PUT to the topic with RFC 2047 headers for non-ASCII', async () => {
  await sendPing(cfg, {
    title: 'Ringkasan: Kuliah 5 — Pengenalan',
    message: 'x',
    priority: 'default',
    attachPath: tmpFile
  })
  const r = fake.requests[0]
  expect(r.method).toBe('PUT')
  expect(r.path).toBe('/member-topic')
  expect(r.headers.title).toStartWith('=?UTF-8?B?')
  expect(r.headers.priority).toBe('3')
  expect(r.headers.filename).toBe(basename(tmpFile))
})
test('5xx retried twice then PingError; 4xx not retried', async () => {
  fake.failWith(503)
  await expect(sendPing(cfg, ping)).rejects.toBeInstanceOf(PingError)
  expect(fake.requests.length).toBe(3)
  fake.reset()
  fake.failWith(403)
  await expect(sendPing(cfg, ping)).rejects.toThrow('403')
  expect(fake.requests.length).toBe(1)
})
```

```ts
// packages/notify/src/messages.test.ts
test('ping copy', () => {
  expect(joinedPing('Data Mining', 41)).toEqual({
    title: 'Joined: Data Mining',
    message: 'In the meeting with 41 participants. Recording.',
    priority: 'default'
  })
  const p = formToSubmitPing('Data Mining', resolvedQr, 'qr_on_screen', '20:41')
  expect(p.priority).toBe('high')
  expect(p.actions).toEqual([{ label: 'Open form', url: resolvedQr.finalUrl }])
  expect(p.message).toBe(
    "A form from a QR code on the shared screen was seen at 20:41. The bot doesn't submit forms yet: open it and submit it yourself."
  )
  expect(formNotSubmittedPing('Data Mining', resolvedChat, '20:42').message).toBe(
    "Student A posted a form in the chat at 20:42. They aren't the host, a co-host or a trusted sender, so it wasn't treated as an attendance form."
  )
  expect(alertPing('Data Mining', 'black_frames').title).toBe('Alert: Data Mining')
  expect(summaryReadyPing('Data Mining', 'x'.repeat(5000)).message.length).toBeLessThanOrEqual(
    3900 + '\n(truncated)'.length
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/notify`
Expected: FAIL with "Cannot find module './ntfy'".

- [ ] **Step 3: Implement**

`sendPing`: without `attachPath`, `POST ${cfg.url}` with JSON `{ topic, title, message, priority, actions? }` where `priority` is 4 for `'high'` and 3 for `'default'` and each action is `{ action: 'view', label, url, clear: false }`. With `attachPath`, `PUT ${cfg.url}/${topic}` with the file as body and headers `Title`, `Message`, `Priority`, `Actions` (`view, <label>, <url>` joined by `; `), `Filename`; any non-ASCII header value is sent as `=?UTF-8?B?<base64>?=`. Header `Authorization: Bearer <token>`; 10-second timeout per request; network errors and 5xx retried after 1 s and 2 s; 4xx throws at once. Never log the token or the message. `messages.ts` copy (exact):

```text
joinedPing(entry, n)              title "Joined: <entry>"; message "In the meeting with <n> participants. Recording." (n null: "In the meeting. Recording."); default
formToSubmitPing(entry, f, reason, hhmm)
                                  title "Form to submit: <entry>"; message "A form from <source> was seen at <hh:mm>. The bot doesn't submit forms yet: open it and submit it yourself."; high; action "Open form" -> f.finalUrl
                                  <source>: qr_on_screen "a QR code on the shared screen"; host "the host"; co_host "a co-host"; trusted_sender "<sender>"
formNotSubmittedPing(entry, f, hhmm)
                                  title "Form seen, not submitted: <entry>"; message "<sender or Someone> posted a form in the chat at <hh:mm>. They aren't the host, a co-host or a trusted sender, so it wasn't treated as an attendance form."; high; action "Open form"
linkUncheckedPing(entry, c, hhmm) title "Link seen, not checked: <entry>"; message "<source> shared a link at <hh:mm> that couldn't be checked within 5 seconds. It may be a form."; high; action "Open link" -> c.url
alertPing(entry, kind, detail?)   title "Alert: <entry>"; high; message by kind:
  black_frames   "The recording has been black for 10 seconds."
  frozen_silent  "Picture and sound have been frozen for 5 minutes."
  dropped        "The bot dropped out of the meeting and is rejoining."
  rejoin_failed  "The bot dropped out of the meeting again and stopped."
  removed        "The host removed the bot from the meeting."
  breakout       "The meeting offered a breakout room. The bot stays in the main room."
  lobby_denied   "The host didn't let the bot in."
  not_admitted   "The bot was still waiting to be let in at the hard stop."
  join_failed    "The bot couldn't join: <detail>."
  zoom_signin    "Zoom asked to sign in. Re-seed the profile, then run the job again."
  devices_on     "A microphone or camera showed as on, so the bot left the meeting."
  no_audio       "No meeting sound reached the recorder in the first 2 minutes."
  signin_forms   "The <detail> forms sign-in has expired. Form links will still be pinged to you."
  ai_key         "Your AI key was rejected (<detail>). Recording continues; the summary needs a working key."
  recording_gap  "The recorder restarted; <detail> seconds are missing from the recording."
summaryReadyPing(entry, md, attachPath?)
                                  title "Summary ready: <entry>"; message md cut to 3,900 bytes plus "\n(truncated)" when cut; default
summaryFailedPing(entry, status)  title "Summary failed: <entry>"; message "Your AI key was rejected (<status>). Everything is kept; run tm-pipeline again after fixing the key."; high
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/notify`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/notify docs/plans/architecture.md
git commit -m "feat(notify): add ntfy client and ping copy"
```

### Task 4: AI chat client

**Files:**

- Create: `packages/ai/src/chat.ts`, `packages/ai/src/errors.ts`
- Modify: `packages/ai/src/index.ts`, `packages/ai/package.json` (depends on `@tm/core`)
- Test: `packages/ai/src/chat.test.ts`

**Interfaces:**

- Consumes: `AiConfig` from `@tm/core` (re-exported here).
- Produces: `chatJson<T>(cfg, model, messages, schema, timeoutMs, opts?)`, `chatText(cfg, model, messages, timeoutMs, opts?)`, `AiKeyError`.
- Produces (adds to contracts): `type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }`; `interface ChatTurn { role: 'system' | 'user' | 'assistant'; content: string | ChatPart[] }`; the optional last parameter `opts?: { thinking?: boolean }` on both chat functions; `class AiError extends Error { status: number }`; `class AiTimeoutError extends Error`.

- [ ] **Step 1: Write the failing test**

````ts
// packages/ai/src/chat.test.ts: a Bun.serve fake at cfg.baseUrl answers /chat/completions
test('sends thinking off, bearer key and returns text', async () => {
  fake.reply({ choices: [{ message: { content: 'hello' } }] })
  expect(await chatText(cfg, 'qwen3.7-plus', [{ role: 'user', content: 'hi' }], 5000)).toBe('hello')
  expect(fake.last.body).toMatchObject({
    model: 'qwen3.7-plus',
    enable_thinking: false,
    stream: false
  })
  expect(fake.last.headers.authorization).toBe('Bearer sk-test')
})
test('chatJson strips fences, validates, retries once on bad JSON', async () => {
  fake.replies([
    { choices: [{ message: { content: 'not json' } }] },
    { choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }
  ])
  expect(await chatJson(cfg, 'm', msgs, z.object({ a: z.number() }), 5000)).toEqual({ a: 1 })
  expect(fake.last.body.response_format).toEqual({ type: 'json_object' })
})
test('401, 402 and 429 raise AiKeyError; timeouts raise AiTimeoutError', async () => {
  for (const s of [401, 402, 429]) {
    fake.status(s)
    await expect(chatText(cfg, 'm', msgs, 5000)).rejects.toMatchObject({
      name: 'AiKeyError',
      status: s
    })
  }
  fake.delay(200)
  await expect(chatText(cfg, 'm', msgs, 50)).rejects.toBeInstanceOf(AiTimeoutError)
  fake.status(500)
  const e = await chatText(cfg, 'm', msgs, 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(String(e)).not.toContain('sk-test')
})
test('thinking: true is passed through', async () => {
  await chatText(cfg, 'm', msgs, 5000, { thinking: true })
  expect(fake.last.body.enable_thinking).toBe(true)
})
````

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai/src/chat.test.ts`
Expected: FAIL with "Cannot find module './chat'".

- [ ] **Step 3: Implement**

`POST ${cfg.baseUrl}/chat/completions` with `{ model, messages, stream: false, enable_thinking: opts?.thinking ?? false }` (plus `response_format: { type: 'json_object' }` in `chatJson`), `AbortSignal.timeout(timeoutMs)`. `chatJson` takes `choices[0].message.content`, strips a surrounding code fence, `JSON.parse`, `schema.parse`; on a parse or validation failure it retries once with an extra user turn "Your reply was not valid JSON for the schema. Reply with JSON only."; a second failure throws `AiError(422)`. Error bodies are cut to 200 characters and never include the request headers.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai/src/chat.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ai docs/plans/architecture.md
git commit -m "feat(ai): add chat client with key errors"
```

### Task 5: Real-time speech stream

**Files:**

- Create: `packages/ai/src/asr.ts`
- Modify: `packages/ai/src/index.ts`, `packages/ai/package.json` (adds `ws`)
- Test: `packages/ai/src/asr.test.ts`

**Interfaces:**

- Consumes: `AiConfig` (`asrUrl`, `apiKey`, `models.asr`), `AiKeyError` from Task 4.
- Produces: `openAsrStream(cfg: AiConfig, opts?: AsrOptions): AsrStream`.
- Produces (adds to contracts): `interface AsrResult { startMs: number; endMs: number; text: string }` (offsets from the first byte sent); `AsrStream` gains `onError(cb: (e: Error) => void): void`; `interface AsrOptions { now?: () => number; rotateAfterMs?: number; forceRotateMs?: number }`; `dropOverlap(prev: string, next: string): string`; `class AsrDisconnected extends Error`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai/src/asr.test.ts: a `ws` WebSocketServer fake at cfg.asrUrl scripts server events per connection
const sec = (s: number) => Buffer.alloc(32_000 * s) // 16 kHz mono s16le = 32 bytes per ms

test('handshake, session.update and append in 100 ms chunks', async () => {
  const s = openAsrStream(cfg)
  s.send(sec(1))
  await fake.waitForAppends(10)
  expect(fake.conn(0).headers.authorization).toBe('Bearer sk-test')
  expect(fake.conn(0).url).toBe('/realtime?model=qwen3-asr-flash-realtime')
  expect(fake.conn(0).events[0]).toMatchObject({
    type: 'session.update',
    session: {
      input_audio_format: 'pcm',
      sample_rate: 16000,
      turn_detection: { type: 'server_vad' }
    }
  })
  expect(Buffer.from(fake.conn(0).appends[0], 'base64').length).toBe(3200)
})
test('results are stamped with stream offsets, falling back to bytes sent', async () => {
  const got: AsrResult[] = []
  const s = openAsrStream(cfg)
  s.onResult((r) => got.push(r))
  s.send(sec(3))
  fake.emit(0, {
    type: 'input_audio_buffer.speech_started',
    audio_start_ms: 500
  })
  fake.emit(0, {
    type: 'input_audio_buffer.speech_stopped',
    audio_end_ms: 2500
  })
  fake.emit(0, {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'selamat petang semua'
  })
  fake.emit(0, { type: 'input_audio_buffer.speech_started' })
  fake.emit(0, { type: 'input_audio_buffer.speech_stopped' })
  fake.emit(0, {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'okay'
  })
  await until(() => got.length === 2)
  expect(got[0]).toEqual({
    startMs: 500,
    endMs: 2500,
    text: 'selamat petang semua'
  })
  expect(got[1]!.endMs).toBe(3000)
})
test('rotation at a pause replays 5 s and removes duplicate text', async () => {
  let t = 0
  const got: AsrResult[] = []
  const s = openAsrStream(cfg, {
    now: () => t,
    rotateAfterMs: 1000,
    forceRotateMs: 2000
  })
  s.onResult((r) => got.push(r))
  s.send(sec(8))
  t = 1500
  fake.emit(0, {
    type: 'input_audio_buffer.speech_stopped',
    audio_end_ms: 7900
  })
  await fake.waitForConnections(2)
  expect(fake.conn(1).appendedBytes()).toBeGreaterThanOrEqual(160_000)
  fake.emit(0, {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'the deadline is Friday'
  })
  fake.emit(1, {
    type: 'input_audio_buffer.speech_started',
    audio_start_ms: 0
  })
  fake.emit(1, {
    type: 'input_audio_buffer.speech_stopped',
    audio_end_ms: 4000
  })
  fake.emit(1, {
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'deadline is Friday at noon'
  })
  await until(() => got.length === 2)
  expect(got[1]!.text).toBe('at noon')
})
test('dropOverlap', () => {
  expect(dropOverlap('the deadline is Friday', 'Deadline is Friday, at noon')).toBe('at noon')
  expect(dropOverlap('hello', 'world')).toBe('world')
  expect(dropOverlap('see you', 'see you')).toBe('')
})
test('rejected key raises AiKeyError through onError', async () => {
  fake.rejectHandshake(401)
  const errs: Error[] = []
  const s = openAsrStream(cfg)
  s.onError((e) => errs.push(e))
  await until(() => errs.length === 1)
  expect(errs[0]).toMatchObject({ name: 'AiKeyError', status: 401 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ai/src/asr.test.ts`
Expected: FAIL with "Cannot find module './asr'".

- [ ] **Step 3: Implement `openAsrStream(cfg: AiConfig, opts?: AsrOptions): AsrStream` in `packages/ai/src/asr.ts`**

Connect with `ws` to `${cfg.asrUrl}?model=${cfg.models.asr}` with header `Authorization: Bearer <apiKey>`; on open send `session.update` with `{ input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { type: 'server_vad' } }`; audio goes as `input_audio_buffer.append` with base64 `audio` in 3,200-byte (100 ms) chunks; `close()` sends `session.finish` and waits up to 5 s for `session.finished`. Event names are DashScope's real-time protocol as recorded in spike 5's report. Defaults: `rotateAfterMs` 6,000,000 (100 minutes), `forceRotateMs` 6,600,000 (110 minutes). Handshake status 401, 402 or 429, or an `error` event whose `code` matches `/InvalidApiKey|Unauthorized/` (401), `/Arrearage|Quota|insufficient/i` (402) or `/Throttl|RateLimit/i` (429), raises `AiKeyError`. The offset and rotation rules:

```text
sentMs          = total bytes sent across all sessions / 32
session         = { baseMs: sentMs when its first byte (including replay) was sent, openedAt: now() }
speech_started  -> pendingStart = baseMs + (ev.audio_start_ms ?? sentMs - baseMs)
speech_stopped  -> pendingEnd   = baseMs + (ev.audio_end_ms   ?? sentMs - baseMs)
completed       -> r = { startMs: pendingStart ?? lastEnd, endMs: pendingEnd ?? sentMs, text: transcript.trim() }
                   if r comes from a newer session than the last emitted result and r.startMs < lastEnd:
                     r.text = dropOverlap(lastText, r.text); r.startMs = lastEnd
                   drop r when r.text is empty or r.endMs <= lastEnd; else emit it, lastEnd = r.endMs, lastText = r.text
rotation        -> at the first speech_stopped once now() - openedAt >= rotateAfterMs, or unconditionally at forceRotateMs:
                   open a new session and send it the last 5,000 ms of audio from a ring buffer (160,000 bytes), then live audio;
                   the old session gets session.finish, may deliver results for 10 s more, then closes
unexpected close-> reopen with the same 5-second replay, up to 5 tries at 1, 2, 4, 8 and 16 s; then onError(new AsrDisconnected())
dropOverlap     -> compare lowercased words without punctuation; remove the longest prefix of next (at most 30 words)
                   that equals a suffix of prev; return the remaining words of next in their original form
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ai/src/asr.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ai docs/plans/architecture.md
git commit -m "feat(ai): add realtime asr stream with rotation"
```

### Task 6: Worker image

**Files:**

- Create: `docker/worker/Dockerfile`, `docker/worker/entrypoint.sh`, `docker/worker/openbox/rc.xml`, `docker/worker/chrome-policy.json`, `docker/worker/pulse/default.pa`, `docker/worker/selfcheck.sh`, `docker/worker/run-job.sh`
- Modify: `packages/worker/package.json` (exact `playwright` and `@playwright/test` versions from `versions.env`)
- Test: `docker/worker/selfcheck.sh` (runs inside the image)

**Interfaces:**

- Consumes: `docker/worker/versions.env`, written by spike 2 (plan 00), with `CHROME_VERSION`, `PLAYWRIGHT_VERSION`, `FFMPEG_VERSION`, `NODE_VERSION` and `BUN_VERSION`. If it is missing, stop: this task can't start before spike 2.
- Produces (adds to contracts): image `tm-worker:dev`; entrypoint modes `selfcheck`, `test <playwright filter>`, `unit <bun test path>`, `seed --job <path>` and `--job <path>`; PulseAudio sink `tm_sink` and muted null source `tm_mic`; `docker/worker/run-job.sh <job.json> [seed]` as the documented way to start a worker.

- [ ] **Step 1: Write the failing test, `docker/worker/selfcheck.sh`**

```bash
#!/bin/sh
set -eu
. /app/docker/worker/versions.env
google-chrome --version | grep -q " $CHROME_VERSION" || { echo "chrome mismatch"; exit 1; }
[ "$(node --version)" = "v$NODE_VERSION" ] || { echo "node mismatch"; exit 1; }
ffmpeg -version | head -1 | grep -q "$FFMPEG_VERSION" || { echo "ffmpeg mismatch"; exit 1; }
[ "$(node -p "require('/app/node_modules/playwright/package.json').version")" = "$PLAYWRIGHT_VERSION" ] || { echo "playwright mismatch"; exit 1; }
[ "$(pactl get-default-sink)" = "tm_sink" ] || { echo "sink"; exit 1; }
[ "$(pactl get-default-source)" = "tm_mic" ] || { echo "source"; exit 1; }
pactl get-source-mute tm_mic | grep -q "Mute: yes" || { echo "mic not muted"; exit 1; }
[ -f /etc/opt/chrome/policies/managed/tm.json ] || { echo "policy"; exit 1; }
[ "$(df -k /dev/shm | awk 'NR==2 {print $2}')" -ge 2000000 ] || { echo "shm below 2g: run with --shm-size=2g"; exit 1; }
echo "SELFCHECK OK"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run image:worker`
Expected: FAIL with "failed to read dockerfile" (no Dockerfile yet).

- [ ] **Step 3: Implement the image**

Dockerfile key lines (base `ubuntu:24.04`, every version from a build argument, non-root user `tm`, `/app` holds the repository):

```dockerfile
ARG CHROME_VERSION NODE_VERSION FFMPEG_VERSION BUN_VERSION PLAYWRIGHT_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends xvfb openbox pulseaudio pulseaudio-utils x11vnc x11-utils \
    "ffmpeg=${FFMPEG_VERSION}*" libgl1-mesa-dri fonts-noto fonts-noto-cjk fonts-noto-color-emoji jq curl ca-certificates xz-utils
RUN curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
    && apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && mv /root/.bun/bin/bun /usr/local/bin/bun
COPY docker/worker/chrome-policy.json /etc/opt/chrome/policies/managed/tm.json
COPY docker/worker/openbox/rc.xml /etc/xdg/openbox/rc.xml
COPY docker/worker/pulse/default.pa /etc/pulse/default.pa
COPY . /app
# cli.ts arrives in Task 18; until then the image is built without dist/
RUN cd /app && bun install --frozen-lockfile && if [ -f packages/worker/src/cli.ts ]; then bun run build:worker; fi
RUN useradd -m tm && chown -R tm /app
ENV TM_SELECTORS_DIR=/app/config/selectors TM_IN_IMAGE=1
USER tm
ENTRYPOINT ["/app/docker/worker/entrypoint.sh"]
# Run with --shm-size=2g: Chrome's WebRTC tabs crash on Docker's 64 MB default. run-job.sh does this.
```

`chrome-policy.json`:

```json
{
  "URLBlocklist": ["file://*", "chrome://*", "javascript:*", "zoommtg:*", "zoomus:*", "msteams:*"],
  "DeveloperToolsAvailability": 2,
  "DownloadRestrictions": 3,
  "AudioCaptureAllowed": false,
  "VideoCaptureAllowed": false,
  "DefaultNotificationsSetting": 2,
  "PasswordManagerEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "MetricsReportingEnabled": false,
  "PromotionalTabsEnabled": false,
  "ExternalProtocolDialogShowAlwaysOpenCheckbox": false
}
```

`pulse/default.pa`:

```text
load-module module-native-protocol-unix auth-anonymous=1
load-module module-null-sink sink_name=tm_sink sink_properties=device.description=tm_sink
load-module module-null-source source_name=tm_mic
set-default-sink tm_sink
set-default-source tm_mic
set-source-mute tm_mic 1
```

`openbox/rc.xml` sets `<focus><focusNew>no</focusNew></focus>` and one `<application class="*">` rule with `<decor>no</decor>`, `<maximized>no</maximized>` and `<focus>no</focus>`. `entrypoint.sh` starts `pulseaudio --daemonize=no --exit-idle-time=-1` in the background, waits for `pactl info`, then dispatches: `selfcheck` runs `selfcheck.sh`; `test` runs `bunx playwright test -c packages/worker/playwright.config.ts "$@"`; `unit` runs `bun test "$@"`; `seed --job <p>` runs `node packages/worker/dist/cli.js --seed --job <p>`; `--job <p>` runs `bun run tm-worker -- --job <p>`, then `bun run tm-pipeline -- --job <p>` whenever `recording/meeting.mkv` exists, and exits with the worker's code if it failed, else the pipeline's. `run-job.sh` reads `identity.id` from the job with `jq`, writes `$TM_PROFILE_ROOT/<identityId>/machine-id` (`printf %s "$id" | sha256sum | cut -c1-32`) if absent, and runs `docker run --rm --shm-size=2g --hostname "tm-<first 20 characters of id>"` with the machine id mounted read-only at `/etc/machine-id`, `$TM_DATA_ROOT` and `$TM_PROFILE_ROOT` mounted at the same paths, the master key file mounted read-only at `/run/secrets/tm_master_key` (`TM_MASTER_KEY_FILE` set to it), the job mounted read-only at `/job/job.json`, and mode `--job /job/job.json`; with `seed` it publishes `127.0.0.1:5900:5900` and uses mode `seed`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run image:worker && docker run --rm --shm-size=2g tm-worker:dev selfcheck`
Expected: last line `SELFCHECK OK`. Without `--shm-size=2g` it prints "shm below 2g: run with --shm-size=2g" and exits 1.

- [ ] **Step 5: Commit**

```bash
git add docker/worker packages/worker/package.json bun.lock docs/plans/architecture.md
git commit -m "feat(worker): add pinned worker image"
```

### Task 7: Screen and browser launch

**Files:**

- Create: `packages/worker/src/types.ts`, `packages/worker/src/display/screen.ts`, `packages/worker/src/chrome/launch.ts`, `packages/worker/src/chrome/mute.ts`, `packages/worker/playwright.config.ts`, `packages/worker/test/serve.mjs`, `packages/worker/test/helpers/image.ts` (`windowBounds`, `browserCmdline`, `playTone`, `sinkLevelDb`)
- Test: `packages/worker/src/chrome/launch.test.ts`, `packages/worker/test/image/launch.spec.ts`

**Interfaces:**

- Consumes: the image from Task 6 (Xvfb, openbox, Chrome, `tm_sink`).
- Produces: `startScreen(): Promise<Screen>`, `launchBrowser(profileDir: string, screen: Screen): Promise<{ context: BrowserContext; stage: Page; desk: Page }>`.
- Produces (adds to contracts): in `src/types.ts`, `interface Stopper { stop(): Promise<void> }` and `interface Screen { display: string; width: 3840; height: 1080; stage: Rect; desk: Rect; stop(): Promise<void> }`; `chromeArgs(screen: Screen): string[]`; `launchGuestStage(screen: Screen): Promise<{ browser: Browser; stage: Page }>` (a throw-away profile on the stage, for the Zoom guest fallback); `muteDesk(page: Page): Promise<void>`. Playwright config: project `fixtures` (headless bundled Chromium, `webServer` running `node packages/worker/test/serve.mjs` on port 4173 to serve `test/fixtures/`, `baseURL` `http://localhost:4173`) and project `image` (files under `test/image/`, skipped unless `TM_IN_IMAGE=1`).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/chrome/launch.test.ts
test('chrome flags from the design', () => {
  const a = chromeArgs(fakeScreen)
  for (const f of [
    '--app=about:blank',
    '--window-position=0,0',
    '--window-size=1920,1080',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--password-store=basic',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--deny-permission-prompts',
    '--no-first-run',
    '--no-default-browser-check'
  ])
    expect(a).toContain(f)
  expect(a).not.toContain('--enable-automation')
})
```

```ts
// packages/worker/test/image/launch.spec.ts (runs in the image)
test('stage and desk split, no automation flag, devices denied, desk muted', async () => {
  const screen = await startScreen()
  const { context, stage, desk } = await launchBrowser(profileDir, screen)
  expect(await stage.evaluate(() => [innerWidth, innerHeight, navigator.webdriver])).toEqual([1920, 1080, false])
  expect(await windowBounds(context, stage)).toEqual({
    left: 0,
    top: 0,
    width: 1920,
    height: 1080
  })
  expect(await windowBounds(context, desk)).toEqual({
    left: 1920,
    top: 0,
    width: 1920,
    height: 1080
  })
  expect(await browserCmdline()).not.toContain('--enable-automation')
  expect(
    await stage.evaluate(() =>
      navigator.mediaDevices.getUserMedia({ audio: true }).then(
        () => 'ok',
        (e) => e.name
      )
    )
  ).toBe('NotAllowedError')
  await playTone(desk)
  expect(await sinkLevelDb(3000)).toBeLessThan(-60)
  await playTone(stage)
  expect(await sinkLevelDb(3000)).toBeGreaterThan(-30)
  expect(await stage.goto('file:///etc/hostname').catch((e) => String(e))).toContain('ERR_BLOCKED_BY_ADMINISTRATOR')
})
```

`windowBounds` uses a CDP session's `Browser.getWindowForTarget`; `browserCmdline` reads `/proc/<pid>/cmdline` of the Chrome process without `--type=`; `playTone` starts a 440 Hz `OscillatorNode`; `sinkLevelDb` records `tm_sink.monitor` with `parec` for the given time and returns RMS dBFS.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/chrome/launch.test.ts`, then `docker run --rm --shm-size=2g tm-worker:dev test launch.spec.ts`
Expected: FAIL with "Cannot find module './launch'" in both.

- [ ] **Step 3: Implement**

`startScreen()` spawns `Xvfb :99 -screen 0 3840x1080x24 -nolisten tcp` and `openbox`, waits up to 10 s for `xdpyinfo -display :99` to report `3840x1080`, sets `DISPLAY=:99` and returns the stage and desk rectangles from Global Constraints; `stop()` kills both. `launchBrowser` calls `chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation'], args: chromeArgs(screen) })`, with any flags spike 2's report adds; the stage is `context.pages()[0]`; the desk is a new window from the browser CDP session's `Target.createTarget({ url: 'about:blank', newWindow: true })`, placed with `Browser.setWindowBounds` at `{ left: 1920, top: 0, width: 1920, height: 1080, windowState: 'normal' }`; the stage bounds are set the same way at `0,0`; then `muteDesk(desk)`. `muteDesk` applies the desk-muting method from spike 2's report; if the report names none, it adds an init script that sets `muted = true` on every media element and routes every `AudioContext` destination through a zero gain node. `launchGuestStage` launches non-persistent Chrome with the same flags and a temporary `--user-data-dir`, placed at the stage rectangle.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/chrome/launch.test.ts && bun run image:worker && docker run --rm --shm-size=2g tm-worker:dev test launch.spec.ts`
Expected: 1 pass, then `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/worker docs/plans/architecture.md
git commit -m "feat(worker): add screen split and chrome launch"
```

### Task 8: Profile preparation and checkpoints

**Files:**

- Create: `packages/worker/src/profile/profile.ts`, `packages/worker/src/profile/keys.ts`
- Test: `packages/worker/src/profile/profile.test.ts`, `packages/worker/src/profile/keys.test.ts`

**Interfaces:**

- Consumes: `Stopper` from Task 7.
- Produces: `prepareProfile(dir: string, identityId: string, host?: HostInfo): Promise<void>`, `checkpointProfile(dir: string, out: string, key: Buffer, now?: () => Date): Promise<string>` (the optional parameters only serve tests).
- Produces (adds to contracts): `restoreProfile(file: string, dir: string, key: Buffer): Promise<void>`; `startCheckpoints(dir: string, out: string, key: Buffer, intervalMs = 300_000): Stopper`; `deriveProfileKey(masterKey: Buffer, identityId: string): Buffer` (HKDF-SHA256, salt `tolongmeeting`, info `profile:<identityId>`, 32 bytes); `readMasterKey(file: string): Promise<Buffer>` (base64 that must decode to 32 bytes); `machineIdFor(identityId: string): string` (first 32 hex characters of SHA-256); `hostnameFor(identityId: string): string` (`tm-` plus the first 20 characters); `interface HostInfo { hostname: string; machineIdPath: string }`; errors `ProfileHostMismatch` and `CheckpointAuthError`; checkpoint format `TMCK1\n`, a 12-byte IV, the AES-256-GCM ciphertext of a tar and a 16-byte tag, named `<YYYYMMDDTHHmmssZ>.tar.enc`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/profile/profile.test.ts
test('prepare removes Chrome singleton files and keeps the rest', async () => {
  await symlink('tm-host-123', join(dir, 'SingletonLock'))
  await writeFile(join(dir, 'SingletonSocket'), '')
  await writeFile(join(dir, 'SingletonCookie'), '')
  await writeFile(join(dir, 'Local State'), '{}')
  await prepareProfile(dir, 'id-1', okHost)
  expect(await readdir(dir)).toEqual(['Local State'])
})
test('prepare refuses a host that does not match the identity', async () => {
  await expect(prepareProfile(dir, 'id-1', { hostname: 'other', machineIdPath: midFile })).rejects.toBeInstanceOf(
    ProfileHostMismatch
  )
})
test('checkpoint strips caches and restores with the right key only', async () => {
  for (const p of [
    'Default/Cache/a',
    'Default/Code Cache/b',
    'Default/GPUCache/c',
    'Default/Service Worker/CacheStorage/d',
    'Crashpad/e',
    'Default/Cookies',
    'Default/IndexedDB/x'
  ])
    await put(join(dir, p), 'v')
  const file = await checkpointProfile(dir, out, key)
  expect(basename(file)).toMatch(/^\d{8}T\d{6}Z\.tar\.enc$/)
  await restoreProfile(file, restored, key)
  expect(await tree(restored)).toEqual(['Default/Cookies', 'Default/IndexedDB/x'])
  await expect(restoreProfile(file, other, randomBytes(32))).rejects.toBeInstanceOf(CheckpointAuthError)
  await flipByte(file, 40)
  await expect(restoreProfile(file, other2, key)).rejects.toBeInstanceOf(CheckpointAuthError)
})
test('only the newest 3 checkpoints are kept and no .tmp file is left', async () => {
  for (let i = 0; i < 5; i++) await checkpointProfile(dir, out, key, clockAt(i))
  const files = await readdir(out)
  expect(files.filter((f) => f.endsWith('.tar.enc')).length).toBe(3)
  expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
})
```

```ts
// packages/worker/src/profile/keys.test.ts
test('derived keys are 32 bytes, stable and per identity', () => {
  const m = Buffer.alloc(32, 7)
  expect(deriveProfileKey(m, 'a').length).toBe(32)
  expect(deriveProfileKey(m, 'a').equals(deriveProfileKey(m, 'a'))).toBe(true)
  expect(deriveProfileKey(m, 'a').equals(deriveProfileKey(m, 'b'))).toBe(false)
  expect(machineIdFor('a')).toMatch(/^[0-9a-f]{32}$/)
  expect(hostnameFor('university-identity-123456')).toBe('tm-university-identity-1')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/profile`
Expected: FAIL with "Cannot find module './profile'".

- [ ] **Step 3: Implement**

`prepareProfile` checks `host.hostname === hostnameFor(identityId)` and that the trimmed contents of `host.machineIdPath` equal `machineIdFor(identityId)` (defaults `os.hostname()` and `/etc/machine-id`), then removes `SingletonLock`, `SingletonSocket` and `SingletonCookie` with `rm({ force: true })` (they may be dangling symlinks). `checkpointProfile` streams `tar.c` (the `tar` package) with a filter that skips any path with a segment `Cache`, `Code Cache`, `GPUCache` or `Crashpad`, or the pair `Service Worker/CacheStorage`, through `createCipheriv('aes-256-gcm', key, iv)` into `<name>.tmp`, appends the tag, renames, then deletes all but the newest 3 `.tar.enc` files. `restoreProfile` reads the tag from the last 16 bytes, calls `setAuthTag` before streaming, extracts into an empty temporary directory and renames it to `dir` only after `final()` succeeds; an authentication failure throws `CheckpointAuthError`. `startCheckpoints` runs `checkpointProfile` every `intervalMs` and never runs two at once.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/profile`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/profile docs/plans/architecture.md
git commit -m "feat(worker): add encrypted profile checkpoints"
```

### Task 9: Recorder

**Files:**

- Create: `packages/worker/src/recorder/recorder.ts`, `packages/worker/src/recorder/join.ts`
- Test: `packages/worker/src/recorder/recorder.test.ts`, `packages/worker/src/recorder/join.test.ts`, `packages/worker/src/recorder/recorder.int.test.ts` (image only)

**Interfaces:**

- Consumes: `Screen` from Task 7.
- Produces: `startRecorder(screen: Screen, outDir: string, attempt: number, opts?: { segmentSeconds?: number }): Promise<Recorder>` (`outDir` is `<dataDir>/recording`).
- Produces (adds to contracts): `interface Recorder { startedAt: Date; stop(): Promise<void>; onGap(cb: (g: { from: Date; to: Date }) => void): void }`; `recorderArgs(screen: Screen, outDir: string, attempt: number, startNumber: number, segmentSeconds = 300): string[]`; `joinRecording(recordingDir: string): Promise<string>` (returns the path of `meeting.mkv`); `recording/attempts.json`, an array of `{ attempt: number; startedAt: string; stoppedAt: string | null }`, which the pipeline uses as the transcript's time origin.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/recorder/recorder.test.ts
test('ffmpeg arguments record the stage and the sink into Matroska segments', () => {
  expect(recorderArgs(fakeScreen, '/d/recording', 2, 0)).toEqual([
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-thread_queue_size',
    '1024',
    '-f',
    'x11grab',
    '-framerate',
    '15',
    '-video_size',
    '1920x1080',
    '-draw_mouse',
    '0',
    '-use_wallclock_as_timestamps',
    '1',
    '-i',
    ':99.0+0,0',
    '-thread_queue_size',
    '1024',
    '-f',
    'pulse',
    '-use_wallclock_as_timestamps',
    '1',
    '-i',
    'tm_sink.monitor',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-af',
    'aresample=async=1',
    '-f',
    'segment',
    '-segment_time',
    '300',
    '-segment_format',
    'matroska',
    '-reset_timestamps',
    '1',
    '-segment_start_number',
    '0',
    '/d/recording/attempt_2_seg_%03d.mkv'
  ])
})
```

```ts
// packages/worker/src/recorder/join.test.ts (skipped when ffmpeg is not on PATH)
test('segments of two attempts join, a truncated segment included', async () => {
  await lavfiSegment(dir, 'attempt_1_seg_000.mkv', 2)
  await lavfiSegment(dir, 'attempt_1_seg_001.mkv', 2)
  await lavfiSegment(dir, 'attempt_2_seg_000.mkv', 2)
  await truncateTail(join(dir, 'attempt_1_seg_001.mkv'), 0.2)
  const out = await joinRecording(dir)
  expect(basename(out)).toBe('meeting.mkv')
  expect(await durationSeconds(out)).toBeGreaterThan(5)
})
```

```ts
// packages/worker/src/recorder/recorder.int.test.ts (image only; Review Focus: ffmpeg dies mid-meeting)
test('records 1920x1080 at 15 fps with AAC, survives an ffmpeg kill, logs the gap', async () => {
  const gaps: { from: Date; to: Date }[] = []
  const r = await startRecorder(screen, dir, 1, { segmentSeconds: 5 })
  r.onGap((g) => gaps.push(g))
  await sleep(6000)
  await killFfmpeg('SIGKILL')
  await sleep(8000)
  await r.stop()
  const segs = (await readdir(dir)).filter((f) => f.endsWith('.mkv')).sort()
  expect(segs[0]).toBe('attempt_1_seg_000.mkv')
  expect(new Set(segs).size).toBe(segs.length)
  expect(await probe(join(dir, segs[0]!))).toMatchObject({
    video: 'h264',
    width: 1920,
    height: 1080,
    fps: 15,
    audio: 'aac'
  })
  expect(gaps.length).toBe(1)
  expect(+gaps[0]!.to - +gaps[0]!.from).toBeLessThan(3000)
  expect(JSON.parse(await readFile(join(dir, 'attempts.json'), 'utf8'))[0].stoppedAt).toBeString()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/recorder/recorder.test.ts packages/worker/src/recorder/join.test.ts`
Expected: FAIL with "Cannot find module './recorder'".

- [ ] **Step 3: Implement**

`startRecorder` appends `{ attempt, startedAt, stoppedAt: null }` to `attempts.json` (atomic rewrite), spawns `ffmpeg` with `recorderArgs` and resolves once the first segment file exists (at most 10 s). When ffmpeg exits while not stopping, it waits 1 s, restarts with `-segment_start_number` one past the highest existing number for this attempt and calls the gap callbacks with the exit and restart times. `stop()` sends `q` on stdin, waits up to 10 s, then SIGINT, and sets `stoppedAt`. The preset is `veryfast` unless spike 6's report sets another. `joinRecording` sorts `attempt_<N>_seg_<NNN>.mkv` by attempt then number, remuxes each with `ffmpeg -err_detect ignore_err -i <seg> -c copy` into a temporary directory (which repairs a truncated tail), and concatenates them with the concat demuxer (`-f concat -safe 0 -c copy`) into `recording/meeting.mkv`. Gaps between attempts are not filled; they live in `attempts.json` and the event log.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/recorder/recorder.test.ts packages/worker/src/recorder/join.test.ts && bun run image:worker && docker run --rm --shm-size=2g tm-worker:dev unit packages/worker/src/recorder/recorder.int.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/recorder docs/plans/architecture.md
git commit -m "feat(worker): add segment recorder and joiner"
```

### Task 10: Audio source, frame loop and health alerts

**Files:**

- Create: `packages/core/src/image.ts`, `packages/worker/src/audio/source.ts`, `packages/worker/src/frames/frames.ts`, `packages/worker/src/frames/keyframes.ts`, `packages/worker/src/health/health.ts`
- Test: `packages/core/src/image.test.ts`, `packages/worker/src/frames/keyframes.test.ts`, `packages/worker/src/health/health.test.ts`, `packages/worker/src/frames/frames.int.test.ts` (image only)

**Interfaces:**

- Consumes: `Screen`, `Stopper` from Task 7.
- Produces: `startFrameLoop(screen: Screen, onFrame: (f: Frame) => Promise<void>, intervalMs = 2000): Stopper`.
- Produces (adds to contracts): `interface Frame { at: Date; png: Buffer }`; in `@tm/core`, `interface GreyImage { width: number; height: number; data: Uint8Array }`, `meanLuma(img: GreyImage): number`, `meanDiff(a: GreyImage, b: GreyImage): number`, `dHash256(img: GreyImage): bigint` (input 17x16), `hamming(a: bigint, b: bigint): number`; in the worker, `thumbnail(png: Buffer): Promise<GreyImage>` (left 74%, greyscale, 128x72), `hashInput(png: Buffer): Promise<GreyImage>` (left 74%, greyscale, 17x16), `class KeyframeSelector { consider(thumb: GreyImage, hash: () => Promise<bigint>): Promise<boolean> }` with exported `CHANGE = 7.0`, `STABLE = 2.0`, `HASH_DUP = 12`, `DIFF_WIDTH = 0.74`; `startAudioSource(): Promise<AudioSource>` with `interface AudioSource { startedAt: Date; onChunk(cb: (pcm16le: Buffer) => void): () => void; levelDb(windowMs: number): number; stop(): Promise<void> }`; `class HealthMonitor { constructor(onAlert: (k: 'black_frames' | 'frozen_silent') => void); sample(s: HealthSample): void }` with `interface HealthSample { atMs: number; meanLuma: number; diffPrev: number; levelDb: number; participants: number | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/frames/keyframes.test.ts (grey(v) is a flat 128x72 image; slide(n) a patterned one)
test("the session's keyframe rule: settled, changed, not a dHash repeat", async () => {
  const k = new KeyframeSelector()
  const h = (n: number) => async () => BigInt(n) << 200n
  expect(await k.consider(slide(1), h(1))).toBe(false) // nothing to compare with yet
  expect(await k.consider(slide(1), h(1))).toBe(true) // settled and new
  expect(await k.consider(slide(1), h(1))).toBe(false) // unchanged
  expect(await k.consider(slide(2), h(2))).toBe(false) // changing, not settled
  expect(await k.consider(slide(2), h(2))).toBe(true)
  expect(await k.consider(slide(1), h(1))).toBe(false) // back to slide 1: not settled yet
  expect(await k.consider(slide(1), h(1))).toBe(false) // settled but a dHash repeat of a kept frame
})
```

```ts
// packages/worker/src/health/health.test.ts
test('black frames alert once after 10 s and re-arm', () => {
  const got: string[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 10_000; t += 2000)
    m.sample({
      atMs: t,
      meanLuma: 3,
      diffPrev: 0,
      levelDb: -20,
      participants: 5
    })
  expect(got).toEqual(['black_frames'])
  m.sample({
    atMs: 12_000,
    meanLuma: 90,
    diffPrev: 1,
    levelDb: -20,
    participants: 5
  })
  for (let t = 14_000; t <= 24_000; t += 2000)
    m.sample({
      atMs: t,
      meanLuma: 3,
      diffPrev: 0,
      levelDb: -20,
      participants: 5
    })
  expect(got).toEqual(['black_frames', 'black_frames'])
})
test('frozen frame plus silence for 5 minutes with participants; a frozen slide alone is normal', () => {
  const got: string[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 300_000; t += 2000)
    m.sample({
      atMs: t,
      meanLuma: 90,
      diffPrev: 0.1,
      levelDb: -25,
      participants: 5
    })
  expect(got).toEqual([])
  for (let t = 302_000; t <= 602_000; t += 2000)
    m.sample({
      atMs: t,
      meanLuma: 90,
      diffPrev: 0.1,
      levelDb: -70,
      participants: 1
    })
  expect(got).toEqual([])
  for (let t = 604_000; t <= 904_000; t += 2000)
    m.sample({
      atMs: t,
      meanLuma: 90,
      diffPrev: 0.1,
      levelDb: -70,
      participants: 3
    })
  expect(got).toEqual(['frozen_silent'])
})
```

```ts
// packages/core/src/image.test.ts
test('image maths', () => {
  expect(meanLuma(flat(128, 72, 40))).toBe(40)
  expect(meanDiff(flat(128, 72, 10), flat(128, 72, 17))).toBe(7)
  expect(dHash256(flat(17, 16, 5))).toBe(0n)
  expect(hamming(0b1011n, 0b0001n)).toBe(2)
})
```

```ts
// packages/worker/src/frames/frames.int.test.ts (image only): stage page red, desk page blue
test('frames every 2 s show the stage only; the audio source reports level', async () => {
  const frames: Frame[] = []
  const s = startFrameLoop(screen, async (f) => {
    frames.push(f)
  })
  await sleep(7000)
  await s.stop()
  expect(frames.length).toBeGreaterThanOrEqual(3)
  expect(await pixel(frames[0]!.png, 960, 540)).toEqual([255, 0, 0])
  const a = await startAudioSource()
  await playTone(stage)
  await sleep(2000)
  expect(a.levelDb(1000)).toBeGreaterThan(-30)
  await a.stop()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/image.test.ts packages/worker/src/frames packages/worker/src/health`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`KeyframeSelector.consider`: `settled = prev !== null && meanDiff(thumb, prev) <= STABLE`; `changed = kept === null || meanDiff(thumb, kept) >= CHANGE`; if both, compute the hash and keep the frame only if `hamming` exceeds `HASH_DUP` against every kept hash; when settled and changed, `kept = thumb` whether or not the hash was new; always `prev = thumb`. `HealthMonitor`: black means `meanLuma < 10`, alerting once black has lasted 10,000 ms; frozen-silent means `diffPrev < 0.5 && levelDb < -50 && participants !== null && participants >= 2`, alerting once it has lasted 300,000 ms; each alert re-arms after one sample without its condition. `startFrameLoop` runs one ffmpeg (`-f x11grab -framerate <1000/intervalMs> -video_size 1920x1080 -draw_mouse 0 -i :99.0+<stage.x>,<stage.y> -c:v png -f image2pipe pipe:1`), splits PNGs after each `IEND` chunk and calls `onFrame` one at a time, skipping frames that arrive while a call is running. `startAudioSource` runs `parec --device=tm_sink.monitor --format=s16le --rate=16000 --channels=1 --latency-msec=100`, keeps the last 10 s for `levelDb` (RMS in dBFS, -120 for digital silence) and fans chunks out to `onChunk` subscribers. Thumbnails use `sharp`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/image.test.ts packages/worker/src/frames packages/worker/src/health && docker run --rm --shm-size=2g tm-worker:dev unit packages/worker/src/frames/frames.int.test.ts` (after `bun run image:worker`)
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/image.ts packages/core/src/image.test.ts packages/worker/src docs/plans/architecture.md
git commit -m "feat(worker): add frames, keyframes and health"
```

### Task 11: QR decoding

**Files:**

- Create: `packages/worker/src/qr/qr.ts`, `packages/worker/src/qr/confirm.ts`, `packages/worker/test/helpers/qr-frame.ts`
- Test: `packages/worker/src/qr/qr.test.ts`

**Interfaces:**

- Consumes: `Rect` from the adapter types; spike 3's report (`spikes/03-qr/REPORT.md`) for the decoder choice.
- Produces: `decodeQr(png: Buffer, region: Rect | null): Promise<string[]>`.
- Produces (adds to contracts): `class QrConfirmer { push(texts: string[]): string[] }` (returns texts seen in this frame and the previous one, each once per meeting); test helper `qrFrame(text: string, size: number, at: { x: number; y: number }): Promise<Buffer>` (a QR code drawn crisply on a dark 1920x1080 PNG with the `qrcode` package and `sharp`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/src/qr/qr.test.ts
const region = { x: 0, y: 60, width: 1410, height: 840 }
test('decodes a large code from the full frame and a small one through the region', async () => {
  expect(await decodeQr(await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 }), null)).toEqual([
    'https://forms.gle/<form-id>'
  ])
  expect(
    await decodeQr(
      await qrFrame('https://forms.office.com/r/<form-id>', 76, {
        x: 1300,
        y: 780
      }),
      region
    )
  ).toEqual(['https://forms.office.com/r/<form-id>'])
  expect(await decodeQr(await qrFrame('', 0, { x: 0, y: 0 }), region)).toEqual([])
})
test('a code counts after two consecutive frames, once', () => {
  const c = new QrConfirmer()
  expect(c.push(['a'])).toEqual([])
  expect(c.push(['a'])).toEqual(['a'])
  expect(c.push(['a'])).toEqual([])
  expect(c.push(['b'])).toEqual([])
  expect(c.push([])).toEqual([])
  expect(c.push(['b'])).toEqual([])
  expect(c.push(['b'])).toEqual(['b'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/worker/src/qr`
Expected: FAIL with "Cannot find module './qr'".

- [ ] **Step 3: Implement**

`decodeQr` decodes the full frame, then (if `region` is given) the region cropped and upscaled 2x with `sharp` (`kernel: 'lanczos3'`), with each decoder spike 3 recommends, and returns unique texts in order of discovery. zxing-cpp runs as `zxing-wasm` (`readBarcodes(imageData, { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 4 })`). If spike 3 recommends OpenCV's WeChat detector too, add `src/qr/wechat.ts`, a client for a long-lived helper `packages/worker/qr/wechat_helper.py` (`cv2.wechat_qrcode_WeChatQRCode`, `opencv-contrib-python-headless` pinned as `OPENCV_VERSION` in `versions.env`) that reads PNG paths on stdin and writes JSON lines, and run the same tests with each decoder alone.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/worker/src/qr`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/qr packages/worker/test/helpers docs/plans/architecture.md
git commit -m "feat(worker): add qr decoding and confirmation"
```

### Task 12: Form links and trust

**Files:**

- Create: `packages/worker/src/forms/links.ts`, `packages/worker/src/forms/trust.ts`
- Test: `packages/worker/src/forms/links.test.ts`, `packages/worker/src/forms/trust.test.ts`

**Interfaces:**

- Consumes: `FormCandidate`, `ResolvedForm`, `FormProvider`, `TrustReason` from `@tm/core`.
- Produces: `resolveFormLink(c: FormCandidate, opts?: ResolveOptions): Promise<ResolvedForm | null>` (null: the final URL is not a form); `checkTrust(f: Pick<ResolvedForm, 'source' | 'sender' | 'senderRole'>, trustedSenders: string[]): { trusted: boolean; reason: TrustReason | null }` (accepts any `ResolvedForm`, as in the contract, and also a bare candidate).
- Produces (adds to contracts): `interface ResolveOptions { fetch?: typeof fetch; timeoutMs?: number; maxRedirects?: number }` (defaults 5,000 and 5); `class LinkResolveError extends Error { reason: 'timeout' | 'network' | 'too_many_redirects' }`; `extractLinks(text: string): string[]`; `unwrapLink(url: string): string`; `formProviderOf(url: string): FormProvider | null`; `normaliseFormUrl(url: string): string` (the per-meeting duplicate key).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/forms/links.test.ts (fakeFetch maps URLs to responses and records each call)
test('extract and unwrap', () => {
  expect(extractLinks('Attendance: https://forms.gle/abc. Also (https://example.com/x)')).toEqual([
    'https://forms.gle/abc',
    'https://example.com/x'
  ])
  expect(
    unwrapLink('https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fforms.office.com%2Fr%2FAbC123&data=x')
  ).toBe('https://forms.office.com/r/AbC123')
  expect(unwrapLink('https://www.google.com/url?q=https://forms.gle/abc&sa=D')).toBe('https://forms.gle/abc')
})
test('follows a shortener without cookies and stops on the provider domain', async () => {
  const f = fakeFetch({
    'https://bit.ly/x': [301, 'https://forms.gle/abc'],
    'https://forms.gle/abc': [302, 'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=send_form']
  })
  const r = await resolveFormLink(cand('https://bit.ly/x'), { fetch: f })
  expect(r).toMatchObject({
    finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=send_form',
    provider: 'google'
  })
  expect(f.calls.map((c) => c.init)).toEqual([
    {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: expect.anything()
    },
    expect.objectContaining({ redirect: 'manual' })
  ])
  expect(f.calls.length).toBe(2)
})
test('non-forms are null; slow, broken and looping links raise LinkResolveError', async () => {
  expect(
    await resolveFormLink(cand('https://example.com/a'), {
      fetch: fakeFetch({ 'https://example.com/a': [200] })
    })
  ).toBeNull()
  await expect(
    resolveFormLink(cand('https://slow.example/a'), {
      fetch: hangingFetch,
      timeoutMs: 50
    })
  ).rejects.toMatchObject({ reason: 'timeout' })
  await expect(resolveFormLink(cand('https://loop.example/0'), { fetch: chainOf(6) })).rejects.toMatchObject({
    reason: 'too_many_redirects'
  })
})
test('Review Focus: one form in three shapes has one key', async () => {
  const long = 'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=pp_url&entry.123=x'
  const wrapped = 'https://apc01.safelinks.protection.outlook.com/?url=' + encodeURIComponent(long)
  const short = (await resolveFormLink(cand('https://forms.gle/abc'), {
    fetch: fakeFetch({
      'https://forms.gle/abc': [302, 'https://docs.google.com/forms/d/e/1FAIpQ/viewform']
    })
  }))!.finalUrl
  const keys = new Set([long, unwrapLink(wrapped), short].map(normaliseFormUrl))
  expect([...keys]).toEqual(['https://docs.google.com/forms/d/e/1FAIpQ'])
  expect(normaliseFormUrl('https://forms.office.com/Pages/ResponsePage.aspx?id=AbC&origin=lprLink')).toBe(
    'https://forms.office.com/id/AbC'
  )
  expect(formProviderOf('https://forms.microsoft.com/r/AbC')).toBe('microsoft')
  expect(formProviderOf('https://docs.google.com/document/d/x')).toBeNull()
})
```

```ts
// packages/worker/src/forms/trust.test.ts
test('pre-open trust rules', () => {
  const t = (source: FormSource, sender: string | null, senderRole: SenderRole | null) =>
    checkTrust({ source, sender, senderRole }, ['Dr Lecturer'])
  expect(t('qr', null, null)).toEqual({
    trusted: true,
    reason: 'qr_on_screen'
  })
  expect(t('meeting_chat', 'Anyone', 'host')).toEqual({
    trusted: true,
    reason: 'host'
  })
  expect(t('meeting_chat', 'Anyone', 'co_host')).toEqual({
    trusted: true,
    reason: 'co_host'
  })
  expect(t('meeting_chat', ' dr  lecturer (Guest) ', 'participant')).toEqual({
    trusted: true,
    reason: 'trusted_sender'
  })
  expect(t('meeting_chat', 'Dr Lecturer2', 'participant')).toEqual({
    trusted: false,
    reason: null
  })
  expect(t('meeting_chat', null, 'unknown')).toEqual({
    trusted: false,
    reason: null
  })
  expect(t('watched_chat', 'Someone', 'host')).toEqual({
    trusted: false,
    reason: null
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/forms`
Expected: FAIL with "Cannot find module './links'".

- [ ] **Step 3: Implement**

`unwrapLink` repeats up to 3 times: hosts ending `.safelinks.protection.outlook.com` yield their `url` parameter; `www.google.com/url` and `google.com/url` yield `q`, else `url`. `resolveFormLink` unwraps, then loops: stop with the current URL when its host is `docs.google.com` with a path starting `/forms/`, or `forms.office.com`, or `forms.microsoft.com`; otherwise `fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal })` with one `AbortSignal.timeout(timeoutMs)` for the whole chain, cancel the body, follow `Location` (resolved against the current URL, then unwrapped) on 301, 302, 303, 307 or 308, at most `maxRedirects` times; a final URL that `formProviderOf` rejects gives `null`. `normaliseFormUrl`: Google `/forms/d/e/<id>/...` and `/forms/d/<id>/...` keep only that prefix; Microsoft `ResponsePage.aspx?id=<id>` becomes `https://forms.office.com/id/<id>`, `/r/<code>` drops its query, and `forms.microsoft.com` is written as `forms.office.com`. `checkTrust`: `qr` is `qr_on_screen`; in `meeting_chat`, role `host` or `co_host` gives that reason; in any chat, a sender whose normalised name (lowercase, whitespace collapsed, trailing parenthesised suffixes removed) equals a normalised trusted sender gives `trusted_sender`; anything else is untrusted.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/forms`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/forms docs/plans/architecture.md
git commit -m "feat(worker): add form link resolution and trust"
```

### Task 13: Zoom adapter join and admission

**Files:**

- Create: `config/selectors/zoom.json`, `packages/worker/src/adapters/types.ts`, `packages/worker/src/adapters/selectors.ts`, `packages/worker/src/adapters/index.ts`, `packages/worker/src/adapters/zoom/index.ts`, `packages/worker/src/adapters/zoom/link.ts`, `packages/worker/src/adapters/zoom/root.ts`, `packages/worker/src/adapters/zoom/join.ts`
- Create fixtures in `packages/worker/test/fixtures/`:
  - `zoom-prejoin.html`: a "Continue without microphone and camera" button that, when clicked, is replaced by a second prompt with the same button (microphone only); its click shows `input#input-for-name` and a "Join" button; Join navigates to the page named by `?then=` (`meeting-top`, `meeting-iframe`, `lobby`); `window.__fixture.clicks` logs every click by name and `__fixture.typedName` the name typed; `?signedin=1` shows the name prefilled.
  - `zoom-signin.html`: the text "Sign in to join this meeting" and an email field.
  - `zoom-busy.html`: the text "You are already in another meeting".
  - `zoom-lobby.html`: "Please wait, the meeting host will let you in soon."; `?admit=<ms>` navigates to `zoom-meeting-top.html` after that time; `?deny=<ms>` shows "You have been removed from the waiting room"; `?end=<ms>` shows "This meeting has been ended by host".
  - `zoom-meeting-top.html`: the in-meeting toolbar (buttons with aria-labels `audio`, `Video`, `open the participants list pane,[12] particpants`, `open the chat panel`, `Share`, `React`, `More meeting control `, `Leave`), and a "Leave Meeting" confirmation shown after Leave. Task 14 extends it.
  - `zoom-meeting-iframe.html`: an `iframe#webclient` filling the page with `zoom-meeting-top.html` inside, same origin.
  - `zoom-devices-on.html`: the toolbar with aria-labels `mute my microphone` and `stop my video`.
- Test: `packages/worker/src/adapters/zoom/link.test.ts`, `packages/worker/test/zoom-join.spec.ts`

**Interfaces:**

- Consumes: `unwrapLink` from Task 12; `PlatformAdapter`, `JoinResult`, `AdmissionResult` from architecture "Worker interfaces".
- Produces: `packages/worker/src/adapters/types.ts` verbatim from the architecture; `adapterFor(url: string): PlatformAdapter | null`; `zoomAdapter: PlatformAdapter` with `normaliseLink`, `join`, `waitUntilAdmitted`, `assertDevicesOff` and `leave` here (the rest in Task 14).
- Produces (adds to contracts): `class DevicesOnError extends Error { labels: string[] }`; `loadSelectors<T>(platform: Platform, schema: z.ZodType<T>): Promise<T>` (reads `${TM_SELECTORS_DIR ?? '/app/config/selectors'}/<platform>.json`); `ZoomSelectorsSchema`; `zoomRoot(page: Page): Promise<PwFrame>` (Playwright's `Frame`, imported as `PwFrame` so it doesn't clash with the worker's `Frame`; the `iframe#webclient` frame if it has a document, else the main frame, resolved on every call); `ZOOM_TIMEOUTS = { join: 60_000, step: 10_000, audio: 15_000 }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/adapters/zoom/link.test.ts (Review Focus: Zoom link variants)
test('every Zoom link becomes the web-client join URL or null', () => {
  const n = zoomAdapter.normaliseLink
  expect(n('https://us06web.zoom.us/j/00000000000?pwd=PWD')).toBe('https://us06web.zoom.us/wc/join/00000000000?pwd=PWD')
  expect(n('https://zoom.us/j/00000000000')).toBe('https://zoom.us/wc/join/00000000000')
  expect(n('https://example-uni.zoom.us/j/00000000000?pwd=PWD#success')).toBe(
    'https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD'
  )
  expect(n('https://app.zoom.us/wc/00000000000/join?pwd=PWD')).toBe('https://app.zoom.us/wc/00000000000/join?pwd=PWD')
  expect(n('https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD')).toBe(
    'https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD'
  )
  expect(
    n('https://apc01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://zoom.us/j/00000000000'))
  ).toBe('https://zoom.us/wc/join/00000000000')
  expect(n('https://example-uni.zoom.us/my/lecturer')).toBeNull()
  expect(n('https://zoom.us.example.com/j/00000000000')).toBeNull()
  expect(n('https://teams.microsoft.com/l/meetup-join/x')).toBeNull()
  expect(adapterFor('https://zoom.us/j/00000000000')).toBe(zoomAdapter)
})
```

```ts
// packages/worker/test/zoom-join.spec.ts
for (const root of ['top', 'iframe'])
  test(`guest join through two device prompts (${root})`, async ({ page }) => {
    await page.goto(`/zoom-prejoin.html?then=meeting-${root}`)
    expect(await zoomAdapter.join(page, { guestName: 'Member Guest' })).toEqual({ kind: 'in_meeting' })
    expect(await page.evaluate(() => [window.__fixture.clicks, window.__fixture.typedName])).toEqual([
      ['continue', 'continue', 'join'],
      'Member Guest'
    ])
    await zoomAdapter.assertDevicesOff(page)
  })
test('signed-in join keeps the prefilled name', async ({ page }) => {
  await page.goto('/zoom-prejoin.html?then=meeting-top&signedin=1')
  expect(await zoomAdapter.join(page, { guestName: 'Member Guest' })).toEqual({
    kind: 'in_meeting'
  })
  expect(await page.evaluate(() => window.__fixture.typedName)).toBe('')
})
test('lobby, sign-in, busy account and missing name are distinct results', async ({ page }) => {
  await page.goto('/zoom-prejoin.html?then=lobby')
  expect(await zoomAdapter.join(page, { guestName: 'G' })).toEqual({
    kind: 'lobby'
  })
  await page.goto('/zoom-signin.html')
  expect(await zoomAdapter.join(page, { guestName: 'G' })).toEqual({
    kind: 'signin_required',
    host: 'localhost'
  })
  await page.goto('/zoom-busy.html')
  expect(await zoomAdapter.join(page, { guestName: 'G' })).toEqual({
    kind: 'account_busy'
  })
  await page.goto('/zoom-prejoin.html?then=meeting-top')
  expect(await zoomAdapter.join(page, { guestName: null })).toEqual({
    kind: 'failed',
    reason: 'name_required'
  })
})
test('admission outcomes', async ({ page }) => {
  await page.goto('/zoom-lobby.html?admit=2000')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(10_000))).toBe('admitted')
  await page.goto('/zoom-lobby.html?deny=1000')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(10_000))).toBe('lobby_denied')
  await page.goto('/zoom-lobby.html?end=1000')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(10_000))).toBe('lobby_denied')
  await page.goto('/zoom-lobby.html')
  expect(await zoomAdapter.waitUntilAdmitted(page, inMs(3_000))).toBe('lobby_expired')
})
test('devices on fail loudly; leave confirms', async ({ page }) => {
  await page.goto('/zoom-devices-on.html')
  await expect(zoomAdapter.assertDevicesOff(page)).rejects.toMatchObject({
    name: 'DevicesOnError',
    labels: ['mute my microphone', 'stop my video']
  })
  await page.goto('/zoom-meeting-top.html')
  await zoomAdapter.leave(page)
  expect(await page.evaluate(() => window.__fixture.clicks)).toEqual(['leave', 'leave meeting'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/adapters/zoom/link.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts zoom-join.spec.ts`
Expected: FAIL with "Cannot find module" in both.

- [ ] **Step 3: Implement**

`config/selectors/zoom.json` (starting values from the session record; spike 2's DOM notes replace any that differ):

```json
{
  "rootIframe": "iframe#webclient",
  "selectors": {
    "continueWithoutDevices": "text=/^continue without microphone and camera$/i",
    "nameInput": "input#input-for-name",
    "joinButton": "button:text-matches('^join$', 'i')",
    "leaveButton": "button[aria-label='Leave']",
    "leaveConfirm": "button:text-matches('leave meeting', 'i')",
    "audioButton": "footer button[aria-label^='audio' i], footer button[aria-label*='microphone' i], footer button[aria-label^='join audio' i]",
    "videoButton": "footer button[aria-label^='video' i], footer button[aria-label*='video' i]",
    "joinAudioByComputer": "button:text-matches('join audio by computer', 'i')",
    "openChat": "button[aria-label='open the chat panel']",
    "participantsButton": "button[aria-label^='open the participants list pane']",
    "chatList": ".chat-container__chat-list",
    "chatItem": ".chat-item-container",
    "chatSender": ".chat-item__sender",
    "chatReceiver": ".chat-item__receiver",
    "chatTime": ".new-chat-item__chat-info-time-stamp",
    "chatText": ".new-chat-message__text-box, .new-chat-message__content, .chat-item__chat-msg-container",
    "chatReplyQuote": ".chat-item__quote",
    "shareSurface": "#sharee-container canvas, .sharee-container__canvas"
  },
  "texts": {
    "signInRequired": "sign in to join|authorized attendees only",
    "accountBusy": "already in (another|a) meeting",
    "lobby": "host will let you in soon|waiting room",
    "lobbyDenied": "removed from the waiting room|host has removed you",
    "ended": "meeting has been ended|this meeting has ended|host has ended this meeting",
    "removed": "you have been removed from this meeting",
    "breakout": "breakout room",
    "roleLabel": "\\s*\\((host|co-host)\\)\\s*$",
    "devicesOnLabel": "^(mute my microphone|mute|stop my video|stop video)"
  },
  "noticeAllowlist": ["OK", "Got it"]
}
```

`normaliseLink` unwraps, requires `https:` and a host equal to `zoom.us` or ending `.zoom.us`, drops the fragment, rewrites `/j/<id>` to `/wc/join/<id>` keeping the query, keeps `/wc/join/<id>` and `/wc/<id>/join`, and returns null otherwise. `join(page, { guestName })` polls the root every 500 ms until `ZOOM_TIMEOUTS.join`: sign-in text gives `signin_required` with `new URL(page.url()).hostname`; busy text gives `account_busy`; the device prompt is clicked, at most 3 times; an empty name input gets `guestName` (null gives `failed: name_required`), then the DOM value is read back and must equal it before Join is clicked; a visible Leave button gives `in_meeting`; lobby text gives `lobby`; the timeout gives `failed: prejoin_timeout`. `waitUntilAdmitted` polls every 2 s: Leave visible gives `admitted`; denied text, or ended text (the meeting ended before admission), gives `lobby_denied`; the deadline gives `lobby_expired`. `assertDevicesOff` reads the aria-labels of `audioButton` and `videoButton` and throws `DevicesOnError` with every label matching `devicesOnLabel`. `leave` clicks Leave, then `leaveConfirm` within 3 s. Every step logs only selector names, never page text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/adapters/zoom/link.test.ts && bunx playwright test -c packages/worker/playwright.config.ts zoom-join.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add config/selectors packages/worker docs/plans/architecture.md
git commit -m "feat(worker): add zoom join and admission"
```

### Task 14: Zoom adapter in-meeting signals

**Files:**

- Create: `packages/worker/src/adapters/zoom/meeting.ts`, `packages/worker/src/adapters/zoom/chat.ts`
- Modify: `packages/worker/src/adapters/zoom/index.ts`, `packages/worker/test/fixtures/zoom-meeting-top.html`
- Fixture additions to `zoom-meeting-top.html`: a virtualised `.chat-container__chat-list` that renders only the items in view, seeded with messages from `Dr Lecturer (Host)` (with `https://forms.gle/abc`), a grouped follow-up without sender or time, `Student A` (with a `forms.office.com` link and element id `msg-student-a`), and a reply carrying `.chat-item__quote`; `?chat=closed` starts with the panel closed; `?seed=60` seeds 60 messages; `canvas#sharee-container` at `{ x: 0, y: 60, width: 1410, height: 840 }` inside `#sharee-container`; a "Join Audio by Computer" button; `__fixture.addMessage(m)`, `scrollTop(y)`, `endMeeting()` ("This meeting has been ended by host" with OK, Leave removed), `remove()`, `breakout()` ("Dr Lecturer invited you to join Breakout Room 1" with "Join" and "Later"), `stopShare()` and `showNotice()` (one dialog with "Got it" and "OK", a hidden "OK", and another with "Allow", "Start Video" and "Join Breakout Room"); `__fixture.forbiddenClicks` logs any click on audio, video, share, react or chat-input controls.
- Test: `packages/worker/test/zoom-meeting.spec.ts`

**Interfaces:**

- Consumes: Task 13's selectors, `zoomRoot`, `ZOOM_TIMEOUTS`; `extractLinks` from Task 12.
- Produces: `zoomAdapter.connectOutputAudio`, `ensureLayout`, `readChat`, `sweepChat`, `sharedScreenRegion`, `participantCount`, `meetingState`, `dismissNotices`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/test/zoom-meeting.spec.ts, each test run for root 'top' and 'iframe'
test('chat: structured messages, roles, grouping, replies, cursor', async ({ page }) => {
  const { messages, cursor } = await zoomAdapter.readChat(page, {
    seenKeys: []
  })
  expect(messages[0]).toMatchObject({
    sender: 'Dr Lecturer',
    senderRole: 'host',
    time: '8:41 PM',
    text: 'Attendance: https://forms.gle/abc',
    links: ['https://forms.gle/abc'],
    replyTo: null
  })
  expect(messages[1]).toMatchObject({ sender: 'Dr Lecturer', time: '8:41 PM' })
  expect(messages[2]!.key).toBe('id:msg-student-a')
  expect(messages[2]!.senderRole).toBe('participant')
  expect(messages[3]!.replyTo).toBe(messages[0]!.key)
  expect((await zoomAdapter.readChat(page, cursor)).messages).toEqual([])
  await page.evaluate(() => {
    window.__fixture.scrollTop(0)
    window.__fixture.addMessage({
      sender: 'Student B',
      time: '8:50 PM',
      text: 'late one'
    })
  })
  await expect
    .poll(async () => (await zoomAdapter.readChat(page, cursor)).messages.map((m) => m.text))
    .toEqual(['late one'])
})
test('sweep recovers every item of a virtualised list', async ({ page }) => {
  // ?seed=60
  expect(new Set((await zoomAdapter.sweepChat(page)).map((m) => m.key)).size).toBe(60)
})
test('signals and notices', async ({ page }) => {
  expect(await zoomAdapter.participantCount(page)).toBe(12)
  expect(await zoomAdapter.sharedScreenRegion(page)).toEqual({
    x: 0,
    y: 60,
    width: 1410,
    height: 840
  })
  expect(await zoomAdapter.meetingState(page)).toBe('in_meeting')
  await page.evaluate(() => window.__fixture.showNotice())
  expect(await zoomAdapter.dismissNotices(page)).toEqual(['Got it', 'OK'])
  await page.evaluate(() => window.__fixture.breakout())
  expect(await zoomAdapter.meetingState(page)).toBe('breakout_prompt')
  expect(await zoomAdapter.dismissNotices(page)).toEqual([])
  await page.evaluate(() => window.__fixture.stopShare())
  expect(await zoomAdapter.sharedScreenRegion(page)).toBeNull()
  await page.evaluate(() => window.__fixture.endMeeting())
  expect(await zoomAdapter.meetingState(page)).toBe('ended')
  expect(await page.evaluate(() => window.__fixture.forbiddenClicks)).toEqual([])
})
test('layout opens chat; audio joins by computer once', async ({ page }) => {
  // ?chat=closed
  await zoomAdapter.ensureLayout(page)
  await expect(page.locator('.chat-container__chat-list')).toBeVisible()
  await zoomAdapter.connectOutputAudio(page)
  await zoomAdapter.connectOutputAudio(page)
  expect(await page.evaluate(() => window.__fixture.clicks.filter((c) => c === 'join audio by computer').length)).toBe(
    1
  )
  expect(await page.evaluate(() => window.__fixture.forbiddenClicks)).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts zoom-meeting.spec.ts`
Expected: FAIL with "zoomAdapter.readChat is not a function".

- [ ] **Step 3: Implement**

`readChat` installs (once per document; reinstalled if missing) an in-page parser modelled on `reference-scripts/browser/zoom-chat-capture.js`: a `MutationObserver` plus a 3-second timer parse each `chatItem` into `{ key, sender, senderRole, time, seenAt, text, links, replyTo }`, carrying sender and time forward for grouped items; the role comes from `roleLabel` on the sender text, which is then stripped (`participant` when there is no label, `unknown` when there is no sender); `key` is `id:<id>` when the item or an id-bearing ancestor inside the list has one, else `` `${sender}|${time}|${text.slice(0, 200)}` ``; `links` are `extractLinks(text)` plus anchor `href`s; `replyTo` is the key of the latest earlier message whose text starts with the `chatReplyQuote` text. A 1.5-second timer keeps the list scrolled to the bottom. `readChat` returns parsed messages whose keys are not in `cursor.seenKeys` and a new cursor with them added; it never advances anything itself, so the caller adopts the cursor only after a durable write. `sweepChat` stops the bottom timer, scrolls top to bottom in steps of `max(200, clientHeight / 2)` px with 300 ms pauses, restarts the timer in a `finally`, and returns every parsed message. `participantCount` reads `[N]` from the participants button's aria-label, else its digits. `sharedScreenRegion` is the bounding box of `shareSurface` plus the iframe's offset, or null. `meetingState` checks, in order: `ended`, `removed`, `breakout` texts, lobby text, a visible Leave button (`in_meeting`), else `unknown`. `dismissNotices` clicks visible buttons whose trimmed text equals an allowlist entry (case-insensitive) unless their dialog contains the breakout text, and returns the texts clicked. `ensureLayout` clicks `openChat` only if the chat list is not visible. `connectOutputAudio` clicks `joinAudioByComputer` if visible (with the microphone permission denied, Zoom joins computer audio for listening only).

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts zoom-meeting.spec.ts`
Expected: all pass for both roots.

- [ ] **Step 5: Commit**

```bash
git add packages/worker
git commit -m "feat(worker): add zoom chat and meeting signals"
```

### Task 15: Chat capture

**Files:**

- Create: `packages/worker/src/chat/capture.ts`
- Test: `packages/worker/test/chat-capture.spec.ts`

**Interfaces:**

- Consumes: `PlatformAdapter.readChat`, `sweepChat` (Task 14); `ChatMessage`, `Stopper`.
- Produces (adds to contracts): `startChatCapture(page: Page, adapter: PlatformAdapter, file: string, onMessage: (m: ChatMessage) => Promise<void>, opts?: { pollMs?: number; sweepMs?: number; append?: (file: string, data: string) => Promise<void> }): Promise<ChatCapture>` with defaults 3,000 and 600,000 ms; `interface ChatCapture extends Stopper { sweepNow(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/test/chat-capture.spec.ts
test('messages reach chat.jsonl before onMessage, in order', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  const seen: string[] = []
  const c = await startChatCapture(
    page,
    zoomAdapter,
    file,
    async (m) => {
      seen.push(m.key)
      expect(await lines(file)).toContainEqual(expect.objectContaining({ key: m.key }))
    },
    { pollMs: 200 }
  )
  await expect.poll(() => seen.length).toBe(4)
  await c.stop()
  expect((await lines(file)).map((m) => m.key)).toEqual(seen)
})
test('a failed write does not advance the cursor', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html')
  let fail = true
  const append = async (f: string, d: string) => {
    if (fail) {
      fail = false
      throw new Error('EIO')
    }
    await appendFile(f, d)
  }
  const c = await startChatCapture(page, zoomAdapter, file, async () => {}, {
    pollMs: 200,
    append
  })
  await expect.poll(async () => (await lines(file)).length).toBe(4)
  await c.stop()
})
test('a restart does not duplicate lines; sweeps recover a virtualised list', async ({ page }) => {
  await page.goto('/zoom-meeting-top.html?seed=60')
  const a = await startChatCapture(page, zoomAdapter, file, async () => {}, {
    pollMs: 200,
    sweepMs: 500
  })
  await expect.poll(async () => (await lines(file)).length).toBe(60)
  await a.stop()
  await page.reload()
  const b = await startChatCapture(page, zoomAdapter, file, async () => {}, {
    pollMs: 200
  })
  await b.sweepNow()
  await b.stop()
  expect((await lines(file)).length).toBe(60)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx playwright test -c packages/worker/playwright.config.ts chat-capture.spec.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

On start, load the keys already in `file` into the cursor. Every `pollMs`, call `readChat`; write all new messages as one JSON-lines append; only after the append resolves adopt the returned cursor and call `onMessage` for each, in order. A failed append keeps the old cursor, logs the error code and retries on the next poll. Every `sweepMs`, and on `sweepNow()`, run `sweepChat` and handle unseen keys the same way. Polls and sweeps never overlap.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx playwright test -c packages/worker/playwright.config.ts chat-capture.spec.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/worker docs/plans/architecture.md
git commit -m "feat(worker): add durable chat capture"
```

### Task 16: Form pings

**Files:**

- Create: `packages/worker/src/forms/pinger.ts`, `packages/worker/src/forms/provider-check.ts`
- Create fixtures: `packages/worker/test/fixtures/forms-home.html` (a forms list page with no sign-in fields), `packages/worker/test/fixtures/forms-signin.html` (a visible `input[type=email]`)
- Test: `packages/worker/src/forms/pinger.test.ts`, `packages/worker/test/provider-check.spec.ts`

**Interfaces:**

- Consumes: `nextFormState`, `FormTrigger` (Task 2); `formToSubmitPing`, `formNotSubmittedPing`, `linkUncheckedPing` (Task 3); `resolveFormLink`, `LinkResolveError`, `normaliseFormUrl`, `checkTrust` (Task 12); `localParts` (Task 2).
- Produces (adds to contracts): `createFormPinger(deps: FormPingerDeps): FormPinger`; `interface FormPingerDeps { cfg: JobConfig; send: (p: Ping) => Promise<void>; emit: (type: EventType, data: Record<string, unknown>) => Promise<void>; resolve?: typeof resolveFormLink; now?: () => Date }`; `interface FormPinger { offer(c: FormCandidate): Promise<void>; idle(): Promise<void> }`; `interface FormPingRecord { formId: string; url: string; source: FormSource; sender: string | null; senderRole: SenderRole | null; seenAt: string; provider: FormProvider | null; state: FormState; trustReason: TrustReason | null; pingedAt: string | null }`, written to `forms/<formId>/record.json` (`formId` is the first 12 hex characters of SHA-256 of the duplicate key); `checkFormProviders(desk: Page, providers: FormProvider[], opts?: { urls?: Partial<Record<FormProvider, string>> }): Promise<FormProvider[]>` (returns the signed-out providers).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/forms/pinger.test.ts (resolveMap is a fake resolver that waits 50 ms; sent collects pings; ev collects events)
test('trusted QR form: manual-submission ping within 30 s and a record', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve: resolveMap })
  await p.offer({
    url: 'https://forms.gle/abc',
    source: 'qr',
    sender: null,
    senderRole: null,
    seenAt: t0
  })
  await p.idle()
  expect(sent.map((s) => s.title)).toEqual(['Form to submit: Data Mining'])
  const rec: FormPingRecord = await readRecord(cfg.dataDir)
  expect(rec).toMatchObject({
    state: 'needs_member',
    trustReason: 'qr_on_screen',
    provider: 'google'
  })
  expect(Date.parse(rec.pingedAt!) - Date.parse(rec.seenAt)).toBeLessThan(30_000)
  expect(ev.filter((e) => e.type === 'form').map((e) => e.data.state)).toEqual([
    'resolving',
    'checking_trust',
    'needs_member'
  ])
  expect(JSON.stringify(ev)).not.toContain('?')
})
test('untrusted sender: "seen, not submitted"; one ping per form across shapes', async () => {
  const p = createFormPinger({ cfg, send, emit, resolve: resolveMap })
  for (const url of [
    'https://forms.gle/abc',
    'https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=pp_url&entry.1=x',
    safeLinked('https://docs.google.com/forms/d/e/1FAIpQ/viewform')
  ])
    await p.offer({
      url,
      source: 'meeting_chat',
      sender: 'Student A',
      senderRole: 'participant',
      seenAt: t0
    })
  await p.idle()
  expect(sent.map((s) => s.title)).toEqual(['Form seen, not submitted: Data Mining'])
})
test('non-forms are ignored; unresolvable links ping only from trusted sources', async () => {
  const p = createFormPinger({
    cfg,
    send,
    emit,
    resolve: async (c) => {
      if (c.url.includes('slow')) throw new LinkResolveError('timeout')
      return null
    }
  })
  await p.offer({
    url: 'https://example.com/notes',
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    seenAt: t0
  })
  await p.offer({
    url: 'https://slow.example/a',
    source: 'meeting_chat',
    sender: 'Student A',
    senderRole: 'participant',
    seenAt: t0
  })
  await p.offer({
    url: 'https://slow.example/b',
    source: 'meeting_chat',
    sender: 'Dr Lecturer',
    senderRole: 'host',
    seenAt: t0
  })
  await p.idle()
  expect(sent.map((s) => s.title)).toEqual(['Link seen, not checked: Data Mining'])
  expect(ev.find((e) => e.data.outcome === 'ignored')!.data.host).toBe('example.com')
})
```

```ts
// packages/worker/test/provider-check.spec.ts
test('reports signed-out providers', async ({ page }) => {
  expect(
    await checkFormProviders(page, ['google', 'microsoft'], {
      urls: { google: '/forms-home.html', microsoft: '/forms-signin.html' }
    })
  ).toEqual(['microsoft'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/forms/pinger.test.ts` and `bunx playwright test -c packages/worker/playwright.config.ts provider-check.spec.ts`
Expected: FAIL with "Cannot find module" in both.

- [ ] **Step 3: Implement**

`offer` ignores a raw URL already in flight or done; each candidate runs concurrently through `nextFormState` from `detected`: `resolve`, then `resolveFormLink`. A null result emits `form` `{ outcome: 'ignored', host }` and stops without a record. A `LinkResolveError` sends `linkUncheckedPing` only when `checkTrust` on the candidate is trusted, emits `form` `{ outcome: 'unresolved', reason, host }`, and stops. Otherwise `resolved`; a duplicate key (`normaliseFormUrl(finalUrl)`) stops silently; then `checkTrust(form, cfg.entry.trustedSenders)` gives `manual_only` (ping `formToSubmitPing`) or `untrusted` (ping `formNotSubmittedPing`), with times shown as `HH:MM` in `cfg.entry.timeZone`. Each state change emits `form` `{ formId, state, source, trustReason, host, path }` (never the query) and rewrites `record.json`; a thrown error moves the form to `failed` and emits `error`. `checkFormProviders` defaults to `https://docs.google.com/forms/u/0/` and `https://forms.office.com/`, navigates the desk with a 15-second timeout, and counts a provider as signed out when the final host is `accounts.google.com`, `login.microsoftonline.com` or `login.live.com`, when a visible `input[type=email]` or `input[type=password]` is present, or when the load times out.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/forms/pinger.test.ts && bunx playwright test -c packages/worker/playwright.config.ts provider-check.spec.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker docs/plans/architecture.md
git commit -m "feat(worker): ping form links to the member"
```

### Task 17: Live transcription in the worker

**Files:**

- Create: `packages/worker/src/asr/live.ts`
- Test: `packages/worker/src/asr/live.test.ts`

**Interfaces:**

- Consumes: `openAsrStream`, `AsrResult`, `AiKeyError` (Task 5); `AudioSource` (Task 10).
- Produces: `startLiveAsr(audio: AudioSource, ai: AiConfig, out: string, opts?: LiveAsrOptions): Promise<LiveAsr>` (`out` is `<dataDir>/transcript/live.jsonl`).
- Produces (adds to contracts): `interface LiveAsr { stop(): Promise<void> }`; `interface LiveAsrOptions { baseMs?: number; onError?: (e: Error) => void; open?: typeof openAsrStream }` (`baseMs` is the audio source's start minus the first recording start, so `live.jsonl` offsets are recording-relative).

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/src/asr/live.test.ts (fakeAudio emits chunks on demand; fakeOpen returns a scriptable AsrStream)
test('results become recording-relative lines', async () => {
  const live = await startLiveAsr(fakeAudio, ai, out, {
    baseMs: 4000,
    open: fakeOpen
  })
  fakeAudio.emit(Buffer.alloc(3200))
  expect(fakeOpen.stream.sent.length).toBe(1)
  fakeOpen.stream.result({
    startMs: 500,
    endMs: 2500,
    text: 'selamat petang semua'
  })
  await live.stop()
  expect(await lines(out)).toEqual([{ startMs: 4500, endMs: 6500, text: 'selamat petang semua' }])
  expect(fakeOpen.stream.closed).toBe(true)
})
test('a rejected key is reported once and stops sending audio', async () => {
  const errs: Error[] = []
  await startLiveAsr(fakeAudio, ai, out, {
    open: fakeOpen,
    onError: (e) => errs.push(e)
  })
  fakeOpen.stream.fail(new AiKeyError(402))
  fakeOpen.stream.fail(new AiKeyError(402))
  fakeAudio.emit(Buffer.alloc(3200))
  expect(errs.length).toBe(1)
  expect(errs[0]).toBeInstanceOf(AiKeyError)
  expect(fakeOpen.stream.sent.length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/worker/src/asr`
Expected: FAIL with "Cannot find module './live'".

- [ ] **Step 3: Implement**

Subscribe to `audio.onChunk` and forward each chunk to the stream; append each result to `out` as one JSON line with `baseMs` added to both offsets, as it arrives. The first `AiKeyError` unsubscribes from the audio, closes the stream and calls `onError` once; later errors are ignored; any other error is passed to `onError` and audio keeps flowing (the stream reconnects itself). `stop()` unsubscribes, then awaits `close()` so final results are written.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/worker/src/asr`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/asr docs/plans/architecture.md
git commit -m "feat(worker): write live transcript lines"
```

### Task 18: Occurrence run and tm-worker CLI

**Files:**

- Create: `packages/worker/src/run.ts`, `packages/worker/src/run-deps.ts`, `packages/worker/src/events.ts`, `packages/worker/src/frames/handler.ts`, `packages/worker/src/seed.ts`, `packages/worker/src/cli.ts`
- Test: `packages/worker/src/run.test.ts`, `packages/worker/src/events.test.ts`, `packages/worker/src/frames/handler.test.ts`, `packages/worker/src/cli.test.ts`

**Interfaces:**

- Consumes: everything produced by Tasks 2 to 17.
- Produces: `runOccurrence(cfg: JobConfig, deps?: Partial<RunDeps>): Promise<OccurrenceOutcome>` (the optional `deps` only serves tests); CLI `tm-worker --job <path>`.
- Produces (adds to contracts): `interface OccurrenceOutcome { result: 'completed' | 'denied' | 'not_admitted' | 'failed'; endedBy: 'page' | 'removed' | 'hard_stop' | 'dropped' | null; reason: string | null; joinedAt: string | null; endedAt: string }`, also written to `<dataDir>/outcome.json`; `interface RunDeps` with members `prepareProfile`, `restoreProfile`, `startScreen`, `launchBrowser`, `launchGuestStage`, `startCheckpoints`, `checkpointProfile`, `checkFormProviders`, `startAudioSource`, `startRecorder`, `joinRecording`, `adapterFor`, `startChatCapture`, `startFrameLoop`, `startLiveAsr`, `createFormPinger`, `sendPing` (each typed as its module's export), `now(): Date` and `sleep(ms: number): Promise<void>`; `interface FrameHandlerDeps { dataDir: string; timeZone: string; recordingStart: Date; lecture: boolean; region: () => Rect | null; participants: () => number | null; levelDb: () => number; emit: EventLog['emit']; onAlert: (k: AlertKind) => void; pinger: FormPinger | null }`; `createEventLog(file: string, occurrenceId: string, attempt: number): EventLog` with `interface EventLog { emit(type: EventType, data: Record<string, unknown>): Promise<void> }`; `redact(v: unknown): unknown`; `createFrameHandler(d: FrameHandlerDeps): (f: Frame) => Promise<void>`; failure artefacts `<dataDir>/errors/<step>-<HHMMSS>.png` and `.aria.yml`; CLI `tm-worker --seed --job <path>` and exit codes 0 (completed), 1 (other outcome), 64 (usage), 65 (invalid job).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/worker/src/run.test.ts (fakeDeps(): a scripted adapter, a fake clock and recorders of calls and pings)
test('happy path: order of steps and outcome', async () => {
  const d = fakeDeps({ states: ['in_meeting', 'in_meeting', 'ended'] })
  const o = await runOccurrence(lectureCfg, d)
  expect(o).toMatchObject({ result: 'completed', endedBy: 'page' })
  expect(d.calls).toEqual([
    'prepareProfile',
    'startScreen',
    'launchBrowser',
    'startCheckpoints',
    'checkFormProviders',
    'startAudioSource',
    'startRecorder',
    'goto',
    'join',
    'assertDevicesOff',
    'connectOutputAudio',
    'ensureLayout',
    'dismissNotices',
    'participantCount',
    'startChatCapture',
    'startFrameLoop',
    'startLiveAsr',
    'chat.stop',
    'frames.stop',
    'asr.stop',
    'pinger.idle',
    'recorder.stop',
    'joinRecording',
    'audio.stop',
    'context.close',
    'checkpoints.stop',
    'checkpointProfile',
    'screen.stop'
  ])
  expect(d.pings.map((p) => p.title)).toEqual(['Joined: Data Mining'])
})
test('hard stop at end + 30 minutes sweeps chat before leaving', async () => {
  const d = fakeDeps({ states: 'always_in_meeting' })
  const o = await runOccurrence(lectureCfg, d)
  expect(o.endedBy).toBe('hard_stop')
  expect(+d.leftAt!).toBe(+new Date(lectureCfg.entry.end) + 30 * 60_000)
  expect(d.calls.indexOf('sweepNow')).toBe(d.calls.indexOf('leave') - 1)
})
test('busy Zoom account falls back to a guest stage', async () => {
  const d = fakeDeps({
    joins: [{ kind: 'account_busy' }, { kind: 'in_meeting' }],
    states: ['ended']
  })
  await runOccurrence(lectureCfg, d)
  expect(d.calls).toContain('launchGuestStage')
  expect(d.joinOpts[1]).toEqual({
    guestName: lectureCfg.identity.zoomGuestName
  })
})
test('Review Focus: never admitted, or ended while waiting', async () => {
  const d = fakeDeps({
    joins: [{ kind: 'lobby' }],
    admissions: ['lobby_expired', 'lobby_expired', 'lobby_expired']
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'not_admitted'
  })
  expect(d.joinCount).toBe(3)
  expect(d.pings.map((p) => p.message)).toEqual(['The bot was still waiting to be let in at the hard stop.'])
  expect(d.calls.indexOf('checkpointProfile')).toBeGreaterThan(d.calls.indexOf('context.close'))
  const e = fakeDeps({
    joins: [{ kind: 'lobby' }],
    admissions: ['lobby_denied']
  })
  expect(await runOccurrence(lectureCfg, e)).toMatchObject({
    result: 'denied'
  })
})
test('devices on: leave at once, ping, fail', async () => {
  const d = fakeDeps({ devicesOn: true })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    result: 'failed',
    reason: 'devices_on'
  })
  expect(d.calls.indexOf('leave')).toBe(d.calls.indexOf('assertDevicesOff') + 1)
})
test('one automatic rejoin after a drop, then stop', async () => {
  const d = fakeDeps({
    states: ['in_meeting', 'unknown', 'in_meeting', 'unknown'],
    unknownMs: 30_000
  })
  expect(await runOccurrence(lectureCfg, d)).toMatchObject({
    endedBy: 'dropped'
  })
  expect(d.joinCount).toBe(2)
  expect(d.pings.filter((p) => p.title.startsWith('Alert')).map((p) => p.message)).toEqual([
    'The bot dropped out of the meeting and is rejoining.',
    'The bot dropped out of the meeting again and stopped.'
  ])
})
test('work entries skip forms; non-fixed links are refused', async () => {
  const d = fakeDeps({ states: ['ended'] })
  await runOccurrence(workCfg, d)
  expect(d.calls).not.toContain('checkFormProviders')
  expect(d.formPinger).toBeNull()
  expect(
    await runOccurrence(
      {
        ...lectureCfg,
        entry: { ...lectureCfg.entry, link: { kind: 'paste' } }
      },
      fakeDeps({})
    )
  ).toMatchObject({ result: 'failed', reason: 'link_source_unsupported' })
})
```

```ts
// packages/worker/src/events.test.ts
test('events are JSON lines with secrets redacted', async () => {
  const log = createEventLog(file, 'occ-1', 1)
  await log.emit('error', {
    url: 'https://zoom.us/wc/join/00000000000?pwd=PWD',
    auth: 'Bearer abc.def'
  })
  const [e] = await lines(file)
  expect(e).toMatchObject({
    occurrenceId: 'occ-1',
    attempt: 1,
    type: 'error',
    data: { url: '<zoom.us/wc/join/00000000000>', auth: 'Bearer REDACTED' }
  })
})
```

```ts
// packages/worker/src/frames/handler.test.ts (synthetic PNGs; fake pinger records offers)
test('QR seen twice is offered once; keyframes saved with clock names', async () => {
  const h = createFrameHandler({ ...deps, timeZone: 'Asia/Kuala_Lumpur' })
  const f = await qrFrame('https://forms.gle/abc', 300, { x: 800, y: 300 })
  for (const at of ['2026-10-21T12:00:00Z', '2026-10-21T12:00:02Z', '2026-10-21T12:00:04Z'])
    await h({ at: new Date(at), png: f })
  expect(offers).toEqual([
    expect.objectContaining({
      url: 'https://forms.gle/abc',
      source: 'qr',
      sender: null
    })
  ])
  expect(await readdir(join(dataDir, 'frames'))).toEqual(['0001_200002.png'])
  expect(events.find((e) => e.type === 'keyframe')!.data).toMatchObject({
    file: 'frames/0001_200002.png',
    region: null,
    offsetMs: 2000
  })
})
```

```ts
// packages/worker/src/cli.test.ts
test('usage and invalid jobs never echo secrets', async () => {
  const a = Bun.spawnSync(['bun', 'packages/worker/src/cli.ts'])
  expect(a.exitCode).toBe(64)
  expect(a.stderr.toString()).toContain('usage: tm-worker [--seed] --job <path>')
  const b = Bun.spawnSync(['bun', 'packages/worker/src/cli.ts', '--job', badJobWithKey('sk-secret-value')])
  expect(b.exitCode).toBe(65)
  expect(b.stderr.toString()).not.toContain('sk-secret-value')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/worker/src/run.test.ts packages/worker/src/events.test.ts packages/worker/src/frames/handler.test.ts packages/worker/src/cli.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `runOccurrence` in `packages/worker/src/run.ts`**

The sequence (every awaited step has the timeout of its module; a failure saves the stage's screenshot and `ariaSnapshot()` under `errors/`, pings `join_failed` with the step name and returns `failed`):

```text
 1  link.kind !== 'fixed' -> failed 'link_source_unsupported'. Create dataDir subfolders; events = createEventLog(dataDir/events.jsonl).
    key = deriveProfileKey(readMasterKey(TM_MASTER_KEY_FILE), identity.id); checkpoints dir = TM_PROFILE_ROOT/<identity.id>/checkpoints.
    If profileDir is empty and a checkpoint exists, restoreProfile(latest). prepareProfile(profileDir, identity.id).
 2  screen = startScreen(); { context, stage, desk } = launchBrowser(profileDir, screen); startCheckpoints(profileDir, checkpoints, key).
 3  lecture: for each provider in checkFormProviders(desk, identity.formProviders): ping alert signin_forms (detail "Google" or "Microsoft").
 4  sleep until start - 10 min. audio = startAudioSource(); recorder = startRecorder(screen, dataDir/recording, attempt);
    recorder.onGap -> event recording_gap + ping alert recording_gap.
 5  adapter = adapterFor(url); url' = adapter.normaliseLink(url) (null -> failed 'unsupported_link'); stage.goto(url');
    r = adapter.join(stage, { guestName: identity.zoomGuestName })
      account_busy    -> guest = launchGuestStage(screen); stage = guest.stage; goto; join again with the same name
      signin_required -> ping zoom_signin; failed 'signin_required'
      lobby           -> waitUntilAdmitted(stage, end + 30 min): lobby_expired before the deadline -> reload and join again (at most 2 more times);
                         lobby_denied -> ping lobby_denied; denied. Deadline reached -> ping not_admitted; not_admitted
      failed          -> ping join_failed (detail = reason); failed
 6  assertDevicesOff (DevicesOnError -> leave at once, ping devices_on, failed 'devices_on'); connectOutputAudio; ensureLayout;
    dismissNotices (each text -> notice_dismissed event); ping joined(participantCount); event joined.
 7  lecture: pinger = createFormPinger; confirmer = new QrConfirmer. chat = startChatCapture(stage, adapter, dataDir/chat.jsonl,
    m -> lecture ? m.links.forEach(url -> pinger.offer({ url, source: 'meeting_chat', sender, senderRole, seenAt })) : nothing).
    frames = startFrameLoop(screen, createFrameHandler(...)); transcription live -> startLiveAsr(audio, ai, dataDir/transcript/live.jsonl,
    { baseMs: audio.startedAt - recorder.startedAt, onError: AiKeyError -> ping ai_key once }).
    If audio.levelDb(5000) stays below -60 dBFS for 120 s after max(join, start): connectOutputAudio once more, then ping no_audio.
 8  every 5 s: dismissNotices; assertDevicesOff (as in 6); every 10 s refresh sharedScreenRegion and participantCount; meetingState:
      ended -> endedBy 'page'; removed -> ping removed, endedBy 'removed'; breakout_prompt -> ping breakout once per prompt;
      unknown for 30 s -> first time: ping dropped, goto + join again (step 5 rules); second time: ping rejoin_failed, endedBy 'dropped'
      now >= end + 30 min -> endedBy 'hard_stop'
 9  teardown, always, in this order: chat.sweepNow() if still in the meeting; adapter.leave if still in the meeting; stop chat, frames, live ASR
    and pinger work (pinger.idle(), at most 30 s); recorder.stop(); joinRecording; audio.stop(); context.close() (and the guest browser);
    stop checkpoints; checkpointProfile(profileDir, checkpoints, key); screen.stop(); write outcome.json.
```

`createFrameHandler` computes the thumbnail, feeds `HealthMonitor` (alerts become pings and `alert` events), runs `KeyframeSelector` (kept frames go to `frames/<NNNN>_<HHMMSS>.png` with the clock in the entry's time zone and a `keyframe` event `{ file, region, offsetMs }`, where `offsetMs` is the frame time minus the first recording start), and for lectures decodes QR codes in the latest shared-screen region and offers each confirmed `http(s)` text as a `qr` candidate. `redact` replaces `pwd=` values, `token=` values and `Bearer` tokens, and rewrites any URL to `<host/path>`. `cli.ts` parses `--job` and `--seed`, reads and validates the job with `parseJob`, prints only issue paths on error, runs `runOccurrence` or `seedProfile`, and maps the outcome to the exit code. `seedProfile(cfg)` (`seed.ts`) restores or prepares the profile, launches the browser, opens `https://zoom.us/signin` on the desk, starts `x11vnc -display :99 -clip 1920x1080+1920+0 -rfbport 5900 -forever -shared -passwdfile <file>` (inside the container; `run-job.sh` publishes the port only on the host's `127.0.0.1`) with a random one-time password printed once to the terminal (never to a log), waits for Enter or SIGINT, then closes the browser and writes a checkpoint.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/worker/src/run.test.ts packages/worker/src/events.test.ts packages/worker/src/frames/handler.test.ts packages/worker/src/cli.test.ts && bun run typecheck && bun run build:worker`
Expected: all pass; `packages/worker/dist/cli.js` exists.

- [ ] **Step 5: Commit**

```bash
git add packages/worker docs/plans/architecture.md
git commit -m "feat(worker): add occurrence run and tm-worker cli"
```

### Task 19: Transcript and chat documents

**Files:**

- Create: `packages/pipeline/src/transcript.ts`, `packages/pipeline/src/names.ts`, `packages/pipeline/src/chat.ts`
- Modify: `packages/pipeline/package.json` (depends on `@tm/core`, `@tm/ai`, `@tm/notify`)
- Test: `packages/pipeline/src/transcript.test.ts`, `packages/pipeline/src/names.test.ts`, `packages/pipeline/src/chat.test.ts`

**Interfaces:**

- Consumes: `JobConfig`, `ChatMessage`, `formatOffset`, `localParts` (Task 2); `transcript/live.jsonl`, `recording/attempts.json` and `chat.jsonl` as written by Tasks 9, 15 and 17.
- Produces (adds to contracts): `interface LiveLine { startMs: number; endMs: number; text: string }`; `interface Gap { atMs: number; ms: number }`; `type TranscriptBlock = { kind: 'para'; atMs: number; text: string } | { kind: 'silence'; atMs: number; ms: number } | { kind: 'gap'; atMs: number; ms: number }`; `isHallucination(text: string): boolean`; `paragraphs(lines: LiveLine[], gaps: Gap[]): TranscriptBlock[]`; `correctNames(text: string, vocab: string[]): string`; `buildTranscript(cfg: JobConfig, vocab: string[]): Promise<string>`; `orderChat(msgs: ChatMessage[]): ChatMessage[]`; `stripInviteLinks(text: string): string`; `buildChat(cfg: JobConfig): Promise<string>` (each builder returns the path it wrote).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pipeline/src/transcript.test.ts
test('hallucinations are dropped', () => {
  for (const t of ['you', 'You.', 'Thank you for watching!', 'thanks for watching', '.'])
    expect(isHallucination(t)).toBe(true)
  expect(isHallucination('Thank you, everyone')).toBe(false)
})
test('paragraphs on pauses of 2 s or 600 characters, silence notes from 2 minutes, recording gaps', () => {
  const b = paragraphs(
    [
      l(0, 1000, 'Selamat petang.'),
      l(1500, 3000, 'Today, clustering.'),
      l(5200, 6000, 'First,'),
      l(130_000, 131_000, 'Okay.')
    ],
    [{ atMs: 200_000, ms: 120_000 }]
  )
  expect(b).toEqual([
    { kind: 'para', atMs: 0, text: 'Selamat petang. Today, clustering.' },
    { kind: 'para', atMs: 5200, text: 'First,' },
    { kind: 'silence', atMs: 6000, ms: 124_000 },
    { kind: 'para', atMs: 130_000, text: 'Okay.' },
    { kind: 'gap', atMs: 200_000, ms: 120_000 }
  ])
})
test('transcript.md format', async () => {
  const md = await Bun.file(await buildTranscript(cfg, [])).text()
  expect(md).toStartWith(
    '# Data Mining: transcript\n\nWed 21 Oct 2026, 20:00 to 22:00 (Asia/Kuala_Lumpur). Live transcription; times are from the recording start, and names may be misheard.\n\n## Transcript\n\n**[00:00:00]** Selamat petang.'
  )
  expect(md).toContain('_[00:00:06] No speech for 2 minutes._')
  expect(md).toContain('_[00:03:20] Recording gap of 2 minutes._')
})
```

```ts
// packages/pipeline/src/names.test.ts
test('names are corrected from authoritative text and marked as heard', () => {
  expect(correctNames('thanks Dr Amina, today Kubernetis and Kubernetes', ['Dr Aminah', 'Kubernetes'])).toBe(
    'thanks Dr Aminah _(as heard: "Dr Amina")_, today Kubernetes _(as heard: "Kubernetis")_ and Kubernetes'
  )
  expect(correctNames('the data is clean', ['Dataset'])).toBe('the data is clean')
})
```

```ts
// packages/pipeline/src/chat.test.ts
test('de-duplicate, order, replies after parents, invite links removed', () => {
  const out = orderChat([
    m('a', '8:41 PM', 'Lecturer', 'Attendance: https://forms.gle/abc', 1),
    m('b', '8:42 PM', 'Student A', 'hi', 2),
    m('c', '8:43 PM', 'Student B', 'thanks', 3, 'a'),
    m('a2', '8:41 PM', 'Lecturer', 'Attendance: https://forms.gle/abc', 4)
  ])
  expect(out.map((x) => x.key)).toEqual(['a', 'c', 'b'])
  expect(stripInviteLinks('join https://example-uni.zoom.us/j/00000000000?pwd=PWD now')).toBe(
    'join [meeting link removed] now'
  )
  expect(stripInviteLinks('https://meet.google.com/abc-defg-hij and https://teams.microsoft.com/l/meetup-join/x')).toBe(
    '[meeting link removed] and [meeting link removed]'
  )
})
test('chat.md format', async () => {
  const md = await Bun.file(await buildChat(cfg)).text()
  expect(md).toContain(
    '# Data Mining: chat\n\n3 messages from the meeting chat, in posting order. Meeting links are removed.\n\n## Messages\n\n'
  )
  expect(md).toContain(
    '**[8:41 PM] Lecturer (host):** Attendance: https://forms.gle/abc\n\n> **[8:43 PM] Student B:** thanks'
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/pipeline/src/transcript.test.ts packages/pipeline/src/names.test.ts packages/pipeline/src/chat.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`isHallucination`: lowercase, strip punctuation and whitespace at the ends; true for an empty or one-character result, or one of `you`, `thank you`, `thank you for watching`, `thanks for watching`. Gaps come from `attempts.json`: for consecutive attempts, `atMs` is the later start minus the first start, `ms` the later start minus the earlier stop. `paragraphs` drops hallucinations, starts a new paragraph after a pause of at least 2,000 ms or at 600 characters, inserts a `silence` block for pauses of at least 120,000 ms, and merges `gap` blocks by time. `correctNames` slides a window of as many words as each term has (1 to 3) over the text; a window whose lowercase form differs from a term of at least 6 letters by a Damerau-Levenshtein distance of at most 1 (2 for terms of 10 or more letters) becomes `<term> _(as heard: "<window>")_`. `buildTranscript` runs `correctNames` on each paragraph and writes `out/transcript.md` (silence and gap notes as `_[HH:MM:SS] No speech for N minutes._` and `_[HH:MM:SS] Recording gap of N minutes._`, rounded minutes). `orderChat` de-duplicates on `(sender, time, text.slice(0, 200))`, keeps posting order by first `seenAt`, and moves each reply directly after its parent and that parent's earlier replies. `stripInviteLinks` replaces Zoom (`/j/`, `/wc/`, `/my/`, `/s/`), Teams (`/l/meetup-join/`, `teams.live.com/meet/`) and Meet (`meet.google.com/xxx-xxxx-xxx`) links with `[meeting link removed]`. `buildChat` writes `out/chat.md`; host and co-host senders get ` (host)` or ` (co-host)`; replies are quoted lines after the parent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/pipeline/src/transcript.test.ts packages/pipeline/src/names.test.ts packages/pipeline/src/chat.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline docs/plans/architecture.md
git commit -m "feat(pipeline): build transcript and chat files"
```

### Task 20: Slides

**Files:**

- Create: `packages/pipeline/src/slides.ts`, `packages/pipeline/src/crop.ts`
- Test: `packages/pipeline/src/crop.test.ts`, `packages/pipeline/src/slides.test.ts`

**Interfaces:**

- Consumes: `keyframe` events in `events.jsonl` and PNGs in `frames/` (Task 18); `GreyImage`, `meanLuma`, `dHash256`, `hamming` (Task 10); `chatJson` (Task 4).
- Produces (adds to contracts): `interface Slide { n: number; file: string; atMs: number; title: string; text: string }` (`file` is `slides/NN.webp`); `interface KeptFrame { file: string; offsetMs: number; region: Rect | null }`; `brightnessCrop(img: GreyImage, search: Rect): Rect | null`; `selectSlides(frames: { frame: KeptFrame; hash: bigint; luma: number }[]): KeptFrame[]`; `buildSlides(cfg: JobConfig, opts?: { concurrency?: number }): Promise<{ slides: Slide[]; mdPath: string }>`; `slides/slides.json` holds `Slide[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pipeline/src/crop.test.ts
test('brightness crop finds the shared screen on a dark stage', () => {
  const img = dark(1920, 1080)
  paint(img, { x: 100, y: 200, width: 1000, height: 600 }, 200)
  expect(brightnessCrop(img, { x: 0, y: 0, width: 1421, height: 1080 })).toEqual({
    x: 100,
    y: 200,
    width: 1000,
    height: 600
  })
  expect(brightnessCrop(dark(1920, 1080), { x: 0, y: 0, width: 1421, height: 1080 })).toBeNull()
})
test('near-duplicates, build-ups and black frames are dropped', () => {
  const kept = selectSlides([
    k('a', 0, 0b0n, 90),
    k('a2', 10_000, 0b111n, 90),
    k('black', 15_000, 0xffffn, 3),
    k('b-part', 20_000, 1n << 100n, 90),
    k('b', 24_000, (1n << 100n) | 0xfffffn, 90)
  ])
  expect(kept.map((f) => f.file)).toEqual(['a', 'b'])
})
```

```ts
// packages/pipeline/src/slides.test.ts (a data dir with three keyframes, one with a region; a fake AI server answers {title, text})
test('slides are cropped, saved as WebP, read by the vision model and written to slides.md', async () => {
  const { slides, mdPath } = await buildSlides(cfg)
  expect(slides.map((s) => [s.n, s.file])).toEqual([
    [1, 'slides/01.webp'],
    [2, 'slides/02.webp']
  ])
  expect(await sharp(join(cfg.dataDir, 'slides/01.webp')).metadata()).toMatchObject({ width: 1410, height: 840 })
  expect(fake.requests[0].body).toMatchObject({
    model: 'qwen3-vl-plus',
    enable_thinking: false
  })
  expect(fake.requests[0].body.messages[1].content[1].image_url.url).toStartWith('data:image/webp;base64,')
  const md = await Bun.file(mdPath).text()
  expect(md).toContain(
    '# Data Mining: slides\n\n2 slides shown in the meeting, read by a vision model. Covered or unreadable text is marked, never guessed.\n\n## Slide 01: Clustering\n\n![Slide 01: Clustering](../slides/01.webp)\n\n'
  )
  expect(JSON.parse(await Bun.file(join(cfg.dataDir, 'slides/slides.json')).text())).toEqual(slides)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/pipeline/src/crop.test.ts packages/pipeline/src/slides.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`brightnessCrop` keeps the span of columns and rows in `search` where at least 4% of pixels (sampling every second pixel) are brighter than 40, or returns null when none qualify (the session's `crop.py` rule). Per keyframe, the crop is the event's `region` (clamped to 1920x1080), else `brightnessCrop` over the left 74% of the stage (`{ x: 0, y: 0, width: 1421, height: 1080 }`); a frame with no crop, or a crop with mean luma below 10, is dropped. `selectSlides` (input sorted by time, hashes of the crops): drop luma below 10; drop a frame whose hash is within 12 bits of an already kept one; drop a frame when the next remaining frame is within 6,000 ms and within 30 bits (a build-up). Each kept crop becomes `slides/NN.webp` (`sharp().webp({ quality: 90, effort: 6 })`, two digits, three past 99) and goes to `chatJson(cfg.ai, cfg.ai.models.vision, ..., z.object({ title: z.string(), text: z.string() }), 60_000)`, at most `concurrency` (default 4) at once, with this system prompt (exact copy):

```text
You read one slide from a lecture's shared screen. Reply with JSON {"title": string, "text": string} and nothing else.
- Transcribe the slide's text faithfully, in its own language, keeping lists and line order.
- Ignore the meeting app's interface: toolbars, name labels, chat panels and cursors.
- Write [covered] where something hides text and [illegible] where it can't be read. Never guess or invent.
- Describe a screenshot of an app in one italic line instead of transcribing it.
- Never transcribe other people's usernames or messages shown on the slide.
- "title" is the slide's heading, or a 3 to 6 word description if it has none.
```

`out/slides.md`: the H1 and intro line from the test, then per slide `## Slide NN: <title>`, the image line and the text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/pipeline/src/crop.test.ts packages/pipeline/src/slides.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline docs/plans/architecture.md
git commit -m "feat(pipeline): curate and read slides"
```

### Task 21: Lecture summary and tm-pipeline CLI

**Files:**

- Create: `packages/pipeline/src/summary/inventory.ts`, `packages/pipeline/src/summary/render.ts`, `packages/pipeline/src/summary/name.ts`, `packages/pipeline/src/pipeline.ts`, `packages/pipeline/src/cli.ts`
- Test: `packages/pipeline/src/summary/render.test.ts`, `packages/pipeline/src/summary/inventory.test.ts`, `packages/pipeline/src/summary/name.test.ts`, `packages/pipeline/src/pipeline.test.ts`

**Interfaces:**

- Consumes: Tasks 19 and 20 builders; `chatJson`, `AiKeyError` (Task 4); `sendPing`, `summaryReadyPing`, `summaryFailedPing` (Task 3); `forms/<formId>/record.json` (Task 16, read with a local schema `{ state: string; url: string }`).
- Produces: `runPipeline(cfg: JobConfig): Promise<PipelineResult>`; CLI `tm-pipeline --job <path>` with exit codes 0, 1 (other error), 2 (`AiKeyError`), 64 (usage), 65 (invalid job).
- Produces (adds to contracts): `InventorySchema`, `type Inventory` and `type InventoryItem = Inventory['items'][number]` (below); `type AttendanceInfo = { kind: 'not_seen' } | { kind: 'needs_you'; url: string }`; `chooseDue(item: InventoryItem): { due: string | null; note: string | null }`; `buildInventory(cfg: JobConfig, src: { transcriptMd: string; slides: Slide[]; chat: ChatMessage[] }): Promise<Inventory>`; `renderLectureSummary(inv: Inventory, ctx: { cfg: JobConfig; attendance: AttendanceInfo | null; outDir: string }): string` (`attendance` null leaves the line out, for work entries until plan 06); `summaryFileName(cfg: JobConfig): string`; `ATTACH_SUMMARY: boolean` (set from spike 8's recommendation).

```ts
const Source = z.enum(['slide', 'lecturer_chat', 'speech'])
export const InventorySchema = z.object({
  sessionLabel: z.string().nullable(),
  nextAction: z.string().nullable(),
  items: z.array(
    z.object({
      kind: z.enum(['deadline', 'task', 'announcement', 'link']),
      text: z.string(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
        .nullable(), // in the entry's time zone
      source: Source,
      ref: z.string().nullable(), // "slide 12", "chat 8:41 PM", "[00:41:03]"
      conflicts: z.array(
        z.object({
          source: Source,
          due: z.string().nullable(),
          text: z.string()
        })
      )
    })
  ),
  covered: z.array(z.string())
})
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/pipeline/src/summary/render.test.ts
test('the lecture template, exactly', () => {
  expect(
    renderLectureSummary(smallInventory, {
      cfg,
      attendance: { kind: 'needs_you', url: 'https://forms.gle/abc' },
      outDir: '/data/out'
    })
  ).toBe(
    [
      'Data Mining, Week 7: Clustering (Wed 21 Oct 2026, 20:00 to 22:00)',
      '',
      'Do next: Submit assignment 2 (due Sun 1 Nov 2026, 23:59; heard as Sat 31 Oct 2026)',
      '',
      'Attendance: needs you: https://forms.gle/abc',
      '',
      'To do',
      '1. Submit assignment 2 (due Sun 1 Nov 2026, 23:59; heard as Sat 31 Oct 2026)',
      '2. Read chapter 8',
      '',
      'What was covered',
      '1. k-means',
      '2. Choosing k',
      '',
      'Details: transcript.md, slides.md and chat.md in /data/out',
      ''
    ].join('\n')
  )
})
test('7 deadlines: 5 most urgent under To do, the rest under More deadlines; empty sections left out', () => {
  const out = renderLectureSummary(sevenDeadlines, {
    cfg,
    attendance: { kind: 'not_seen' },
    outDir: '/o'
  })
  expect(section(out, 'To do')).toHaveLength(5)
  expect(section(out, 'More deadlines')).toHaveLength(2)
  expect(section(out, 'To do')[0]).toContain('(due Thu 22 Oct 2026)')
  expect(out).not.toContain('Announcements')
  expect(out.split('\n')[2]).toStartWith('Do next: ')
})
test('source priority: slide over lecturer chat over speech', () => {
  expect(
    chooseDue({
      ...item,
      source: 'speech',
      due: '2026-10-31',
      conflicts: [{ source: 'slide', due: '2026-11-01T23:59', text: '' }]
    })
  ).toEqual({ due: '2026-11-01T23:59', note: 'heard as Sat 31 Oct 2026' })
})
```

```ts
// packages/pipeline/src/summary/name.test.ts (Review Focus: UTC container, KL entry, unsafe names); run with TZ=UTC
test('file name in the entry time zone with unsafe characters replaced', () => {
  expect(
    summaryFileName({
      ...cfg,
      entry: {
        ...cfg.entry,
        start: '2026-10-21T12:00:00Z',
        timeZone: 'Asia/Kuala_Lumpur',
        name: 'Data Mining / Kuliah 5: Pengenalan'
      }
    })
  ).toBe('2026-10-21 2000 Data Mining - Kuliah 5- Pengenalan.md')
})
```

```ts
// packages/pipeline/src/summary/inventory.test.ts (fake AI server)
test('one uncapped inventory call with thinking off and sources labelled', async () => {
  const inv = await buildInventory(cfg, { transcriptMd, slides, chat })
  const body = fake.requests[0].body
  expect(body).toMatchObject({
    model: 'qwen3.7-plus',
    enable_thinking: false,
    response_format: { type: 'json_object' }
  })
  expect(body.messages[1].content).toContain('## Slides\n\nSlide 01: Clustering')
  expect(body.messages[1].content).toMatch(/## Lecturer chat\n\n\[8:41 PM\] Dr Lecturer: Assignment 2/)
  expect(InventorySchema.parse(inv)).toEqual(inv)
})
```

```ts
// packages/pipeline/src/pipeline.test.ts (a complete fixture data dir, fake AI and ntfy servers)
test('runPipeline writes the four files and pings the summary', async () => {
  const r = await runPipeline(cfg)
  for (const p of [r.transcriptPath, r.slidesPath, r.chatPath, r.summaryPath])
    expect(await Bun.file(p).exists()).toBe(true)
  expect(basename(r.summaryPath)).toBe('2026-10-21 2000 Data Mining.md')
  expect(ntfy.requests.at(-1)!.json).toMatchObject({
    title: 'Summary ready: Data Mining',
    priority: 3
  })
  expect(ntfy.requests.at(-1)!.json.message).toStartWith('Data Mining')
})
test('a rejected key keeps the inputs, pings and rethrows', async () => {
  ai.status(401)
  await expect(runPipeline(cfg)).rejects.toMatchObject({
    name: 'AiKeyError',
    status: 401
  })
  expect(ntfy.requests.at(-1)!.json.title).toBe('Summary failed: Data Mining')
  expect(await Bun.file(join(cfg.dataDir, 'transcript/live.jsonl')).exists()).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=UTC bun test packages/pipeline/src/summary packages/pipeline/src/pipeline.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`buildInventory` sends one `chatJson(cfg.ai, cfg.ai.models.summary, ..., InventorySchema, 180_000)` call. The user turn has four sections: `## Slides` (`Slide NN: <title>` then the text), `## Lecturer chat` (messages whose role is host or co-host, or whose sender is a trusted sender, as `[time] sender: text`), `## Other chat`, and `## Transcript`. The system prompt (exact copy):

```text
You extract an inventory from one lecture. Reply with JSON for the given schema and nothing else.
- List every deadline, task, announcement and link from the slides, the chat and the transcript. Do not cap or merge the list.
- Sources rank: slide text first, then the lecturer's chat messages, then speech. Put the highest-ranked source in "source" and "due".
- When sources disagree on a date or detail, keep the item once and list each other version in "conflicts".
- Dates are "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the lecture's time zone, resolved against the lecture date <YYYY-MM-DD>. Use null when no date was given; never guess one.
- "covered": the main topics taught, most important first, one short line each.
- "nextAction": the single most urgent thing the student must do, or null.
- "sessionLabel": the session's week or title as shown on the slides, or null.
- Keep names as written on the slides. Do not add a preamble, a recap or advice.
```

`chooseDue` takes the value from the highest-ranked source with a non-null date (slide, then lecturer chat, then speech) and notes every other differing date as `slide says`, `chat says` or `heard as`, plus the date, joined by `; `. `renderLectureSummary` follows the design's lecture template: the title line (`, <sessionLabel>` only when present; weekday, date and times from `localParts` in the entry's time zone); `Do next:` the earliest-due deadline or task (with its due text), else `nextAction`, else `nothing to do from this session`; the attendance line; `To do` (deadlines and tasks by due date, undated last, first 5); `What was covered` (first 5); `Announcements` (announcements then links, first 5); `More deadlines` (every remaining deadline and task, and any overflowing announcement with a date, uncapped); `Details: transcript.md, slides.md and chat.md in <outDir>`. Due text is `due <Ddd D Mon YYYY>` plus `, HH:mm` when timed, then `; <note>` when there is one. Empty sections are left out; sections are separated by one blank line. `summaryFileName`: `<localParts.date> <localParts.hhmm> <name>.md`, with each of `/ \ : * ? " < > |` replaced by `-`, whitespace collapsed and the name cut to 120 characters. `runPipeline`: `mkdir out`; `buildSlides`; vocabulary = `entry.formDetails` values plus capitalised words of at least 6 letters in slide text; `buildTranscript` (when `live.jsonl` is missing the transcript says `_No live transcript for this meeting._`); `buildChat`; `buildInventory`; render to `out/<summaryFileName>`; attendance is `needs_you` with the first `needs_member` record's URL, else `not_seen`; `sendPing(cfg.ntfy, summaryReadyPing(entry.name, md, ATTACH_SUMMARY ? summaryPath : undefined))`. An `AiKeyError` anywhere sends `summaryFailedPing(entry.name, status)` and is rethrown. `cli.ts` mirrors the worker CLI's argument and error handling.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC bun test packages/pipeline && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline docs/plans/architecture.md
git commit -m "feat(pipeline): add lecture summary and cli"
```

### Task 22: Milestone acceptance

**Files:**

- Modify: `docs/plans/01a-recorder-and-pings.md` (tick the steps and add a dated result line under each)

**Interfaces:**

- Consumes: the image (Task 6), `run-job.sh`, `tm-worker`, `tm-pipeline`.
- Produces: the 01a exit criteria in `docs/plans/README.md`, met on a real Zoom meeting: the "joined" ping, a ping for each trusted form link within 30 seconds, the summary within 10 minutes of the end, and a recording that contains only the stage.

- [ ] **Step 1: Prepare**

Prerequisites: the server with `TM_DATA_ROOT`, `TM_PROFILE_ROOT` (on the encrypted volume) and a 32-byte base64 master key file; a self-hosted ntfy with `auth-default-access: deny-all`, one member topic and token (the 1C Compose file doesn't exist yet, so run the ntfy image by hand), subscribed on the member's phone; a free TolongLabs Zoom account as host (each test meeting under 40 minutes) with the waiting room on; a second Zoom account as an untrusted participant; an organisation-restricted Google Form and Microsoft Form, each with an attendance confirmation; a 10-slide deck with the Google Form's QR code on slide 6 at about 12% of the slide's height, and two deadlines on slide 3. Run `bun run image:worker && docker run --rm --shm-size=2g tm-worker:dev selfcheck` (pass: `SELFCHECK OK`). Write `job.json` (trusted senders left empty so the host's role label is what's tested):

```json
{
  "occurrenceId": "accept-01a-1",
  "attempt": 1,
  "entry": {
    "name": "Acceptance Lecture",
    "type": "lecture",
    "start": "<YYYY-MM-DDTHH:mm:00+08:00>",
    "end": "<YYYY-MM-DDTHH:mm:00+08:00>",
    "timeZone": "Asia/Kuala_Lumpur",
    "link": { "kind": "fixed", "url": "<zoom-join-link>" },
    "trustedSenders": [],
    "transcription": "live",
    "formDetails": {
      "course_code": "<course-code>",
      "section": "<section>",
      "lecturer": "<host-display-name>"
    },
    "attendanceKeywords": []
  },
  "identity": {
    "id": "<identity-id>",
    "name": "University",
    "zoomGuestName": "<member-display-name>",
    "formProviders": ["google", "microsoft"]
  },
  "member": {
    "id": "<member-id>",
    "displayName": "<member-display-name>",
    "mentionNames": [],
    "details": []
  },
  "ai": {
    "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "apiKey": "<dashscope-key>",
    "asrUrl": "wss://<workspace-id>.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime",
    "models": {
      "summary": "qwen3.7-plus",
      "vision": "qwen3-vl-plus",
      "formMatch": "qwen-flash",
      "asr": "qwen3-asr-flash-realtime"
    }
  },
  "ntfy": {
    "url": "<ntfy-url>",
    "topic": "<member-topic>",
    "token": "<ntfy-token>"
  },
  "dataDir": "<TM_DATA_ROOT>/occurrences/accept-01a-1",
  "profileDir": "<TM_PROFILE_ROOT>/<identity-id>/work",
  "control": null
}
```

- [ ] **Step 2: Seed the profile**

Run `docker/worker/run-job.sh job.json seed` on the server, open `ssh -L 5900:127.0.0.1:5900 <server>` from the member's PC, connect a VNC viewer to `localhost:5900` with the printed one-time password, sign in to Google and Microsoft (and Zoom, if the identity has an account) in the desk window, then press Enter in the server terminal. Pass: a new `.tar.enc` in `<TM_PROFILE_ROOT>/<identity-id>/checkpoints/`, and a second seed run shows the accounts still signed in.

- [ ] **Step 3: Join, forms and end (exit criteria; design tests "Form fixture" in its 1A form, "Unsafe form" for the untrusted sender, and "End")**

At T-15 run `docker/worker/run-job.sh job.json`. The host starts the meeting at T-5 and admits the bot from the waiting room. At a random minute between 5 and 15, the host shares slide 6 for 60 seconds; at about minute 18 the host posts the Microsoft Form link in chat; at about minute 20 the untrusted participant posts the Google Form link; at about minute 21 the host posts the Microsoft link again. The host reads slide 3's first deadline aloud with a different date, and later types a third deadline in chat. At about minute 30 the host ends the meeting for everyone. Note the host's clock time for every event. Pass:

- "Joined: Acceptance Lecture" with the participant count arrives within 2 minutes of admission;
- "Form to submit" arrives within 30 seconds of the QR slide appearing and within 30 seconds of the host's chat link, and tapping "Open form" on the phone opens each form for a manual submission;
- "Form seen, not submitted" arrives within 30 seconds of the untrusted participant's link; the repeated host link brings no second ping;
- `outcome.json` says `endedBy: "page"`; the end of the last segment (from `attempts.json` and ffprobe) is within 60 seconds of the host ending the meeting;
- "Summary ready" arrives within 10 minutes of the end.

- [ ] **Step 4: Inspect the artefacts (exit criterion "the recording contains only the stage")**

Pass:

- `recording/meeting.mkv` is 1920x1080 and, scrubbed at the join, the QR slide and the form-provider check, shows only the Zoom window: never the desk, a sign-in page or a form;
- `out/chat.md` holds every chat line with the host marked `(host)`;
- `out/slides.md` holds slides 3 and 6;
- the summary is named `YYYY-MM-DD HHmm Acceptance Lecture.md`, its first line after the title starts `Do next:`, and all three deadlines appear, the spoken one with the slide's date and a `heard as` note;
- the host's participant list showed the bot's microphone and camera off for the whole meeting.

- [ ] **Step 5: Failure paths (short meetings)**

(a) A job whose host never admits the bot, with the end 5 minutes after the start: pass is one "still waiting to be let in" ping at the hard stop, `outcome.json` `not_admitted`, and a new checkpoint. (b) During a meeting, `docker exec <container> pkill -9 ffmpeg`: pass is a "recorder restarted" ping and a gap of at most 3 seconds in `meeting.mkv`. (c) Sign out of Microsoft in a seed session, then run a job: pass is a "Microsoft forms sign-in has expired" ping before the join. (d) The host removes the bot: pass is the "removed" ping and a joined recording.

- [ ] **Step 6: Summary quality (design test "Summary quality")**

Run 3 test lectures in which the host plays a recorded lecture with its slides shared: one with 7 deadlines, and one where speech and slide disagree on a date. Pass: every deadline appears with the slide's date; the first line after the title is an action; the 7-deadline summary shows 5 under "To do" and 2 under "More deadlines".

- [ ] **Step 7: Silence over 90 minutes (design test "Silence in the meeting")**

If a university-licensed Zoom account is available, run a 90-minute meeting. Pass: the bot never unmutes, starts video, types, reacts or shares, as the host's participant view confirms throughout, and `events.jsonl` shows only allowlisted notice clicks. If no licensed account is available, record that and carry this step to plan 01c.

- [ ] **Step 8: Commit the results**

```bash
git add docs/plans/01a-recorder-and-pings.md
git commit -m "docs: record 01a acceptance results"
```
