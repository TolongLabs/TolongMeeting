# Environment

The machine, software, accounts and conventions the session ran on, as established during it. An app that automates this workflow has to discover or configure each of these; the "App implication" notes say how.

Contents:

1.  [Hardware and operating system](#hardware-and-operating-system)
1.  [Agent runtime](#agent-runtime)
1.  [Applications](#applications)
1.  [Command-line tools and runtimes](#command-line-tools-and-runtimes)
1.  [Accounts and logged-in sessions](#accounts-and-logged-in-sessions)
1.  [Files, folders and conventions](#files-folders-and-conventions)
1.  [Settings changed for the session and restored afterwards](#settings-changed-for-the-session-and-restored-afterwards)

## Hardware and operating system

- **OS**: Windows 11 Pro (build 26200) with WSL2 (Ubuntu as the default distribution).
- **Memory**: 31.2 GB RAM on Windows; WSL had about 16 GB. Free memory fell to about 4 GB with Chrome, OBS and two Whisper runs, which triggered the agent harness's memory-pressure reaper.
- **GPU**: NVIDIA RTX 3050 Ti Laptop with 4 GB VRAM, visible inside WSL (`nvidia-smi`). Whisper medium fits; large-v3 does not.
- **Displays**: two monitors.
  - Left (`DISPLAY1`, the laptop panel) at x = -1920: 1920x1080 physical, 125% scaling (1536x864 logical), work area -1920,0 to 0,1020.
  - Primary (`DISPLAY6`) at 0,0: 1920x1080, work area 0,0 to 1920,1032.
- **Power**: plan "Silent", on AC. AC standby and display-off were both 300 minutes (0x4650). The PC had blue-screened before, which is why recordings used MKV.
- **App implication**: detect monitors, DPI scaling and free RAM/VRAM up front; choose a capture monitor that the user isn't using; pick transcription models that fit the GPU.

## Agent runtime

- **Claude Code** (CLI on Windows) in auto mode, with PowerShell as the primary shell and Git Bash available. Tools used: Bash, PowerShell, Read/Write/Edit, Glob/Grep, Agent (parallel subagents), CronCreate/CronDelete (session-only scheduled prompts), AskUserQuestion, WebSearch, ToolSearch for deferred tools.
- **claude-in-chrome** browser extension (MCP tools `tabs_context_mcp`, `navigate`, `computer`, `find`, `read_page`, `get_page_text`, `javascript_tool`, `tabs_create_mcp`, `tabs_close_mcp`). It works on a tab group it owns, redacts query strings and sensitive-looking strings in some tool outputs, truncates output at about 1,000 characters, and loses its tab group when Chrome restarts or the conversation is compacted.
- **claude-mem plugin** (`work_state_write` / `work_state_read`): durable per-task state that survives context compaction and is visible to scheduled prompts.
- **Google Drive connector** (claude.ai MCP): reads files and metadata by id; cannot list a link-shared folder that isn't in the user's Drive.
- **Harness behaviours that mattered**: background shell jobs are killed under memory pressure; large tool outputs are persisted to files; context is compacted automatically near the limit (once, at 22:33).
- **App implication**: an app needs its own scheduler, durable state store, browser-control layer with full (unredacted, untruncated) access to page data, and resource management for long jobs.

## Applications

- **OBS Studio 30.2.2** at `C:\Program Files\obs-studio\bin\64bit\obs64.exe`, with the built-in obs-websocket v5 (port 4455, authentication on, disabled by default). Original profile and scene collection: `Untitled` (Simple output mode, MP4, NVENC, 1920x1080 at 30 fps, 48 kHz stereo, path `C:/Users/User/Videos/OBS`).
- **Google Chrome** with the claude-in-chrome extension; logged in to Discord and the hackathon portal. The user browses in **Opera**, which kept Chrome free for the agent.
- **Zoom Workplace desktop 7.1.9** at `%APPDATA%\Zoom\bin\Zoom.exe`, signed out. Used only for settings; the meeting was attended in the **Zoom web client**.
- **Other running apps** that affected automation: WhatsApp Desktop (received stray keystrokes once), Discord desktop, a terminal on the left monitor that covered Chrome.
- **App implication**: the app must not assume it owns the desktop; it should run in a browser profile it controls and treat everything else as the user's.

## Command-line tools and runtimes

- **Windows**: Python 3.12 (a session venv with `obsws-python` 13.0.0, `pillow`, `uiautomation`, later `pymupdf`), `gh`, `git`, `powercfg`, `taskkill`. No ffmpeg on Windows.
- **WSL**: ffmpeg/ffprobe, `uv`, Python older than 3.12 (no backslashes in f-string expressions), git, bun (`~/.bun/bin`, not on the non-interactive PATH), Node v16 at `/usr/bin/node` plus nvm Node v24.14.0 and v25.8.0 (the repo's hooks need v24).
- **whisper-transcriber** (`~/CS/whisper-transcriber`, version 4.0.0): `uv run transcriber <audio> -m medium -l en -f txt,srt,json [-o <dir>]`. openai-whisper 20250625 with torch 2.7.1; cached models tiny, small, medium, large-v3. Its Gemini `--polish` step is obsolete per the user.
- **OpenAI API**: key in another local project's `.env` (`OPENAI_API_KEY`), read at run time and never printed. Models available included `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` and `gpt-transcribe`.
- **App implication**: ship or detect ffmpeg; abstract the ASR backend (local Whisper, OpenAI, others); manage secrets in one place.

## Accounts and logged-in sessions

- **Discord** (in Chrome): the hackathon server's `#announcements` channel, where the Zoom link was posted at 19:32 for an 8 PM start.
- **Hackathon portal** `https://sdchack.my/portal` (in Chrome): team details, payment and refund details (never used), the assigned domain and, from 10 PM, the problem-statement Drive link.
- **Zoom**: no account; joined as a guest with the display name "Team T010NG".
- **GitHub**: `gh` authenticated with push access to `TolongLabs/sdc-hack` (private).
- **App implication**: the app should use the user's existing logged-in sessions read-only, and list which accounts each step touches.

## Files, folders and conventions

- **Deliverable folder**: `C:\Users\User\Downloads\sdc-hack-opening-ceremony\` (`transcript.md`, `slides.md`, `slides/NN.webp`, `chat.md`).
- **Format precedent**: the "three-file set" from a previous hackathon briefing at `~/CS/sdp-hack/docs/sources/opening-briefing/`; write-up style precedent at `~/CS/kabel/catatmd-transcripts/`.
- **Repo**: `~/CS/sdc-hack` (TolongLabs/sdc-hack). Rules: `docs/references/markdown-style.md` (single H1, short intro, "Contents:" list with lazy numbering, sentence-case headings, no hard wraps, no trailing whitespace); conventional commits with a 50-character header (commitlint); husky hooks run `bunx lint-staged` (Prettier) and `bunx commitlint`; `.gitattributes` forces LF. The user allowed pushing straight to `main`.
- **Recordings**: `C:\Users\User\Videos\OBS\`, file names `%CCYY-%MM-%DD %hh-%mm-%ss`.
- **Audio and raw transcripts**: `~/CS/whisper-transcriber/audio/` and `.../transcripts/` (the user keeps past meetings there).
- **Agent scratch**: the session scratchpad under `%TEMP%\claude\...\scratchpad\sdc\`.
- **App implication**: output templates, destinations and repository rules must be configurable per user and per project.

## Settings changed for the session and restored afterwards

| Setting                            | During the session                                        | Restored to                                         |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| AC standby timeout                 | Never (`powercfg /change standby-timeout-ac 0`)           | 300 minutes                                         |
| OBS profile                        | `sdc-hack` (clone of Untitled, MKV, recording quality HQ) | `Untitled` (the `sdc-hack` profile still exists)    |
| OBS scene collection               | `sdc-hack` (meeting window capture + Chrome audio)        | `Untitled` (the `sdc-hack` collection still exists) |
| obs-websocket server               | Enabled (existing password kept)                          | Disabled, from the `config.json.bak-sdc` backup     |
| Chrome launch flags                | `--disable-features=CalculateNativeWinOcclusion`          | Normal launch (Chrome was shut down at the end)     |
| Chrome window                      | Left monitor, bottom of the z-order                       | Closed                                              |
| Zoom desktop join settings         | Camera off, mic muted, no video preview, auto audio       | Left as set                                         |
| Chrome "always open zoom.us links" | Ticked by the user during the rehearsal                   | Left as set                                         |
