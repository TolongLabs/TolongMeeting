# Meeting worker and platform adapters

How one meeting is attended: the container, its virtual screen, Chrome, audio, profile storage and recording, and the adapters that drive Zoom, Teams and Meet. What the app does for the member is in [scheduling and attending](../PRD.md#scheduling-and-attending) in the PRD. The code lives in `packages/worker`, and the binding interfaces are in [worker interfaces](../TRD.md#worker-interfaces). This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Meeting worker](#meeting-worker)
1.  [Platform adapters](#platform-adapters)

## Meeting worker

One container per meeting occurrence, Linux, no GPU, started with `--shm-size=2g`.

![Inside of one meeting worker container: stage and desk, tm-worker, the PulseAudio sink, ffmpeg, the frame loop, live ASR, the occurrence directory and the control client](../images/diagrams/meeting-worker.svg)

- **Screen**: one virtual X display (Xvfb) of 3840x1080 with a simple window manager (openbox) and fixed window placement.
  - **Stage**: the left half (1920x1080) holds only the meeting, in a Chrome app-mode window (`--app=<url>`) with no tabs or toolbar. Only the stage is recorded, scanned for QR codes and used for slides.
  - **Desk**: the right half holds a second Chrome window with the chat-watcher tabs and any form tabs. The remote sign-in view shows only the desk, so credentials and forms are never recorded.
  - The two halves never overlap, so neither window is hidden and throttled.
- **Chrome**: full Chrome (not headless), pinned version, launched by Playwright with a persistent profile. Settings to verify in [spike 2](../TRD.md#early-spikes):
  - drop Playwright's `--enable-automation`;
  - add `--disable-blink-features=AutomationControlled`, `--autoplay-policy=no-user-gesture-required`, `--password-store=basic`, and the software rendering flags Chrome needs without a GPU (for example `--use-gl=angle --use-angle=swiftshader`);
  - add `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`;
  - deny camera and microphone permission;
  - make a muted null audio source the default input, so no real or loopback device is ever offered as a microphone.

  A managed Chrome policy blocks `file://`, `chrome://` and `javascript:` URLs, developer tools and downloads.

- **Audio**: PulseAudio with one sink. Only the meeting window's audio may reach it; desk tabs are muted (the method is verified in spike 2).
- **Profile storage**:
  - **Working copy**: the identity's profile is decrypted into a working directory on an encrypted host volume, mounted only into this worker. It isn't held in memory, so a crash doesn't lose rotated session cookies or WhatsApp Web's encryption state.
  - **Checkpoints**: every 5 minutes and right after a sign-in, the worker writes an encrypted checkpoint of the profile, leaving out caches (`Cache`, `Code Cache`, `GPUCache`, `Service Worker/CacheStorage`, `Crashpad`).
  - **Before every launch**: remove `SingletonLock`, `SingletonSocket` and `SingletonCookie`, and keep the hostname and `/etc/machine-id` fixed per identity.
- **Recording**: ffmpeg records the stage (x11grab region) and the sink into 5-minute Matroska segments named by attempt (`attempt_<N>_seg_<NNN>.mkv`), at 1920x1080, 15 frames per second, H.264 with a fast preset, AAC audio, and wall-clock timestamps. Segments are remuxed and joined at the end; gaps between attempts are recorded in the event log, so transcript times stay aligned with wall-clock time.
- **Frames**: every 2 seconds a full-resolution frame of the stage goes to the QR detector and the slide keyframe selector (the session's watcher rules; see [techniques](../session-record/techniques.md#watcher-keeper-and-end-detection)).
- **Health alerts**:
  - black frames for 10 seconds;
  - a frozen frame together with silence for 5 minutes while participants are present (a frozen slide alone is normal);
  - leaving the meeting unexpectedly. It rejoins once automatically after an unexpected drop.
- **Controls**: the worker never clicks microphone, camera, chat input, reactions, share or record controls. Notices are acknowledged only through an allowlist of button texts per platform (for example `OK`, `Got it`), and each click is logged.
- **Sign-in pause**: on `pause_for_signin`, the worker stops all automation on the desk, keeps recording the stage, and hands the desk to the member's remote view. It resumes on `resume_after_signin` or after 15 minutes idle, then checkpoints the profile.
- **Outputs**: recording segments, kept frames, chat (stored as it arrives), event log, form records and live transcript, all written incrementally to a host-mounted directory. A crash loses at most a few seconds.

## Platform adapters

One module per platform behind a common interface, so the platform order doesn't change the rest. Selectors live in a JSON map per platform, loaded at start, so a UI change can be fixed without rebuilding. The interface (designer's sketch):

- `normaliseLink(url)`: turn a pasted link into the web-client join URL.
- `join(page, identity)`: get through the pre-join screens with devices off, signed in (or as a guest on Zoom when the identity has no Zoom account). Recognise a sign-in or MFA challenge as its own result, distinct from a lobby. Return when in the meeting or in a lobby.
- `connectOutputAudio(page)`: make sure meeting audio plays (for example Zoom's "Join Audio by Computer" without a microphone), verified by the sink's level.
- `ensureLayout(page)`: keep the shared screen as large as possible on the stage, with the chat readable.
- `waitUntilAdmitted(page)`: returns `admitted`, `lobby_expired` (knock again, up to 2 times) or `lobby_denied` (stop and ping). Waits until the scheduled end plus 30 minutes at most.
- `assertDevicesOff(page)`: read the controls' labels and fail loudly if either device is on.
- `readChat(page, cursor)`: return new messages since the cursor (sender, time, text, links), handling virtualised lists. It is called continuously, with full sweeps every 10 minutes.
- `sharedScreenRegion(page)`: the rectangle of the shared screen, from the video element's position first and a brightness crop as the fallback.
- `participantCount(page)`: read without closing the chat panel.
- `meetingState(page)`: one of in meeting, lobby, ended, removed, breakout prompt or unknown, using page signals such as end dialogs or the Leave button disappearing. A breakout prompt is never accepted; it triggers a ping.
- `dismissNotices(page)`: the allowlist.
- `leave(page)`: leave the meeting, used only at the end, on `leave_now` or on `take_over`.

Platform notes:

- **Zoom (first)**:
  - Rewrite `/j/<id>?pwd=` to `/wc/join/<id>?pwd=`, which never launches the desktop app. `/wc/<id>/join` is rewritten to `/wc/join/<id>` too.
  - Pre-join asks twice to continue without microphone and camera.
  - The in-meeting DOM can be in the top document or in `iframe#webclient`, so resolve it at run time.
  - Controls are found by `aria-label`, and chat by the classes in [techniques](../session-record/techniques.md#web-client-dom).
  - If the identity has no Zoom account, or a signed-in join fails because the account is busy in another meeting, join as a guest with the identity's display name.
- **Teams (second)**: the Teams web client signed in as the member, joining with audio and video off. The lobby depends on the organiser's policy. Joining sets the member's presence to "In a call".
- **Google Meet (third)**: meet.google.com signed in as the member. Turn microphone and camera off on the pre-join screen, then "Join now", or "Ask to join" if the member isn't trusted by the meeting's organisation.
- **Failures**: every adapter step has a timeout. On failure the adapter saves a screenshot and the page's accessibility tree, and pings the member.
- **Upkeep**: Chrome and Playwright versions are pinned in the worker image. A monthly smoke test joins each platform's test meeting and fails loudly if a selector is missing.
