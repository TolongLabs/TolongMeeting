# Spike 08: ntfy attachments

Can the summary file be attached to the "summary ready" ping without one member's file reaching anyone else? No: ntfy 2.32.0 serves an attachment to anyone who has its URL, so `ntfy.attachSummary=false`. Run on 2026-10-19 against a local container (`binwiederhier/ntfy` 2.32.0), not the Singapore server.

## Verdict

Fail on N1 and N2, pass on N3, N4 not run.

- N1 (no token): the attachment URL returns 200 without any `Authorization` header.
- N2 (other member's token): member 2's token also gets 200 on member 1's attachment. The download route checks no topic access, and no server setting changes that.
- N3 (expiry): with `attachment-expiry-duration: '2m'`, the file is gone from disk and the URL returns 404 once the expiry passes. The 3-hour run published with `expires - published = 10800` seconds, as configured.
- N4 (phone app): not run. It needs a public DNS name and a phone.

Because N2 fails, an attachment would break anti-goal 6. The summary ping links to the meeting page instead, which `docs/trd/notifications-and-companion.md` already says.

## Setup

- ntfy 2.32.0 in Docker, `auth-default-access: 'deny-all'`, two users each with read-write on their own topic only (`server.yml`, `compose.yaml`).
- Deviation: port 18090 instead of 8090, because 8090 is taken on this machine.
- `check.sh` publishes a small Markdown file as member 1, then requests the attachment URL with no token, member 2's token and member 1's token.
- `compose.expiry-test.yaml` overrides the expiry to 2 minutes for N3.

## Other findings

- ntfy rejects a message with more than 3 actions: `400 invalid request: actions invalid; only 3 actions allowed`. Every ping in `packages/notify/src/messages.ts` uses at most 2, and `sendPing` surfaces the 400 as a `PingError`.
- Priority and `view` actions survive both the JSON publish and the attachment (`PUT`) publish.

## Data

`data/ntfy.json` holds both runs (3-hour and 2-minute expiry), including the HTTP status of each N request.
