import type { ChatApp, FormCandidate } from '@tm/core'
import type { Ping, PingAction } from './ntfy'

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
  | 'meet_signin'
  | 'devices_on'
  | 'no_audio'
  | 'signin_forms'
  | 'ai_key'
  | 'recording_gap'
  | 'form_ping_failed'
  | 'recording_unstable'
  | 'recorder_failed'
  | 'component_failed'
  | 'run_failed'
  | 'device_check_failed'
  | 'device_check_stopped'
  | 'no_link'

const SUMMARY_LIMIT_BYTES = 3900

/** The website pages a ping can link to (null when the worker does not know the website's address). */
export interface SiteLinks {
  meetingPage: string
  signIn: string
  leave: string
  takeOver: string
}

export function joinedPing(entry: string, participants: number | null, links?: SiteLinks | null): Ping {
  const message =
    participants === null
      ? 'In the meeting. Recording.'
      : `In the meeting with ${participants} participants. Recording.`
  return {
    title: `Joined: ${entry}`,
    message,
    priority: 'default',
    // Three actions at most (ntfy's limit).
    ...(links
      ? {
          actions: [
            { label: 'Open meeting page', url: links.meetingPage },
            { label: 'Make the bot leave', url: links.leave },
            { label: 'Take over', url: links.takeOver }
          ]
        }
      : {})
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

// A form the bot saw but did not fill (no dispatcher took it): the member opens it themselves.
export function formNotFilledPing(entry: string, c: FormCandidate, hhmm: string, url: string): Ping {
  const message =
    c.source === 'qr'
      ? `A QR code on the shared screen pointed to a form at ${hhmm}. The bot did not fill it. Open it yourself.`
      : `${c.sender ?? 'Someone'} shared a form at ${hhmm}. The bot did not fill it. Open it yourself.`
  return {
    title: `Form seen, not filled: ${entry}`,
    message,
    priority: 'high',
    actions: [{ label: 'Open form', url }]
  }
}

// The alerts that send the member to a page: an expired sign-in to the sign-in page, a missing link to the meeting page.
// One action each (ntfy allows at most 3 per message).
function alertActions(kind: AlertKind, links: SiteLinks | null | undefined): PingAction[] | null {
  if (!links) return null
  if (kind === 'zoom_signin' || kind === 'meet_signin' || kind === 'signin_forms') {
    return [{ label: 'Sign in again', url: links.signIn }]
  }
  if (kind === 'no_link') return [{ label: 'Open meeting page', url: links.meetingPage }]
  return null
}

export function alertPing(entry: string, kind: AlertKind, detail?: string, links?: SiteLinks | null): Ping {
  const actions = alertActions(kind, links)
  return {
    title: `Alert: ${entry}`,
    message: alertMessage(kind, detail),
    priority: 'high',
    ...(actions ? { actions } : {})
  }
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

export type WorkerFailureReason =
  'it crashed 3 times' | "it couldn't start" | 'it ran past the hard stop' | 'worker_unreachable'

/** Why the bot is not watching a chat for a meeting link. */
export type WatcherProblem = 'not_found' | 'ambiguous' | 'not_loaded' | 'lost' | 'signed_out'

const APP_NAME: Record<ChatApp, string> = { whatsapp: 'WhatsApp', discord: 'Discord', teams: 'Teams' }

// The actions whose URL is known. A null URL leaves its action out; no action at all leaves the field out.
function withActions(pairs: [label: string, url: string | null][]): { actions?: PingAction[] } {
  const actions = pairs.flatMap(([label, url]) => (url === null ? [] : [{ label, url }]))
  return actions.length > 0 ? { actions } : {}
}

function watcherProblemMessage(app: ChatApp, problem: WatcherProblem): string {
  const name = APP_NAME[app]
  switch (problem) {
    case 'not_found':
      return "The bot couldn't find the chat named on the timetable entry. Check it, and paste the meeting link on the meeting page this time."
    case 'ambiguous':
      return `More than one ${name} chat has the name on the timetable entry. Rename one or change the entry, and paste the meeting link on the meeting page this time.`
    case 'not_loaded':
      return `${name} didn't finish loading within 60 seconds, so the bot isn't watching the chat. Paste the meeting link on the meeting page if one is posted.`
    case 'lost':
      return "The bot lost the chat and stopped watching it. Paste the meeting link on the meeting page if one is posted; forms posted there won't be seen."
    case 'signed_out':
      return `${name} signed the bot out while it was watching. Sign in again; until then, new links in the chat aren't seen.`
  }
}

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
      message:
        p.reason === 'worker_unreachable'
          ? `The bot for ${p.entry} couldn't be reached, so the meeting was marked failed.`
          : `The bot stopped and won't retry (${p.reason}). Anything it recorded is on the meeting page.`,
      priority: 'high',
      actions: [{ label: 'Open meeting page', url: p.meetingUrl }]
    }
  },

  workerUnchecked(p: { entry: string; meetingUrl: string }): Ping {
    return {
      title: `Can't check your meeting bot: ${p.entry}`,
      message: `TolongMeeting can't check on the bot for ${p.entry} right now. It will keep trying; open the meeting page to see what it recorded.`,
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
  },

  // No link arrived by the time the bot gave up (T+30). `until` is the formatted give-up time.
  noLinkStopped(p: { entry: string; until: string; meetingUrl: string | null }): Ping {
    return {
      title: `Not attended: ${p.entry}`,
      message: `No meeting link arrived by ${p.until}, so the bot stopped without joining ${p.entry}.`,
      priority: 'default',
      ...withActions([['Open meeting page', p.meetingUrl]])
    }
  },

  // The member's name was said in a live-transcribed meeting. The transcript is cut of links and long numbers first.
  // The actions are left out when a URL is null (job-file runs have no website address).
  nameMentioned(p: {
    entry: string
    at: string
    transcript: string
    meetingUrl: string | null
    takeOverUrl: string | null
  }): Ping {
    return {
      title: `Your name was mentioned: ${p.entry}`,
      message: `Heard at ${p.at}. The last 30 seconds:\n${withoutMeetingDetails(p.transcript)}`,
      priority: 'high',
      ...withActions([
        ['Open meeting page', p.meetingUrl],
        ['Take over', p.takeOverUrl]
      ])
    }
  },

  // The bot cannot watch a chat for the link. "Sign in again" is offered only when the chat app signed the bot out.
  watcherProblem(p: {
    entry: string
    app: ChatApp
    problem: WatcherProblem
    meetingUrl: string | null
    signInUrl: string | null
  }): Ping {
    return {
      title: `Not watching ${APP_NAME[p.app]}: ${p.entry}`,
      message: watcherProblemMessage(p.app, p.problem),
      priority: 'high',
      ...withActions([
        ['Open meeting page', p.meetingUrl],
        ['Sign in again', p.problem === 'signed_out' ? p.signInUrl : null]
      ])
    }
  },

  // The gate keeps the bot off a chat: `home_only` for this identity's location, `none` for WhatsApp switched off.
  watchingOff(p: {
    entry: string
    app: ChatApp
    gate: 'home_only' | 'none'
    meetingUrl: string | null
    accountsUrl: string | null
  }): Ping {
    const name = APP_NAME[p.app]
    const message =
      p.gate === 'none'
        ? `${name} watching is switched off, so the bot won't watch it for ${p.entry}. Paste the meeting link on the meeting page.`
        : `${name} is watched only for identities that run at home or on your PC, so the bot won't watch it for ${p.entry}. Paste the meeting link on the meeting page, or change where this identity runs.`
    return {
      title: `Not watching ${name}: ${p.entry}`,
      message,
      priority: 'high',
      ...withActions([
        ['Open meeting page', p.meetingUrl],
        ['Open accounts', p.accountsUrl]
      ])
    }
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
    case 'meet_signin':
      return "Google asked to sign in, so the bot couldn't join the Meet call. Sign in to Google again for this identity."
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
    case 'recording_unstable':
      return 'The recorder keeps restarting. Parts of the recording are missing.'
    case 'recorder_failed':
      return 'The recorder stopped and could not restart. Nothing is recorded from now on.'
    case 'component_failed':
      return `The bot's ${requireDetail(kind, detail)} stopped working. The recording continues.`
    case 'run_failed':
      return 'The bot stopped unexpectedly. The meeting is no longer being recorded.'
    case 'device_check_failed':
      return 'The bot could not check that its microphone and camera are off, so it is rejoining the meeting.'
    case 'device_check_stopped':
      return 'The bot could not check its microphone and camera again, so it stopped.'
    case 'no_link':
      return 'There is no meeting link yet. Paste it on the meeting page; the bot keeps watching until 30 minutes after the start.'
  }
}

function requireDetail(kind: AlertKind, detail: string | undefined): string {
  if (detail === undefined || detail === '') {
    throw new Error(`alertPing ${kind} needs a detail`)
  }
  return detail
}

// Spoken text can carry a join link, a meeting ID or a passcode. A ping must never show one, so meeting-host links and
// runs of six or more digits (meeting IDs and six-digit passcodes) are replaced. Spoken words are not caught.
const MEETING_DETAILS: RegExp[] = [
  /(?:https?|zoommtg|zoomus|msteams|ms-teams):\S*/gi,
  /\b(?:[\w-]+\.)*(?:zoom\.us|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com)\S*/gi,
  /\bg\.co\/meet\S*/gi,
  /\d{6,}/g
]

function withoutMeetingDetails(text: string): string {
  return MEETING_DETAILS.reduce((out, pattern) => out.replace(pattern, '[removed]'), text)
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
