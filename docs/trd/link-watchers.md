# Link watchers

How the worker finds meeting links and form links in the member's chats. What the member gets is in [link watching](../PRD.md#link-watching) in the PRD. The code lives in `packages/worker/src/watchers`, in milestone 2 (Teams in milestone 4). This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Placement](#placement)
1.  [Sources](#sources)
1.  [Behaviour](#behaviour)

## Placement

Watchers run as tabs in the desk window from T-60 until the meeting ends, kept open rather than reloaded. Each watches only the chat named in the timetable entry.

## Sources

- **WhatsApp Web**: the member links it once as a device from the Accounts page; the worker reads the chosen chat's latest messages. WhatsApp's linked-device state must survive restores, so [spike 7](../TRD.md#early-spikes) tests it.
- **Discord**: a server channel, group DM or DM, read on discord.com in the member's session.
- **Teams chat**: a chat or group chat in the Teams web client. Built with the Teams adapter.
- **Manual**: the member pastes a link on the website at any time; it overrides watched links.

## Behaviour

- At start, read the last 24 hours of the chat, then poll the visible messages every 25 to 45 seconds before the meeting and every 12 to 25 seconds during it, at random intervals.
- Extract meeting links before the meeting, and form links with their sender during it.
- Never send, react or mark-as-read beyond what opening the chat does.
- Entry points and the `ChatSourceReader` contract are in [worker interfaces](../TRD.md#worker-interfaces) and [additions by plan](../TRD.md#additions-by-plan).
