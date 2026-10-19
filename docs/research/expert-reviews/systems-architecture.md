# Systems architect and delivery lead review

This review evaluates whether the TolongMeeting specification is internally consistent, rigid enough to implement without guesswork, and realistically scoped for a solo developer as of 20 October 2026. It examines system boundaries, delivery sequencing, container operations, state management, and the Alibaba Cloud Model Studio (DashScope) AI pipeline.

Contents:

1.  [Verdict](#verdict)
1.  [Findings](#findings)
1.  [Rigidity gaps](#rigidity-gaps)
1.  [What the spec gets right](#what-the-spec-gets-right)
1.  [Questions for the requester](#questions-for-the-requester)

## Verdict

Feasible with changes. The product shape is sound, grounded in lessons from the 19 October 2026 manual Zoom run, and appropriately built on a modular monolith with isolated ephemeral browser containers. However, three blockers prevent the design from working as written: `qwen3-asr-flash-realtime` neither returns timestamps nor supports custom vocabulary hotwords, the exclusive Chrome profile locking rules deadlock mid-session re-authentication and conflict across server and local modes, and the worker egress firewall blocks university single sign-on (SSO) identity providers and short-link redirects. Milestone 1 also bundles 8 to 12 person-weeks across eight subsystems before proving value on a single lecture, and contradictions around summary delivery, audio retention, and server RAM budgets must be resolved before coding starts.

## Findings

### ARC-01: Live ASR model `qwen3-asr-flash-realtime` neither returns timestamps nor supports vocabulary hotwords

- **Severity:** Blocker
- **Spec section:** Transcription
- **Problem:** The specification selects `qwen3-asr-flash-realtime` over WebSocket for `[HH:MM:SS]` player-synced transcripts, custom vocabulary seeding (course, lecturer, member names, and cumulative slide text), and continuous streaming. As of October 2026, `qwen3-asr-flash-realtime` returns no timestamps, lacks the `run-task` protocol needed for hotwords and `input.context` (which is capped at 400 characters and truncates cumulative slide text), and drops WebSocket sessions at 120 minutes, cutting off a 2-hour lecture with a 30-minute overrun window.
- **Evidence:** Alibaba Cloud's [Real-Time Speech Recognition guide](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition) (accessed 20 October 2026) states `qwen3-asr-flash-realtime` "does not currently return timestamps" and caps sessions at 120 minutes without connection reuse. [Improve recognition accuracy](https://www.alibabacloud.com/help/en/model-studio/improve-asr-accuracy) (accessed 20 October 2026) restricts hotwords and the 400-character `input.context` field to `qwen-audio-3.1-asr-flash-streaming`, `qwen-audio-3.0-asr-flash-streaming`, and `fun-asr-realtime`, while [qwen3-asr-flash-realtime Model Info](https://www.alibabacloud.com/help/en/model-studio/qwen3-asr-flash-realtime) (updated 11 October 2026) confirms the US$0.324/hour Singapore rate.
- **Recommended change:** Stream 16 kHz mono PCM to `qwen-audio-3.1-asr-flash-streaming` (which returns sentence timestamps and accepts a 400-character `input.context` holding course code, lecturer, member nicknames, and top 15 current-slide terms), or stamp local stream offsets on `qwen3-asr-flash-realtime` events and run a post-meeting `qwen3-asr-flash-filetrans` pass. Rotate the WebSocket connection every 90 minutes during a silent VAD pause with a 5-second ring-buffer overlap.

### ARC-02: Single-profile exclusivity deadlocks mid-session re-authentication and breaks across server and local modes

- **Severity:** Blocker
- **Spec section:** Accounts, Scheduler, Local mode, Security and privacy
- **Problem:** The worker opens the identity's Chrome profile at `T-60`, holds an exclusive lock until meeting end, and only saves it back on exit, yet expired-login alerts at `T-60` and mid-meeting form alerts send a `"Sign in again"` link to open that identity's profile via noVNC—which cannot start a second container and would be overwritten on exit. Moreover, each identity has one profile stored on either the server or the member's PC, whereas `run on (server or my PC)` is configured per timetable entry, breaking whenever one identity spans server and local entries.
- **Evidence:** Compare "How a lecture goes" ("T-60 min: start worker and verify... If any has expired, the member gets an urgent ping") and "Attendance form handler" ("urgent, with a link to re-sign-in") against "Scheduler" ("Refuses to start a second worker for the same identity while one is running"), "Security and privacy" ("re-encrypt on exit"), and "Data and storage" ("one per identity... where it lives (server or member's PC)").
- **Recommended change:** Move `run_on` (`server` or `local_pc`) from the timetable entry to the **Identity** (or keep separate server and local profiles per identity). Route `"Sign in again"` noVNC sessions while a worker is active directly into the **running worker container's** browser on a second virtual display (`:100`) so `ffmpeg` on `:99` never records credentials, and checkpoint-encrypt the profile immediately after sign-in.

### ARC-03: Strict worker egress allowlist blocks university SSO identity providers, link shorteners and WebRTC media relays

- **Severity:** Blocker
- **Spec section:** Security and privacy
- **Problem:** Restricting worker network egress to five fixed categories blocks three mandatory external flows: federated Google Workspace and Microsoft 365 accounts redirect authentication to institutional SAML, ADFS, Shibboleth, Okta, or Duo SSO domains; lecturers share attendance links via URL shorteners (`bit.ly`, `tinyurl.com`, or campus shorteners) that require an initial HTTP request before redirecting to Google or Microsoft Forms; and Zoom, Teams, and Meet web clients connect to dynamic regional STUN/TURN media relays and CDNs.
- **Evidence:** Compare "Security and privacy" ("Workers can reach the meeting platforms, form providers, chat apps, the transcription and AI services, and the app's own server; nothing else") with "Attendance form handler" ("A URL counts as a form if it points to Google Forms or Microsoft Forms, or redirects there").
- **Recommended change:** Replace the egress allowlist in "Security and privacy" with a **private-network deny-list (SSRF protection)** blocking RFC 1918 private subnets, link-local addresses (`169.254.0.0/16`), and inter-container traffic except the TolongMeeting server API, while permitting outbound HTTPS (TCP 443) and WebRTC media (UDP/TCP 3478, 8801–8810, 19302–19309) to the public internet.

### ARC-04: Milestone 1 bundles eight subsystems (~8 to 12 person-weeks) before proving core lecture value

- **Severity:** Major
- **Spec section:** Build order
- **Problem:** Milestone 1 requires a solo builder to integrate almost the entire platform before attending a single lecture. Realistic solo effort across the build order is: Early spikes (1.5–2 person-weeks); Milestone 1 Zoom end-to-end on server (8–12 person-weeks, highest risk); Milestone 2 WhatsApp/Discord/Teams link watchers (3–4 person-weeks, high DOM fragility); Milestone 3 companion app and native mode (2.5–3.5 person-weeks); Milestone 4 Teams adapter (2.5–3.5 person-weeks); Milestone 5 Meet adapter (2–3 person-weeks); Milestone 6 work-meeting template and name alerts (1 person-week); Milestone 7 exports (2.5–3.5 person-weeks); and Milestone 8 local mode (2–3 person-weeks), totalling 25.5 to 35.5 person-weeks.
- **Evidence:** "Build order" item 1 bundles eleven capabilities ("Sign-in, accounts remote view, timetable with pasted link, Zoom join, recording, QR and chat form detection, Google and Microsoft Forms submission, live transcription, slide reading, lecture summary, ntfy notifications"), whereas the 19 October 2026 manual session record uncovered 13 defects in basic Zoom joining, recording, and transcription alone.
- **Recommended change:** Split Milestone 1 into three vertical slices: **Milestone 1A (1.5–2 person-weeks)** uses a seeded profile and JSON/CLI schedule to join Zoom, record segmented MKV, **ping QR/chat form URLs and screenshots to ntfy for 1-tap manual submission**, and send the post-meeting ASR, slide OCR, and ADHD summary via ntfy; **Milestone 1B (2–3 person-weeks)** adds automated Google and Microsoft Forms DOM inspection and auto-submission; **Milestone 1C (3–4 person-weeks)** adds the Next.js website, GitHub OAuth, noVNC sign-in UI, and playback page.

### ARC-05: Memory-backed browser profiles and multi-tab Chrome workers exceed the 8 GB server budget

- **Severity:** Major
- **Spec section:** Deployment and cost, Meeting worker
- **Problem:** Sizing the server at 4 vCPU and 8 GB RAM (US$25–50/month) for 2 to 3 concurrent meetings with each worker capped at 2 GB RAM fails when the identity's Chrome profile is decrypted into container `tmpfs` (`/dev/shm`), which Linux Docker counts against the 2 GB cgroup limit. A Chrome profile signed into WhatsApp Web, Discord, Teams, Zoom, and Google accumulates 500 MB to 1.5 GB of IndexedDB and Service Worker caches, leaving under 1 GB for five Chrome tabs, Xvfb, PulseAudio, Node 24, and `ffmpeg` H.264 encoding (which need 1.5–2.2 GB), causing OOM kills when 2 to 3 workers overlap.
- **Evidence:** Compare "Deployment and cost" ("An 8 GB server comfortably runs the website, database, ntfy and 2 to 3 meetings at once") with "Meeting worker" ("capped at 2 GB RAM" and "decrypted into memory-backed storage") and `ASR-02` in the 19 October 2026 manual session record.
- **Recommended change:** Strip transient browser caches (`Default/Cache`, `Default/Code Cache`, `Default/GPUCache`, `Default/Service Worker/CacheStorage`, `Crashpad`) before archiving each profile so `tmpfs` stays under 100 MB, close link-watcher tabs once the meeting link is extracted, and either upgrade the VPS for 3 concurrent workers to **8 vCPU and 16 GB RAM** (~US$45–65/month) or enforce `max_concurrent_workers = 2` on an 8 GB host.

### ARC-06: Contradictions on summary delivery, work-meeting form checks and audio retention

- **Severity:** Major
- **Spec section:** Decisions, How a lecture goes, Companion app, Data and storage
- **Problem:** Four contradictions leave behaviour ambiguous: (1) Decision 19 and "What success looks like" open the summary file automatically, whereas "Companion app" opens it only on notification click, and "Post-processing and summaries" names it `YYYY-MM-DD HHmm <entry name>.md` versus `summary.md` in "Exports"; (2) "Attendance form handler" restricts forms to lectures, but step 1 of "How a lecture goes" checks "form provider" login at `T-60` for all entries; (3) "Data and storage" deletes audio once the transcript is final (or after 30 days in native mode) and deletes video after 30 days, breaking the website's audio/video player; and (4) "Transcription" ("Native mode") has the server extract the 48 kHz FLAC, forcing a **Local mode + Native mode** PC run to upload video to Singapore just to download the FLAC back.
- **Evidence:** Compare Decision 19 ("opened in the member's default app") with "Companion app" ("when its notification is clicked, never on its own"); "How a lecture goes" step 1 ("form provider") with "Attendance form handler" ("Lectures only"); and "Data and storage" ("audio is deleted after the transcript is final") with "Website" ("transcript with timestamps linked to an audio and video player").
- **Recommended change:** Save the summary as `YYYY-MM-DD HHmm <entry name>.md` and open it only on notification click; skip `T-60` form-provider login checks and hide form fields on work meetings; delete the temporary 48 kHz `.flac` immediately after transcription in both modes while serving website playback from the `.mp4`/`.mkv` video for 30 days; and extract the `.flac` inside the **worker** so Local Mode + Native Mode stays on the member's PC.

### ARC-07: Missing state machines and control plane between server, worker and companion app

- **Severity:** Major
- **Spec section:** Scheduler, Meeting worker, Local mode, Data and storage
- **Problem:** The specification lists a `state` column on "Meeting occurrence" and loose UI badges (`waiting for link`, `joined`, `recording`, `forms handled`, `waiting for your PC`), but omits state machines for occurrences and form submissions and the control-plane protocol between server, worker, and companion app. A builder must guess how `"Make the bot leave"` (Decision 33) reaches a Local Mode worker behind home NAT, whether an `auth_expired` form retries automatically once the member completes `"Sign in again"` within 5 minutes, how a restarted worker avoids re-submitting a form or overwriting earlier video segments, and why "Local mode" omits the video recording from its upload list.
- **Evidence:** Compare "Data and storage" ("Meeting occurrence: one run of an entry; state, start and end times, worker log"), "Meeting worker" ("The member can click 'Make the bot leave'"), and "Local mode" ("uploads the summary, transcript, slides and attendance record").
- **Recommended change:** Define explicit state machines (`scheduled` -> `starting_worker` -> `verifying_auth` -> `watching_for_link` -> `joining` -> `in_lobby` -> `in_meeting` -> `leaving` -> `uploading_artefacts` -> `awaiting_native_asr` -> `post_processing` -> `completed` | `failed` | `left_by_member` | `skipped_pc_offline` | `skipped_identity_clash` for occurrences; `detected` -> `opening` -> `awaiting_reauth` -> `inspecting` -> `awaiting_manual_fill` -> `submitting` -> `submitted` | `already_answered` | `ignored_non_attendance` | `failed` for forms, polling auth every 10 seconds in `awaiting_reauth`), and use an outbound 5-second HTTPS/SSE worker heartbeat to receive `leave_now` and `reauth_completed` commands and persist form deduplication state in Postgres.

### ARC-08: DashScope pipeline lacks thinking-mode bounds, `qwen3.7-flash` pricing updates, `WorkspaceId` config and a workable fallback

- **Severity:** Major
- **Spec section:** Tech stack, Attendance form handler, Post-processing and summaries
- **Problem:** Four AI client details risk latency blowouts, higher costs, or runtime errors: (1) `qwen3.7-plus` (1M context) fits a 90-minute lecture (~33K input tokens, ~US$0.018) inside its `<= 256K` tier, but supports Thinking mode that bills reasoning tokens at US$1.60/M and adds 15–60 seconds of latency if `enable_thinking` is not disabled; (2) the 30-second form-matching budget (~0.6–1.5 seconds in Singapore) requires batching all unmatched fields on a page into one non-thinking JSON request, and `qwen3.7-flash` is cheaper than `qwen-flash`; (3) DashScope's production workspace endpoint requires a `WorkspaceId` subdomain missing from the "AI keys" page; and (4) ModelScope's free tier (`api-inference.modelscope.cn/v1`) fails as a same-config fallback because it requires a China-mainland real-name-verified Alibaba Cloud binding, caps models at ~500 calls/day, lacks WebSocket ASR, and uses repo IDs (`Qwen/Qwen3-VL-235B-A22B-Instruct`) instead of DashScope names (`qwen3.7-plus`).
- **Evidence:** [Model Pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) (updated 19 October 2026) lists Singapore rates for `qwen3.7-plus` (US$0.40/M input, US$1.60/M output up to 256K), `qwen3-vl-plus` (US$0.20/M input, US$1.60/M output up to 32K, or ~US$0.043 for 60 slides), `qwen-flash` (US$0.05/M input, US$0.40/M output), and `qwen3.7-flash` (US$0.03/M input, US$0.13/M output up to 32K). [Base URL overview](https://www.alibabacloud.com/help/en/model-studio/base-url) (accessed 20 October 2026) documents `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`, and [Data Retention Policy](https://www.alibabacloud.com/help/en/model-studio/data-retention-policy) (updated 11 October 2026) confirms 30-day retention without training on customer data.
- **Recommended change:** Default form matching to `qwen3.7-flash` with `enable_thinking: false` and `response_format: { type: "json_object" }` in a single batched call per form page (5-second timeout), add an optional `Workspace ID` field to the "AI keys" page, and replace the ModelScope fallback with OpenRouter, a secondary DashScope key, or a per-provider model-ID mapping table (with ASR falling back to Native Whisper).

### ARC-09: Single-pass ADHD summary generation risks dropping deadlines beyond five items and picking misheard ASR dates over slides

- **Severity:** Major
- **Spec section:** Post-processing and summaries, Anti-goals
- **Problem:** Requiring every deadline to appear in the summary while simultaneously capping every list at 5 items creates a direct conflict whenever a lecture announces more than 5 deadlines or tasks. In addition, a single-pass LLM prompt over raw transcript, slide text, and chat will frequently pick a misheard spoken ASR date over an authoritative date printed on a slide.
- **Evidence:** Compare Anti-goal 5 ("If the member has to open the transcript to find a deadline, the summary failed") and "Post-processing and summaries" ("cap every list at 5 items") with `WRITE-01` ("31st October" in ASR vs "1 November 2026" on slides) and `WRITE-04` in the 19 October 2026 manual session record.
- **Recommended change:** Use a two-step prompt on `qwen3.7-plus`: Step 1 extracts an uncapped JSON inventory of all deadlines, tasks, and links with an explicit authority hierarchy (**Slide OCR text > Lecturer chat message > Spoken ASR transcript**, noting conflicts as `(slide says 1 Nov; spoken as 31 Oct)`); Step 2 renders the ADHD Markdown summary with the top 5 most urgent items per section and appends an `## Additional deadlines (N more)` overflow table whenever more than 5 deadlines exist.

### ARC-10: Tech stack friction in Next.js WebSocket proxying for noVNC and Bun single-executable Windows tray and toast activation

- **Severity:** Major
- **Spec section:** Tech stack, Companion app
- **Problem:** Next.js App Router route handlers do not natively support HTTP `Upgrade: websocket` hijacking required to proxy live noVNC WebSocket traffic without a custom server wrapper. Similarly, compiling the Windows companion app via `bun build --compile` with a tray icon and click-to-open toast notifications hits Bun's `$bunfs` virtual filesystem limitation (embedded helper binaries like `snoretoast.exe` cannot be executed directly via Win32 `CreateProcessW` from `$bunfs`) and Windows 10/11's requirement for a registered `AppUserModelID` (AUMID) and protocol/COM activator to receive toast click callbacks.
- **Evidence:** Compare "Tech stack" ("noVNC into the worker's virtual screen, proxied through the website" and `bun build --compile`) with "Companion app" ("opens a file in the default app when its notification is clicked, never on its own").
- **Recommended change:** Proxy noVNC WebSocket connections directly through **Caddy** using `forward_auth` against a Next.js `/api/auth/verify-novnc` endpoint instead of routing WebSockets through Next.js; and for the Windows companion app, either use a lightweight **Tauri v2** shell or have the Bun executable extract its notification helper to `%LOCALAPPDATA%\TolongMeeting\bin` on startup and register a `tolongmeeting://open?file=` protocol handler in `HKCU\Software\Classes\tolongmeeting`.

### ARC-11: Early spikes and acceptance tests omit Google and Microsoft Forms custom ARIA widgets, WhatsApp Web container persistence and Malay code-switching

- **Severity:** Minor
- **Spec section:** Early spikes, Acceptance tests
- **Problem:** The early spikes and acceptance tests miss three common failure modes: Spike 4 only tests "name, ID and a required free-text question", omitting the custom `<div role="radio">`, `<div role="listbox">`, and `<div role="checkbox">` ARIA widgets and multi-page `"Next"` buttons used by Google and Microsoft Forms; no spike tests whether a WhatsApp Web linked-device session inside an encrypted Chrome profile archive survives repeated Docker container restarts without invalidating its IndexedDB state; and Spike 5 does not test Malay/English code-switching ("Bahasa Rojak") and Malaysian proper nouns.
- **Evidence:** Compare "Early spikes" items 1–6 and "Acceptance tests" against `ASR-04` (`Xiamen` -> `Sherman`, `Sepang` -> `Saipan`, `Matric No.` -> `metric number`) and `TECH-07` in the 19 October 2026 manual session record.
- **Recommended change:** Expand Spike 4 to a two-page Google Form and Microsoft Form with radio, checkbox, and dropdown (`role="listbox"`) controls plus "already responded" and expired-login states; run Spike 5 on a 15-minute mixed English/Malay Malaysian lecture recording; and add a Spike 7 before Milestone 2 that archives, encrypts, and restores a WhatsApp Web profile across 3 fresh container runs over 24 hours.

## Rigidity gaps

- **How a lecture goes / Scheduler:** Does not specify what happens when a lecturer posts the meeting link in WhatsApp or Teams chat _before_ `T-60`; the link watcher must scan the last 24 hours of chat history on startup rather than only messages arriving after `T-60`.
- **Scheduler:** Does not define the priority rule when two timetable entries sharing the **same identity** overlap in time—only that the scheduler "warns the member and skips the second".
- **Attendance form handler:** Does not specify how the worker distinguishes an attendance form from a graded in-class quiz when the title lacks the words "Quiz" or "Test".
- **Attendance form handler:** Does not specify how the worker navigates multi-section Google or Microsoft Forms where `"Submit"` only appears after clicking `"Next"` on page 1.
- **Transcription:** Does not specify the exact `ffmpeg` segment length (for example `-f segment -segment_time 60`) or how PulseAudio recovers if the browser audio sink resets mid-meeting.
- **Slide capture:** Does not specify how `ffmpeg -f x11grab` avoids recording the attendance form tab or chat watcher tabs into the lecture video and slide pipeline when the worker opens tabs on the same Xvfb screen.
- **Post-processing and summaries:** Does not define retry and recovery behaviour if a member's DashScope API key returns `402/429` (quota exhausted) after a meeting finishes; the server should retain all artefacts and allow a 1-click re-run once the key is topped up.
- **Exports:** Does not specify who owns the OAuth client credentials (`client_id` / `client_secret`) for Google Drive (`drive.file`) and Notion exports or how Google's OAuth verification for Drive scopes is handled.
- **Data and storage:** Does not specify where the "server master key kept outside the database" is stored (Docker secret vs environment variable) or how key rotation re-wraps per-member keys.

## What the spec gets right

- **Clear anti-goals and human-in-the-loop safety:** Refusing to guess unmatched form fields, refusing to bypass CAPTCHAs or 2FA, and immediately pinging the member with a screenshot and link prevent brittle automation failures.
- **Direct continuity from the 19 October 2026 manual session:** Segmented video capture, `T-60` pre-flight login checks, lossless 48 kHz mono FLAC extraction, screen-share-aware end detection, and dual QR + chat scanning directly solve the failures observed in the manual run.
- **Modular monolith with Postgres and `pg-boss`:** Running Next.js, Postgres with `pg-boss`, ntfy, and ephemeral Docker containers on one box avoids unnecessary distributed-systems overhead for a solo maintainer.
- **Pre-build verification spikes:** Requiring six concrete technical spikes before application development will expose platform DOM and bot-detection hurdles early.
- **Sensible cost and privacy model:** Having each member supply their own DashScope API key while keeping the shared server under US$65/month prevents central billing surprises.

## Questions for the requester

1.  **Milestone 1 slicing:** Are you willing to split Milestone 1 so Milestone 1A ships a CLI/seed-driven Zoom recorder that pings QR and chat form links to ntfy for 1-tap manual submission plus the automated ADHD summary in ~2 weeks, deferring automatic DOM form filling to Milestone 1B and the multi-user Next.js/noVNC UI to Milestone 1C?
1.  **Form tab recording isolation:** When the worker opens an attendance form mid-lecture, should that form open on a second Xvfb display (or a separate browser window excluded from `ffmpeg` capture) so the member's student ID, email, and form submission are not recorded into the lecture video and slide deck?
1.  **Identity location vs entry location:** Can we bind `run on (server or my PC)` to the **Identity** rather than the individual timetable entry, so a single Chrome profile never has to split or sync between the Singapore server and the member's home PC?
1.  **ASR timestamp strategy:** Since `qwen3-asr-flash-realtime` neither returns timestamps nor supports hotword vocabularies, do you prefer switching the live stream to `qwen-audio-3.1-asr-flash-streaming` (which supports sentence timestamps and a 400-character context string) or keeping `qwen3-asr-flash-realtime` for live name-mention alerts and running a post-meeting `qwen3-asr-flash-filetrans` batch pass for accurate timestamps?
