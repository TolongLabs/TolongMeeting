# Scheduler and control channel

How timetable entries become running workers, and how a worker and the server talk to each other. The behaviour the member sees is in [scheduling and attending](../PRD.md#scheduling-and-attending) in the PRD. The code lives in `packages/scheduler` and `packages/worker/src/control`, in milestone 1C. This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Scheduler](#scheduler)
1.  [Control channel](#control-channel)

## Scheduler

- **Expansion**: expands timetable entries into meeting occurrences 14 days ahead and enqueues a worker start at T-60 (SCH-1; designer's call).
- **Queue**: runs jobs from a Postgres-backed queue so restarts don't lose them.
- **Identity lock** (SCH-4): never runs two workers for the same identity at once, because a Chrome profile can't be open twice. The clash is found when the entry is saved and again at T-60.
- **Server capacity** (SCH-5): counts running server workers against the cap of 2 (decision 38) before starting one.
- **Health** (SCH-6): watches each worker's heartbeat (see [control channel](#control-channel)). No heartbeat for 30 seconds counts as a crash. It restarts the worker and rejoins, up to 3 times per occurrence, pinging the member each time. The restarted worker reuses the identity's working copy, which survives on the host volume and holds the freshest session state; it falls back to the latest checkpoint only if the working copy is damaged or missing (Chrome refuses to open it).
- **Retention**: deletes each occurrence's data 30 days after the meeting, after a normal-priority ping 3 days before (see [retention](../PRD.md#retention)).
- **Starting containers**: through the restricted Docker socket proxy (see [security and privacy](../TRD.md#security-and-privacy)).

## Control channel

- Each worker sends a heartbeat to the server every 5 seconds over HTTPS, with its state, recording status, participant count and pending events.
- The reply carries commands: `leave_now` (the member pressed "Make the bot leave"), `take_over` (leave, then the member's ping opens the meeting link), `pause_for_signin`, `resume_after_signin`, and `stop`.
- In local mode, the companion app relays the same heartbeat and commands, so the member's home network never needs to accept incoming connections.
- Events (joined, form seen, form submitted, alert, error) are stored in Postgres as they arrive, so a restarted worker knows which forms were already handled.
