# Open-source meeting bots

A survey, made on 20 October 2026, of self-hostable open-source projects that send a bot into Zoom, Microsoft Teams and Google Meet meetings, judged against what TolongMeeting needs. It explains why the design builds its own browser bot instead of adopting one. Facts come from each project's repository, documentation and issue tracker on that date; nothing was installed or run.

Contents:

1.  [What was needed](#what-was-needed)
1.  [Comparison](#comparison)
1.  [Attendee](#attendee)
1.  [Vexa](#vexa)
1.  [joinly](#joinly)
1.  [screenappai/meeting-bot](#screenappaimeeting-bot)
1.  [Dropped candidates](#dropped-candidates)
1.  [Conclusion](#conclusion)

## What was needed

The research asked each project for five capabilities:

1.  **(a) Live video frames** of the shared screen, to decode QR codes within seconds.
1.  **(b) Live chat messages**, to catch form links.
1.  **(c) Live audio out** to a third-party speech-to-text service during the meeting.
1.  **(d) The full recording** afterwards, at least audio, for local Whisper transcription.
1.  **(e) Control of a signed-in browser session**, for example to open and submit a Google or Microsoft Form (a bonus at the time; essential after the requester chose to join as the member).

## Comparison

| Project                                                               | Licence             | Activity (20 Oct 2026)                         | Join method                                            | (a) Frames             | (b) Chat     | (c) Live audio                    | (d) Recording     | (e) Browser control         |
| --------------------------------------------------------------------- | ------------------- | ---------------------------------------------- | ------------------------------------------------------ | ---------------------- | ------------ | --------------------------------- | ----------------- | --------------------------- |
| [Attendee](https://github.com/attendee-labs/attendee)                 | Elastic License 2.0 | v1.84.0 on 16 Oct; about 8 releases in 2 weeks | Zoom Meeting SDK (or web); Chromium for Teams and Meet | Yes, 1 to 2 fps JPEG   | Yes, webhook | Yes, WebSocket                    | Yes               | No                          |
| [Vexa](https://github.com/Vexa-ai/vexa)                               | Apache 2.0          | v0.12.28 on 9 Oct                              | Browser container per meeting                          | No                     | No           | Partly (pluggable speech-to-text) | Yes, with caveats | No                          |
| [joinly](https://github.com/joinly-ai/joinly)                         | MIT                 | v0.5.4 on 1 Sep                                | Playwright                                             | Screenshots on request | Yes          | Live transcript, pluggable        | No                | Partly (it's a browser)     |
| [screenappai/meeting-bot](https://github.com/screenappai/meeting-bot) | MIT                 | v1.2.34 on 18 Jun; pushed 28 Aug               | Playwright                                             | No (needs a fork)      | No           | No                                | Yes               | Signed-in profiles for Meet |

## Attendee

- **What it is**: a Django app in one Docker image with Postgres and Redis (Celery workers). Maintained by Attendee Labs, LLC; 762 stars, 159 open issues. A hosted service charges US$0.50 an hour after 5 free hours.
- **Licence**: Elastic License 2.0. Self-hosting for internal use is fine; offering it to third parties as a managed service is not.
- **Zoom**: defaults to the native Meeting SDK, which needs the operator's own Zoom app, approval to join other accounts' meetings, and OBF or ZAK tokens for anonymous joins. A web-client adapter is optional. Zoom RTMS is supported as a receive-only route.
- **Teams and Meet**: Chromium web clients. Signed-in Teams uses a dedicated Microsoft 365 account with two-factor authentication disabled; signed-in Meet uses a Google Workspace account with Attendee as the identity provider.
- **Needs**: (a) per-participant and screen-share frames as base64 JPEG at 1 fps (720p or 1080p) or 2 fps (360p), possibly too slow for small QR codes; (b) chat through webhooks and an API; (c) mixed or per-participant PCM audio over a WebSocket; (d) recordings to S3 or Azure; (e) no API to drive the bot's browser.
- **Deployment**: Ubuntu 22.04 image pinned to Chrome 134 (stale); one pod per bot in Kubernetes mode; no published per-bot resource figures.
- **Open issues that matter**: concurrent bots in the default Celery mode sharing audio devices and mixing recordings; a worker restart overwriting finished recordings with empty files; Teams silent audio and a "bot detect bypass" report (5 October 2026); Meet blocking by IP.
- Sources: [repository](https://github.com/attendee-labs/attendee), [real-time video](https://github.com/attendee-labs/attendee/blob/main/docs/realtime_video.md), [real-time audio](https://github.com/attendee-labs/attendee/blob/main/docs/realtime_audio.md), [webhooks](https://github.com/attendee-labs/attendee/blob/main/docs/webhooks.md), [signed-in bots](https://github.com/attendee-labs/attendee/blob/main/docs/signed_in_bots.md), [pricing](https://attendee.dev/pricing).

## Vexa

- **What it is**: a real-time meeting transcription bot API; 2.9k stars, 472 open issues; Apache 2.0. A hosted service charges about US$0.30 per bot hour.
- **Platforms**: Google Meet, Teams and Zoom marked production; Jitsi built but unproven. Zoom joins only through the web client. Teams signed-in joins are partial.
- **Needs**: (a) screen share isn't wired; (b) chat reads return an empty list on every platform; (c) speech-to-text is swappable for any OpenAI-compatible endpoint, sent in roughly 2-second chunks, with no live audio export, and its WebSocket API is planned but not wired in the open-source core; (d) recording on by default to S3 or MinIO, but the end-to-end loop is unvalidated; (e) speak, chat-write and screen-share routes return 404.
- **Deployment**: Docker Compose (`make all`), a single-container "Lite" mode, and a Helm chart needing external S3. Per-bot resources undocumented.
- **Open issues that matter**: Teams flagging the bot as a "potential threat" and needing manual admission (14 October 2026); Teams "Join now" not found since 28 August; Zoom speech dropped under CPU starvation; a fresh install broken by removed MinIO images.
- Sources: [repository](https://github.com/Vexa-ai/vexa), [status](https://docs.vexa.ai/roadmap/status.md), [configuration](https://docs.vexa.ai/configuration.md), [webhooks](https://docs.vexa.ai/webhooks.md).

## joinly

- MIT, 569 stars, pre-1.0, built for AI agents that take part in meetings; joins all three platforms with Playwright.
- (a) `get_video_snapshot` takes a page screenshot on request (pull, not stream); (b) chat history and sending; (c) live transcript with pluggable speech-to-text (a Deepgram adapter exists); (d) no recording.
- Docker image of about 2.3 GB, with a CUDA variant. Pins Python 3.12 and Playwright 1.58.
- Useful as a reference for join flows on all three platforms.

## screenappai/meeting-bot

- MIT, 181 stars; Playwright joins for all three platforms; one job at a time.
- Recording through in-page `getDisplayMedia` and `MediaRecorder`, uploaded in chunks to S3 or Azure with webhook or Redis notifications. Frames, chat and live audio aren't exposed and would need a fork.
- Supports signed-in Chrome profiles for Google Meet through environment variables, though not wired into its local Compose file.
- Useful as a reference for join flows and recording upload.

## Dropped candidates

- **meetingbot/meetingbot**: LGPL-3.0, last default-branch commit 20 October 2025, AWS-specific Terraform deployment. Stale.
- **AgentCall**: the bot runs on a hosted service only; not self-hostable.
- **Meeting BaaS**: its open-source repositories are SDKs, examples and clients for its hosted API; the core bot repository returned 404 and its licence couldn't be verified.
- **recallai/meeting-bot**: a client for the hosted Recall.ai service.
- **Not bots**: Meetily and Hyprnote capture audio locally and don't join meetings as participants.

## Conclusion

- None of the projects meets all five needs. Attendee comes closest on (a) to (d) but has no browser control, uses Zoom's SDK route (now needing Zoom approval and tokens), and its licence forbids offering it as a service.
- Once the requester chose to join meetings as the member through their own signed-in accounts, browser control (e) became essential, and the attendance form must be submitted in the same signed-in browser. That points to building a small browser bot in-house, as the design does.
- Borrow join flows from the MIT-licensed joinly and screenappai/meeting-bot, with attribution; read Attendee for ideas only.
