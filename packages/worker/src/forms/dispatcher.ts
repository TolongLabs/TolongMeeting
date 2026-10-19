import {
  applyFormTrigger,
  formIdFor,
  isTerminalFormState,
  newFormRecord,
  type FormRecord,
  type ResolvedForm,
  type StopReason
} from '@tm/core'
import { handleForm } from './handler'
import { formPing } from './pings'
import { errorText } from './redact'
import { formEventData, loadFormRecords, saveFormRecord } from './store'
import { checkTrust } from './trust'
import type { FormContext, FormContextBase } from './types'

export interface FormDispatcher {
  offer(f: ResolvedForm): void
  close(): Promise<FormRecord[]> // aborts sign-in waits, waits for every running form, returns all records of this occurrence
}

type Handle = (f: ResolvedForm, ctx: FormContext) => Promise<FormRecord>

// What the dispatcher knows about one form. `record` is the latest one; it is null only while the first run is still
// going, or after a handler threw without returning one (the form then counts as handled and is never run again).
interface Entry {
  record: FormRecord | null
  running: boolean
  runningTrusted: boolean // whether the candidate now running was trusted
  pending: ResolvedForm | null // a trusted sighting that arrived while an untrusted run was going
  blockedPinged: boolean
}

const BLOCKED_REASON: StopReason = 'unexpected_error'

// Hands each form to `handle` once per meeting. A form is handled again only when it ended `untrusted` and a trusted
// sender later posted it, and then the handler continues from the saved record. Every form with a record on disk (a
// restart) counts as handled, and a `submitting` one is never resubmitted: it is failed as `interrupted_submitting`.
export async function startFormDispatcher(base: FormContextBase, handle: Handle = handleForm): Promise<FormDispatcher> {
  const { cfg } = base
  const abort = new AbortController()
  const entries = new Map<string, Entry>()
  const handledInvalid = new Set<string>()
  const tasks = new Set<Promise<void>>()
  let tabsBlocked = false // set by a form_tab_not_closed alert: no more form tabs this meeting
  let closing: Promise<FormRecord[]> | null = null

  // A failing emitter never stops the dispatcher: the record on disk already holds what happened.
  const emit: FormContextBase['emitEvent'] = async (type, data) => {
    try {
      await base.emitEvent(type, data)
    } catch {
      console.error(`[tm-worker] could not emit a ${type} event`)
    }
  }
  const emitError = (formId: string | null, error: unknown) =>
    emit('error', { where: 'form_dispatcher', ...(formId === null ? {} : { formId }), message: errorText(cfg, error) })
  const watched: FormContextBase = {
    ...base,
    emitEvent: async (type, data) => {
      if (type === 'alert' && data.kind === 'form_tab_not_closed') tabsBlocked = true
      await base.emitEvent(type, data)
    }
  }
  const pingOptions = { entryName: cfg.entry.name, timeZone: cfg.entry.timeZone, links: base.links }

  // Fails a record that is not terminal, saves it, emits it and pings the member.
  async function failRecord(rec: FormRecord, reason: StopReason): Promise<FormRecord> {
    let failed = applyFormTrigger({ ...rec, reason }, 'error', new Date().toISOString())
    await saveFormRecord(cfg.dataDir, failed)
    await emit('form', formEventData(failed))
    const ping = formPing(failed, pingOptions)
    if (ping !== null) {
      await base.ping(ping)
      failed = { ...failed, pings: [...failed.pings, { state: failed.state, at: new Date().toISOString() }] }
      await saveFormRecord(cfg.dataDir, failed)
    }
    return failed
  }

  const loaded = await loadFormRecords(cfg.dataDir)
  for (const formId of loaded.invalid) handledInvalid.add(formId)
  for (const rec of loaded.records) {
    const record = isTerminalFormState(rec.state)
      ? rec
      : await failRecord(rec, rec.state === 'submitting' ? 'interrupted_submitting' : 'interrupted')
    entries.set(rec.formId, { record, running: false, runningTrusted: false, pending: null, blockedPinged: false })
  }

  // One handler call. It never throws: a handler that throws leaves the record as it was.
  async function run(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<FormRecord | null> {
    try {
      const rec = await handle(f, { ...watched, previous, signal: abort.signal })
      entry.record = rec
      return rec
    } catch (error) {
      await emitError(entry.record?.formId ?? formIdFor(f.finalUrl), error)
      return entry.record
    }
  }

  // Runs `f`, then any trusted sighting that arrived meanwhile if the run ended untrusted.
  async function drive(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<void> {
    let rec = await run(entry, f, previous)
    while (rec !== null && rec.state === 'untrusted' && entry.pending !== null) {
      const next = entry.pending
      entry.pending = null
      entry.runningTrusted = true
      rec = await run(entry, next, rec)
    }
    entry.pending = null
    entry.running = false
  }

  function track(task: Promise<void>): void {
    const tracked = task.finally(() => tasks.delete(tracked))
    tasks.add(tracked)
  }

  // With form tabs blocked a new form is failed unopened; an untrusted one a trusted sender posted gets a ping only.
  async function refuse(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<void> {
    if (previous === null) {
      entry.record = await failRecord(newFormRecord(f, cfg.occurrenceId), BLOCKED_REASON)
    } else if (!entry.blockedPinged) {
      entry.blockedPinged = true
      const ping = formPing({ ...previous, state: 'failed', reason: BLOCKED_REASON }, pingOptions)
      if (ping !== null) await base.ping(ping)
    }
    entry.running = false
  }

  function start(entry: Entry, f: ResolvedForm, trusted: boolean, previous: FormRecord | null): void {
    entry.running = true
    entry.runningTrusted = trusted
    track(tabsBlocked ? refuse(entry, f, previous) : drive(entry, f, previous))
  }

  function offer(f: ResolvedForm): void {
    if (closing !== null) return
    if (!URL.canParse(f.finalUrl)) {
      track(emitError(null, new Error('a form candidate has a finalUrl that is not a URL')))
      return
    }
    const id = formIdFor(f.finalUrl)
    if (handledInvalid.has(id)) return
    const trusted = checkTrust(f, cfg.entry.trustedSenders).trusted
    const entry = entries.get(id)
    if (entry === undefined) {
      const created: Entry = {
        record: null,
        running: false,
        runningTrusted: false,
        pending: null,
        blockedPinged: false
      }
      entries.set(id, created)
      start(created, f, trusted, null)
    } else if (entry.running) {
      if (trusted && !entry.runningTrusted && entry.pending === null) entry.pending = f
    } else if (
      trusted &&
      entry.record?.state === 'untrusted' &&
      !entry.record.history.some((h) => h.state === 'submitting')
    ) {
      start(entry, f, true, entry.record)
    }
  }

  function close(): Promise<FormRecord[]> {
    closing ??= (async () => {
      abort.abort()
      while (tasks.size > 0) await Promise.all([...tasks])
      return [...entries.values()].flatMap((e) => (e.record === null ? [] : [e.record]))
    })()
    return closing
  }

  return { offer, close }
}
