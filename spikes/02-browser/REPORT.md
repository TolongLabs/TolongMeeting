# Spike 02: browser in the container

Does pinned full Chrome, driven by Playwright in the worker image on Xvfb, join, hear, read chat and detect the end on Zoom, Teams and Meet, with the stage and desk layout, the Chrome flags and the policy? Not run: the image could not be built on this machine, and no accounts or test meetings exist. Recorded on 2026-10-20.

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

Not run. No design or plan change was made from this spike. The prototype worker image (`spikes/00-setup/worker/`) and the pins in `docker/worker/versions.env` are committed but unverified.

## Setup

- **Machine**: local workstation, not the Singapore server. Docker 29.1.3 with the containerd snapshotter.
- **Pins** (sources checked, image not built):
  - Node 24.22.0 (Node dist index).
  - Chrome 155.0.8059.84 (Google package index; `.deb` SHA-256 `8fbd2ae69cdf7ee98b7513c3396a7b5e06f974f8625fdd590df3091dd0c3e9de`, unverified against a build).
  - Playwright 1.64.1 (release notes list Chrome 155).
  - ffmpeg `7:5.1.9-0+deb12u1` (Debian 12 package).
  - Bun 1.4.3 (GitHub release `bun-v1.4.3`, 2026-10-10, and npm).

## Procedure

Task 2 steps 1 to 9 are not run:

- **J1 to J5, J9, J10, J12 and the background-tab check**: no accounts or test meetings on this machine.
- **J6, J7, J8, J11 and the stage part of J2**: the root filesystem is full, so `docker build` fails in the apt step (`You don't have enough free space in /var/cache/apt/archives`).

## Measurements

None.

## Decisions

All are the design defaults and unverified:

| Key                     | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| `chrome.args`           | `DESIGN_ARGS` in `spikes/00-setup/worker/browser.mjs` |
| `chrome.policyFile`     | `spikes/00-setup/worker/chrome-policy.json`           |
| `chrome.deskMute`       | `init_script` (plan method A; the design names none)  |
| `chrome.captureBlock`   | `policy`                                              |
| `worker.concurrencyCap` | 2 (design decision 38)                                |
| `worker.cpuLimit`       | not set (spike 6)                                     |
| `worker.memoryLimitGb`  | not set (spike 6)                                     |

## Design and plan edits

None.

## Surprises

- Docker's root directory is in `/home`, but the containerd snapshotter keeps image layers in `/var/lib/containerd` on the root filesystem, which was full.
- `/tmp` is a 1 GB tmpfs, too small for frame or image work.

## Data

Next checks, in order, once the image builds:

1.  Build the image twice and check the Chrome version and the `.deb` SHA-256.
1.  Run the display, audio and window smoke test (Task 0 step 6).
1.  Run `flags-check.mjs` for J6, J7, J11 and the no-sign-in part of J8.
1.  Freeze `DESIGN_ARGS` and the policy (Task 2 step 8).
1.  Run the account-based checks (Task 2 steps 1 and 3 to 7).
