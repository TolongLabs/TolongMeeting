# Website and API

How the website and its API are built. What the member can do on each page is in the [design](../DESIGN.md#website-pages) and the requirements are WEB-1 to WEB-11 in the [PRD](../PRD.md#website-and-accounts). The code lives in `packages/web`, in milestone 1C. This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Sign-in and organisation check](#sign-in-and-organisation-check)
1.  [API and isolation](#api-and-isolation)
1.  [Remote sign-in view](#remote-sign-in-view)
1.  [Routes for other processes](#routes-for-other-processes)

## Sign-in and organisation check

- The website and API run on Next.js with Bun, behind Caddy. Sign-in is GitHub OAuth through the `read:org` scope, restricted to the TolongLabs organisation (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_ORG` in [environment variables](../TRD.md#environment-variables)).
- The organisation check runs at each sign-in and daily; a member who has left the organisation has their sessions ended ([WEB-1](../PRD.md#website-and-accounts)).
- Tables for members, identities, profiles and the rest are in [database](../TRD.md#database).

## API and isolation

- Every API handler resolves the signed-in member first and filters by that member's id. A second member's session must not reach the first member's meetings, profiles, files or ntfy topic; the isolation acceptance test checks it through the website and API.
- Admin routes add and remove members only. They expose no member data.
- API bodies are validated with zod.

## Remote sign-in view

- A worker's desk is served to the browser by noVNC, with x11vnc clipped to the desk half of the screen. The stage is never shown, so credentials and forms are never recorded.
- Access control for the view (Caddy `forward_auth`, owner only, idle timeout) is in [security and privacy](../TRD.md#security-and-privacy).
- If a worker is running for the identity, the website sends it `pause_for_signin` through the [control channel](scheduler-and-control.md#control-channel) and attaches to that worker's desk. "Done" sends `resume_after_signin`. Otherwise the scheduler starts a short-lived sign-in container for the identity.
- In local mode the companion app serves the same view locally ([run locations](notifications-and-companion.md#run-locations)).

## Routes for other processes

- The scheduler, the pipeline and the workers reach the website's database and heartbeat endpoint through the shared packages and the control URL in the job configuration ([core types](../TRD.md#core-types)).
- The companion app uses `/api/companion/*` routes with a device token, covered in [companion app](notifications-and-companion.md#companion-app).
- Meeting pages live at `${TM_PUBLIC_URL}/meetings/<occurrenceId>` ([name reconciliation](../TRD.md#name-reconciliation)).
