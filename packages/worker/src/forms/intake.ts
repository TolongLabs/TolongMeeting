import { localParts, type FormCandidate, type JobConfig, type ResolvedForm } from '@tm/core'
import { linkUncheckedPing, type Ping } from '@tm/notify'
import type { FormDispatcher } from './dispatcher'
import { LinkResolveError } from './links'
import { errorText } from './redact'
import { checkTrust } from './trust'
import type { FormContextBase } from './types'

export interface IntakeDeps {
  cfg: JobConfig
  resolve: (c: FormCandidate) => Promise<ResolvedForm | null>
  /** Null when the dispatcher failed to start: trusted links then reach the member as "link seen, not checked". */
  dispatcher: FormDispatcher | null
  emitEvent: FormContextBase['emitEvent']
  ping: (p: Ping) => Promise<void>
  /** Raw URLs being resolved right now, shared by every call of one run. The dispatcher dedupes resolved forms. */
  inFlight: Set<string>
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
//   pings "link seen, not checked": it may be an attendance form. The same happens to a resolved form when there is no
//   dispatcher to take it.
export async function onFormCandidate(c: FormCandidate, deps: IntakeDeps): Promise<void> {
  if (deps.inFlight.has(c.url)) return
  deps.inFlight.add(c.url)
  try {
    await intake(c, deps)
  } catch (error) {
    await emitQuietly(deps, 'error', {
      where: 'form_intake',
      host: hostOf(c.url),
      message: errorText(deps.cfg, error)
    })
  } finally {
    deps.inFlight.delete(c.url)
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
  if (deps.dispatcher === null) {
    await unchecked(c, host, 'dispatcher_unavailable', deps)
    return
  }
  deps.dispatcher.offer(form)
}

async function unchecked(c: FormCandidate, host: string, reason: string, deps: IntakeDeps): Promise<void> {
  const { cfg } = deps
  await deps.emitEvent('form', { formId: null, outcome: 'unresolved', reason, host, source: c.source })
  if (checkTrust(c, cfg.entry.trustedSenders).trusted) {
    await deps.ping(linkUncheckedPing(cfg.entry.name, c, clockOf(cfg, c.seenAt)))
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
