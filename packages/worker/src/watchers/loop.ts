import type { ChatMessage, FormCandidate } from '@tm/core'
import type { Page } from 'playwright'
import type { Stopper } from '../types'
import { chooseMeetingLink, messageSignature, nextPollDelayMs, splitLinks, type WatchPhase } from './rules'

/** One chat source (WhatsApp, Discord, Teams). Messages are oldest first. `desk` is the watcher's own desk tab. */
export interface ChatSourceReader {
  open(desk: Page): Promise<void>
  history(desk: Page, since: Date): Promise<ChatMessage[]>
  latest(desk: Page): Promise<ChatMessage[]>
}

/** The reader found the account signed out. The loop reports it once and keeps polling. */
export class WatcherSigninError extends Error {
  constructor(readonly host: string) {
    super(`signed out of ${host}`)
    this.name = 'WatcherSigninError'
  }
}

/** The reader could not find or read the chat. `lost` makes the loop reopen the chat at once. */
export class WatcherChatError extends Error {
  constructor(readonly reason: 'not_found' | 'ambiguous' | 'not_loaded' | 'lost') {
    super(`chat ${reason}`)
    this.name = 'WatcherChatError'
  }
}

export type WatcherStatus = { kind: 'signed_out'; host: string } | { kind: 'signed_in' } | { kind: 'chat_lost' }

/** The seam for time, phase and the desk. `deskStep` is the DeskPause busy gate: every desk action runs through it. */
export interface WatcherEnv {
  now(): Date
  random(): number
  sleep(ms: number): Promise<void>
  phase(): WatchPhase
  formsSince(): Date
  pastedLink(): string | null
  deskStep<T>(step: () => Promise<T>): Promise<T>
  onStatus(status: WatcherStatus): void
}

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const PHASE_CHECK_MS = 1000
const FAILURES_BEFORE_REOPEN = 3
const MAX_REOPENS = 3
const NEVER = new Date(8.64e15)

const defaultEnv = (): WatcherEnv => ({
  now: () => new Date(),
  random: Math.random,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  phase: () => 'before',
  formsSince: () => NEVER,
  pastedLink: () => null,
  deskStep: (step) => step(),
  onStatus: () => {}
})

let env = defaultEnv()

/** Replaces the named parts of the environment. Every decision reads the environment again, so a change applies at once. */
export function configureWatchers(over: Partial<WatcherEnv>): void {
  env = { ...env, ...over }
}

export function resetWatcherEnv(): void {
  env = defaultEnv()
}

type Read<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function read<T>(step: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await step() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Watches one chat. Resolves once the chat is open and its history is read (an open error rejects). Before joining it
 * reports the newest meeting link; once joining starts it offers form links. The Stopper wakes a sleeping loop and
 * resolves when the loop has exited.
 */
export async function runChatWatcher(
  desk: Page,
  reader: ChatSourceReader,
  onLink: (c: FormCandidate | { meetingUrl: string }) => void
): Promise<Stopper> {
  const seen = new Set<string>()
  const held: FormCandidate[] = []
  let newest: string | null = null
  let lastReported: string | null = null
  let signedOut = false
  let failures = 0
  let reopens = 0
  let stopped = false
  let lost = false
  let wakeUp = () => {}
  const woken = new Promise<void>((resolve) => (wakeUp = resolve))

  function process(messages: ChatMessage[]): void {
    for (const m of messages) {
      const signature = messageSignature(m)
      if (seen.has(signature)) continue
      seen.add(signature)
      const seenAt = env.now()
      const { meeting, other } = splitLinks(m)
      const before = env.phase() === 'before'
      if (before && meeting.length > 0) newest = meeting[meeting.length - 1]!
      for (const url of other) {
        const candidate: FormCandidate = {
          url,
          source: 'watched_chat',
          sender: m.sender || null,
          senderRole: 'unknown',
          seenAt: seenAt.toISOString()
        }
        if (!before) onLink(candidate)
        else if (seenAt >= env.formsSince()) held.push(candidate)
      }
    }
    if (env.phase() === 'during') {
      for (const candidate of held.splice(0)) onLink(candidate)
      return
    }
    const chosen = chooseMeetingLink(newest, env.pastedLink())
    if (chosen !== null && chosen !== lastReported) {
      lastReported = chosen
      onLink({ meetingUrl: chosen })
    }
  }

  const openAndScan = async (): Promise<ChatMessage[]> => {
    await env.deskStep(() => reader.open(desk))
    const since = env.phase() === 'before' ? new Date(env.now().getTime() - HISTORY_WINDOW_MS) : env.formsSince()
    return env.deskStep(() => reader.history(desk, since))
  }

  function goodRead(): void {
    failures = 0
    if (!signedOut) return
    signedOut = false
    env.onStatus({ kind: 'signed_in' })
  }

  function signedOutRead(error: WatcherSigninError): void {
    failures = 0
    if (signedOut) return
    signedOut = true
    env.onStatus({ kind: 'signed_out', host: error.host })
  }

  async function reopen(): Promise<void> {
    failures = 0
    reopens += 1
    if (reopens > MAX_REOPENS) {
      lost = true
      env.onStatus({ kind: 'chat_lost' })
      return
    }
    const result = await read(openAndScan)
    if (result.ok) {
      goodRead()
      process(result.value)
    } else if (result.error instanceof WatcherSigninError) signedOutRead(result.error)
    // Any other failure is left to the next poll, which meets it again and counts it.
  }

  async function poll(): Promise<void> {
    const result = await read(() => env.deskStep(() => reader.latest(desk)))
    if (result.ok) {
      reopens = 0
      goodRead()
      process(result.value)
    } else if (result.error instanceof WatcherSigninError) signedOutRead(result.error)
    else if (result.error instanceof WatcherChatError && result.error.reason === 'lost') await reopen()
    else if (++failures >= FAILURES_BEFORE_REOPEN) await reopen()
  }

  // Sleeps for the current phase's delay. Wakes early on stop, or when the phase changes (checked every second).
  async function pause(): Promise<void> {
    const startPhase = env.phase()
    let phaseChanged = () => {}
    const changed = new Promise<void>((resolve) => (phaseChanged = resolve))
    const timer = setInterval(() => {
      if (env.phase() !== startPhase) phaseChanged()
    }, PHASE_CHECK_MS)
    try {
      await Promise.race([env.sleep(nextPollDelayMs(startPhase, env.random)), woken, changed])
    } finally {
      clearInterval(timer)
    }
  }

  async function loop(): Promise<void> {
    while (!stopped && !lost) {
      await pause()
      if (!stopped) await poll()
    }
  }

  process(await openAndScan())
  const done = loop()
  return {
    stop: async () => {
      stopped = true
      wakeUp()
      await done
    }
  }
}
