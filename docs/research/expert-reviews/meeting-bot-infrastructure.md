# Meeting-bot infrastructure engineer review

This review evaluates the TolongMeeting specification from the perspective of containerised browser-automation infrastructure, WebRTC media capture, platform DOM stability and anti-bot enforcement across Zoom, Microsoft Teams and Google Meet as of 20 October 2026. It assesses whether a single engineer can build and operate the system reliably from the specification without guesswork.

Contents:

1.  [Verdict](#verdict)
1.  [Findings](#findings)
1.  [Rigidity gaps](#rigidity-gaps)
1.  [What the spec gets right](#what-the-spec-gets-right)
1.  [Questions for the requester](#questions-for-the-requester)

## Verdict

Feasible with changes. Joining lectures and work meetings through a persistent signed-in Chrome profile inside an Xvfb and PulseAudio container is the right architecture for an internal tool in October 2026, now that Zoom enforces On-Behalf-Of tokens for SDK bots, Google Meet has closed Media API registrations, and Microsoft Teams holds and labels unauthenticated bots in the lobby. However, four infrastructure blockers in the current specification will break production runs: running link watchers and form tabs inside the same captured window corrupts `x11grab` video and leaks chat chimes into the audio; decrypting the profile into ephemeral container memory loses rotating session tokens and leaves stale `SingletonLock` files on crash; the 4 vCPU and 8 GB server sizing will run out of memory and starve software WebRTC rendering at 2 to 3 concurrent meetings; and launching Playwright without stealth, autoplay and software-WebGL flags triggers Google Meet blocks and black canvases. With the concrete changes below, one builder can ship and maintain this system reliably.

## Findings

### BOT-01: Single-window tab sharing corrupts Xvfb screen capture and leaks non-meeting audio

- **Severity:** Blocker
- **Spec section:** Meeting worker; Link watchers; Attendance form handler
- **Problem:** Running WhatsApp Web, Discord and Teams chat watchers as tabs alongside the meeting from T-60 until teardown, and opening attendance forms in a new tab of the same browser while `ffmpeg` records Xvfb (`x11grab`) and the default PulseAudio sink, corrupts both video and audio. In headed Chrome on X11, calling `newPage()` or activating a watcher tab switches the visible viewport away from the meeting (recording private chats or form pages instead of slides), whereas leaving watcher tabs backgrounded without disabling occlusion throttling stops virtualised chat lists from rendering new messages, and all tabs route notification chimes into the recorded PulseAudio sink.
- **Evidence:** Chrome activates new tabs by default in headed mode ([Playwright Page documentation](https://playwright.dev/docs/api/class-page), October 2026), and Xvfb bots like [Attendee](https://github.com/attendee-labs/attendee) (October 2026) isolate the capture window; the 19 October 2026 run hit these occlusion and background-tab limits (`OBS-04`, `BRW-03` in `problems-and-fixes.md`).
- **Recommended change:** Run `openbox` in Xvfb and open the meeting in a dedicated `--app=<url>` Chrome window pinned to the top of `:99.0` at 1920x1080, while opening link-watcher and form tabs in a second Chrome window stacked behind it with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`, taking form screenshots via Playwright `page.screenshot()` and muting non-meeting tabs via CDP `Page.setAudioMuted({ muted: true })`.

### BOT-02: Ephemeral profile encryption and container restarts break rotating auth tokens and leave stale locks

- **Severity:** Blocker
- **Spec section:** Scheduler; Meeting worker; Security and privacy
- **Problem:** Decrypting the browser profile into container memory-backed storage and re-encrypting only on exit fails when the scheduler restarts a crashed worker (up to 3 times). If a container crashes or hits OOM, in-memory profile mutations vanish, so the replacement container restores the pre-meeting archive after Microsoft Entra ID refresh tokens, Google `__Secure-1PSIDTS` cookies or WhatsApp Web IndexedDB Signal ratchets have already rotated, invalidating logins and unlinking WhatsApp Web; furthermore, an unclean exit leaves `SingletonLock`, `SingletonSocket` and `SingletonCookie` files that block Chrome startup in a new container, and omitting `--password-store=basic` breaks Linux `OSCrypt` cookie decryption.
- **Evidence:** Chromium's `ProcessSingletonPosix` aborts startup when `SingletonLock` points to another hostname ([Chromium `process_singleton_posix.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/process_singleton_posix.cc), October 2026), and WhatsApp Web's IndexedDB Signal store rejects rolled-back ratchet state.
- **Recommended change:** Decrypt the profile into a host-mounted working directory on an encrypted volume so state survives crashes across all 3 retries; delete `SingletonLock`, `SingletonSocket` and `SingletonCookie` before every Chrome launch; pass `--password-store=basic` in every Chrome invocation; and strip transient caches (`Default/Cache`, `Default/Code Cache`, `Default/GPUCache`, `Default/Service Worker/CacheStorage`) before re-encrypting on exit.

### BOT-03: Server sizing (4 vCPUs, 8 GB RAM) will OOM and drop WebRTC streams at 2 to 3 concurrent meetings

- **Severity:** Blocker
- **Spec section:** Meeting worker; Deployment and cost
- **Problem:** A 4 vCPU, 8 GB RAM VM cannot run 2 to 3 concurrent meetings alongside the website, Postgres, job queue, `ntfy` and post-processing. Without a GPU, Chrome decodes WebRTC video and composites the 1920x1080 canvas in software (SwiftShader or Mesa `llvmpipe`, taking 1.5 to 2.5 vCPUs), while `ffmpeg x11grab` H.264 encoding at 15 fps (0.5 vCPU), 0.5 fps QR decoding (0.2 vCPU), WhatsApp/Discord/Teams SPAs (2.0 to 2.8 GB Chrome RSS), a `tmpfs` profile (800 MB to 1.5 GB) and `/dev/shm` buffers push each worker to 2.5 to 3.5 vCPUs and 3.5 to 4.5 GB RAM, causing CPU starvation and OOM kills (`ASR-02` in `problems-and-fixes.md`) at 2 concurrent sessions.
- **Evidence:** Open-source bots ([Attendee](https://github.com/attendee-labs/attendee) and [ScreenApp meeting-bot](https://github.com/screenappai/meeting-bot), October 2026) allocate 2 to 4 vCPUs and 4 GB RAM per single-tab container without chat watchers or `tmpfs` profiles, and Docker's default 64 MB `/dev/shm` crashes Chrome WebRTC tabs unless `--shm-size=2g` is set.
- **Recommended change:** Size the server to at least 8 vCPUs and 16 GB RAM for 2 concurrent meetings (12 vCPUs and 24 GB RAM for 3), pass `--shm-size=2g` to worker containers, move decrypted profiles off `tmpfs` onto encrypted disk after cache pruning, and run a single `ffmpeg` pipeline (or `parec` for 16 kHz PCM) with `-preset ultrafast -thread_queue_size 1024 -use_wallclock_as_timestamps 1` and `-af aresample=async=1`.

### BOT-04: Playwright default automation flags and missing WebGL/media flags block Google Meet and break rendering

- **Severity:** Blocker
- **Spec section:** Meeting worker; Platform adapters; Tech stack
- **Problem:** Launching full Chrome via Playwright on Xvfb without stealth, WebGL and media flags breaks across all three platforms. Playwright passes `--enable-automation` (`navigator.webdriver = true`) by default, which Google Meet blocks with "You can't join this video call"; recent Chrome versions disabled automatic SwiftShader WebGL fallback on GPU-less Linux unless opted in (breaking Zoom and Teams canvases); and PulseAudio's `bot_sink.monitor` is exposed as a microphone input while omitting `--autoplay-policy=no-user-gesture-required` suspends WebRTC `<audio>` playback.
- **Evidence:** Chromium deprecated automatic SwiftShader fallback on GPU-less Linux ([Chromium SwiftShader documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md), 2025 to 2026), requiring `--enable-unsafe-swiftshader` or `libgl1-mesa-dri`, and Playwright enables `--enable-automation` by default ([Playwright BrowserType documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), October 2026).
- **Recommended change:** Install `google-chrome-stable` and `libgl1-mesa-dri` in the worker image, launch via `chromium.launchPersistentContext` with `channel: 'chrome'`, `ignoreDefaultArgs: ['--enable-automation']`, and flags `--disable-blink-features=AutomationControlled`, `--autoplay-policy=no-user-gesture-required`, `--disable-features=CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns`, `--enable-unsafe-swiftshader`, `--use-gl=angle` and `--use-angle=swiftshader`, and set a muted PulseAudio null source as default source so `bot_sink.monitor` is hidden from microphone enumeration.

### BOT-05: Strict domain filtering before redirect resolution drops shortened and Safe-Links-wrapped attendance forms

- **Severity:** Major
- **Spec section:** Attendance form handler
- **Problem:** Acting only on raw URLs matching `docs.google.com/forms`, `forms.gle`, `forms.office.com` and `forms.microsoft.com` drops wrapped and shortened links. Universities using Microsoft 365 rewrite Teams and Outlook URLs into Microsoft Safe Links (`*.safelinks.protection.outlook.com/?url=...`), and lecturers placing QR codes on slides routinely use Canva, PowerPoint add-ins or shorteners (`bit.ly`, `tinyurl.com`, `qrfy.com`, `me-qr.com`), so filtering before resolving redirects violates Anti-goal 2 by silently ignoring valid forms.
- **Evidence:** Microsoft Defender for Office 365 wraps Teams URLs in `safelinks.protection.outlook.com` ([Microsoft Safe Links documentation](https://learn.microsoft.com/en-us/defender-office-365/safe-links-about), October 2026), and slide QR generators default to short redirect domains to lower module density.
- **Recommended change:** Unwrap known wrappers (extracting `url` from `*.safelinks.protection.outlook.com` and `q` from `www.google.com/url`) and resolve HTTP `301`/`302`/`307`/`308` redirects via a `HEAD`/`GET` request with `redirect: 'manual'` (up to 5 hops, 5-second timeout, no cookies or script execution) before matching the final URL against the allowlist.

### BOT-06: Joining as the member's signed-in account causes session collisions when the member is active elsewhere

- **Severity:** Major
- **Spec section:** Decisions; Platform adapters; Platform realities
- **Problem:** Because the bot runs when lectures clash with work, the member is usually signed in on their laptop or phone simultaneously. On Zoom, signing into the web client counts against the two-device web/desktop limit, joining two concurrent Zoom meetings on one account is blocked unless the admin enabled "Join different meetings simultaneously on desktop", and opening the same Zoom meeting after a name-mention ping kicks one of the duplicate User IDs; on Teams, joining sets tenant-wide presence to "In a call", displays a "You're in a call on another device" banner, and places any concurrent call on hold; on Meet, joining after a ping displays two tiles with the member's name.
- **Evidence:** Zoom's session rules are documented in [Signing in to Zoom on multiple devices](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063169) and [Joining multiple meetings simultaneously on desktop](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061500) (October 2026). Whether Teams' October 2026 bot detection flags a signed-in browser on a datacentre IP remains uncertain and needs spike testing.
- **Recommended change:** Enforce separate browser profiles for University and Work identities so a work call and a lecture never share a Zoom or Teams account; add a "Take over (make bot leave and open link)" button on name-mention pings; and on Zoom, fall back to guest join if a signed-in join fails with a concurrent-meeting error.

### BOT-07: `zxing-cpp` with simple upscaling fails on small WebRTC-compressed QR codes when the chat panel is open

- **Severity:** Major
- **Spec section:** Meeting worker; Attendance form handler; Tech stack
- **Problem:** Decoding QR codes every 2 seconds with `zxing-cpp` (WebAssembly) on the 1080p frame plus an upscaled shared-screen region misses small slide codes. In the 19 October 2026 session (`techniques.md`), keeping the browser toolbar (180 px) and Zoom's chat panel (510 px) open shrank the slide inside a 1920x1080 capture to 1118x634 pixels, where a corner QR code (12% of slide height, 76x76 px) encoding a `forms.office.com` URL (37x37 to 41x41 modules) has under 1.9 pixels per module smeared by H.264 4:2:0 subsampling, defeating `zxing-cpp` binarisation even after bicubic upscaling.
- **Evidence:** `zxing-cpp` relies on geometric finder-pattern binarisation ([`zxing-cpp` repository](https://github.com/zxing-cpp/zxing-cpp), October 2026), whereas OpenCV's [`wechat_qrcode`](https://docs.opencv.org/4.x/dd/d63/group__wechat__qrcode.html) uses an SSD detector and super-resolution CNN trained for sub-2px blurred QR modules. The 1118x634 slide crop is measured in `techniques.md`.
- **Recommended change:** Launch the meeting window in Chrome `--app=<url>` mode in Xvfb to reclaim 180 pixels of toolbar height, keep the side panel narrow or collapsed when supported so the shared screen renders at 1500x900 pixels or larger, and run OpenCV's `wechat_qrcode` detector alongside `zxing-cpp`.

### BOT-08: Platform adapter interface lacks audio-join, layout control, breakout-room handling and pre-end chat persistence

- **Severity:** Major
- **Spec section:** How a lecture goes; Platform adapters
- **Problem:** The adapter sketch omits key lifecycle methods across the three platforms: Zoom Web Client often leaves speaker output disconnected until "Join Audio by Computer" is clicked (`CAP-01`); Teams and Meet share one side panel between Chat and Participants so opening Roster closes Chat; Breakout Rooms are unhandled; `waitUntilAdmitted` and `meetingState` do not distinguish a lobby timeout (10 to 15 minutes on Meet) from host denial; and "How a lecture goes" step 7 sweeps chat _after_ detecting the meeting end, which fails because Meet, Teams and Zoom destroy the chat DOM when the host ends the call (`CHAT-02`).
- **Evidence:** `problems-and-fixes.md` (`CAP-01`, `CAP-04`, `CHAT-02`) confirms that Zoom's chat disappears when the meeting ends and that speaker connection cannot be inferred from the mute button label.
- **Recommended change:** Add `connectOutputAudio(page)` and `ensureLayout(page)` (reading participant count from toolbar badges without closing chat) to the adapter interface; split lobby states in `meetingState(page)` into `lobby_waiting`, `lobby_expired` (up to 2 re-knocks) and `lobby_denied` (aborting immediately); ignore or ping on breakout-room prompts; and stream chat to disk every 5 seconds via `MutationObserver` plus sweeps every 10 minutes instead of a post-end sweep.

### BOT-09: Segment recording format and crash-restart splicing are underspecified and risk corrupt MP4s

- **Severity:** Major
- **Spec section:** Scheduler; Meeting worker; Post-processing and summaries
- **Problem:** Recording H.264 and AAC into 5-minute `.mp4` segments (`-f segment`) loses up to 5 minutes of recording when a container crashes mid-segment because an unfinalised `.mp4` lacks its `moov` atom and breaks `ffmpeg -f concat`; across up to 3 restarts, the spec also omits how segment filenames avoid collisions and how transcript `[HH:MM:SS]` timestamps align across the downtime gap.
- **Evidence:** Lesson `OBS-01` in `problems-and-fixes.md` and `techniques.md` selected Matroska (`.mkv`) because standard `.mp4` files are unreadable after an unclean exit.
- **Recommended change:** Write Matroska segments (`-f segment -segment_time 300 -segment_format matroska -reset_timestamps 1`) into a host-mounted directory using attempt-prefixed filenames (`attempt_<N>_seg_%03d.mkv`), and remux any truncated segment before concatenating attempts and anchoring transcript timestamps to each segment's wall-clock start offset.

### BOT-10: Build order delays Teams and Meet validation and puts Teams chat watching before the Teams adapter

- **Severity:** Minor
- **Spec section:** Build order; Early spikes
- **Problem:** Putting Zoom in Milestone 1, link watchers (including Teams chat) in Milestone 2, the Teams adapter in Milestone 4, and Google Meet in Milestone 5, while testing only Zoom in Xvfb during the spikes, splits `teams.microsoft.com/v2` automation across two milestones and delays testing Teams and Meet in Xvfb until late in the build.
- **Evidence:** "Platform realities" in `design.md` notes that Teams' October 2026 bot labelling on signed-in browsers is unverified, and Decision 30 notes that university accounts may be Microsoft or Google from the start.
- **Recommended change:** Expand Early Spike 2 to test a signed-in join, audio capture and chat read on both Microsoft Teams Web and Google Meet inside the Linux Xvfb container on the Singapore server before Milestone 1, and move the Teams chat watcher into the Teams adapter milestone.

### BOT-11: Hard-coded DOM selectors and unpinned Chrome versions will break silently on platform UI rollouts

- **Severity:** Minor
- **Spec section:** Platform adapters; Left to the builder
- **Problem:** Zoom, Teams and Meet ship weekly frontend changes and per-account UI A/B tests (Zoom rendering in `iframe#webclient` or top document in `ZOOM-11`, Teams regenerating hashed Fluent UI classes, Meet changing obfuscated `jsname` attributes), while unpinned `google-chrome-stable` installs in Docker can jump major versions unexpectedly and break selectors mid-semester.
- **Evidence:** `ZOOM-06`, `ZOOM-09`, `ZOOM-11` and `ZOOM-12` in `problems-and-fixes.md` document four DOM and accessibility-tree discrepancies in a single 3-hour Zoom session.
- **Recommended change:** Pin exact `google-chrome-stable` and Playwright versions in the Dockerfile with a monthly smoke test against `zoom.us/test`, load per-platform selector maps from an external JSON file at worker startup, and add a `qwen3-vl-plus` vision fallback on a page screenshot when a primary DOM selector times out during `join()`, `dismissNotices()` or form filling.

## Rigidity gaps

- **Components (Scheduler):** Omits how the scheduler distinguishes a hung worker container from a clean exit, or what heartbeat timeout triggers the 3-attempt restart.
- **Components (Meeting worker):** Omits whether the 2-second frame grabber reads from X11 directly or tails recording segments, affecting Xvfb lock contention and CPU load.
- **Components (Platform adapters):** Omits `timeout` for `waitUntilAdmitted(page, timeout)` and behaviour when a lecturer starts 20 minutes late after a lobby knock expires.
- **Components (Platform adapters):** Omits how `sharedScreenRegion(page)` is computed per platform (DOM video/canvas bounding box versus pixel-brightness auto-crop as in `crop.py`).
- **Components (Platform adapters):** Omits the "frozen frames" alert threshold, given that a lecturer speaking over a static slide with cameras off produces identical video frames for 5 to 15 minutes legitimately.
- **Components (Link watchers):** Omits how a timetable entry identifies the exact WhatsApp Web chat, Discord channel URL or Teams chat thread, and how virtualised lists are scrolled.
- **Components (Attendance form handler):** Omits how multi-page Google or Microsoft Forms ("Next" buttons before "Submit") and "Send me a copy of my responses" checkboxes are handled.
- **Components (Transcription):** Omits how DashScope real-time WebSocket disconnects or session duration limits are reconnected mid-lecture without dropping audio or shifting timestamps.
- **Components (Local mode):** Omits WSL2 memory limits for Docker Desktop on Windows when a worker container runs alongside `whisper-transcriber` and desktop apps.

## What the spec gets right

- **Dedicated Xvfb display per meeting with OS-level input banned:** Running full Chrome inside an isolated virtual framebuffer per meeting eliminates every focus-steal, window-minimise (`DESK-01`, `DESK-02`) and misdirected-keystroke (`SAFE-02`) failure from the 19 October Windows session.
- **Joining via signed-in web clients rather than official bot APIs:** Using the member's authenticated web profile bypasses Zoom's March 2026 Meeting SDK On-Behalf-Of token review, Google Meet's closed Media API, and university guest-lobby blocks in a way that fits an internal tool.
- **Strict safety posture on attendance forms and in-meeting controls:** Refusing to guess answers on unmatched required questions, ignoring quizzes, requiring 2 consecutive QR frame decodes, denying camera and microphone permissions at launch, and restricting notice dismissal to a logged text allowlist enforce Anti-goals 1 and 4.
- **Carrying over virtualised-chat and DOM-root lessons from the manual run:** Mandating runtime DOM root resolution (`iframe#webclient` vs top document), virtualised chat pinning plus periodic sweeps, and durable cursor advancement prevents the data-loss bugs (`CHAT-02`, `CHAT-03`, `ZOOM-11`) hit on 19 October.
- **Interactive `noVNC` profile sign-in with zero password storage:** Letting the member complete university SSO, MFA and WhatsApp Web QR linking once inside a remote browser view avoids brittle login automation and reduces account-lockout risk (Anti-goal 3).

## Questions for the requester

1.  **Which platform hosts your actual university lectures right now (Zoom, Microsoft Teams or Google Meet)?** If this semester's lectures run on Teams or Meet rather than Zoom, put that platform's adapter in Milestone 1 so the tool is usable straight away.
2.  **Are you willing to budget US$40 to 80 a month for an 8 vCPU and 16 GB RAM server (or burst worker VMs on demand)?** If the US$25 to 50 cap is strict, limit server concurrency to 1 meeting at a time and overflow clashing sessions to Local Mode on your PC.
3.  **When a name-mention alert fires during a Zoom lecture, how do you want to join?** Because Zoom disconnects one session when the same signed-in account joins the same meeting from a second device, should the "Open meeting" ping button make the bot leave first, or should the bot join Zoom lectures as a guest whenever allowed?
