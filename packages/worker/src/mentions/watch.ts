import { readFile } from 'node:fs/promises'
import type { AsrResult } from '@tm/ai'
import { formatWhen, meetingPasscode } from '@tm/core'
import { pings, type Ping } from '@tm/notify'
import { compileNames, findMention, transcriptWindow } from './match'

/** A second ping waits until this much stream offset has passed since the last one (a roll call names the member often). */
export const MENTION_DEBOUNCE_MS = 120_000
// Results older than this, counted back from the newest, are dropped: the ping quotes the last 30 seconds only.
const KEEP_MS = 60_000

export interface MentionWatchDeps {
  names: string[] // cfg.member.mentionNames
  entry: string
  timeZone: string
  recordingStartedAt: Date // the wall-clock time that live.jsonl offsets count from
  links: { meetingPage: string; takeOver: string } | null
  /** The link the bot joined with, as given (and as normalised): the passcode it carries is cut from the quoted speech. */
  joinedLinks?: string[]
  /** When the last ping went out in an earlier run of this watch (see `lastMentionPing`); null or absent: none. */
  lastPingAt?: Date | null
  emit(atMs: number): void // becomes a `mention` event { atMs }; the event never carries text
  ping(p: Ping): Promise<void>
}

/**
 * When the last ping went out, from the occurrence's `mention` events (`events.jsonl`, which a restarted worker keeps):
 * the debounce is replayed over them, so a roll call that named the member ten times counts one ping, as it did. Null
 * when there is no such event. A line that is not a mention event is skipped; a file that is missing holds none.
 */
export async function lastMentionPing(eventsFile: string): Promise<Date | null> {
  let text: string
  try {
    text = await readFile(eventsFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let last: number | null = null
  for (const line of text.split('\n')) {
    let event: { type?: unknown; at?: unknown }
    try {
      event = JSON.parse(line) as { type?: unknown; at?: unknown }
    } catch {
      continue // an empty line, or one cut short by a crash
    }
    if (event.type !== 'mention' || typeof event.at !== 'string') continue
    const at = Date.parse(event.at)
    if (Number.isNaN(at)) continue
    if (last === null || at - last >= MENTION_DEBOUNCE_MS) last = at
  }
  return last === null ? null : new Date(last)
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown')

/**
 * Watches live results for the member's names. Every matching result is emitted as a mention (its offset only), and
 * pings with the last 30 seconds when no ping went out in the last MENTION_DEBOUNCE_MS of stream offset. A failure of
 * `emit` or `ping` is logged by name and never reaches the caller, which is the speech path. Null when no name is
 * long enough to match.
 */
export function startMentionWatch(d: MentionWatchDeps): { onResult(r: AsrResult): void } | null {
  const names = compileNames(d.names)
  if (names.length === 0) return null
  let recent: AsrResult[] = []
  // Stream offsets count from `recordingStartedAt`; a ping an earlier run sent counts from there too (it may be negative).
  let lastPingMs: number | null = d.lastPingAt == null ? null : d.lastPingAt.getTime() - d.recordingStartedAt.getTime()
  let newestMs = Number.NEGATIVE_INFINITY
  const passcode = (d.joinedLinks ?? []).map(meetingPasscode).find((p) => p !== null) ?? null

  const send = async (p: Ping, sentAtMs: number): Promise<void> => {
    try {
      await d.ping(p)
    } catch (e) {
      if (lastPingMs === sentAtMs) lastPingMs = null // the member heard nothing, so the next mention may try again
      console.error(`mention ping failed (${errorName(e)})`)
    }
  }

  return {
    onResult(r) {
      // A result whose offset is behind the newest one (a reconnect that replays older speech) is ignored: it must not
      // move the debounce back, or hold every later ping off until the offsets catch up.
      if (r.endMs < newestMs) return
      newestMs = r.endMs
      recent = [...recent.filter((x) => x.endMs > r.endMs - KEEP_MS), r]
      if (findMention(r.text, names) === null) return
      try {
        d.emit(r.endMs)
      } catch (e) {
        console.error(`mention event failed (${errorName(e)})`)
      }
      if (lastPingMs !== null && r.endMs - lastPingMs < MENTION_DEBOUNCE_MS) return
      lastPingMs = r.endMs
      void send(
        pings.nameMentioned({
          entry: d.entry,
          at: formatWhen(new Date(d.recordingStartedAt.getTime() + r.endMs), d.timeZone),
          transcript: transcriptWindow(recent, r.endMs),
          meetingUrl: d.links?.meetingPage ?? null,
          takeOverUrl: d.links?.takeOver ?? null,
          passcode
        }),
        r.endMs
      )
    }
  }
}
