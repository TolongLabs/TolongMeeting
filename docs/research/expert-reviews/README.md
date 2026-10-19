# Expert reviews

Three specialist reviews of revision 1 of the TolongMeeting design (now the [PRD](../../PRD.md), [TRD](../../TRD.md) and [design](../../DESIGN.md)), made on 20 October 2026, and the triage of every finding into revision 2. The requester asked whether the spec was rigid enough to build from and feasible; all three reviewers answered "feasible with changes".

Contents:

1.  [How the reviews were run](#how-the-reviews-were-run)
1.  [Verdicts](#verdicts)
1.  [Triage](#triage)
    1.  [Meeting-bot infrastructure](#meeting-bot-infrastructure)
    1.  [Identity, security and compliance](#identity-security-and-compliance)
    1.  [Systems architecture](#systems-architecture)
1.  [Requester answers prompted by the reviews](#requester-answers-prompted-by-the-reviews)
1.  [Caveats](#caveats)

## How the reviews were run

- **Reviewers**: three workers of the Antigravity CLI (`agy` 1.4.2) on `gemini-4-argon-high`, dispatched with the requester's `agy-fanout` skill. Each got a specialist brief plus a common brief with the review format. The briefs are in [briefs](briefs/).
- **Inputs**: revision 1 of the design and the session record's overview, workflow, techniques and problems-and-fixes pages.
- **Web access**: the meeting-bot and architecture reviewers could search the web. The identity reviewer ran sandboxed and offline, because the session's safety classifier blocked the unrestricted permission flag and auto mode wasn't available on the account; it marks claims it couldn't check as unverified ([offline brief](briefs/common-offline.md)).
- **Reviews**:
  - [Meeting-bot infrastructure](meeting-bot-infrastructure.md): findings BOT-01 to BOT-11.
  - [Identity, security and compliance](identity-security-compliance.md): findings SEC-01 to SEC-12.
  - [Systems architecture](systems-architecture.md): findings ARC-01 to ARC-11.

## Verdicts

| Reviewer                          | Verdict               | Blockers | Major | Minor |
| --------------------------------- | --------------------- | -------- | ----- | ----- |
| Meeting-bot infrastructure        | Feasible with changes | 4        | 5     | 2     |
| Identity, security and compliance | Feasible with changes | 3        | 6     | 3     |
| Systems architecture              | Feasible with changes | 3        | 7     | 1     |

Several blockers describe the same problem from different angles. Merged, they are:

- browser profiles that don't survive restarts;
- sign-ins replayed from a data centre;
- forms and sign-in leaking into the recording, or clashing with a running worker;
- an undersized server;
- Chrome settings that trigger automation blocks;
- the live speech model's missing timestamps;
- an unworkable network allowlist.

## Triage

"Adopted" means revision 2 takes the recommendation; "adapted" means it solves the problem differently; "partly" and "not adopted" give the reason. Section names refer to revision 1 of the design, which is now split into the [PRD](../../PRD.md), [TRD](../../TRD.md) and [design](../../DESIGN.md); the [section map](../../app-design/2026-10-20-meeting-bot-design.md) shows where each old section went.

### Meeting-bot infrastructure

| ID     | Severity | Finding                                                    | Outcome                                                                                                                                                        | Where in the design                    |
| ------ | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| BOT-01 | Blocker  | Watcher and form tabs corrupt the recording and leak audio | Adapted: one 3840-wide display split into a recorded stage and an unrecorded desk, rather than stacked windows; desk tabs muted                                | Meeting worker                         |
| BOT-02 | Blocker  | In-memory profiles lose rotated tokens; stale locks        | Adopted: encrypted host working copy, 5-minute checkpoints, lock-file cleanup, `--password-store=basic`, cache stripping                                       | Meeting worker                         |
| BOT-03 | Blocker  | 4 vCPUs and 8 GB too small                                 | Adopted: 8 vCPUs and 16 GB, at most 2 meetings, `--shm-size=2g`, measured in spike 6                                                                           | Deployment and cost; Scheduler         |
| BOT-04 | Blocker  | Default automation flags and missing rendering flags       | Adopted, to be verified in spike 2                                                                                                                             | Meeting worker                         |
| BOT-05 | Major    | Wrapped and shortened form links ignored                   | Adopted: unwrap Safe Links and Google redirects, follow up to 5 redirects without cookies                                                                      | Attendance form handler                |
| BOT-06 | Major    | Session collisions when the member is active elsewhere     | Adopted: identities kept separate, "Take over" button, Zoom guest fallback when the account is busy                                                            | Name-mention alerts; Platform adapters |
| BOT-07 | Major    | Small QR codes missed                                      | Adopted: app-mode meeting window, layout control, WeChat detector alongside zxing-cpp, spike 3                                                                 | Meeting worker; Platform adapters      |
| BOT-08 | Major    | Adapter interface incomplete                               | Adopted: audio output, layout, lobby outcomes, breakout prompts, continuous chat storage                                                                       | Platform adapters                      |
| BOT-09 | Major    | MP4 segments and restart splicing                          | Adopted: Matroska segments named by attempt, wall-clock alignment                                                                                              | Meeting worker                         |
| BOT-10 | Minor    | Teams and Meet tested too late                             | Adopted: spike 2 covers all three platforms; Teams chat watcher built with the Teams adapter                                                                   | Early spikes; Build order              |
| BOT-11 | Minor    | Selector drift and unpinned Chrome                         | Partly: pinned versions, selector maps in JSON, monthly smoke test; the vision-model fallback for selectors was left out to keep model calls off the join path | Platform adapters                      |

### Identity, security and compliance

| ID     | Severity | Finding                                                            | Outcome                                                                                                                                                                                                                      | Where in the design                             |
| ------ | -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| SEC-01 | Blocker  | Sessions replayed from a data centre may be challenged or locked   | Adopted: spike 1 tests simultaneous use and form sign-in, with and without a home route; run locations per identity (server, server through home, local); form-provider check before joining                                 | Run locations; Early spikes; How a lecture goes |
| SEC-02 | Blocker  | Cookie encryption, device-bound sessions and WhatsApp state lost   | Adopted with BOT-02; spike 7 tests persistence; WhatsApp watching limited to home routes if it fails from the server                                                                                                         | Meeting worker; Link watchers                   |
| SEC-03 | Blocker  | Sign-in view clashes with a running worker; Chrome not locked down | Adopted: sign-in on the worker's desk with automation paused; managed Chrome policy                                                                                                                                          | Meeting worker; Website                         |
| SEC-04 | Major    | Anyone can post a fake attendance form                             | Adopted: trusted sources (QR on screen, host, co-host or named lecturer, university-restricted form) and form text isolated from the model                                                                                   | Attendance form handler                         |
| SEC-05 | Major    | Docker socket gives root; key wrapping adds little                 | Adopted: restricted socket proxy, per-identity key derived with HKDF, plain statement that root can read everything                                                                                                          | Security and privacy                            |
| SEC-06 | Major    | Privacy-law exposure (Malaysia PDPA)                               | Partly: the requester chose 30-day retention for everything and to keep names as they are; work meetings default to native transcription with an employer notice; legal advice recommended before wider use                  | Data and storage; Security and privacy          |
| SEC-07 | Major    | WhatsApp and Discord ban risk from a data centre                   | Partly: automation flag off, random poll intervals, tabs kept open, WhatsApp limited to home routes if spike 7 shows trouble; a Discord bot-token option wasn't added, because the requester chose watching through web apps | Link watchers                                   |
| SEC-08 | Major    | Domain allowlist unworkable                                        | Adopted: private-network deny-list instead                                                                                                                                                                                   | Security and privacy                            |
| SEC-09 | Major    | Companion token and local secrets                                  | Adopted: narrowly scoped device token, Windows protected storage, key passed by short-lived file                                                                                                                             | Companion app                                   |
| SEC-10 | Minor    | Passcodes in the database; ntfy attachments                        | Adopted: passcodes removed after the meeting, page-only screenshots shown on the meeting page, attachments only if authenticated and short-lived (spike 8)                                                                   | Data and storage; Notifications                 |
| SEC-11 | Minor    | Google OAuth testing status expires tokens                         | Adopted: `drive.file` only, app published "In production", default folder or Google Picker                                                                                                                                   | Exports                                         |
| SEC-12 | Minor    | Custom details could tick declarations                             | Not adopted as proposed: the requester decided the bot ticks attendance confirmations and "Present" options (decision 36), limited to trusted attendance forms                                                               | Attendance form handler                         |

### Systems architecture

| ID     | Severity | Finding                                                           | Outcome                                                                                                                                                                                                                                                           | Where in the design                 |
| ------ | -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| ARC-01 | Blocker  | Live speech model lacks timestamps and vocabulary; 120-minute cap | Adapted: timestamps from stream offsets, reconnection before 110 minutes, names fixed from slides; spike 5 looks for a streaming model with native timestamps (the reviewer's suggested model names weren't verified)                                             | Transcription                       |
| ARC-02 | Blocker  | Profile lock blocks re-sign-in; run location per entry            | Adopted: sign-in through the running worker's desk; run location moved to the identity                                                                                                                                                                            | Website; Run locations              |
| ARC-03 | Blocker  | Egress allowlist blocks sign-in and media                         | Adopted (same as SEC-08)                                                                                                                                                                                                                                          | Security and privacy                |
| ARC-04 | Major    | Milestone 1 too big for one builder                               | Adopted: milestones 1A, 1B and 1C, with effort estimates for every milestone                                                                                                                                                                                      | Build order                         |
| ARC-05 | Major    | Memory budget                                                     | Adopted with BOT-03; profiles no longer held in memory                                                                                                                                                                                                            | Deployment and cost; Meeting worker |
| ARC-06 | Major    | Contradictions                                                    | Adopted: summary opens on click; form-provider check for lectures only; FLAC deleted after transcription with playback from the video; FLAC extracted on the PC in local mode. Some quotes in the review don't match revision 1's wording, but the substance held | Several                             |
| ARC-07 | Major    | No state machines or control plane                                | Adopted: occurrence and form state machines, worker heartbeat with commands                                                                                                                                                                                       | State machines; Control channel     |
| ARC-08 | Major    | DashScope details                                                 | Adopted: thinking off, one batched JSON call per form page, Workspace ID field, cheapest flash model at build time; ModelScope kept as an alternative for text (decision 31) but never for live speech or as the only form route                                  | Tech stack                          |
| ARC-09 | Major    | Summary could drop deadlines or trust misheard dates              | Adopted: two-step summary with source priority and an overflow section                                                                                                                                                                                            | Post-processing and summaries       |
| ARC-10 | Major    | Next.js can't proxy WebSockets; Bun tray app fragile              | Adopted: Caddy with `forward_auth` for noVNC; companion app on Electron                                                                                                                                                                                           | Tech stack                          |
| ARC-11 | Minor    | Spikes miss form widgets, WhatsApp persistence, code-switching    | Adopted: spikes 4, 5 and 7 extended or added                                                                                                                                                                                                                      | Early spikes                        |

The reviewers also listed rigidity gaps. Revision 2 closes these:

- **Scheduler**: crash detection by heartbeat timeout, the rule for overlapping entries, and lock-file cleanup.
- **Platform adapters**: lobby time limits, how the shared-screen region is found, and the frozen-frame rule.
- **Link watchers**: how a chat is identified, and a 24-hour history scan at start.
- **Forms**: multi-page forms.
- **Transcription**: reconnection, and re-runs after key errors.
- **Security**: where the master key lives, and the GitHub organisation check.
- **Exports**: OAuth client ownership.

## Requester answers prompted by the reviews

- **Declarations** (SEC-12): the bot ticks attendance confirmations such as "I confirm I am attending" and "Present / Hadir" (decision 36).
- **Retention and names** (SEC-06): everything on the server is deleted after 30 days, and names in saved chat are kept as they are (decision 37).
- **Not asked**: questions the reviewers raised that the design settles itself:
  - which platform comes first: unknown to the requester, so Zoom first;
  - budget: hosting was delegated to the designer;
  - milestone slicing;
  - run location per identity;
  - the speech-recognition strategy.

## Caveats

- The reviews are model output. Claims marked unverified, and specific model names, prices, API behaviours and legal section numbers, must be checked against primary sources before they're relied on. The early spikes exist partly for this.
- The identity review is about twice the requested length and was produced without web access.
- The architecture run hit its print timeout during a final self-check, after its file was complete.
