import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  EventType,
  FormCandidate,
  FormProvider,
  FormSource,
  FormState,
  JobConfig,
  ResolvedForm,
  SenderRole,
  TrustReason
} from '@tm/core'
import { canonicalFormUrl, formIdFor, IllegalTransition, localParts, nextFormState } from '@tm/core'
import { formNotSubmittedPing, formToSubmitPing, linkUncheckedPing, type Ping } from '@tm/notify'
import { LinkResolveError, normaliseFormUrl, resolveFormLink } from './links'
import { loadHandledFormIds, writeFileAtomic } from './store'
import { checkTrust } from './trust'

export interface FormPingerDeps {
  cfg: JobConfig
  send: (p: Ping) => Promise<void>
  emit: (type: EventType, data: Record<string, unknown>) => Promise<void>
  resolve?: typeof resolveFormLink
  now?: () => Date
}

export interface FormPinger {
  // Settles once the forms already on disk are known. It rejects if the forms directory cannot be read. `offer`
  // waits for it, so callers need not.
  readonly ready: Promise<void>
  offer(c: FormCandidate): Promise<void>
  idle(): Promise<void>
}

export interface FormPingRecord {
  formId: string
  url: string
  source: FormSource
  sender: string | null
  senderRole: SenderRole | null
  seenAt: string
  provider: FormProvider | null
  state: FormState
  trustReason: TrustReason | null
  pingedAt: string | null
}

interface Location {
  host: string
  path: string
}

// Only host and path reach events and logs, never the query.
function locate(url: string): Location {
  const u = new URL(url)
  return { host: u.host, path: u.pathname }
}

// Only non-terminal states have an 'error' edge. Terminal states such as needs_member keep their state.
function canFail(state: FormState): boolean {
  try {
    nextFormState(state, 'error')
    return true
  } catch (err) {
    if (err instanceof IllegalTransition) return false
    throw err
  }
}

// A resolver timeout is reported by its reason alone: its message names the link.
function messageOf(err: unknown): string {
  if (err instanceof LinkResolveError) return err.reason
  return err instanceof Error ? err.message : String(err)
}

// Reporting must never reject a task: idle() would rethrow it. A report that cannot be emitted goes to stderr,
// with only host, path and the message.
async function emitOrStderr(
  emit: FormPingerDeps['emit'],
  type: EventType,
  data: Record<string, unknown>,
  at: { host: string | null; path: string | null }
): Promise<void> {
  try {
    await emit(type, data)
  } catch (err) {
    console.error(`form pinger: ${type} not emitted for host=${at.host} path=${at.path}: ${messageOf(err)}`)
  }
}

export function createFormPinger(deps: FormPingerDeps): FormPinger {
  const { cfg, send, emit } = deps
  const resolve = deps.resolve ?? resolveFormLink
  const now = deps.now ?? (() => new Date())
  const offered = new Set<string>() // raw URLs seen in flight or done
  const formKeys = new Set<string>() // normalised final URLs: one ping per form
  const tasks = new Set<Promise<void>>()
  // Forms an earlier run already pinged (or whose record cannot be parsed): see loadHandledFormIds. A form with no
  // record, or whose record shows no ping went out, is not here, so a restart pings it.
  const handled = new Set<string>()
  const ready = loadHandledFormIds(cfg.dataDir).then((ids) => {
    for (const id of ids) handled.add(id)
  })
  // A caller that never reads `ready` must not trigger an unhandled rejection: `offer` rethrows it.
  ready.catch(() => {})

  // Times in pings are wall-clock HH:MM in the entry's zone.
  function clockOf(at: string): string {
    const { hhmm } = localParts(at, cfg.entry.timeZone)
    return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
  }

  async function writeRecord(rec: FormPingRecord): Promise<void> {
    const dir = join(cfg.dataDir, 'forms', rec.formId)
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, 'record.json'), `${JSON.stringify(rec, null, 2)}\n`)
  }

  async function commit(rec: FormPingRecord, at: Location): Promise<void> {
    await writeRecord(rec)
    await emit('form', {
      formId: rec.formId,
      state: rec.state,
      source: rec.source,
      trustReason: rec.trustReason,
      ...at
    })
  }

  async function reportUnresolved(c: FormCandidate, err: LinkResolveError, at: Location): Promise<void> {
    if (checkTrust(c, cfg.entry.trustedSenders).trusted) {
      await send(linkUncheckedPing(cfg.entry.name, c, clockOf(c.seenAt)))
    } else {
      // No ping went out, so the link is not done: a later trusted posting of the same URL is still checked.
      offered.delete(c.url)
    }
    await emit('form', { formId: null, outcome: 'unresolved', reason: err.reason, ...at })
  }

  async function run(c: FormCandidate): Promise<void> {
    let state: FormState = 'detected'
    let location: Location | null = null
    let formId: string | null = null
    let claimedKey: string | null = null
    let rec: FormPingRecord | null = null
    let pinged = false // the ping's send resolved; the record write can fail after this without undoing it
    try {
      // Text that is not a URL (arbitrary QR content) is not a form, so it is ignored rather than failed.
      if (!URL.canParse(c.url)) {
        await emit('form', { formId: null, outcome: 'ignored', host: null, path: null })
        return
      }
      location = locate(c.url)
      state = nextFormState(state, 'resolve_started')
      await emit('form', { formId: null, state, source: c.source, trustReason: null, ...location })

      let form: ResolvedForm | null
      try {
        form = await resolve(c)
      } catch (err) {
        if (!(err instanceof LinkResolveError)) throw err
        await reportUnresolved(c, err, location)
        return
      }
      if (form === null) {
        await emit('form', { formId: null, outcome: 'ignored', ...location })
        return
      }

      // A form an earlier run already pinged is not pinged again. One whose ping never went out is pinged here.
      const found = formIdFor(form.finalUrl)
      if (handled.has(found)) {
        location = locate(form.finalUrl)
        await emit('form', { formId: found, outcome: 'ignored', reason: 'already_handled', ...location })
        return
      }

      // Checked and claimed with no await in between, so two candidates for one form cannot both ping.
      const key = normaliseFormUrl(form.finalUrl)
      if (formKeys.has(key)) return
      formKeys.add(key)
      claimedKey = key
      formId = found

      location = locate(form.finalUrl)
      state = nextFormState(state, 'resolved')
      rec = {
        formId,
        url: c.url,
        source: c.source,
        sender: c.sender,
        senderRole: c.senderRole,
        seenAt: c.seenAt,
        provider: form.provider,
        state,
        trustReason: null,
        pingedAt: null
      }
      await commit(rec, location)

      // The member opens the link from the ping, so it is the plain form page: no prefilled answers, no direct submit.
      const plainForm: ResolvedForm = { ...form, finalUrl: canonicalFormUrl(form.finalUrl) }

      // The ping goes out before the state moves, so a failed send leaves the form in a state that can still fail.
      const decision = checkTrust(form, cfg.entry.trustedSenders)
      if (decision.reason !== null) {
        await send(formToSubmitPing(cfg.entry.name, plainForm, decision.reason, clockOf(c.seenAt)))
        pinged = true
        state = nextFormState(state, 'manual_only')
      } else {
        await send(formNotSubmittedPing(cfg.entry.name, plainForm, clockOf(c.seenAt)))
        pinged = true
        state = nextFormState(state, 'trust_failed')
      }
      rec = { ...rec, state, trustReason: decision.reason, pingedAt: now().toISOString() }
      await commit(rec, location)
    } catch (err) {
      const ended: FormState = canFail(state) ? nextFormState(state, 'error') : state
      const failed = ended === 'failed'
      // A claimed form whose ping never went out is released whatever state it stopped in. Such a claim always
      // sits in checking_trust, which has a 'fail' edge, so `ended` is 'failed' for it too.
      const unpinged = claimedKey !== null && !pinged
      // Not pinged, so a later sighting of this form or raw URL must be handled again.
      if (failed || unpinged) offered.delete(c.url)
      if (claimedKey !== null && !pinged) formKeys.delete(claimedKey)

      let recordMessage: string | null = null
      if (rec !== null) {
        try {
          await writeRecord({ ...rec, state: ended })
        } catch (writeErr) {
          recordMessage = messageOf(writeErr)
        }
      }

      const at = location ?? { host: null, path: null }
      await emitOrStderr(
        emit,
        'error',
        { where: 'form', formId, state: ended, ...at, message: messageOf(err), recordMessage },
        at
      )
      if (failed || unpinged) {
        await emitOrStderr(emit, 'alert', { kind: 'form_ping_failed', formId, ...at }, at)
      }
    }
  }

  return {
    ready,
    async offer(c) {
      try {
        await ready
      } catch (err) {
        // The forms directory cannot be read, so no form can be checked for a ping. Every offer says so, then fails.
        await emitOrStderr(
          emit,
          'error',
          { where: 'form', formId: null, state: null, host: null, path: null, message: messageOf(err) },
          { host: null, path: null }
        )
        throw err
      }
      if (offered.has(c.url)) return
      offered.add(c.url)
      const task: Promise<void> = run(c).finally(() => tasks.delete(task))
      tasks.add(task)
    },
    async idle() {
      while (tasks.size > 0) await Promise.all([...tasks])
    }
  }
}
