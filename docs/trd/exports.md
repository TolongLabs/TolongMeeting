# Exports

How a meeting leaves the app for the member's own files and services. What the member can export is in [exports](../PRD.md#exports) in the PRD. The code lives in `packages/exports` and the `tm-exports` process, in milestone 7. This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Targets](#targets)
1.  [Credentials](#credentials)

## Targets

Each export target is a module behind one interface (`ExportTarget`), so more can be added later.

- **Download**: builds the Markdown zip and the PDF from the occurrence's `out/` directory.
- **Google Docs**: one document per meeting, created through Google sign-in with only the `drive.file` scope. The folder is "TolongMeeting Exports" or one the member picks with the Google Picker.
- **GitHub**: commits the three-file set and summary through a fine-grained token limited to the repository the member configures.
- **Notion**: creates one page per meeting under a parent page or database the member shares with the TolongLabs Notion integration.

## Credentials

- TolongLabs owns the Google OAuth client and publishes it "In production", so refresh tokens don't expire after 7 days.
- Export tokens are encrypted at rest and never logged (see [security and privacy](../TRD.md#security-and-privacy)). The companion token can't reach them.
- Results and errors go to the meeting page and are pinged (EXP-6). The environment variables are in [environment variables](../TRD.md#environment-variables).
