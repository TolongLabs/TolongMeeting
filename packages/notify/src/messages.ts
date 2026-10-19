import type { FormCandidate, ResolvedForm, TrustReason } from '@tm/core'
import type { Ping } from './ntfy'

export type AlertKind =
  | 'black_frames'
  | 'frozen_silent'
  | 'dropped'
  | 'rejoin_failed'
  | 'removed'
  | 'breakout'
  | 'lobby_denied'
  | 'not_admitted'
  | 'join_failed'
  | 'zoom_signin'
  | 'devices_on'
  | 'no_audio'
  | 'signin_forms'
  | 'ai_key'
  | 'recording_gap'
  | 'form_ping_failed'

const SUMMARY_LIMIT_BYTES = 3900

export function joinedPing(entry: string, participants: number | null): Ping {
  const message =
    participants === null
      ? 'In the meeting. Recording.'
      : `In the meeting with ${participants} participants. Recording.`
  return { title: `Joined: ${entry}`, message, priority: 'default' }
}

export function formToSubmitPing(entry: string, f: ResolvedForm, reason: TrustReason, hhmm: string): Ping {
  return {
    title: `Form to submit: ${entry}`,
    message: `A form from ${trustSource(reason, f.sender)} was seen at ${hhmm}. The bot doesn't submit forms yet: open it and submit it yourself.`,
    priority: 'high',
    actions: [{ label: 'Open form', url: f.finalUrl }]
  }
}

export function formNotSubmittedPing(entry: string, f: ResolvedForm, hhmm: string): Ping {
  return {
    title: `Form seen, not submitted: ${entry}`,
    message: `${f.sender ?? 'Someone'} posted a form in the chat at ${hhmm}. They aren't the host, a co-host or a trusted sender, so it wasn't treated as an attendance form.`,
    priority: 'high',
    actions: [{ label: 'Open form', url: f.finalUrl }]
  }
}

export function linkUncheckedPing(entry: string, c: FormCandidate, hhmm: string): Ping {
  const message =
    c.source === 'qr'
      ? `A QR code on the shared screen pointed to a link at ${hhmm} that couldn't be checked within 5 seconds. It may be a form.`
      : `${c.sender ?? 'Someone'} shared a link at ${hhmm} that couldn't be checked within 5 seconds. It may be a form.`
  return {
    title: `Link seen, not checked: ${entry}`,
    message,
    priority: 'high',
    actions: [{ label: 'Open link', url: c.url }]
  }
}

export function alertPing(entry: string, kind: AlertKind, detail?: string): Ping {
  return { title: `Alert: ${entry}`, message: alertMessage(kind, detail), priority: 'high' }
}

export function summaryReadyPing(entry: string, md: string, attachPath?: string): Ping {
  const cut = cutToBytes(md, SUMMARY_LIMIT_BYTES)
  return {
    title: `Summary ready: ${entry}`,
    message: cut === null ? md : `${cut}\n(truncated)`,
    priority: 'default',
    ...(attachPath === undefined ? {} : { attachPath })
  }
}

export function summaryFailedPing(entry: string, status: number): Ping {
  return {
    title: `Summary failed: ${entry}`,
    message: `Your AI key was rejected (${status}). Everything is kept; run tm-pipeline again after fixing the key.`,
    priority: 'high'
  }
}

export type WorkerFailureReason = 'it crashed 3 times' | "it couldn't start" | 'it ran past the hard stop'

// The member-facing pings of plan 01c. Each wording is fixed here; callers pass only the values that fill it in.
export const pings = {
  notificationsTest(): Ping {
    return {
      title: 'TolongMeeting test',
      message: 'Notifications work. Meeting pings will arrive here.',
      priority: 'default'
    }
  },

  identityClashSaved(p: { loser: string; winner: string; when: string; identity: string; timetableUrl: string }): Ping {
    return {
      title: `Timetable clash on ${p.identity}`,
      message: `${p.loser} at ${p.when} overlaps ${p.winner} on the same identity, so ${p.loser} won't be attended. Change a time or pick another identity.`,
      priority: 'high',
      actions: [{ label: 'Open timetable', url: p.timetableUrl }]
    }
  },

  identityClashSkipped(p: {
    entry: string
    when: string
    winner: string
    identity: string
    timetableUrl: string
  }): Ping {
    return {
      title: `Skipped: ${p.entry}`,
      message: `${p.entry} at ${p.when} overlaps ${p.winner}, which uses the same identity (${p.identity}), so the bot won't attend it.`,
      priority: 'high',
      actions: [{ label: 'Open timetable', url: p.timetableUrl }]
    }
  },

  capacityClash(p: { entry: string; when: string; identity: string; accountsUrl: string }): Ping {
    return {
      title: `Skipped: ${p.entry} (server full)`,
      message: `Two meetings are already running on the server, so the bot won't attend ${p.entry} at ${p.when}. To run it, switch the ${p.identity} identity to your PC.`,
      priority: 'high',
      actions: [{ label: 'Open accounts', url: p.accountsUrl }]
    }
  },

  workerRestarted(p: { entry: string; n: number; meetingUrl: string }): Ping {
    return {
      title: `Restarting: ${p.entry}`,
      message: `The bot stopped responding and is rejoining from its last checkpoint (restart ${p.n} of 3).`,
      priority: 'high',
      actions: [{ label: 'Open meeting page', url: p.meetingUrl }]
    }
  },

  workerFailed(p: { entry: string; reason: WorkerFailureReason; meetingUrl: string }): Ping {
    return {
      title: `Failed: ${p.entry}`,
      message: `The bot stopped and won't retry (${p.reason}). Anything it recorded is on the meeting page.`,
      priority: 'high',
      actions: [{ label: 'Open meeting page', url: p.meetingUrl }]
    }
  },

  deletionSoon(p: { entry: string; when: string; deleteOn: string; meetingUrl: string }): Ping {
    return {
      title: `Deleting in 3 days: ${p.entry}`,
      message: `${p.entry} (${p.when}) will be deleted from the server on ${p.deleteOn}. Export anything you want to keep before then.`,
      priority: 'default',
      actions: [{ label: 'Open meeting page', url: p.meetingUrl }]
    }
  },

  waitingForPc(p: { entry: string; meetingUrl: string }): Ping {
    return {
      title: `Waiting for your PC: ${p.entry}`,
      message: `Turn on your PC with the companion app to transcribe ${p.entry}.`,
      priority: 'default',
      actions: [{ label: 'Open meeting page', url: p.meetingUrl }]
    }
  },

  aiKeyProblem(p: { entry: string; status: number; meetingUrl: string; aiKeysUrl: string }): Ping {
    return {
      title: `Summary needs your key: ${p.entry}`,
      message: `DashScope refused your key (${p.status}). Everything is kept; fix the key on the AI keys page, then press Re-run on the meeting page.`,
      priority: 'high',
      actions: [
        { label: 'Open AI keys', url: p.aiKeysUrl },
        { label: 'Open meeting page', url: p.meetingUrl }
      ]
    }
  },

  pipelineFailed(p: { entry: string; meetingUrl: string }): Ping {
    return {
      title: `Summary failed: ${p.entry}`,
      message: 'Post-processing failed. The recording, chat and transcript are kept on the meeting page.',
      priority: 'high',
      actions: [{ label: 'Open meeting page', url: p.meetingUrl }]
    }
  }
}

// Sender-based sources need a name; a missing one is an error, not a blank in the copy.
function trustSource(reason: TrustReason, sender: string | null): string {
  switch (reason) {
    case 'qr_on_screen':
      return 'a QR code on the shared screen'
    case 'host':
      return 'the host'
    case 'co_host':
      return 'a co-host'
    case 'trusted_sender':
      if (sender === null) {
        throw new Error(`formToSubmitPing: reason ${reason} needs a sender name`)
      }
      return sender
    // The page itself is restricted to the member's organisation; the sender is not involved.
    case 'org_restricted':
      return 'your organisation'
  }
}

function alertMessage(kind: AlertKind, detail: string | undefined): string {
  switch (kind) {
    case 'black_frames':
      return 'The recording has been black for 10 seconds.'
    case 'frozen_silent':
      return 'Picture and sound have been frozen for 5 minutes.'
    case 'dropped':
      return 'The bot dropped out of the meeting and is rejoining.'
    case 'rejoin_failed':
      return 'The bot dropped out of the meeting again and stopped.'
    case 'removed':
      return 'The host removed the bot from the meeting.'
    case 'breakout':
      return 'The meeting offered a breakout room. The bot stays in the main room.'
    case 'lobby_denied':
      return "The host didn't let the bot in."
    case 'not_admitted':
      return 'The bot was still waiting to be let in at the hard stop.'
    case 'join_failed':
      return `The bot couldn't join: ${requireDetail(kind, detail)}.`
    case 'zoom_signin':
      return 'Zoom asked to sign in. Re-seed the profile, then run the job again.'
    case 'devices_on':
      return 'A microphone or camera showed as on, so the bot left the meeting.'
    case 'no_audio':
      return 'No meeting sound reached the recorder in the first 2 minutes.'
    case 'signin_forms':
      return `The ${requireDetail(kind, detail)} forms sign-in has expired. Form links will still be pinged to you.`
    case 'ai_key':
      return `Your AI key was rejected (${requireDetail(kind, detail)}). Recording continues; the summary needs a working key.`
    case 'recording_gap':
      return `The recorder restarted; ${requireDetail(kind, detail)} seconds are missing from the recording.`
    case 'form_ping_failed':
      return "A form couldn't be checked or pinged. Open the meeting page to see what the bot recorded."
  }
}

function requireDetail(kind: AlertKind, detail: string | undefined): string {
  if (detail === undefined || detail === '') {
    throw new Error(`alertPing ${kind} needs a detail`)
  }
  return detail
}

// Cuts text to at most `limit` UTF-8 bytes without splitting a character.
// Returns null when the text already fits.
function cutToBytes(text: string, limit: number): string | null {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) {
    return null
  }
  let end = limit
  // 10xxxxxx marks a continuation byte; move back to the lead byte of the split character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--
  }
  return new TextDecoder().decode(bytes.subarray(0, end))
}
