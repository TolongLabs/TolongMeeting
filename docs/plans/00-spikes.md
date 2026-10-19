# Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the design's eight early-spike questions with measurements on a throwaway Singapore server, and record the decisions later plans read: pinned worker versions, Chrome settings, the QR decoder, form markers, the live speech model, the concurrency cap, run-location defaults, whether WhatsApp may be watched from the server, and whether ntfy attachments are used.

**Architecture:** Task 0 provisions one throwaway server and a prototype worker image that matches the design's meeting worker: one 3840x1080 Xvfb display split into a recorded stage and an unrecorded desk, a PulseAudio sink, pinned Chrome driven by Playwright on Node 24, and a desk-only remote view reached through an SSH tunnel. Each spike is one task with throwaway scripts in `spikes/<NN>-<slug>/`, measured against pass/fail thresholds derived from the design's targets, and written up in a `REPORT.md` from one template. Task 9 collects every decision into `spikes/DECISIONS.md` and applies the design and plan edits listed for each outcome. Run order: Task 0, then Task 1's day-0 sign-ins, then Tasks 2 to 5, 7, 6 and 8 while Task 1's day-1 and day-7 checks fall due, then Task 9.

**Tech Stack:** Ubuntu 24.04 LTS server (Singapore, 8 vCPUs, 16 GB, 200 GB), Docker Engine, Xvfb, openbox, PulseAudio, pinned Google Chrome, Node 24 and Playwright, x11vnc and noVNC, ffmpeg, Bun for scripts run on the server itself, zxing-wasm (zxing-cpp's WebAssembly build), OpenCV's WeChat QR detector (`opencv-contrib-python-headless`), DashScope real-time speech recognition, Tailscale, ntfy, Caddy.

**Spec:** `docs/app-design/2026-10-20-meeting-bot-design.md` plus `docs/plans/architecture.md`

Contents:

1.  [Global Constraints](#global-constraints)
1.  [Review Focus](#review-focus)
1.  [Tasks](#tasks)
    1.  [Task 0: Throwaway server and prototype worker](#task-0-throwaway-server-and-prototype-worker)
    1.  [Task 1: Spike 1, sign-in from the server](#task-1-spike-1-sign-in-from-the-server)
    1.  [Task 2: Spike 2, browser in the container](#task-2-spike-2-browser-in-the-container)
    1.  [Task 3: Spike 3, QR decoding](#task-3-spike-3-qr-decoding)
    1.  [Task 4: Spike 4, forms](#task-4-spike-4-forms)
    1.  [Task 5: Spike 5, speech recognition](#task-5-spike-5-speech-recognition)
    1.  [Task 6: Spike 6, resources](#task-6-spike-6-resources)
    1.  [Task 7: Spike 7, profile persistence](#task-7-spike-7-profile-persistence)
    1.  [Task 8: Spike 8, ntfy attachments](#task-8-spike-8-ntfy-attachments)
    1.  [Task 9: Decisions and design updates](#task-9-decisions-and-design-updates)

## Global Constraints

- **Throwaway code**: spike scripts live only under `spikes/`, are never imported by `packages/*` and carry no tests. Later plans read only the reports, `spikes/DECISIONS.md`, the seed files each task names, and `docker/worker/versions.env`.
- **Never automate a login**: the member signs in themself through the desk remote view. No script types into, clicks on or submits a sign-in, MFA or account-picker page, and no password is stored (decision 11; security and privacy, "Signing in").
- **Back off**: if any account shows a lock, a forced password reset, a security alert, or a WhatsApp or Discord warning, stop every test that uses that account at once, don't retry, and record it (anti-goal 3).
- **Silent in meetings**: microphone and camera stay off. Scripts never click microphone, camera, chat input, reaction, share or record controls; notices are clicked only through the allowlist `OK` and `Got it`. Joining and leaving are the only visible actions (anti-goal 4).
- **Test material only**: meetings are hosted by the builder's test accounts and forms are test forms the member owns. No real lecture's attendance form is opened or submitted. The spike 5 lecture recording is used only with the lecturer's permission or under a licence that allows it.
- **Screen**: one Xvfb display of 3840x1080. The stage, 1920x1080 at (0, 0), holds only the meeting in a Chrome app-mode window; the desk, 1920x1080 at (1920, 0), holds every other tab.
- **Server**: Singapore region, 8 vCPUs, 16 GB, 200 GB disk, from the provider intended for production, because spike 1's result depends on its network. It is destroyed in Task 9.
- **Containers**: every worker container runs with `--shm-size=2g`, the hostname `tm-<identity>` and a fixed `/etc/machine-id` per identity.
- **Exposure**: the firewall allows only 22/tcp inbound, plus 80/tcp and 443/tcp during Task 8's phone check only. Every published container port binds to `127.0.0.1`; noVNC is reached only through `ssh -L`.
- **Personal data**: recordings, frames of real meetings, transcripts, browser profiles and checkpoints stay on the server under `/srv/spikes/data/<NN>/private/` or `/srv/spikes/profiles/`, and are deleted with it. The repository gets only aggregate CSV and JSON, test-slide samples and reports written with placeholders (`<meeting-id>`, "the member's university Microsoft account").
- **Secrets**: the DashScope key, ntfy tokens, Tailscale auth key and spike master key live in `/srv/spikes/secrets/*.env` or `/srv/spikes/secrets/*.key` (mode 600), are read inside a subshell, and never appear in commits, logs, command lines or URL query strings.
- **Targets the thresholds come from**: a form submitted within 2 minutes of first appearance; a fallback ping within 30 seconds; recording stopped within 60 seconds of the end; the summary within 10 minutes; at most 2 meetings on 8 vCPUs and 16 GB; a crash rejoin within 2 minutes; ntfy attachments expiring within 3 hours.
- **Dates**: Teams' bot labelling reaches general availability "by end of October 2026", so Task 2's Teams label check runs on or after 1 November 2026.
- **Commits**: conventional commits with a header of at most 50 characters, and `bash spikes/00-setup/precommit-check.sh` passing on the staged files before every commit.

## Review Focus

1.  **Chrome offers to save the member's password or turn on sync** when they sign in to Google or Microsoft through the desk view; expected: neither happens (decision 11). Pinned in Task 2 (check J8: `Login Data` holds 0 logins after the sign-ins, and no sync prompt appears) and Task 7 (check P5).
1.  **A published container port bypasses the firewall**, because Docker writes its own iptables rules that ufw doesn't filter, and exposes noVNC to the internet; expected: unreachable except through the tunnel. Pinned in Task 0, step 7.
1.  **Personal data or a secret gets committed**, such as a passcode in a join log, a token in a command, or a frame from a real meeting; expected: nothing of the kind in any commit. Pinned by `precommit-check.sh` in every task's commit step.
1.  **The member's Zoom account is busy in another meeting** while the worker joins; expected: the signed-in join is recognised as `account_busy` and the guest fallback joins with the identity's display name (decision 28). Pinned in Task 2, step 6.
1.  **WhatsApp's linked-device limit of 4 is already full** from the member's own desktop and web links; expected: the spike counts linked devices before linking and unlinks its own devices at the end. Pinned in Task 7, step 1, and Task 9, step 4.

---

## Tasks

### Task 0: Throwaway server and prototype worker

**Files:**

- Create: `spikes/.gitignore`
- Create: `spikes/REPORT-TEMPLATE.md`
- Create: `spikes/00-setup/provision.sh`, `spikes/00-setup/new-identity.sh`, `spikes/00-setup/run-worker.sh`, `spikes/00-setup/sync.sh`, `spikes/00-setup/measure-audio.sh`, `spikes/00-setup/stage-shot.sh`, `spikes/00-setup/precommit-check.sh`
- Create: `spikes/00-setup/worker/Dockerfile`, `spikes/00-setup/worker/entrypoint.sh`, `spikes/00-setup/worker/openbox-rc.xml`, `spikes/00-setup/worker/default.pa`, `spikes/00-setup/worker/chrome-policy.json`, `spikes/00-setup/worker/versions.env`
- Create: `spikes/00-setup/worker/browser.mjs`, `spikes/00-setup/worker/hold.mjs`
- Create: `spikes/00-setup/REPORT.md`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `run-worker.sh --name <container> --identity <id> --data <NN> [--vnc-port <port>] [--network <container>] [--full-view] [--image <tag>] -- <script.mjs> [args]`: starts the image (default `tm-spike-worker:$CHROME_VERSION`) detached with `--shm-size=2g` and `--hostname tm-<id>`, and mounts `/srv/spikes/profiles/<id>/work` at `/profile`, `/srv/spikes/profiles/<id>/machine-id` at `/etc/machine-id` (read-only), `/srv/spikes/data/<NN>` at `/data` and `/srv/spikes/repo/spikes` at `/spikes` (read-only). It publishes the desk view on `127.0.0.1:<port>` (default 6080) and, with `--full-view`, a spike-only full-screen view on `127.0.0.1:<port + 1>`; with `--network container:<name>` it publishes nothing, sets no hostname (the network's owner holds it) and shares that container's network. It runs `node <script.mjs> [args]`.
  - `new-identity.sh <id>`: creates `/srv/spikes/profiles/<id>/work` and `/srv/spikes/profiles/<id>/checkpoints` owned by uid 1000, and a `machine-id` file of 32 random hex digits.
  - `launchSpikeBrowser({ profileDir = '/profile', stageUrl, deskUrls = ['about:blank'], extraArgs = [], deskInitScripts = [] }): Promise<{ context, stage, desks }>` in `spikes/00-setup/worker/browser.mjs`: launches Chrome with the design's flags, puts the stage app window at (0, 0) and the desk window at (1920, 0), each 1920x1080, opens each desk URL as a tab of the desk window, and throws `desk opened in stage window` if a desk page shares the stage's window id. It also exports `DESIGN_ARGS: string[]` and `openDeskTab(context, url, initScripts = []): Promise<Page>`.
  - Inside the container: `DISPLAY=:99`, `PULSE_SERVER=unix:/tmp/pulse/native`, the default sink `tm_sink` and the muted default source `tm_mic`; every script under `/spikes` resolves `playwright` from `/node_modules`.
  - `measure-audio.sh <container> <seconds>` prints `mean_volume: <dB>` and `max_volume: <dB>` for `tm_sink.monitor`; `stage-shot.sh <container> <out.png>` grabs the stage at 1920x1080; `sync.sh push` copies `spikes/` to `/srv/spikes/repo/spikes/`; `sync.sh pull <NN>-<slug>` copies `/srv/spikes/data/<NN>/results/` into `spikes/<NN>-<slug>/data/`; `precommit-check.sh` exits 1 when a staged file or added line looks like media, an archive or a secret.
  - `spikes/REPORT-TEMPLATE.md`, which every spike's report follows.
  - The keys of `spikes/00-setup/worker/versions.env`: `NODE_VERSION`, `CHROME_VERSION`, `PLAYWRIGHT_VERSION`, `FFMPEG_VERSION` (adds to contracts: `docker/worker/versions.env` uses the same keys; Task 2 creates it).

- [ ] **Step 1: Create the server and the branch**

Create a server in the production provider's Singapore region: 8 vCPUs, 16 GB, 200 GB SSD, Ubuntu 24.04 LTS, SSH-key login only. Note the provider, plan and the network's ASN and country (`curl -s https://ipinfo.io/org` on the server) for the report; spike 1 needs them. In the repository run `git switch -c spikes`.

- [ ] **Step 2: Write and run `provision.sh`**

`spikes/00-setup/provision.sh` (run once as root) does, in order: `apt-get update && apt-get -y upgrade`; creates user `spike` with uid 1000 (removing the provider's default user if it holds that uid, so files the container's `node` user writes belong to `spike`), sudo and the `docker` group, and copies root's `authorized_keys`; sets `PasswordAuthentication no` and `PermitRootLogin prohibit-password` in sshd; `ufw default deny incoming`, `ufw allow 22/tcp`, `ufw --force enable`; installs Docker Engine and the Compose plugin from Docker's apt repository; installs `jq`, `sqlite3`, `rsync`, `python3-venv` and Bun for user `spike`; creates `/srv/spikes/{repo,data,profiles,secrets}` owned by `spike` with mode 700; ends with `docker run --rm hello-world` and `ufw status`. `spikes/.gitignore` ignores `**/private/`, `**/node_modules/` and `*.mkv`, `*.flac`, `*.wav`, `*.pcm`, `*.tar`, `*.enc`.

Run: `scp spikes/00-setup/provision.sh root@<vm-ip>:/root/ && ssh root@<vm-ip> bash /root/provision.sh`

Expected: the output contains `Hello from Docker!`, and `ufw status` lists only `22/tcp ALLOW IN Anywhere` (and its v6 twin).

- [ ] **Step 3: Write the image files**

`spikes/00-setup/worker/versions.env` holds the four keys. Fill them at build time: `NODE_VERSION` is the newest Node 24 release, `CHROME_VERSION` the current stable version on Google's Linux package pool, `PLAYWRIGHT_VERSION` the newest Playwright whose release notes cover that Chrome major version, and `FFMPEG_VERSION` the full Debian version from `apt-cache policy ffmpeg` in `node:<NODE_VERSION>-bookworm-slim`. Dockerfile key lines:

```dockerfile
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim
ARG CHROME_VERSION
ARG PLAYWRIGHT_VERSION
ARG FFMPEG_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox pulseaudio pulseaudio-utils x11vnc novnc websockify wmctrl x11-utils \
      ffmpeg=${FFMPEG_VERSION} libgl1-mesa-dri fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      sqlite3 curl ca-certificates \
 && curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
 && apt-get install -y /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list \
 && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix / --no-save --no-fund playwright@${PLAYWRIGHT_VERSION}
ENV DISPLAY=:99 PULSE_SERVER=unix:/tmp/pulse/native
COPY chrome-policy.json /etc/opt/chrome/policies/managed/tm-policy.json
COPY openbox-rc.xml /etc/xdg/openbox/rc.xml
COPY default.pa /etc/pulse/tm.pa
COPY entrypoint.sh /opt/spike/entrypoint.sh
USER node
ENTRYPOINT ["/opt/spike/entrypoint.sh"]
```

`default.pa`:

```text
load-module module-native-protocol-unix socket=/tmp/pulse/native auth-anonymous=1
load-module module-null-sink sink_name=tm_sink sink_properties=device.description=tm_sink
load-module module-null-source source_name=tm_mic
set-default-sink tm_sink
set-default-source tm_mic
set-source-mute tm_mic 1
```

`chrome-policy.json`. The first three entries are the design's policy; the rest are candidates that Task 2 keeps or drops (`devtools://*`, password manager, browser sign-in, sync and capture):

```json
{
  "URLBlocklist": ["file://*", "chrome://*", "javascript://*", "devtools://*"],
  "DeveloperToolsAvailability": 2,
  "DownloadRestrictions": 3,
  "PasswordManagerEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "AudioCaptureAllowed": false,
  "VideoCaptureAllowed": false
}
```

`openbox-rc.xml` is openbox's default `rc.xml` with one desktop and this rule:

```xml
<applications>
  <application class="Google-chrome" type="normal">
    <decor>no</decor>
    <focus>no</focus>
  </application>
</applications>
```

`entrypoint.sh` (`set -euo pipefail`), in order: remove `/profile/SingletonLock`, `/profile/SingletonSocket` and `/profile/SingletonCookie`; start `Xvfb :99 -screen 0 3840x1080x24 -nolisten tcp` and wait until `xdpyinfo -display :99` succeeds; start `openbox`; start `pulseaudio --daemonize=yes --exit-idle-time=-1 -n -F /etc/pulse/tm.pa`; start `x11vnc -display :99 -clip 1920x1080+1920+0 -localhost -forever -shared -nopw -quiet -rfbport 5900` and `websockify --web /usr/share/novnc 6080 localhost:5900`; if `FULL_VIEW=1`, also an unclipped `x11vnc` on 5901 behind `websockify` on 6081; finally `exec node "$@"`.

- [ ] **Step 4: Write `browser.mjs`, `hold.mjs` and the helpers**

`launchSpikeBrowser` launches with these options; it then places each window through a CDP session on one of its pages (`Browser.getWindowForTarget`, then `Browser.setWindowBounds` with `{ left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }` for the stage and `left: 1920` for the desk). The stage is `context.pages()[0]`; the desk window comes from the first `context.newPage()`, because an app-mode window takes no tabs.

```js
export const DESIGN_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--autoplay-policy=no-user-gesture-required",
  "--password-store=basic",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ["--enable-automation"],
  args: [
    ...DESIGN_ARGS,
    ...extraArgs,
    `--app=${stageUrl}`,
    "--window-position=0,0",
    "--window-size=1920,1080",
  ],
});
```

`hold.mjs --stage-url <url> --desk-url <url> [--desk-url <url> ...]` launches, writes `/data/results/hold-<ISO time>.json` with `{ chrome: browser.version(), node: process.version, stageBounds, deskBounds }`, and on SIGTERM closes the context so the profile is flushed. It is the container used for every member sign-in. `run-worker.sh` and `new-identity.sh` follow the Interfaces block; `measure-audio.sh` runs `docker exec <container> ffmpeg -hide_banner -f pulse -i tm_sink.monitor -t <seconds> -af volumedetect -f null -` and prints the two volume lines; `stage-shot.sh` runs `ffmpeg -f x11grab -video_size 1920x1080 -i :99.0+0,0 -frames:v 1` inside the container and copies the file out. `precommit-check.sh` fails on any staged path matching `\.(png|jpe?g|webp|mkv|mp4|webm|wav|flac|pcm|tar|enc|db|sqlite)$` outside `spikes/03-qr/samples/`, or any added line matching `pwd=|tk_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|tskey-|Bearer [A-Za-z0-9._-]{8,}`; it prints only the file names, never the match.

- [ ] **Step 5: Build the image twice**

Run on the server, after `bash spikes/00-setup/sync.sh push` from the PC:

```bash
cd /srv/spikes/repo/spikes/00-setup/worker && set -a && . ./versions.env && set +a
docker build --build-arg NODE_VERSION --build-arg CHROME_VERSION --build-arg PLAYWRIGHT_VERSION --build-arg FFMPEG_VERSION -t tm-spike-worker:$CHROME_VERSION .
docker run --rm --entrypoint google-chrome tm-spike-worker:$CHROME_VERSION --version
docker build --no-cache --build-arg NODE_VERSION --build-arg CHROME_VERSION --build-arg PLAYWRIGHT_VERSION --build-arg FFMPEG_VERSION -t tm-spike-worker:check .
docker run --rm --entrypoint google-chrome tm-spike-worker:check --version
```

Expected: both builds succeed and both version lines print `Google Chrome <CHROME_VERSION>` exactly. If Google's pool no longer has that version, take the current one, update `versions.env` and rebuild; record the `.deb`'s SHA-256 in the report.

- [ ] **Step 6: Smoke-test the display, audio and windows**

```bash
bash /srv/spikes/repo/spikes/00-setup/new-identity.sh check
bash /srv/spikes/repo/spikes/00-setup/run-worker.sh --name tm-check --identity check --data 00 -- /spikes/00-setup/worker/hold.mjs \
  --stage-url 'data:text/html,<body style="background:#00ff00">' --desk-url 'data:text/html,<body style="background:#ff00ff">'
docker exec tm-check xdpyinfo -display :99 | grep dimensions
docker exec tm-check pactl info | grep -E 'Default (Sink|Source)'
docker exec tm-check wmctrl -lG
for x in 0 1920; do docker exec tm-check sh -c "ffmpeg -loglevel error -f x11grab -video_size 1920x1080 -i :99.0+$x,0 -frames:v 1 -vf scale=1:1:flags=area -f rawvideo -pix_fmt rgb24 - | od -An -tu1"; done
```

Expected: `dimensions:    3840x1080 pixels`; `Default Sink: tm_sink` and `Default Source: tm_mic`; two Chrome windows with geometry `0 0 1920 1080` and `1920 0 1920 1080`; the stage's average colour is `0 255 0` and the desk's `255 0 255`, each channel within 3.

- [ ] **Step 7: Check the remote view and exposure**

From the PC: `Test-NetConnection <vm-ip> -Port 6080` (PowerShell). Expected: `TcpTestSucceeded : False`. Then `ssh -N -L 6080:127.0.0.1:6080 spike@<vm-ip>` and, in another shell, `curl -sI http://localhost:6080/vnc.html`. Expected: `HTTP/1.1 200 OK`. Open `http://localhost:6080/vnc.html?autoconnect=1&resize=scale`. Expected: only the magenta desk is visible, never the green stage.

- [ ] **Step 8: Record the idle baseline**

Run: `for i in 1 2 3 4 5 6; do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' tm-check; sleep 10; done; docker image ls tm-spike-worker`

Expected: six lines of CPU and memory, and the image size. Record them as the empty worker's floor. Then `docker stop -t 30 tm-check`.

- [ ] **Step 9: Write the report template and this task's report**

`spikes/REPORT-TEMPLATE.md`, exactly:

```markdown
# Spike <NN>: <title>

<The question from the design's early spikes, and the verdict, in one sentence.> Run from <YYYY-MM-DD> to <YYYY-MM-DD> on <provider> Singapore (<vCPUs> vCPUs, <GB> GB), image `tm-spike-worker:<CHROME_VERSION>`.

Contents:

1.  [Verdict](#verdict)
1.  [Setup](#setup)
1.  [Procedure](#procedure)
1.  [Measurements](#measurements)
1.  [Decisions](#decisions)
1.  [Design and plan edits](#design-and-plan-edits)
1.  [Surprises](#surprises)
1.  [Data](#data)

## Verdict

<pass, partial or fail>: what was learnt and what it changes, in one paragraph.

## Setup

- **Accounts**: <roles only, for example "the member's university Microsoft account"; never addresses or names>.
- **Meetings and forms**: <which test account hosted them; placeholders such as `<meeting-id>`>.
- **Versions**: <image tag, Chrome, Playwright, Node and any other tool>.

## Procedure

1.  <each step as run, with its exact command; mark departures from the plan "Deviation:">

## Measurements

| Check                       | Threshold   | Measured | Result       |
| --------------------------- | ----------- | -------- | ------------ |
| <id and name from the plan> | <threshold> | <value>  | pass or fail |

## Decisions

| Key     | Value   | Read by |
| ------- | ------- | ------- |
| `<key>` | <value> | <plans> |

## Design and plan edits

- <file, section and edit, from Task 9's outcome table, or "None">

## Surprises

- <anything unexpected, including any warning from any account>

## Data

- <committed files under `data/`, and what stayed on the server under `private/` and was deleted with it>
```

`spikes/00-setup/REPORT.md` follows it: provider, plan, ASN, versions, step 5 to 8 results, with the checks of steps 5 to 7 as rows of the measurements table.

- [ ] **Step 10: Commit**

```bash
git add spikes/.gitignore spikes/REPORT-TEMPLATE.md spikes/00-setup
bash spikes/00-setup/precommit-check.sh
git commit -m "chore(spikes): add prototype worker image"
```

Expected: the check prints nothing and exits 0; the commit succeeds.

### Task 1: Spike 1, sign-in from the server

**Files:**

- Create: `spikes/01-signin/check-sessions.mjs`
- Create: `spikes/01-signin/checks.json`
- Create: `spikes/01-signin/ts-home.sh`
- Create: `spikes/01-signin/data/sessions.csv`, `spikes/01-signin/data/simultaneous.csv`
- Create: `spikes/01-signin/REPORT.md`

**Interfaces:**

- Consumes: `run-worker.sh`, `new-identity.sh`, `launchSpikeBrowser`, `openDeskTab` and `hold.mjs` (Task 0).
- Produces:
  - `check-sessions.mjs --identity <id> --route <dc|home> --checks <name,...> [--idp-host <host>]`: opens each named check from `checks.json` in a desk tab, never types or clicks, and appends one JSON line per check to `/data/results/sessions.jsonl`: `{ at, identity, route, egressCountry, egressAsn, name, finalHost, state }`, with `state` one of `signed_in`, `signin_required`, `blocked`. Task 7 reuses it.
  - `checks.json`: `google` (`https://myaccount.google.com/`), `microsoft` (`https://myaccount.microsoft.com/`), `zoom` (`https://zoom.us/profile`), `teams` (`https://teams.microsoft.com/v2/`), `gforms` (`https://docs.google.com/forms/u/0/`), `msforms` (`https://forms.office.com/`), `discord` (`https://discord.com/channels/@me`), `whatsapp` (`https://web.whatsapp.com/`), each with its signed-in marker (a CSS selector) recorded when first seen.
  - Decisions (adds to contracts, read through `spikes/DECISIONS.md`): `runLocation.university` and `runLocation.work` (a `RunLocation`), `signin.survivalDays.university` and `signin.survivalDays.work` (1, 7, or 0 when the day-1 check failed), `teams.deviceCompliance` (`required` or `not_required`).

Classification rule for `check-sessions.mjs`, after the page settles (network idle or 20 seconds): `blocked` if the page text contains `AADSTS53000`, `AADSTS53003`, "You can't get there from here", "This browser or app may not be secure" or "Couldn't sign you in"; else `signin_required` if the final host is `accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, the `--idp-host`, or the path is `/signin` or `/login`, or a password field or WhatsApp's link-device QR code is visible; else `signed_in` if the check's marker is present; else `signin_required`. Each check saves a screenshot to `/data/private/checks/`.

Thresholds per identity (university, work) and route (data centre, home):

| Check                 | Threshold                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 Day 1              | every needed check `signed_in` at 24 hours (plus or minus 2) after sign-in, with no member action                                                                                                              |
| S2 Day 7              | every needed check `signed_in` at 168 hours (plus or minus 4)                                                                                                                                                  |
| S3 Simultaneous use   | while the member actively uses the same accounts in Malaysia, the worker joins a test meeting signed in, and 60 minutes later opens the member's organisation-restricted test form with no sign-in or MFA page |
| S4 No alerts          | no lock, forced reset, security alert email or "unusual activity" entry on the member's accounts at day 0, 1 and 7                                                                                             |
| S5 Device (work only) | `teams` never `blocked`                                                                                                                                                                                        |

A route passes for an identity only when S1 to S5 all pass. Defaults: `server` if the data-centre route passes; else `server_via_home` if the home route passes; else `local`. `teams.deviceCompliance` is `required` if S5 fails on both routes.

- [ ] **Step 1: Create the identities and sign in from the data centre**

Needed checks: university `microsoft` or `google` (whichever the university uses; both if it has both), `msforms` or `gforms`, and `zoom` if lectures use the university's Zoom; work `microsoft`, `teams` and `msforms`. Create `uni-dc` and `work-dc` with `new-identity.sh`, start each with `run-worker.sh --name tm-<id> --identity <id> --data 01 -- /spikes/00-setup/worker/hold.mjs --stage-url about:blank --desk-url <sign-in page>`, open the desk view through the tunnel, and have the member sign in to every needed account themself, choosing "Stay signed in" where offered. Note every prompt they saw (MFA, location challenge, device prompt). Then `docker stop -t 30 tm-<id>`. These two profiles are used only by this task.

- [ ] **Step 2: Run the day-0 check**

Run: `bash /srv/spikes/repo/spikes/00-setup/run-worker.sh --name tm-uni-dc --identity uni-dc --data 01 -- /spikes/01-signin/check-sessions.mjs --identity uni-dc --route dc --checks microsoft,msforms,zoom` (and the same for `work-dc` with `microsoft,teams,msforms`).

Expected: every line `signed_in`. A `signin_required` here means the sign-in didn't stick; redo step 1 once.

- [ ] **Step 3: Set up the home route and repeat steps 1 and 2**

On a device at the member's home that stays on (a PC or a small board), install Tailscale, enable "Run exit node", and approve it in the admin console. Put a tagged auth key in `/srv/spikes/secrets/ts.env` as `TS_AUTHKEY=...`. `ts-home.sh <id> <vnc-port>` starts the sidecar and the worker shares its network:

```bash
docker run -d --name ts-$1 --hostname tm-$1 --cap-add NET_ADMIN --device /dev/net/tun \
  --env-file /srv/spikes/secrets/ts.env -e TS_STATE_DIR=/var/lib/tailscale -e TS_USERSPACE=false \
  -e TS_EXTRA_ARGS="--exit-node=<home-node-ip> --exit-node-allow-lan-access=false" \
  -p 127.0.0.1:$2:6080 -v ts-$1:/var/lib/tailscale tailscale/tailscale:<pinned-tag>
```

Start workers with `--network container:ts-<id>`. Check the route: `docker exec tm-uni-home curl -s https://ipinfo.io/country` prints `MY`, and the member confirms the egress address matches their home connection (the address itself is never written down). Create `uni-home` and `work-home`, sign in through this route, and run the day-0 check with `--route home`.

- [ ] **Step 4: Run the simultaneous-use test on each route**

Host a test meeting that lasts at least 70 minutes (a Google Meet one-to-one call from a free account, a university-licensed Zoom meeting, or a Teams meeting for the work identity). During the whole window the member actively uses the same university and work accounts on their own laptop or phone in Malaysia (mail, files, chat). The worker joins signed in through the stage with Task 2's `join.mjs`; if that isn't ready yet, the builder clicks through the pre-join screen in a `--full-view` view, using only the device-off and join buttons. At join plus 60 minutes, run `check-sessions.mjs --checks msforms` (or `gforms`) and open the member's organisation-restricted test form in a desk tab. Append one row per identity and route to `/data/results/simultaneous.csv`: `identity,route,joined,formState,minutesAfterJoin,prompts`.

Expected: `joined=true` and `formState=signed_in`.

- [ ] **Step 5: Check alerts and the work tenant's device rule**

After each step that touches an account, the member checks the provider's activity pages (Microsoft "My Sign-Ins" recent activity, Google "Security activity", Zoom's sign-in emails) and their inbox for alerts, and the tenant's response to `teams` (an `AADSTS53000` or `AADSTS53003` page means a compliant device is required). Record each as yes or no. Any lock or alert stops that account's tests (Global Constraints, "Back off").

- [ ] **Step 6: Run the day-1 and day-7 checks**

At 24 hours and 168 hours after each identity's sign-in, rerun step 2's command for all four identities, in fresh containers, with no member action in between. Expected: every line `signed_in`.

- [ ] **Step 7: Record and compare**

Run `bash spikes/00-setup/sync.sh pull 01-signin`, convert `sessions.jsonl` to `data/sessions.csv` (`at,identity,route,name,state`), and fill the S1 to S5 table per identity and route. Measure the home route's cost too: `docker stats --no-stream ts-uni-home` network I/O after the 70-minute meeting, as megabytes per hour.

- [ ] **Step 8: Write the report**

`spikes/01-signin/REPORT.md` from the template, with the egress country and ASN per route (never addresses), every prompt the member saw, survival days, and the decisions `runLocation.university`, `runLocation.work`, `signin.survivalDays.*` and `teams.deviceCompliance`.

- [ ] **Step 9: Apply the outcome's edits**

Apply the rows for spike 1 from Task 9's outcome table that match the result, in the design and plans named there.

- [ ] **Step 10: Commit**

```bash
git add spikes/01-signin docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report sign-in from server"
```

Expected: the check prints nothing; the commit succeeds.

### Task 2: Spike 2, browser in the container

**Files:**

- Create: `spikes/02-browser/join.mjs`
- Create: `spikes/02-browser/flags-check.mjs`
- Create: `spikes/02-browser/tone.html`
- Create: `spikes/02-browser/mute-desk.js`
- Create: `spikes/02-browser/selectors/zoom.json`, `spikes/02-browser/selectors/teams.json`, `spikes/02-browser/selectors/meet.json`
- Create: `spikes/02-browser/chrome-policy.json`
- Create: `spikes/02-browser/data/joins.csv`, `spikes/02-browser/data/checks.csv`
- Create: `docker/worker/versions.env`
- Modify: `spikes/00-setup/worker/browser.mjs` (final `DESIGN_ARGS`), `spikes/00-setup/worker/chrome-policy.json`
- Create: `spikes/02-browser/REPORT.md`

**Interfaces:**

- Consumes: Task 0's helpers and `launchSpikeBrowser`; `check-sessions.mjs` (Task 1).
- Produces:
  - Identities `lab-uni` (the member's university account and Zoom) and `lab-work` (the member's work account and Teams), also used by Tasks 3, 4 and 6.
  - `join.mjs --platform <zoom|teams|meet> --url <link> [--guest-name <name>] --stay-minutes <n> --run <label>`, which also exports `joinMeeting(stage, { platform, url, guestName }): Promise<JoinResult>` and `readChatOnce(stage, platform): Promise<ChatEvent[]>` for Tasks 3, 4 and 6. It appends `{ at, step, ok, ms, detail }` lines to `/data/results/join-<label>.jsonl` for the steps `navigated`, `prejoin_devices_off`, `join_result` (the `JoinResult` kinds of `packages/worker/src/adapters/types.ts`: `in_meeting`, `lobby`, `signin_required`, `account_busy`, `failed`), `admitted`, `audio_connected`, `chat` (one per message: `sender`, `senderRole` or `null`, `text`, `links`, `readAt`), `participants`, `shared_rect`, `zoom_root` (`top` or `iframe`), `state` and `ended_detected`. It saves `ariaSnapshot()` dumps to `/data/private/aria/` for selector discovery, and clicks only pre-join device-off controls, join, computer-audio join, `OK` and `Got it`.
  - `docker/worker/versions.env` with Task 0's four keys, read by plan 01a's Dockerfile task.
  - `spikes/02-browser/chrome-policy.json` and the final `DESIGN_ARGS`, read by plan 01a's tasks for `docker/worker/chrome-policy.json` and `packages/worker/src/chrome/launch.ts`.
  - `spikes/02-browser/selectors/{zoom,teams,meet}.json`, seeds of `config/selectors/{zoom,teams,meet}.json` (plans 01a, 04, 05), each a flat object from purpose to selector with the purposes `prejoinNoDevices`, `joinButton`, `audioJoinComputer`, `micButton`, `cameraButton`, `chatToggle`, `chatList`, `chatItem`, `chatSender`, `chatTime`, `chatText`, `participantsButton`, `leaveButton`, `leaveConfirm`, `endedMarker`, `lobbyMarker`, `sharedVideo`, `noticeButtons`.
  - Decisions (adds to contracts): `chrome.args`, `chrome.policyFile`, `chrome.deskMute` (`init_script` or `sound_setting`), `chrome.captureBlock` (`policy` or `permission_deny`), `desk.backgroundTabsLive` (`yes` or `no`), `teams.signedInLabelled` (`yes` or `no`), `platform.zoom`, `platform.teams`, `platform.meet` (`pass` or `fail: <reason>`), `zoom.guestFallback` (`pass` or `fail`), `chat.senderRoleVisible.<platform>` (`yes` or `no`), `stage.sharedRect.<platform>` (`<width>x<height>` with the chat panel open).

Thresholds. J1 to J5 apply per platform; a platform passes with J1 to J5, plus J9 for Teams and J10 for Meet.

| Check            | Threshold                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1 Join          | 3 of 3 signed-in joins reach `in_meeting` or `lobby`, each within 120 seconds of navigation, lobby time excluded (the T-10 to T-5 join window leaves room for one retry)                                                                                                                                                                                                    |
| J2 Devices off   | the host's participant view shows the member muted with camera off for the whole run; in the stage, `getUserMedia({ audio: true })` rejects with `NotAllowedError` and `enumerateDevices()` offers no `tm_sink.monitor` input                                                                                                                                               |
| J3 Audio heard   | `measure-audio.sh` over 30 seconds while the host plays a clip: `mean_volume` of -45 dB or louder                                                                                                                                                                                                                                                                           |
| J4 Chat          | 30 of 30 host messages read with the exact sender and text and every link extracted, each within 30 seconds of the send time written in it                                                                                                                                                                                                                                  |
| J5 End           | `ended_detected` within 15 seconds of the host ending the meeting (recording must stop within 60)                                                                                                                                                                                                                                                                           |
| J6 Layout        | stage window at `0 0 1920 1080` and desk at `1920 0 1920 1080`; 3 extra desk tabs all land in the desk window; 100 stage frames taken 2 seconds apart while the desk shows a magenta page contain 0 magenta pixels (R over 200, G under 60, B over 200)                                                                                                                     |
| J7 Flags         | `navigator.webdriver` is `false` in stage and desk; the browser's command line lacks `--enable-automation`; no "controlled by automated test software" bar in the desk; the WebGL2 renderer string contains `SwiftShader`; both windows report `visibilityState` `visible`; a 1-second timer in the desk's active tab drifts under 10% over 5 minutes                       |
| J8 Policy        | `file://`, `chrome://` and `javascript:` navigations show `ERR_BLOCKED_BY_ADMINISTRATOR`; Ctrl+Shift+I and F12 in the desk view open nothing; a download link saves nothing; Playwright still drives the browser; after the member's sign-ins `sqlite3 "/profile/Default/Login Data" "select count(*) from logins"` prints `0` and no sync or save-password prompt appeared |
| J9 Teams label   | on or after 1 November 2026, the organiser's lobby and participant views show the member's name with no bot, assistant, app or "Unverified" label, in a same-tenant and a cross-tenant meeting                                                                                                                                                                              |
| J10 Meet         | no "You can't join this video call"; "Join now" or "Ask to join" is reached                                                                                                                                                                                                                                                                                                 |
| J11 Desk mute    | with the stage silent and a desk tab playing `tone.html`, `max_volume` is -70 dB or quieter; the same page on the stage gives `mean_volume` of -30 dB or louder                                                                                                                                                                                                             |
| J12 Account busy | a signed-in Zoom join while the member's own device is in another meeting on the same account returns `account_busy`, and the guest join with `--guest-name` reaches `in_meeting`                                                                                                                                                                                           |

- [ ] **Step 1: Create the lab identities**

Create `lab-uni` and `lab-work` with `new-identity.sh`, start each with `hold.mjs`, and have the member sign in through the desk view: university account and Zoom in `lab-uni`, work account and Teams in `lab-work`. Note whether Chrome offered sync or to save a password (J8). Run `check-sessions.mjs` for the signed-in checks. Expected: every line `signed_in`.

- [ ] **Step 2: Run the flag, policy, layout and mute checks**

`tone.html` loops a 440 Hz `OscillatorNode` and an `<audio>` element playing a generated WAV blob. `mute-desk.js` (method A) is a desk-only init script that sets `muted = true` and `volume = 0` on every media element before `play()` and inserts a zero-gain node in front of every `AudioContext` destination. Method B sets the site's sound content setting to block in `Default/Preferences` before launch; it can't separate the Teams meeting from a Teams chat tab, so it's measured only for comparison. `flags-check.mjs` loads `tone.html` through a `data:` URL, measures J6, J7, J8 and J11 for both methods, and writes `/data/results/flags.json`.

Run: `bash /srv/spikes/repo/spikes/00-setup/run-worker.sh --name tm-lab-uni --identity lab-uni --data 02 -- /spikes/02-browser/flags-check.mjs`

Expected: `flags.json` shows J6, J7, J8 and J11 passing for method A. On a failure, change one setting at a time and rerun: add `--enable-unsafe-swiftshader` if WebGL2 is missing; if Playwright can't attach under `DeveloperToolsAvailability: 2`, drop that policy and rely on the `devtools://*` block; if a platform refuses to join under `AudioCaptureAllowed: false` and `VideoCaptureAllowed: false`, drop both and deny the two permissions in `Default/Preferences` instead (`chrome.captureBlock=permission_deny`). Record every change.

- [ ] **Step 3: Write `join.mjs` and the selector maps**

Zoom: rewrite `/j/<id>?pwd=` to `/wc/join/<id>?pwd=`, pass both "continue without microphone and camera" prompts, resolve the in-meeting root at run time (`iframe#webclient` or the top document), and read chat with the classes and scroll-and-sweep rules of `reference-scripts/browser/zoom-chat-capture.js`. Teams: "Continue on this browser", devices off, "Join now". Meet: devices off on the pre-join screen, then "Join now" or "Ask to join". Find each control from the aria dumps of a first run started with `--full-view`, write it into the platform's selector map, and rerun until the script needs no help.

- [ ] **Step 4: Run three joins per platform**

For each platform, a test account hosts and follows the same script: share a slide deck, play a 30-second clip with sound, post 30 messages `m01 <HH:MM:SS>` to `m30 <HH:MM:SS>` as fast as possible (send time from an NTP-synchronised clock; five carry `https://example.com/<n>`), then end the meeting.

```bash
bash /srv/spikes/repo/spikes/00-setup/run-worker.sh --name tm-lab-uni --identity lab-uni --data 02 -- /spikes/02-browser/join.mjs --platform zoom --url '<zoom-link>' --stay-minutes 20 --run zoom-1
bash /srv/spikes/repo/spikes/00-setup/measure-audio.sh tm-lab-uni 30
for i in $(seq 1 60); do docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' tm-lab-uni; sleep 10; done > /srv/spikes/data/02/results/stats-zoom-1.txt
```

Use `lab-work` for Teams and either identity for Meet: once with a host in the member's own organisation, once with a free-account host who admits the member. Expected: J1 to J5 hold in each run; `shared_rect`, `zoom_root` and `senderRole` are recorded.

- [ ] **Step 5: Check Teams labelling**

On or after 1 November 2026, join two Teams test meetings with `lab-work`: one organised in the member's work tenant, one in another tenant. The organiser screenshots the lobby and participant list. Expected: J9 holds; otherwise record the exact label text.

- [ ] **Step 6: Check the Zoom account-busy fallback**

While the member's own device sits in another Zoom meeting signed in to the same account, run `join.mjs --platform zoom --url '<zoom-link>' --stay-minutes 5 --run zoom-busy`, then again with `--guest-name '<identity display name>'`. Expected: J12.

- [ ] **Step 7: Check background desk tabs**

With `lab-work`, open the Teams test chat in a desk tab, then open a second desk tab in front of it. A test account posts 5 messages over 5 minutes. Read the background tab's DOM every 30 seconds without bringing it to the front. Record `desk.backgroundTabsLive=yes` if every message appears within 45 seconds (the watchers' longest poll interval), else `no`.

- [ ] **Step 8: Freeze the settings and versions**

Copy the passing flag list into `DESIGN_ARGS` and the passing policy into `spikes/00-setup/worker/chrome-policy.json` and `spikes/02-browser/chrome-policy.json`. Rerun step 2 and one Zoom join with the frozen settings. Write `docker/worker/versions.env` with the four values from `spikes/00-setup/worker/versions.env`, under the comment line `# Set by spike 2; change only together with a passing smoke test`. Expected: the rerun passes and `docker run --rm --entrypoint google-chrome tm-spike-worker:$CHROME_VERSION --version` matches `CHROME_VERSION`.

- [ ] **Step 9: Record and compare**

Run `bash spikes/00-setup/sync.sh pull 02-browser`. Write `data/joins.csv` (`run,platform,joinResult,joinMs,audioMeanDb,chatRead,chatMaxLagS,endLagS,zoomRoot,senderRole,sharedRect,cpuP95`) and `data/checks.csv` (`check,value,threshold,result`), and fill the J1 to J12 table.

- [ ] **Step 10: Write the report and apply the outcome's edits**

`spikes/02-browser/REPORT.md` from the template, with the browser's full command line (from `/proc/<pid>/cmdline`), the final flags and policy, and every decision key above. Apply the spike 2 rows of Task 9's outcome table.

- [ ] **Step 11: Commit**

```bash
git add spikes/02-browser spikes/00-setup/worker docker/worker/versions.env docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report browser in container"
```

Expected: the check prints nothing; the commit succeeds.

### Task 3: Spike 3, QR decoding

**Files:**

- Create: `spikes/03-qr/make-deck.sh`, `spikes/03-qr/deck-plan.csv`
- Create: `spikes/03-qr/Dockerfile`
- Create: `spikes/03-qr/decode-zxing.mjs`, `spikes/03-qr/decode_wechat.py`, `spikes/03-qr/bridge-check.mjs`
- Create: `spikes/03-qr/score.ts`
- Create: `spikes/03-qr/samples/` (at most 20 frames of the test deck)
- Create: `spikes/03-qr/data/decodes.csv`, `spikes/03-qr/data/summary.json`
- Create: `spikes/03-qr/REPORT.md`

**Interfaces:**

- Consumes: `lab-uni`, `join.mjs`'s `joinMeeting` and the recorded `stage.sharedRect.zoom` (Task 2); `run-worker.sh --image` (Task 0).
- Produces:
  - Image `tm-spike-qr:$CHROME_VERSION`: the worker image plus `zxing-wasm` and `sharp` (npm, pinned, installed under `/node_modules`), a Python venv at `/opt/qr` with `opencv-contrib-python-headless` (pinned), and the four WeChat model files (`detect.prototxt`, `detect.caffemodel`, `sr.prototxt`, `sr.caffemodel` from the `WeChatCV/opencv_3rdparty` repository's `wechat_qrcode` branch, SHA-256 recorded). Task 6 uses it.
  - `decode-zxing.mjs --frames <dir> --rect <x,y,w,h> --out <csv>` and `decode_wechat.py --frames <dir> --rect <x,y,w,h> --out <csv>` append rows `frame,tSec,decoder,mode,ms,texts`, with `mode` either `full` (the whole 1920x1080 frame) or `region` (the shared-screen rectangle upscaled 2x with Lanczos). `decode_wechat.py --serve` reads 4-byte length-prefixed PNGs on stdin and writes one JSON line `{ "texts": [...], "ms": n }` per frame.
  - Decisions (adds to contracts): `qr.decoder` (`zxing`, `wechat` or `both`), `qr.minSizePct`, `qr.p95Ms`, read by plan 01a's task for `packages/worker/src/qr/qr.ts` (`decodeQr(png: Buffer, region: Rect | null): Promise<string[]>`).

Budget behind the thresholds: the 2-minute submission target splits into detection within 10 seconds (two consecutive 2-second frames plus decoding), link resolution and trust within 10 seconds (the 5-second redirect cap plus margin), and opening, filling and submitting within 60 seconds (Task 4), leaving 40 seconds of slack.

| Check            | Threshold                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 No wrong text | 0 decodes whose text differs from an encoded URL; 0 decodes on blank control slides                                                                   |
| Q2 Accept time   | every code of 8% of slide height or more is accepted (decoded in 2 consecutive frames) within 10 seconds of its slide appearing                       |
| Q3 Frame rate    | per-frame decode rate of 90% or more for codes of 12% or more                                                                                         |
| Q4 Cost          | pipeline time per frame at p95 of 1,500 ms or less on one vCPU, so the 2-second loop never falls behind                                               |
| Q5 Bridge        | for `wechat` or `both` only: the Node to Python round trip adds 100 ms or less at p95 beyond decoding, and the Python process starts within 5 seconds |

Pipelines scored: `zxing` (full, then region if nothing was found), `wechat` (full, then region), and `both` (zxing full, zxing region, WeChat full, WeChat region, stopping at the first hit). Decision: the first of `zxing`, `wechat`, `both` that passes Q1 to Q5. `qr.minSizePct` is the smallest size at which the chosen pipeline passes Q2. If none passes Q2 at 8%, choose the pipeline with the smallest passing size and say so in the report.

- [ ] **Step 1: Make the test deck**

`deck-plan.csv` (`slide,urlKind,sizePct,position,url`) lists 18 slides: three URL kinds with random IDs of each provider's real length (`https://forms.office.com/r/<10 characters>`, `https://docs.google.com/forms/d/e/<56 characters>/viewform?usp=sf_link`, `https://forms.gle/<17 characters>`) at 5, 8 and 12% of slide height in the bottom-right corner and at 20 and 35% in the centre; one slide with two 12% codes; and two blank control slides. `make-deck.sh` runs `qrencode -l M -m 4 -s 20 -o <slide>.png '<url>'` for each code; place the images on 16:9 slides in Google Slides or PowerPoint at the planned sizes. Expected: 18 slides, and `zbarimg` decodes each source PNG to its URL.

- [ ] **Step 2: Build the QR image**

Run on the server: `docker build --build-arg BASE=tm-spike-worker:$CHROME_VERSION -t tm-spike-qr:$CHROME_VERSION /srv/spikes/repo/spikes/03-qr`

Expected: `docker run --rm --entrypoint /opt/qr/bin/python tm-spike-qr:$CHROME_VERSION -c "import cv2; print(cv2.__version__, hasattr(cv2, 'wechat_qrcode_WeChatQRCode'))"` prints the pinned version and `True`.

- [ ] **Step 3: Capture frames from a real share**

A test account hosts a Zoom meeting and shares the deck, 60 seconds per slide, writing each slide's start time to `slide-starts.csv`. `lab-uni` attends through `joinMeeting` with the chat panel open, and a stage frame is saved every 2 seconds:

```bash
docker exec tm-lab-uni ffmpeg -loglevel error -f x11grab -framerate 0.5 -video_size 1920x1080 -i :99.0+0,0 -strftime 1 /data/private/frames/%H%M%S.png
```

Repeat on one more platform that passed Task 2. Expected: about 540 frames per run.

- [ ] **Step 4: Decode and score**

```bash
R=/srv/spikes/repo/spikes; D=/srv/spikes/data/03; I=tm-spike-qr:$CHROME_VERSION
docker run --rm --cpuset-cpus 3 -v $D:/data -v $R:/spikes:ro --entrypoint node $I /spikes/03-qr/decode-zxing.mjs --frames /data/private/frames --rect <x,y,w,h> --out /data/results/decodes.csv
docker run --rm --cpuset-cpus 3 -v $D:/data -v $R:/spikes:ro --entrypoint /opt/qr/bin/python $I /spikes/03-qr/decode_wechat.py --frames /data/private/frames --rect <x,y,w,h> --out /data/results/decodes.csv
docker run --rm --cpuset-cpus 3 -v $R:/spikes:ro --entrypoint node $I /spikes/03-qr/bridge-check.mjs
bun $R/03-qr/score.ts --decodes $D/results/decodes.csv --plan $R/03-qr/deck-plan.csv --slide-starts $D/results/slide-starts.csv --out $D/results/summary.json
```

`score.ts` maps each frame to its slide by time, then reports per pipeline and size the per-frame decode rate, wrong decodes, time to acceptance, and p50 and p95 milliseconds per frame. Expected: `summary.json` holds Q1 to Q5 per pipeline and the chosen `qr.decoder`.

- [ ] **Step 5: Keep samples, write the report and apply the outcome's edits**

Copy at most 20 representative frames (test slides only, no participant tiles) to `spikes/03-qr/samples/`, run `sync.sh pull 03-qr`, and write `REPORT.md` with the Q table per pipeline, the size curve and the decisions. Apply the spike 3 rows of Task 9's outcome table.

- [ ] **Step 6: Commit**

```bash
git add spikes/03-qr docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report QR decoding"
```

Expected: the check prints nothing (sample frames under `samples/` are allowed); the commit succeeds.

### Task 4: Spike 4, forms

**Files:**

- Create: `spikes/04-forms/details.json`, `spikes/04-forms/form-spec.json`
- Create: `spikes/04-forms/fill-form.mjs`, `spikes/04-forms/unwrap.mjs`, `spikes/04-forms/trust-check.mjs`, `spikes/04-forms/match-labels.ts`
- Create: `spikes/04-forms/form-markers.json`
- Create: `spikes/04-forms/data/runs.csv`, `spikes/04-forms/data/match-latency.csv`
- Create: `spikes/04-forms/REPORT.md`

**Interfaces:**

- Consumes: `lab-uni` and `join.mjs` (Task 2); `run-worker.sh` and `openDeskTab` (Task 0).
- Produces:
  - `fill-form.mjs --url <form> --details /spikes/04-forms/details.json --run <label>` opens the form in a desk tab and, page by page, reads every question (`label`, `type`, `options`, `required`), fills exact label-variant matches, ticks attendance confirmations, and presses Next until Submit. It submits only when every required question is filled. It writes `/data/results/form-<label>.json` as `{ pages: [{ questions, filled }], decision, question, timings: { openMs, decideMs, confirmMs } }`, with `decision` one of the `FormState` names `submitted`, `needs_member`, `already_answered`, `quiz`, `awaiting_signin`, and page-only screenshots in `/data/private/forms/`.
  - `unwrap.mjs <url>` prints `{ finalUrl, hops, ms, cookieSent }`: it unwraps `*.safelinks.protection.outlook.com/?url=` and `www.google.com/url?q=`, then follows up to 5 redirects with `fetch(url, { redirect: 'manual' })`, sending no cookies, within 5 seconds in total.
  - `form-markers.json`, per provider: question container, title, required marker, option roles, Next, Back and Submit texts (English and Malay), confirmation marker, already-answered marker, quiz marker, organisation-restriction marker, sign-in hosts and the "send me a copy" control. Plan 01b seeds its provider modules and its fixtures in `packages/worker/test/fixtures/` from it.
  - Decisions (adds to contracts): `forms.markersFile`, `forms.matchModel`, `forms.matchP95Ms`, `forms.fillP95Ms`, `forms.orgRestrictedStepUp` (`yes` or `no`).

Fill rule for attendance confirmations, which the test forms probe on purpose: an option counts only if its normalised text equals an allowlisted phrase (`present`, `hadir`, `i confirm i am attending this class`) or starts with `i confirm`, and never if it contains a negation (`tidak`, `tak`, `not`, `absent`). "Tidak hadir" contains "hadir", so a substring rule would tick the wrong option.

Test forms, built by the member in their university account (one per provider the university uses; the other provider on the work tenant, with the difference noted), restricted to the organisation and limited to one response per person:

- **Form A**, two pages. Page 1: "Full name" (short text, required); "No. Matrik / Student ID" (short text, required); "Section" (radio `1`, `2`, `3`, required); "I confirm I am attending this class" (checkbox, required). Page 2: "Programme" (dropdown `MSc Test`, `MSc Other`, `PhD Test`, required); "Kehadiran" (radio `Hadir`, `Tidak hadir`, required); "Topics you found useful" (checkbox `A`, `B`, `C`, optional); "What did you learn today?" (paragraph, required).
- **Form B**: form A without the paragraph question.
- **Form Q**: form B in quiz mode, with points.

`details.json` holds placeholder values only (`full_name` "Test Student", `student_id` "A00000000", `programme` "MSc Test", `section` "2"), with the label variants the forms use. `form-spec.json` holds each form's questions and the expected action for each.

| Check               | Threshold                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 Read             | every question's label, type, options and required flag match `form-spec.json`, on both pages, for each provider                                                                                                                                                    |
| F2 Fill             | every matchable question gets its saved value; "I confirm I am attending this class" ticked; "Hadir" chosen and "Tidak hadir" never; "Topics you found useful" left blank; "send me a copy" unticked                                                                |
| F3 Refuse           | form A ends `needs_member` naming "What did you learn today?", the owner's response count is unchanged, and `decideMs` is 20,000 or less (the 30-second fallback budget minus 10 seconds of detection)                                                              |
| F4 Submit           | form B ends `submitted` on the confirmation page with `confirmMs` of 60,000 or less, and the screenshots show the page only, with no browser toolbar                                                                                                                |
| F5 Already answered | reopening form B ends `already_answered` within 10 seconds                                                                                                                                                                                                          |
| F6 No session       | form B ends `awaiting_signin`, naming the sign-in host, within 10 seconds, with no keystroke sent, both in a fresh identity `lab-blank` with no sign-in and in `lab-uni` after the member signed out of the form provider                                           |
| F7 Links            | Safe Links and `google.com/url` links unwrap to the exact form URL; `forms.gle` resolves in 5 hops or fewer within 5 seconds with `cookieSent=false`                                                                                                                |
| F8 Model            | 20 batched label-matching calls to the form-matching model (`qwen-flash`, or the cheapest current flash model) with thinking off: p95 of 5,000 ms or less, and 20 of 20 replies valid JSON                                                                          |
| F9 Quiz             | form Q ends `quiz` before anything is filled                                                                                                                                                                                                                        |
| F10 Trust           | a link posted by a non-host test participant is untrusted and the same link from the host is trusted, by `trust-check.mjs` over `join.mjs` chat events; where `senderRole` is `null`, the report says trust must fall back to trusted sender names on that platform |

F1 to F5 and F9 run 3 times per provider; timings use the p95 of those runs.

- [ ] **Step 1: Build the forms and the spec files**

The member builds forms A, B and Q per provider and shares their URLs with the builder, who writes `form-spec.json` and `details.json`. Expected: each form opens in `lab-uni` (signed in), and its settings show the organisation restriction.

- [ ] **Step 2: Run the fill script against forms A, B and Q**

For each provider run `fill-form.mjs` on form A, form B, form Q and form B again (the already-answered check), each in its own container:

```bash
bash /srv/spikes/repo/spikes/00-setup/run-worker.sh --name tm-lab-uni --identity lab-uni --data 04 -- /spikes/04-forms/fill-form.mjs --url '<form-url>' --details /spikes/04-forms/details.json --run <provider>-<form>-<round>
docker wait tm-lab-uni
```

Do three rounds per provider, clearing form B's responses between rounds. Expected: decisions `needs_member`, `submitted`, `quiz` and `already_answered`, and F1 to F5 and F9 hold.

- [ ] **Step 3: Check the missing-session case**

Create identity `lab-blank` with no sign-in and run `fill-form.mjs` on form B. Then the member signs out of the form provider in `lab-uni` through the desk view (the closest stand-in for an expired session), `fill-form.mjs` runs on form B again, and the member signs back in. Expected: F6 in both runs.

- [ ] **Step 4: Check link unwrapping and trust**

The member mails form B's link from another account to their Safe Links-protected mailbox and copies the wrapped link target; the builder also makes a `forms.gle` short link and a `https://www.google.com/url?q=<form-url>` link. Run `bun /srv/spikes/repo/spikes/04-forms/unwrap.mjs '<link>'` for each. Then, in a Zoom test meeting, the host and a second, non-host test participant each post form B's link while `join.mjs` reads chat, and run `bun /srv/spikes/repo/spikes/04-forms/trust-check.mjs /srv/spikes/data/04/results/join-trust.jsonl`. Expected: F7 and F10.

- [ ] **Step 5: Measure label matching**

`match-labels.ts` sends form A's labels and options (each cut to 120 characters, never the description) in one call to the OpenAI-compatible endpoint with `enable_thinking: false`, asking for `{ "matches": [{ "question": number, "detail": string | null, "confidence": "high" | "low" }] }`, 20 times. Run: `( set -a; . /srv/spikes/secrets/dashscope.env; bun /srv/spikes/repo/spikes/04-forms/match-labels.ts --model qwen-flash --runs 20 --out /srv/spikes/data/04/results/match-latency.csv )`. Expected: F8.

- [ ] **Step 6: Record, write the report and apply the outcome's edits**

Run `sync.sh pull 04-forms`, write `data/runs.csv` (`run,provider,form,decision,openMs,decideMs,confirmMs,f1,f2`), fill `form-markers.json` from the runs, and write `REPORT.md` with the F table and the decisions. Apply the spike 4 rows of Task 9's outcome table.

- [ ] **Step 7: Commit**

```bash
git add spikes/04-forms docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report form handling"
```

Expected: the check prints nothing; the commit succeeds.

### Task 5: Spike 5, speech recognition

**Files:**

- Create: `spikes/05-asr/stream.ts`
- Create: `spikes/05-asr/score.ts`
- Create: `spikes/05-asr/data/scores.csv`, `spikes/05-asr/data/candidates.csv`
- Create: `spikes/05-asr/REPORT.md`

**Interfaces:**

- Consumes: the server and `/srv/spikes/secrets/` (Task 0). No browser.
- Produces:
  - `stream.ts --model <id> --url <wss-url> --pcm <16 kHz mono s16le file> --out <dir> [--reconnect-at-sec <s>] [--loop-minutes <m>]` paces audio in 100 ms chunks at real time, logs every server event raw to `<dir>/events.jsonl` with `recvMs` (since stream start) and `sentMs` (audio sent so far), and writes `<dir>/results.jsonl` lines `{ startMs, endMs, text, latencyMs }`, the shape of `transcript/live.jsonl` in the architecture plus latency.
  - `score.ts --ref <reference.jsonl> --hyp <results.jsonl> --out <score.json>` reports WER, marked-phrase recall, timestamp error, latency and duplicates.
  - Decisions (adds to contracts): `asr.liveModel`, `asr.url` (the URL form that accepts a plain key), `asr.timestamps` (`stream_offset` or `native`), `asr.vocabulary` (`none` or the request field name), `asr.sessionCapMinutes`, `asr.eventNames` (the event types that carry partial text, final text, speech start and speech stop). Plan 01a's tasks for `openAsrStream` in `packages/ai` and for `packages/worker/src/asr/live.ts` read them.

Rules `stream.ts` and `score.ts` follow, which the signatures don't fix:

- **Stream offsets**: a result's `startMs` and `endMs` come from the speech-start and speech-stop events' own audio offsets if the server sends them, else from `sentMs` when those events arrive; the report says which.
- **Reconnection**: at the first stretch of 700 ms below -45 dBFS after `--reconnect-at-sec`, open a new session, replay the last 5 seconds of audio into it, and close the old session after its final result. Offsets keep counting from the original stream start. Duplicates are removed by dropping the longest run of normalised words at the start of the new session's first result that equals the end of the previous result (at most 15 words).
- **Normalising**: NFKC, lower case, punctuation removed except inside numbers and times (`10:30`, `1.5`), whitespace collapsed. WER is word-level edit distance over reference words.
- **Marked phrases**: dates, times and numbers in the reference are wrapped `{{...}}`; one counts as recalled when its normalised text appears in a result within 30 seconds of the reference sentence.
- **Timestamp error**: each reference sentence is matched to the result whose first seven normalised words best match within 90 seconds (the session's `check_ts.py` rule); the error is the difference of start times.

| Check           | Threshold                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Accuracy     | WER of 25% or less over the 15-minute English and Malay clip (whisper `medium` on the same clip is recorded for comparison)                                       |
| A2 Deadlines    | 90% or more of marked dates, times and numbers recalled, because every announced deadline must reach the summary                                                  |
| A3 Timestamps   | median start error of 1.0 second or less and p95 of 3.0 seconds or less                                                                                           |
| A4 Latency      | final result within 5 seconds of the end of its speech at p95, so a name-mention ping arrives while the question is still open                                    |
| A5 Reconnection | across the forced reconnection, no reference word within 30 seconds of the switch is lost, 2 or fewer duplicate words remain, and offsets continue without a jump |
| A6 Silence      | 60 seconds of silence produce no result, or only results the design's drop rule removes ("you", "Thank you for watching")                                         |
| A7 Session cap  | the server's session limit measured in minutes, with its close code or error event                                                                                |

Replacement rule: a candidate replaces `qwen3-asr-flash-realtime` only if it runs in the Singapore region, supports English and Malay, returns native timestamps and accepts vocabulary, scores a WER no more than 2 points worse and an A2 recall no worse, passes A3 to A6, and costs no more than twice the current model per hour (about US$0.65).

- [ ] **Step 1: Prepare the recording and reference**

Get a 15-minute recording of a Malaysian lecture mixing English and Malay, used with the lecturer's permission or under a licence that allows it. The member, who understands both languages, corrects a whisper `medium` transcript into `reference.jsonl` (`{ startMs, text }` per sentence, with `{{...}}` marks). All of it stays in `/srv/spikes/data/05/private/`. Convert: `ffmpeg -i <recording> -ss <start> -t 900 -ac 1 -ar 16000 -f s16le /srv/spikes/data/05/private/lecture.pcm`, and make `silence.pcm` with `-f lavfi -i anullsrc=r=16000:cl=mono -t 60`. Run whisper `medium` on the member's PC (`uv run transcriber lecture.flac -m medium -f json`) and convert its segments to `results.jsonl` form as the baseline.

- [ ] **Step 2: Set up a spike key**

Create a dedicated DashScope key in the Singapore region for the spikes and store it as `DASHSCOPE_API_KEY=...` in `/srv/spikes/secrets/dashscope.env` (mode 600). It is deleted in Task 9.

- [ ] **Step 3: Stream the clip through the current model**

```bash
( set -a; . /srv/spikes/secrets/dashscope.env; cd /srv/spikes/repo/spikes/05-asr
  bun stream.ts --model qwen3-asr-flash-realtime --url 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime' --pcm /srv/spikes/data/05/private/lecture.pcm --out /srv/spikes/data/05/private/base
  bun stream.ts --model qwen3-asr-flash-realtime --url '<same url>' --pcm /srv/spikes/data/05/private/lecture.pcm --reconnect-at-sec 420 --out /srv/spikes/data/05/private/reconnect
  bun stream.ts --model qwen3-asr-flash-realtime --url '<same url>' --pcm /srv/spikes/data/05/private/silence.pcm --out /srv/spikes/data/05/private/silence )
```

If the plain URL rejects the key, try the workspace form `wss://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime` and record which works. Expected: three result files; the session settings sent (language, voice-activity detection) are copied into the report.

- [ ] **Step 4: Measure the session cap**

Run `stream.ts` once with `--loop-minutes 125` (the clip looped with 1-second gaps; about US$0.68 at the listed price). Expected: `events.jsonl` shows when and how the server ended the session, or that it didn't within 125 minutes.

- [ ] **Step 5: Look for a better streaming model**

From Alibaba Model Studio's real-time speech recognition pages for the Singapore region, list every streaming model, including the reviewer's unverified names (`fun-asr-realtime`, `qwen-audio-3.1-asr-flash-streaming`, `paraformer-realtime-v2`), in `data/candidates.csv`: `model,singapore,english,malay,nativeTimestamps,vocabularyField,sessionCapMin,usdPerHour,sourceUrl,checkedOn`. For each candidate available in Singapore with English and Malay, add its protocol to `stream.ts` and repeat steps 3 and 4, passing the vocabulary field with the clip's course names and key terms. Expected: the table is complete, and each eligible candidate has result files.

- [ ] **Step 6: Score and compare**

Run `bun /srv/spikes/repo/spikes/05-asr/score.ts --ref /srv/spikes/data/05/private/reference.jsonl --hyp <run>/results.jsonl --out <run>/score.json` for every run, including the whisper baseline, and copy the numbers into `data/scores.csv` (`run,model,wer,markedRecall,tsMedianS,tsP95S,latencyP95S,silenceResults,reconnectLost,reconnectDupes,sessionCapMin`). Expected: A1 to A7 filled per model, and a decision by the replacement rule.

- [ ] **Step 7: Write the report and apply the outcome's edits**

`spikes/05-asr/REPORT.md` from the template, with the event names and an example of each event's JSON shape (text replaced by `<text>`), the scores, the candidates and the decisions. No transcript text from the lecture goes into the repository. Apply the spike 5 rows of Task 9's outcome table.

- [ ] **Step 8: Commit**

```bash
git add spikes/05-asr docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report speech recognition"
```

Expected: the check prints nothing; the commit succeeds.

### Task 6: Spike 6, resources

Run after Task 7, because it reuses Task 7's `persist` identity, which has WhatsApp, Discord and Microsoft signed in.

**Files:**

- Create: `spikes/06-resources/load.mjs`
- Create: `spikes/06-resources/sample.sh`
- Create: `spikes/06-resources/summarise.ts`
- Create: `spikes/06-resources/data/summary.json`, `spikes/06-resources/data/samples.csv`
- Create: `spikes/06-resources/REPORT.md`

**Interfaces:**

- Consumes: `joinMeeting` (Task 2); image `tm-spike-qr` and the chosen `qr.decoder` (Task 3); the `persist` identity (Task 7); `lab-uni` (Task 2); `run-worker.sh --image` (Task 0).
- Produces:
  - `load.mjs --platform <p> --url <link> --minutes <n> --preset <ultrafast|veryfast> --decoder <zxing|wechat|both> --desk-url <url> ...` runs a full worker load: joins on the stage, opens the desk URLs as tabs, records with the command below, saves a stage frame every 2 seconds and decodes it with the chosen pipeline, taps `tm_sink.monitor` at 16 kHz mono (as live transcription would), and reads chat every 5 seconds.
  - Decisions (adds to contracts): `worker.concurrencyCap` (1, 2 or 3), `worker.cpuLimit` (vCPUs), `worker.memoryLimitGb`, `recording.preset`, `disk.gbPerMeetingHour`, `local.dockerMemoryGb`. Plan 01c's scheduler and container launcher, plan 01a's recorder (`packages/worker/src/recorder/recorder.ts`) and plans 03 and 08 (Docker Desktop memory check) read them.

Recording command under test (the design's settings: x11grab of the stage, the sink, 5-minute Matroska segments, 1920x1080 at 15 frames per second, H.264, AAC, wall-clock timestamps):

```bash
ffmpeg -hide_banner -loglevel warning -progress /data/private/ffmpeg-progress.txt \
  -thread_queue_size 1024 -use_wallclock_as_timestamps 1 -f x11grab -framerate 15 -video_size 1920x1080 -i :99.0+0,0 \
  -thread_queue_size 1024 -use_wallclock_as_timestamps 1 -f pulse -i tm_sink.monitor \
  -c:v libx264 -preset "$PRESET" -pix_fmt yuv420p -c:a aac -b:a 96k -af aresample=async=1 \
  -f segment -segment_time 300 -segment_format matroska -reset_timestamps 1 /data/private/recording/attempt_1_seg_%03d.mkv
```

Derivation of the thresholds: the server also runs Caddy, the website, Postgres, ntfy, the scheduler and the pipeline, for which this spike reserves 1.5 vCPUs and 3 GB (an assumption plan 01c checks), leaving 6.5 vCPUs and 13 GB for workers. Disk: 200 GB less 50 GB for the system, images, Postgres and profiles leaves 150 GB for 30 days of meetings; at an assumed 5 members, 4 sessions a week each, 2 hours each (about 172 meeting-hours in 30 days) that allows 0.87 GB per meeting-hour.

| Check               | Threshold                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Single worker    | over 2 hours, p95 CPU of 3.25 vCPUs or less and peak memory (cgroup `memory.peak`) of 6.5 GB or less, which allows 2 workers                              |
| R2 Recording health | ffmpeg `speed` of 1.0x or more in every progress sample, dropped frames 1% or fewer, `OOMKilled` false, every segment playable (`ffprobe` exits 0)        |
| R3 Two at once      | two workers in two meetings for 60 minutes: R2 holds for both, the host's 1-minute load average stays at 7.0 or less and available memory at 3 GB or more |
| R4 Disk             | recording, frames, chat and logs grow by 0.87 GB per meeting-hour or less                                                                                 |
| R5 Shared memory    | `/dev/shm` use peaks at 1.5 GB or less (75% of `--shm-size=2g`)                                                                                           |

Cap rule: `worker.concurrencyCap` is the largest N of 1, 2 or 3 with N times the p95 CPU at 6.5 or less and N times the peak memory at 13 GB or less, and, for N of 2 or more, an N-worker run that passed R3. `worker.cpuLimit` is the p95 CPU rounded up to the next half vCPU; `worker.memoryLimitGb` is the peak memory times 1.25, rounded up to the next whole GB; `local.dockerMemoryGb` is the peak memory rounded up to the next whole GB.

- [ ] **Step 1: Prepare the meetings**

Host 2-hour test meetings that stay up without a time limit (a Google Meet one-to-one call from a free account, or a university-licensed Zoom meeting). The host shares a looping lecture video with sound at 1080p and posts a chat message every 5 minutes. `persist`'s desk opens WhatsApp Web, Discord and Teams chat (with whichever Microsoft account it holds).

- [ ] **Step 2: Choose the preset**

Start `load.mjs` in `persist` for 15 minutes with `--preset ultrafast`, then 15 minutes with `--preset veryfast`, sampling throughout:

```bash
bash /srv/spikes/repo/spikes/00-setup/run-worker.sh --name tm-persist --identity persist --data 06 --image tm-spike-qr:$CHROME_VERSION -- /spikes/06-resources/load.mjs --platform meet --url '<meet-link>' --minutes 15 --preset ultrafast --decoder <qr.decoder> --desk-url https://web.whatsapp.com/ --desk-url https://discord.com/channels/@me --desk-url https://teams.microsoft.com/v2/
bash /srv/spikes/repo/spikes/06-resources/sample.sh /srv/spikes/data/06/results/preset-ultrafast tm-persist
```

`sample.sh <outdir> <container>...` appends, every 10 seconds until the containers stop, `docker stats --no-stream --format '{{json .}}'`, each container's cgroup `memory.peak`, `df -B1 /dev/shm` inside it, `du -sb /srv/spikes/data/06`, `/proc/loadavg` and `free -b`. Expected: two sample sets. Choose `veryfast` if its p95 CPU passes R1 and its R2 holds, else `ultrafast`.

- [ ] **Step 3: Run the 2-hour single worker**

Run step 2's commands with `--minutes 120` and the chosen preset, then `bun /srv/spikes/repo/spikes/06-resources/summarise.ts --samples /srv/spikes/data/06/results/single --progress /srv/spikes/data/06/private/ffmpeg-progress.txt --out /srv/spikes/data/06/results/single.json` and `docker inspect -f '{{.State.OOMKilled}}' tm-persist`. Expected: R1, R2, R4 and R5 filled.

- [ ] **Step 4: Run two workers at once**

Run `persist` and `lab-uni` in two separate meetings for 60 minutes, sampling both with one `sample.sh` call. If 3 times the single worker's p95 CPU is 6.5 or less and 3 times its peak memory is 13 GB or less, also run three workers (adding `lab-work`) for 30 minutes. Expected: R3 per run.

- [ ] **Step 5: Record and compare**

Run `sync.sh pull 06-resources`, keep `data/samples.csv` (`at,container,cpuVcpu,memGb,shmGb,diskGb,load1,availGb`) and `data/summary.json`, and apply the cap rule.

- [ ] **Step 6: Write the report and apply the outcome's edits**

`spikes/06-resources/REPORT.md` from the template, with per-run tables, the reserve assumption, the preset comparison and the decisions. Apply the spike 6 rows of Task 9's outcome table.

- [ ] **Step 7: Commit**

```bash
git add spikes/06-resources docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report worker resources"
```

Expected: the check prints nothing; the commit succeeds.

### Task 7: Spike 7, profile persistence

**Files:**

- Create: `spikes/07-profile/checkpoint.ts`, `spikes/07-profile/restore.ts`
- Create: `spikes/07-profile/wa-read.mjs`
- Create: `spikes/07-profile/cycle.sh`
- Create: `spikes/07-profile/data/cycles.csv`, `spikes/07-profile/data/checkpoints.csv`
- Create: `spikes/07-profile/REPORT.md`

**Interfaces:**

- Consumes: `run-worker.sh`, `new-identity.sh`, `hold.mjs` (Task 0); `check-sessions.mjs` (Task 1); `ts-home.sh` (Task 1) for the home repeat.
- Produces:
  - Identity `persist`, signed in to Google, Microsoft (university), Zoom, Discord and WhatsApp Web; Task 6 reuses it.
  - `checkpoint.ts --dir <work> --out <checkpoints dir> --identity <id> --master-key-file <file>` writes `<ISO time>.tar.enc` and prints `{ bytes, ms }`. It tars the working copy without `Cache`, `Code Cache`, `GPUCache`, `Service Worker/CacheStorage` and `Crashpad`, and encrypts it with AES-256-GCM under a key derived with HKDF-SHA256 from the master key with info `tm-profile:<id>`; the file is the bytes `TMP1`, a 12-byte IV, the ciphertext and the 16-byte tag. This is the spike's format; plan 01a owns the production one (`checkpointProfile` in `packages/worker/src/profile/profile.ts`).
  - `restore.ts --from <file> --to <dir> --identity <id> --master-key-file <file>` reverses it into an empty directory, removes the three `Singleton*` files and prints `{ ms }`.
  - `wa-read.mjs --chat '<test group name>'` reads the test group's last 40 messages in a desk tab and writes `{ seen: ["w01", ...], waiting: n }`, where `waiting` counts "Waiting for this message" placeholders.
  - Decisions (adds to contracts): `profile.survivesRestore` (`yes` or `no`), `profile.restartSource` (`checkpoint` or `working_copy`), `watchers.whatsappFromServer` (`allowed`, `home_only` or `none`), `watchers.discordFromServer` (`allowed` or `home_only`), `profile.checkpointSeconds`, `profile.restoreSeconds`.

| Check                | Threshold                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Sessions          | `google`, `microsoft`, `zoom` and `discord` are `signed_in` at the start and end of containers B and C, with no member action                                                         |
| P2 WhatsApp linked   | `whatsapp` is `signed_in` in A, B and C; the device is still in the phone's Linked devices; no logged-out notice                                                                      |
| P3 WhatsApp messages | every message sent after B started (`w14` to `w20`) and after C started (`w21` to `w30`) is readable; unreadable crash-gap messages (`w11` to `w13`) are counted, not failed          |
| P4 No warnings       | no warning, ban notice or verification demand from WhatsApp or Discord, in the app, by email or on the phone                                                                          |
| P5 No passwords      | `Login Data` holds 0 logins                                                                                                                                                           |
| P6 Timing            | a checkpoint takes 30 seconds or less, so the 5-minute cadence holds; restore plus launch until every check is `signed_in` takes 60 seconds or less, within the 2-minute crash rejoin |
| P7 Integrity         | `PRAGMA integrity_check` on the restored `Default/Cookies` prints `ok`                                                                                                                |

Decisions: `profile.survivesRestore=yes` if P1, P6 and P7 hold. `watchers.whatsappFromServer=allowed` if P2 to P4 hold for WhatsApp from the server; else `home_only` if the home repeat (step 6) passes them; else `none`. `watchers.discordFromServer=allowed` if P1 and P4 hold for Discord, else `home_only`.

- [ ] **Step 1: Check the linked-device count**

The member opens WhatsApp on their phone, Linked devices, and counts them (the number only). With 4 already linked, they unlink one they don't need or this task skips WhatsApp. Expected: at most 3 linked before the spike.

- [ ] **Step 2: Create `persist` and sign in**

Create the identity and a spike master key (`openssl rand -base64 32 > /srv/spikes/secrets/master.key; chmod 600 /srv/spikes/secrets/master.key`). Start `hold.mjs` with desk tabs for each sign-in page; the member signs in to Google, Microsoft, Zoom and Discord, and links WhatsApp by scanning its code. The builder creates a WhatsApp test group with the member and a second phone (a test number), named `<test group name>`. Expected: `check-sessions.mjs --checks google,microsoft,zoom,discord,whatsapp` prints `signed_in` five times.

- [ ] **Step 3: Container A, then a forced crash**

`cycle.sh A` starts `persist` with `hold.mjs` (desk tabs WhatsApp and Discord) and a checkpoint loop on the server:

```bash
while [ "$(docker inspect -f '{{.State.Running}}' tm-persist)" = true ]; do
  bun /srv/spikes/repo/spikes/07-profile/checkpoint.ts --dir /srv/spikes/profiles/persist/work --out /srv/spikes/profiles/persist/checkpoints --identity persist --master-key-file /srv/spikes/secrets/master.key >> /srv/spikes/data/07/results/checkpoints.jsonl
  sleep 300
done
```

The second phone sends `w01` to `w10` over 40 minutes. At about 45 minutes, 2 minutes after a checkpoint, it sends `w11` to `w13`, and `cycle.sh` runs `docker kill --signal KILL tm-persist`. Expected: at least 9 checkpoints and a killed container.

- [ ] **Step 4: Container B from the latest checkpoint**

`cycle.sh B` moves the crashed working copy to `work-crashed`, restores the latest checkpoint into a fresh `work` with `restore.ts`, starts `persist` again, and times restore plus launch until `check-sessions.mjs` reports every check `signed_in`. It runs `wa-read.mjs`, `sqlite3 /profile/Default/Cookies 'PRAGMA integrity_check'` and the `Login Data` count; the second phone sends `w14` to `w20`; after 1 hour `docker stop -t 30` and a final checkpoint. If P1 or P2 fails here, the member signs in or relinks again, the crash is repeated, and B' starts from the crashed working copy instead (after removing the `Singleton*` files); record which source passed as `profile.restartSource`. Expected: P1 to P7 hold for B.

- [ ] **Step 5: Container C after 24 hours**

At 24 hours after step 2, `cycle.sh C` restores B's final checkpoint into a fresh directory, starts `persist`, runs the same checks, and the second phone sends `w21` to `w30`. Expected: P1 to P7 hold for C. The member also checks their WhatsApp and Discord notifications and email for warnings (P4).

- [ ] **Step 6: Repeat WhatsApp through home if it failed**

Only if P2, P3 or P4 failed for WhatsApp: create `persist-home`, start it behind `ts-home.sh` (Task 1), link WhatsApp, and repeat steps 3 and 4 for WhatsApp only. Expected: a pass sets `home_only`; a fail sets `none`.

- [ ] **Step 7: Record, write the report and apply the outcome's edits**

Run `sync.sh pull 07-profile`, write `data/cycles.csv` (`container,source,check,state,at`) and `data/checkpoints.csv` (`at,bytes,ms`), and write `REPORT.md` with the P table, the crash-gap count and the decisions. Apply the spike 7 rows of Task 9's outcome table.

- [ ] **Step 8: Commit**

```bash
git add spikes/07-profile docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report profile persistence"
```

Expected: the check prints nothing; the commit succeeds.

### Task 8: Spike 8, ntfy attachments

**Files:**

- Create: `spikes/08-ntfy/compose.yaml`
- Create: `spikes/08-ntfy/server.yml`
- Create: `spikes/08-ntfy/Caddyfile`
- Create: `spikes/08-ntfy/check.sh`
- Create: `spikes/08-ntfy/data/ntfy.json`
- Create: `spikes/08-ntfy/REPORT.md`

**Interfaces:**

- Consumes: the server and `/srv/spikes/secrets/` (Task 0).
- Produces:
  - `check.sh` publishes a Markdown file as an attachment to member 1's topic and writes `/srv/spikes/data/08/results/ntfy.json` with N1 to N3's status codes, the attachment's `expires` and the publish time.
  - The proven `server.yml` keys, read by plan 01c's Compose task for ntfy.
  - Decisions (adds to contracts): `ntfy.attachSummary` (`true` or `false`), `ntfy.version`. Plan 01a's summary ping (`sendPing` with or without `attachPath`), plan 01c's ntfy configuration and plan 03's summary download read them.

`compose.yaml` runs `binwiederhier/ntfy:<pinned tag>` (command `serve`, `server.yml` mounted at `/etc/ntfy/server.yml`, a volume at `/var/lib/ntfy`, published on `127.0.0.1:8090:80`) and, under the Compose profile `phone`, `caddy:<pinned tag>` on ports 80 and 443 with the Caddyfile `<ntfy-host> { reverse_proxy ntfy:80 }`. `server.yml`:

```yaml
base-url: "http://127.0.0.1:8090"
listen-http: ":80"
behind-proxy: true
cache-file: "/var/lib/ntfy/cache.db"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"
attachment-cache-dir: "/var/lib/ntfy/attachments"
attachment-total-size-limit: "1G"
attachment-file-size-limit: "5M"
attachment-expiry-duration: "3h"
```

| Check                       | Threshold                                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 No anonymous download    | `GET` of the attachment URL with no credentials returns 401 or 403                                                                                                                            |
| N2 No cross-member download | the same `GET` with member 2's token returns 403, while member 1's token returns 200 with identical bytes                                                                                     |
| N3 Expiry                   | `attachment.expires` minus the publish time is 10,800 seconds or less, and 3 hours 5 minutes after publishing member 1's token gets 404 and the file is gone from `/var/lib/ntfy/attachments` |
| N4 Phone                    | the official ntfy Android app (and the iOS app if a member uses an iPhone), subscribed with member 1's credentials, shows and downloads the attachment                                        |

`ntfy.attachSummary=true` only if N1 to N4 all pass; N2 is required because anything less would let one member's summary reach another (anti-goal 6).

- [ ] **Step 1: Start ntfy and create two members**

```bash
cd /srv/spikes/repo/spikes/08-ntfy && docker compose up -d ntfy
( set -a; . /srv/spikes/secrets/ntfy-pw.env
  docker compose exec -e NTFY_PASSWORD ntfy ntfy user add member1
  docker compose exec -e NTFY_PASSWORD ntfy ntfy user add member2 )
docker compose exec ntfy ntfy access member1 tm-spike-member1 rw
docker compose exec ntfy ntfy access member2 tm-spike-member2 rw
docker compose exec ntfy ntfy token add member1
docker compose exec ntfy ntfy token add member2
```

`ntfy-pw.env` holds a random `NTFY_PASSWORD`; copy the two tokens into `/srv/spikes/secrets/ntfy.env` as `NTFY_TOKEN_1` and `NTFY_TOKEN_2` without echoing them elsewhere. Expected: `docker compose exec ntfy ntfy user list` shows both users with access to their own topic only.

- [ ] **Step 2: Run the access and expiry checks**

`check.sh` reads the tokens inside a subshell, publishes `printf '# Test summary\n' > /tmp/summary.md` with `curl -s -H "Authorization: Bearer $NTFY_TOKEN_1" -H "Filename: 2026-11-02 1900 Test.md" -T /tmp/summary.md http://127.0.0.1:8090/tm-spike-member1`, reads `attachment.url` and `attachment.expires` from the reply, runs the N1 and N2 requests with `curl -s -o /dev/null -w '%{http_code}'`, and starts a background check that runs N3 after 11,100 seconds. Run: `bash /srv/spikes/repo/spikes/08-ntfy/check.sh`. Expected: `ntfy.json` filled; N3 completes 3 hours 5 minutes later.

- [ ] **Step 3: Check the phone app, only if N1 to N3 passed**

Point a throwaway DNS name at the server (a TolongLabs test subdomain), set `base-url` to `https://<ntfy-host>`, run `ufw allow 80/tcp && ufw allow 443/tcp`, and `docker compose --profile phone up -d`. Subscribe the ntfy app to `tm-spike-member1` with member 1's credentials, run `check.sh` against the public URL, and check the app shows and downloads the attachment. Then `docker compose --profile phone down`, `ufw delete allow 80/tcp && ufw delete allow 443/tcp`, and delete the DNS name. Expected: N4 holds, and `ufw status` lists only 22/tcp again.

- [ ] **Step 4: Record, write the report and apply the outcome's edits**

Run `sync.sh pull 08-ntfy`, write `REPORT.md` with the N table, the ntfy version and the decision, and apply the spike 8 rows of Task 9's outcome table.

- [ ] **Step 5: Commit**

```bash
git add spikes/08-ntfy docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): report ntfy attachments"
```

Expected: the check prints nothing; the commit succeeds.

### Task 9: Decisions and design updates

**Files:**

- Create: `spikes/DECISIONS.md`
- Modify: `docs/app-design/2026-10-20-meeting-bot-design.md` ("Early spikes", and the sections the outcome table names)
- Modify: `docs/plans/README.md` ("Roadmap", "When the spikes change things")
- Modify, only where an outcome row says so: `docs/plans/architecture.md`, `docs/plans/01a-recorder-and-pings.md`, `docs/plans/01b-form-submission.md`, `docs/plans/01c-website-and-scheduler.md`, `docs/plans/02-link-watchers.md`, `docs/plans/03-companion-and-native.md`, `docs/plans/04-teams.md`, `docs/plans/05-meet.md`, `docs/plans/08-run-locations.md`

**Interfaces:**

- Consumes: every decision key produced by Tasks 1 to 8, and `docker/worker/versions.env` (Task 2).
- Produces: `spikes/DECISIONS.md`, the one file later plans read spike decisions from (adds to contracts): a table of `Key | Value | Spike | Read by` holding exactly these keys, in this order:

| Key                                                                                                         | Spike | Read by      |
| ----------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| `versions` (pointer to `docker/worker/versions.env`)                                                        | 2     | 01a          |
| `runLocation.university`, `runLocation.work`                                                                | 1     | 01c, 08      |
| `signin.survivalDays.university`, `signin.survivalDays.work`                                                | 1     | 01c          |
| `teams.deviceCompliance`                                                                                    | 1     | 04           |
| `chrome.args`, `chrome.policyFile`, `chrome.deskMute`, `chrome.captureBlock`                                | 2     | 01a          |
| `desk.backgroundTabsLive`                                                                                   | 2     | 02, 04       |
| `teams.signedInLabelled`                                                                                    | 2     | 04           |
| `platform.zoom`, `platform.teams`, `platform.meet`                                                          | 2     | 01a, 04, 05  |
| `zoom.guestFallback`                                                                                        | 2     | 01a          |
| `chat.senderRoleVisible.zoom`, `.teams`, `.meet`                                                            | 2     | 01a, 04, 05  |
| `stage.sharedRect.zoom`, `.teams`, `.meet`                                                                  | 2     | 01a          |
| `qr.decoder`, `qr.minSizePct`, `qr.p95Ms`                                                                   | 3     | 01a          |
| `forms.markersFile`, `forms.matchModel`, `forms.matchP95Ms`, `forms.fillP95Ms`, `forms.orgRestrictedStepUp` | 4     | 01b          |
| `asr.liveModel`, `asr.url`, `asr.timestamps`, `asr.vocabulary`, `asr.sessionCapMinutes`, `asr.eventNames`   | 5     | 01a          |
| `worker.concurrencyCap`, `worker.cpuLimit`, `worker.memoryLimitGb`                                          | 6     | 01c          |
| `recording.preset`, `disk.gbPerMeetingHour`                                                                 | 6     | 01a          |
| `local.dockerMemoryGb`                                                                                      | 6     | 03, 08       |
| `profile.survivesRestore`, `profile.restartSource`, `profile.checkpointSeconds`, `profile.restoreSeconds`   | 7     | 01a, 01c     |
| `watchers.whatsappFromServer`, `watchers.discordFromServer`                                                 | 7     | 01c, 02      |
| `ntfy.attachSummary`, `ntfy.version`                                                                        | 8     | 01a, 01c, 03 |

Outcome table. Each spike task applies its matching rows in its own commit; this task checks them and applies row 0. "Design" means `docs/app-design/2026-10-20-meeting-bot-design.md`; plan names are files in `docs/plans/`; quoted text is the design's current wording.

| Row  | Outcome                                                                                                                                                                               | Design edits                                                                                                                                                                                                                                                                                                                                                       | Plan edits                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Any outcome, every spike                                                                                                                                                              | "Early spikes": append to the spike's item "Result (<date>): <one sentence>. `[Report](../../spikes/<NN>-<slug>/REPORT.md)`."                                                                                                                                                                                                                                        | `README.md`, "When the spikes change things": append the result to the spike's bullet (spikes 4 and 6 get bullets if they changed anything)                                                                                                                                                                                                                                     |
| 1.1  | University and work pass on the server route                                                                                                                                          | "Run locations": replace "The spike 1 results decide the default for a member's university and work identities." with "Spike 1 found university and work sign-ins held for 7 days from the server, so both default to the server."                                                                                                                                 | None; plan 08 stays after 03                                                                                                                                                                                                                                                                                                                                                    |
| 1.2  | An identity type fails on the server but passes through home                                                                                                                          | "Run locations": the default sentence names `server_via_home` for that identity type, with the reason; "Platform realities", "University and work sign-in policies": add what was observed; "Build order", item 11: split into "Home route", right after milestone 1C, and "Local mode", where it is                                                               | `README.md`: split row 08 into 08a (home route, depends on 01c, placed after 01c) and 08b (local mode, depends on 03); `08-run-locations.md`: home-route tasks first, without the dependency on 03; `01c-website-and-scheduler.md`: the identity form's run-location default and help text follow `runLocation.*`                                                               |
| 1.3  | An identity type fails on both routes                                                                                                                                                 | "Run locations": that identity type defaults to `local`; "Build order": move items 6 (companion app and native mode) and 11 (run locations) to right after milestone 1C, as item 11 foresees                                                                                                                                                                       | `README.md`: order 00, 01a, 01b, 01c, 03, 08, then 02, 04, 05, 06, 07; `01a-recorder-and-pings.md`: milestone acceptance runs the worker image on the member's PC through Docker Desktop; `01c`: default as in 1.2                                                                                                                                                              |
| 1.4  | Work tenant needs a compliant device (`teams.deviceCompliance=required`)                                                                                                              | "Platform realities", "University and work sign-in policies": the member's work tenant blocks Teams on the web from unmanaged devices, which no run location satisfies; "Platform adapters", Teams note: such tenants are reported to the member, not joined. Requester question: whether work Teams meetings leave scope (decision 8 is theirs)                   | `04-teams.md`: the join maps an `AADSTS53000` or `AADSTS53003` page to `{ kind: 'failed', reason: 'device_compliance' }` with a high-priority ping, tested against a fixture of that page                                                                                                                                                                                       |
| 1.5  | An account was locked or alerted on a route                                                                                                                                           | As 1.2 or 1.3 for that identity type, never retried; "Platform realities": what triggered it                                                                                                                                                                                                                                                                       | As 1.2 or 1.3                                                                                                                                                                                                                                                                                                                                                                   |
| 2.1  | All platforms pass with the frozen settings                                                                                                                                           | "Meeting worker", Chrome: "Settings to verify in spike 2:" becomes "Settings verified in spike 2:"                                                                                                                                                                                                                                                                 | `01a`: the tasks creating `docker/worker/Dockerfile`, `docker/worker/chrome-policy.json` and `packages/worker/src/chrome/launch.ts` take `docker/worker/versions.env`, `spikes/02-browser/chrome-policy.json` and `chrome.args`; the task creating `config/selectors/zoom.json` starts from `spikes/02-browser/selectors/zoom.json` (likewise `04` for Teams and `05` for Meet) |
| 2.2  | Extra flags or policies kept (`--enable-unsafe-swiftshader`, `devtools://*`, `PasswordManagerEnabled`, `BrowserSignin`, `SyncDisabled`, `AudioCaptureAllowed`, `VideoCaptureAllowed`) | "Meeting worker": each kept flag joins the flags bullet, and each kept policy joins "A managed Chrome policy blocks …" (password saving, browser sign-in and sync, capture devices); "Security and privacy", "Remote view": the same policy list                                                                                                                   | `01a`: launch and policy tasks as in 2.1                                                                                                                                                                                                                                                                                                                                        |
| 2.3  | `DeveloperToolsAvailability: 2` stops Playwright                                                                                                                                      | "Meeting worker", policy sentence: "developer tools" becomes "developer tools (by blocking `devtools://` URLs)"                                                                                                                                                                                                                                                    | `01a`: policy file without that key                                                                                                                                                                                                                                                                                                                                             |
| 2.4  | Capture denied through permissions, not policy (`chrome.captureBlock=permission_deny`)                                                                                                | "Meeting worker": after "deny camera and microphone permission" add "in the profile's preferences, because a platform wouldn't join with capture disabled by policy"                                                                                                                                                                                               | `01a`: `prepareProfile` in `packages/worker/src/profile/profile.ts` writes both content settings, with a test                                                                                                                                                                                                                                                                   |
| 2.5  | Desk muting method chosen                                                                                                                                                             | "Meeting worker", Audio: "(the method is verified in spike 2)" becomes "by a desk-only script that mutes media elements and Web Audio" (`init_script`) or "by blocking sound for desk sites" (`sound_setting`)                                                                                                                                                     | `01a`: `launchBrowser` applies it to every desk page; `01b` form tabs and `02` and `04` watcher tabs open through the same desk-tab helper                                                                                                                                                                                                                                      |
| 2.6  | `desk.backgroundTabsLive=no`                                                                                                                                                          | "Link watchers", Behaviour: add "Before each poll, a watcher brings its tab to the front of the desk window."                                                                                                                                                                                                                                                      | `02-link-watchers.md`, `04-teams.md`: each watcher's poll brings its tab to the front first, with a test asserting the order                                                                                                                                                                                                                                                    |
| 2.7  | Teams labels the signed-in browser                                                                                                                                                    | "Platform realities", Teams: replace "A signed-in member joining from a browser isn't expected to be labelled, but this is unverified (spike 2)." with the observed label and whether the organiser must approve; "Platform adapters", Teams note: the lobby wait covers organiser approval and pings the member. Requester question: whether Teams stays in scope | `04-teams.md`: `waitUntilAdmitted` treats the approval state as lobby, with a fixture; `README.md`: risk noted on row 04                                                                                                                                                                                                                                                        |
| 2.8  | Teams doesn't label it                                                                                                                                                                | "Platform realities", Teams: "A signed-in member joining from a browser wasn't labelled (spike 2, <date>)."                                                                                                                                                                                                                                                        | None                                                                                                                                                                                                                                                                                                                                                                            |
| 2.9  | Meet blocks or always queues the browser                                                                                                                                              | "Platform realities", Google Meet, and "Platform adapters", Google Meet note: the observed block                                                                                                                                                                                                                                                                   | `README.md`: row 05 marked blocked; `05-meet.md`: a first task reruns spike 2's Meet check with the then-current Chrome before any adapter work                                                                                                                                                                                                                                 |
| 2.10 | A platform's signed-in join fails for another reason                                                                                                                                  | "Platform adapters", that platform's note: the reason                                                                                                                                                                                                                                                                                                              | That platform's plan (`01a` Zoom, `04` Teams, `05` Meet): a first task solves it from the recorded aria dumps                                                                                                                                                                                                                                                                   |
| 2.11 | `zoom.guestFallback=fail`                                                                                                                                                             | "Platform adapters", Zoom: a busy account leads to a ping instead of a guest join; decision 28 annotated                                                                                                                                                                                                                                                           | `01a`: `account_busy` leads to a high-priority ping and no guest join                                                                                                                                                                                                                                                                                                           |
| 2.12 | `chat.senderRoleVisible.<platform>=no`                                                                                                                                                | "Attendance form handler", Trust: on that platform, a host's link counts only when the host's display name is a trusted sender                                                                                                                                                                                                                                     | `01a` (Zoom), `04`, `05`: `checkTrust` tests for that platform use `senderRole: 'unknown'`                                                                                                                                                                                                                                                                                      |
| 3.1  | `qr.decoder=zxing`                                                                                                                                                                    | "Attendance form handler", QR decoding, and "Tech stack", QR decoding: zxing-cpp only, "spike 3 found the WeChat detector added nothing"                                                                                                                                                                                                                           | `01a`: `decodeQr` in `packages/worker/src/qr/qr.ts` uses `zxing-wasm` only; no Python in the image                                                                                                                                                                                                                                                                              |
| 3.2  | `qr.decoder=wechat`                                                                                                                                                                   | The same two places: OpenCV's WeChat detector only, run as a long-lived Python process in the worker                                                                                                                                                                                                                                                               | `01a`: `decodeQr` talks to a Python child process using `decode_wechat.py --serve`'s protocol; the Dockerfile task adds the venv, `opencv-contrib-python-headless` and the model files with their SHA-256                                                                                                                                                                       |
| 3.3  | `qr.decoder=both`                                                                                                                                                                     | "(compared in spike 3)" becomes "both run, zxing-cpp first; spike 3 found each catches codes the other misses"                                                                                                                                                                                                                                                     | `01a`: `decodeQr` runs zxing first and WeChat only when zxing finds nothing; Dockerfile as 3.2                                                                                                                                                                                                                                                                                  |
| 3.4  | `qr.minSizePct` above 8                                                                                                                                                               | "Attendance form handler", QR decoding: add "Codes smaller than <N>% of the slide height may be missed; links in chat remain the fallback."                                                                                                                                                                                                                        | None                                                                                                                                                                                                                                                                                                                                                                            |
| 3.5  | No pipeline passes Q4                                                                                                                                                                 | "Meeting worker", Frames: QR decoding runs on every second frame, and the 10-second detection budget is restated from the measured times                                                                                                                                                                                                                           | `01a`: the QR consumer of `startFrameLoop` skips alternate frames, with a test                                                                                                                                                                                                                                                                                                  |
| 4.1  | All form checks pass                                                                                                                                                                  | None beyond row 0                                                                                                                                                                                                                                                                                                                                                  | `01b`: provider modules and the fixtures in `packages/worker/test/fixtures/` start from `spikes/04-forms/form-markers.json`; the attendance-option rule carries the negation list (`tidak`, `tak`, `not`, `absent`) with a test that "Tidak hadir" is never chosen                                                                                                              |
| 4.2  | `forms.orgRestrictedStepUp=yes`                                                                                                                                                       | "Attendance form handler", Opening: record that the provider asked for sign-in on open from the server; the identity's run location follows spike 1's home or local row                                                                                                                                                                                            | As 1.2 or 1.3                                                                                                                                                                                                                                                                                                                                                                   |
| 4.3  | `forms.matchP95Ms` above 5,000                                                                                                                                                        | "Attendance form handler", Filling, step 2: "allows 5 seconds" becomes the p95 rounded up to whole seconds, or "Tech stack", form-label matching, names a faster model; whichever keeps opening to submission within 60 seconds                                                                                                                                    | `01b`: the matching call's timeout constant                                                                                                                                                                                                                                                                                                                                     |
| 4.4  | Already-answered or quiz marker unreliable                                                                                                                                            | "Attendance form handler": "When the provider shows no clear already-answered or quiz marker, the form is treated as needing the member."                                                                                                                                                                                                                          | `01b`: inspection returns `needs_member` when a marker is missing, with a fixture                                                                                                                                                                                                                                                                                               |
| 4.5  | Wrappers or redirects differ from the design                                                                                                                                          | "Attendance form handler", Unwrapping: list the wrappers observed                                                                                                                                                                                                                                                                                                  | `01a`: `resolveFormLink` tests add each observed URL shape, with placeholder IDs                                                                                                                                                                                                                                                                                                |
| 4.6  | `forms.fillP95Ms` above 60,000                                                                                                                                                        | "Attendance form handler", Speed: record the measured time and what dominates it                                                                                                                                                                                                                                                                                   | `01b`: per-step timeouts that sum to at most 120 seconds minus the measured detection and resolution times                                                                                                                                                                                                                                                                      |
| 5.1  | `qwen3-asr-flash-realtime` stays                                                                                                                                                      | "Transcription", Swapping models: "Spike 5 found no Singapore streaming model with native timestamps and vocabulary that did better, so this one stays."; Timestamps: add the measured median error                                                                                                                                                                | `01a`: `openAsrStream` in `packages/ai` and `startLiveAsr` in `packages/worker/src/asr/live.ts` use `asr.url`, `asr.eventNames`, and Task 5's reconnection and de-duplication rules                                                                                                                                                                                             |
| 5.2  | A candidate replaces it                                                                                                                                                               | Decision 35, "Tech stack" live speech recognition, "Transcription" live mode (native timestamps; vocabulary from the entry's names and slide terms), "Deployment and cost" speech price, and Swapping models: the result                                                                                                                                           | `architecture.md`: the default for `AiConfig.models.asr`; `01a`: `openAsrStream`'s protocol and tests for the new model                                                                                                                                                                                                                                                         |
| 5.3  | `asr.sessionCapMinutes` isn't 120                                                                                                                                                     | "Transcription", Long meetings: "before 110 minutes" becomes "before <cap minus 10> minutes", or the reconnection is dropped if no cap appeared in 125 minutes                                                                                                                                                                                                     | `01a`: the reconnection constant in `live.ts`                                                                                                                                                                                                                                                                                                                                   |
| 5.4  | A1 or A2 fails for every live model                                                                                                                                                   | "Transcription": live results feed name-mention alerts only, and after the meeting `qwen3-asr-flash-filetrans` (scored the same way first) builds the transcript the summary uses; goal 4's 10 minutes rechecked                                                                                                                                                   | `01a`: the pipeline task adds a file-transcription step before the summary                                                                                                                                                                                                                                                                                                      |
| 5.5  | A3 fails                                                                                                                                                                              | "Transcription", Timestamps: the offset method that passed                                                                                                                                                                                                                                                                                                         | `01a`: the offset rule in `live.ts`                                                                                                                                                                                                                                                                                                                                             |
| 6.1  | `worker.concurrencyCap=2`                                                                                                                                                             | "Deployment and cost", Per worker: the estimate becomes "measured in spike 6: <p95> vCPUs and <peak> GB per worker"                                                                                                                                                                                                                                                | `01c`: the container launcher sets `--cpus <worker.cpuLimit>` and `--memory <worker.memoryLimitGb>g`                                                                                                                                                                                                                                                                            |
| 6.2  | `worker.concurrencyCap=1`                                                                                                                                                             | Decision 38, "Scheduler", Server capacity, and "Deployment and cost": 1 meeting at once, or a 12-vCPU, 24-GB server for 2 with its cost; the designer picks and records why                                                                                                                                                                                        | `01c`: the capacity constant and its tests                                                                                                                                                                                                                                                                                                                                      |
| 6.3  | `worker.concurrencyCap=3`                                                                                                                                                             | Decision 38, "Scheduler", Server capacity, and "Deployment and cost": at most 3 meetings                                                                                                                                                                                                                                                                           | `01c`: as 6.2                                                                                                                                                                                                                                                                                                                                                                   |
| 6.4  | `local.dockerMemoryGb` above 4                                                                                                                                                        | "Run locations", Memory: "about 4 GB" becomes "<N> GB"                                                                                                                                                                                                                                                                                                             | `03-companion-and-native.md`, `08-run-locations.md`: the pre-run memory check uses N                                                                                                                                                                                                                                                                                            |
| 6.5  | Recording preset chosen                                                                                                                                                               | "Meeting worker", Recording: "a fast preset" becomes "the `<preset>` preset"                                                                                                                                                                                                                                                                                       | `01a`: `startRecorder`'s ffmpeg arguments in `packages/worker/src/recorder/recorder.ts` match the tested command                                                                                                                                                                                                                                                                |
| 6.6  | R4 fails                                                                                                                                                                              | "Deployment and cost": the disk grows to fit the measured GB per meeting-hour times 172, plus 50 GB, or the recording bitrate is capped                                                                                                                                                                                                                            | `01a`: `-maxrate` and `-bufsize` in the recorder arguments, if capped                                                                                                                                                                                                                                                                                                           |
| 7.1  | Everything survives and WhatsApp stays linked                                                                                                                                         | "Link watchers", WhatsApp: the spike sentence becomes "Spike 7 found WhatsApp stayed linked across restores from the server."                                                                                                                                                                                                                                      | `02`: WhatsApp watching allowed at every run location                                                                                                                                                                                                                                                                                                                           |
| 7.2  | `profile.restartSource=working_copy`                                                                                                                                                  | "Scheduler", Health: "from the latest profile checkpoint" becomes "from the identity's working copy, or the latest checkpoint if the working copy is damaged"; "Meeting worker", Profile storage: the same                                                                                                                                                         | `01c`: the restart path; `01a`: `prepareProfile` accepts a crashed working copy                                                                                                                                                                                                                                                                                                 |
| 7.3  | `watchers.whatsappFromServer=home_only`                                                                                                                                               | "Link watchers", WhatsApp: "WhatsApp watching is limited to identities that run at home (spike 7)."; "Website", Timetable: a WhatsApp chat is offered only for identities that run at home or locally                                                                                                                                                              | `02`: the watcher refuses on `server` identities with a ping; `01c`: the timetable form hides the option; `README.md`: plan 02's WhatsApp tasks depend on 08                                                                                                                                                                                                                    |
| 7.4  | `watchers.whatsappFromServer=none`                                                                                                                                                    | Decision 14 and "Link watchers": WhatsApp watching suspended. Requester question, because decision 14 is theirs                                                                                                                                                                                                                                                    | `02`: WhatsApp tasks parked until the answer                                                                                                                                                                                                                                                                                                                                    |
| 7.5  | `watchers.discordFromServer=home_only`                                                                                                                                                | "Link watchers", Discord: limited to identities that run at home or locally                                                                                                                                                                                                                                                                                        | `02`, `01c`: as 7.3, for Discord                                                                                                                                                                                                                                                                                                                                                |
| 7.6  | `profile.survivesRestore=no`                                                                                                                                                          | "Meeting worker", Profile storage: record the failure. It blocks milestone 1A: rerun the spike changing machine ID, hostname and `--password-store=basic` one at a time, and bring the result to the requester                                                                                                                                                     | `README.md`: 01a marked blocked until resolved                                                                                                                                                                                                                                                                                                                                  |
| 7.7  | P6 fails                                                                                                                                                                              | "Meeting worker", Profile storage: checkpoint interval set so checkpointing takes under 10% of the time; the crash acceptance test's 2 minutes rechecked                                                                                                                                                                                                           | `01a`: the checkpoint interval constant                                                                                                                                                                                                                                                                                                                                         |
| 8.1  | `ntfy.attachSummary=true`                                                                                                                                                             | "Notifications", Attachments: "The summary file is attached; spike 8 showed ntfy attachments need the topic's credentials and expire within 3 hours."                                                                                                                                                                                                              | `01a`: the summary ping passes `attachPath`; `01c`: the ntfy service uses `spikes/08-ntfy/server.yml`'s keys with the production `base-url`                                                                                                                                                                                                                                     |
| 8.2  | `ntfy.attachSummary=false`                                                                                                                                                            | "Notifications", Attachments: "The summary file isn't attached, because spike 8 found <reason>; the ping links to the meeting page and the companion app fetches the file."                                                                                                                                                                                        | `01a`: the summary ping has no `attachPath`, and until the website exists its message carries the summary text cut at ntfy's 4,096-byte message limit; `01c`: the ping links to the meeting page; `03`: the companion app downloads the summary file                                                                                                                            |

- [ ] **Step 1: Write `spikes/DECISIONS.md`**

Exactly this shape, one row per key above, values copied from the reports:

```markdown
# Spike decisions

The values later plans read, from the eight spikes run from <YYYY-MM-DD> to <YYYY-MM-DD>. Each spike's report holds the evidence.

Contents:

1.  [Decisions](#decisions)
1.  [Edits made](#edits-made)
1.  [Questions for the requester](#questions-for-the-requester)
1.  [Teardown](#teardown)

## Decisions

| Key     | Value   | Spike                        | Read by |
| ------- | ------- | ---------------------------- | ------- |
| `<key>` | <value> | [<N>](<NN>-<slug>/REPORT.md) | <plans> |

## Edits made

- <file>, <section>: <edit> (row <id>, commit <short hash>)

## Questions for the requester

- <question>, raised by row <id>; <what waits on the answer>

## Teardown

- <item>: done <YYYY-MM-DD>
```

- [ ] **Step 2: Check that every outcome's edits were made**

For each spike, find its rows in the outcome table from its decisions, confirm the edits are in the design and plans (`git log --oneline -- docs`), apply any that were missed, and list every edit under "Edits made". Rows that raise a requester question (1.4, 2.7, 7.4 and 7.6) go under "Questions for the requester", and their design edits wait for the answer. Apply row 0 for all eight spikes.

- [ ] **Step 3: Run the consistency checks**

```bash
ls spikes/0*/REPORT.md | wc -l
grep -nE "spike [1-8]" docs/app-design/2026-10-20-meeting-bot-design.md
diff <(grep -v '^#' docker/worker/versions.env) <(grep -v '^#' spikes/00-setup/worker/versions.env)
grep -rnE "at most [0-9] (server workers|meetings)" docs/app-design docs/plans
bunx prettier --check "docs/**/*.md" "spikes/**/*.md"
```

Expected: `9`; every spike mention in the design states a result (none left saying "verify", "tests it", "decide", "compared in" or "measures"); no `diff` output; every cap matches `worker.concurrencyCap`; Prettier reports all files formatted.

- [ ] **Step 4: Tear down**

- The member logs out the spike's linked WhatsApp devices (`persist`, `persist-home`), Discord sessions and Google "Your devices" entries for the spike browsers; Microsoft and Zoom sessions die with the server.
- Delete the spike DashScope key; revoke the Tailscale auth key and remove the spike nodes; turn off "Run exit node" at home unless plan 08 will use it.
- Destroy the server with its disks, snapshots and backups in the provider console, and delete any DNS name made for Task 8.
- Delete any `private/` data copied off the server. Keep the test forms; plan 01b's acceptance reuses them.

Expected: each item dated under "Teardown", and the member confirms the WhatsApp linked-device count is back to its step-1 number (Task 7).

- [ ] **Step 5: Commit**

```bash
git add spikes/DECISIONS.md docs
bash spikes/00-setup/precommit-check.sh
git commit -m "docs(spikes): record spike decisions"
```

Expected: the check prints nothing; the commit succeeds.
