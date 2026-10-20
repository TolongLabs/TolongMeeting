import { canonicalFormUrl, localParts, type FormCandidate, type JobConfig, type ResolvedForm } from '@tm/core'
import { formNotFilledPing, linkUncheckedPing, type Ping } from '@tm/notify'
import type { FormDispatcher } from './dispatcher'
import { LinkResolveError } from './links'
import { errorText } from './redact'
import { checkTrust } from './trust'
import type { FormContextBase } from './types'

export interface IntakeDeps {
  cfg: JobConfig
  resolve: (c: FormCandidate) => Promise<ResolvedForm | null>
  /**
   * Null when the dispatcher failed to start or is closed: links then reach the member as "link seen, not checked".
   * Read after the link resolved, so a property getter lets a late resolve see a dispatcher closed in the meantime.
   */
  dispatcher: FormDispatcher | null
  emitEvent: FormContextBase['emitEvent']
  /** Rejects when the ping could not be sent. */
  ping: (p: Ping) => Promise<void>
  /** Links being resolved right now (keyed by trust and raw URL), shared by every call of one run. */
  inFlight: Set<string>
  /** URLs already pinged ("link seen, not checked" or "form seen, not filled"), shared by every call of one run:
   * a chat replay pings once. */
  pinged: Set<string>
}

// Only the host of a web link reaches events: the rest can carry a passcode or pre-filled answers. Anything that is not
// an http(s) URL (arbitrary QR text) has no host.
function hostOf(url: string): string | null {
  if (!URL.canParse(url)) return null
  const u = new URL(url)
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null
}

const clockOf = (cfg: JobConfig, at: string): string => {
  const { hhmm } = localParts(at, cfg.entry.timeZone)
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
}

// Resolves a link seen on the shared screen or in the chat and offers the form to the dispatcher. It runs without being
// awaited, from the chat and frame loops, so it never rejects: every failure becomes a redacted `error` event.
//
// - A link that is not a form emits `form` {outcome: 'ignored', reason: 'not_a_form'}.
// - A link that cannot be resolved (timeout, network) emits `form` {outcome: 'unresolved'} and, for a trusted sighting,
//   pings "link seen, not checked": it may be an attendance form.
// - A resolved form when there is no dispatcher to take it (it failed to start, or it is closed) pings "form seen, not
//   filled", for a trusted or an untrusted sender, with the canonical form URL: the member hears about every form.
export async function onFormCandidate(c: FormCandidate, deps: IntakeDeps): Promise<void> {
  // Keyed by trust too: a trusted repost of a link that is resolving as untrusted must not be dropped.
  const key = `${checkTrust(c, deps.cfg.entry.trustedSenders).trusted ? 'trusted' : 'untrusted'}:${c.url}`
  if (deps.inFlight.has(key)) return
  deps.inFlight.add(key)
  try {
    await intake(c, deps)
  } catch (error) {
    await emitQuietly(deps, 'error', {
      where: 'form_intake',
      host: hostOf(c.url),
      message: errorText(deps.cfg, error)
    })
  } finally {
    deps.inFlight.delete(key)
  }
}

async function intake(c: FormCandidate, deps: IntakeDeps): Promise<void> {
  const host = hostOf(c.url)
  if (host === null) {
    await deps.emitEvent('form', { formId: null, outcome: 'ignored', reason: 'not_a_url', host, source: c.source })
    return
  }
  let form: ResolvedForm | null
  try {
    form = await deps.resolve(c)
  } catch (error) {
    if (!(error instanceof LinkResolveError)) throw error
    await unchecked(c, host, error.reason, deps)
    return
  }
  if (form === null) {
    await deps.emitEvent('form', { formId: null, outcome: 'ignored', reason: 'not_a_form', host, source: c.source })
    return
  }
  const { dispatcher } = deps
  if (dispatcher === null) {
    // The raw link can carry pre-filled answers: the member gets the canonical form URL.
    const canonical = { ...c, url: canonicalFormUrl(form.finalUrl) }
    await notFilled(canonical, host, deps)
    return
  }
  dispatcher.offer(form)
}

// A link that could not be checked is pinged only for a trusted sender: it may be an attendance form.
async function unchecked(c: FormCandidate, host: string, reason: string, deps: IntakeDeps): Promise<void> {
  const { cfg } = deps
  const trusted = checkTrust(c, cfg.entry.trustedSenders).trusted
  await reach(c, host, reason, deps, trusted ? (hhmm) => linkUncheckedPing(cfg.entry.name, c, hhmm) : null)
}

// A resolved form that no dispatcher took is pinged for a trusted or an untrusted sender.
async function notFilled(c: FormCandidate, host: string, deps: IntakeDeps): Promise<void> {
  await reach(c, host, 'dispatcher_unavailable', deps, (hhmm) => formNotFilledPing(deps.cfg.entry.name, c, hhmm, c.url))
}

// The member is pinged first (once per URL), then the event is written: a failing event writer must not keep the ping
// back. A ping that fails is not remembered, so the next sighting tries again, and its error is rethrown.
async function reach(
  c: FormCandidate,
  host: string,
  reason: string,
  deps: IntakeDeps,
  ping: ((hhmm: string) => Ping) | null
): Promise<void> {
  try {
    if (ping !== null && !deps.pinged.has(c.url)) {
      await deps.ping(ping(clockOf(deps.cfg, c.seenAt)))
      deps.pinged.add(c.url)
    }
  } finally {
    await deps.emitEvent('form', { formId: null, outcome: 'unresolved', reason, host, source: c.source })
  }
}

// A failing event writer must not turn into the rejection this function promises never to throw.
async function emitQuietly(deps: IntakeDeps, type: 'error', data: Record<string, unknown>): Promise<void> {
  try {
    await deps.emitEvent(type, data)
  } catch {
    console.error(`[tm-worker] could not emit a ${type} event`)
  }
}
