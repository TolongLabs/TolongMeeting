import type { AsrResult } from '@tm/ai'
import { formatWhen } from '@tm/core'
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
  emit(atMs: number): void // becomes a `mention` event { atMs }; the event never carries text
  ping(p: Ping): Promise<void>
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
  let lastPingMs: number | null = null

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
          takeOverUrl: d.links?.takeOver ?? null
        }),
        r.endMs
      )
    }
  }
}
