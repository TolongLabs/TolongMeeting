# Exports

How a meeting leaves the app for the member's own files and services. What the member can export is in [exports](../PRD.md#exports) in the PRD. The code lives in `packages/exports` and the `tm-exports` process, in milestone 7. This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Targets](#targets)
1.  [Runner](#runner)
1.  [Credentials](#credentials)

## Targets

Each export target is a module behind one interface (`ExportTarget`), so more can be added later.

- **Download**: builds the Markdown zip and the PDF from the occurrence's `out/` directory. The zip holds one folder with the summary as `summary.md`, then `transcript.md`, `slides.md`, `chat.md` and `slides/NN.webp`. The result's file path is relative to the occurrence directory.
- **Google Docs**: one document per meeting, created through Google sign-in with only the `drive.file` scope. The folder is "TolongMeeting Exports" or one the member picks with the Google Picker.
- **GitHub**: commits the three-file set and summary through a fine-grained token limited to the repository the member configures.
- **Notion**: creates one page per meeting under a parent page or database the member shares with the TolongLabs Notion integration. A re-export updates the page the member's earlier export made (never another page); if that page is gone, trashed or no longer under the chosen parent, it makes a new one. Slide images are uploaded to Notion from the re-encoded JPEGs.

## Runner

`tm-exports` (`packages/exports/src/main.ts`, Compose service `exports`) is the only process that runs exports. The `exports` table is its queue: `claimNext` makes one `queued` row `running` (`for update skip locked`), so no row runs twice. It serves members in turn: it takes the oldest row of the member whose latest claim is the oldest (a member never served goes first), so one member's backlog can't starve the others. There is no automatic retry, because an export writes to the member's own services; the member presses the button again.

- **Start**: the environment is checked first (an error names variables, never values). Rows still `running` belong to a process that died: they fail with `interrupted` and the member is pinged. Rows of deleted meetings are purged then and every hour.
- **Per-member cap**: a member may have 3 exports queued or running at once (all meetings together). A fourth request answers 429 with a fixed message; a finished export frees a place.
- **Replaced downloads**: when a zip or PDF succeeds, the same member's earlier succeeded download of the same meeting and target loses its file. Its row stays, with no file path and the note "Replaced by a newer export.", and the API shows it as `replaced` with no download link. Disk use per meeting and target is one file.
- **Limits**: an export fails after 10 minutes (its network calls are aborted) and a download larger than 512 MB is refused and removed. A target can only leave `exports/<exportId>.zip` or `.pdf`, and an `exports/` folder that is a symlink is refused.
- **Silent providers**: a provider call from a web route stops after 15 s, and one from the runner stops with the export's 10-minute deadline. A network error, timeout or abort answers `google_unavailable`, `github_unavailable` or `notion_unavailable` (502) in a route and a fixed sentence in an export. A sign-in callback always clears its cookie, also when something unexpected throws. A download that is ready after the deadline is never written, and a file a target writes late is removed when the target settles.
- **Messages**: the text of an error is cleaned with `redact` (the connection's tokens, including a rotated one, and known token shapes) before it is stored, shown or pinged. Logs hold `export <id> <target> <status> [<code>]` and the name and code of an unexpected error, never its message.
- **Stop**: SIGTERM stops claiming, lets the export in progress finish for up to 30 s and closes the database. A health file (`/tmp/tm-exports-alive`) is touched every 5 s. Compose runs it as uid 1000, read-only, with no capabilities, on `backend` (Postgres) and `app` (the providers and ntfy). The occurrences directory is the one writable bind mount.

## Credentials

- TolongLabs owns the Google OAuth client and publishes it "In production", so refresh tokens don't expire after 7 days.
- Export tokens are encrypted at rest and never logged (see [security and privacy](../TRD.md#security-and-privacy)). The companion token can't reach them.
- Results and errors go to the meeting page and are pinged (EXP-6). The environment variables are in [environment variables](../TRD.md#environment-variables).
