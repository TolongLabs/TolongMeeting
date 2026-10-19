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
// going, or when even the fallback record for a crashed first run could not be built.
interface Entry {
  record: FormRecord | null
  running: boolean // queued for a slot or running
  runningTrusted: boolean // whether the candidate now running was trusted
  pending: ResolvedForm | null // a trusted sighting that arrived while an untrusted run was going
  blockedPinged: boolean // the "tab could not be closed" ping for this form went out
  dead: boolean // a handler threw for it: every later sighting is ignored, so it can never be submitted twice
}

// At most this many forms are handled at once, each in its own desk tab. A form past the cap waits in a FIFO queue.
// Its deadline still runs from `seenAt` (the handler enforces it), so a form queued too long fails `deadline` unopened.
export const MAX_FORMS_IN_FLIGHT = 3

const BLOCKED_REASON: StopReason = 'tab_stuck'

// Hands each form to `handle` once per meeting. A form is handled again only when it ended `untrusted` and a trusted
// sender later posted it, and then the handler continues from the saved record. Every form with a record on disk (a
// restart) counts as handled, and a `submitting` one is never resubmitted: it is failed as `interrupted_submitting`.
// Nothing here throws at the caller: a failed ping, save or handler becomes a redacted `error` event, and the form is
// settled (never left running, never handled again).
export async function startFormDispatcher(base: FormContextBase, handle: Handle = handleForm): Promise<FormDispatcher> {
  const { cfg } = base
  const abort = new AbortController()
  const entries = new Map<string, Entry>()
  const handledInvalid = new Set<string>()
  const tasks = new Set<Promise<void>>()
  let tabsBlocked = false // set by a form_tab_not_closed alert: no more form tabs this meeting
  let closing: Promise<FormRecord[]> | null = null
  let inFlight = 0
  const waiting: (() => void)[] = []

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
  // Runs one step; a failure is reported as an `error` event and the step counts as not done.
  async function attempt(formId: string, step: () => Promise<void>): Promise<boolean> {
    try {
      await step()
      return true
    } catch (error) {
      await emitError(formId, error)
      return false
    }
  }
  const watched: FormContextBase = {
    ...base,
    emitEvent: async (type, data) => {
      if (type === 'alert' && data.kind === 'form_tab_not_closed') tabsBlocked = true
      await base.emitEvent(type, data)
    }
  }
  const pingOptions = { entryName: cfg.entry.name, timeZone: cfg.entry.timeZone, links: base.links }

  // Sends the ping of a record's state and logs it in the record. A failed ping leaves the record without the log
  // entry (a restart pings it again); a failed save after a sent ping keeps the entry in memory only.
  async function pingRecord(rec: FormRecord): Promise<FormRecord> {
    let sent = false
    await attempt(rec.formId, async () => {
      const ping = formPing(rec, pingOptions)
      if (ping === null) return
      await base.ping(ping)
      sent = true
    })
    if (!sent) return rec
    const pinged = { ...rec, pings: [...rec.pings, { state: rec.state, at: new Date().toISOString() }] }
    await attempt(rec.formId, () => saveFormRecord(cfg.dataDir, pinged))
    return pinged
  }

  // Fails a record that is not terminal, saves it, emits it and pings the member. Each step is attempted even when an
  // earlier one failed, so a broken disk still lets the member hear about the form.
  async function failRecord(rec: FormRecord, reason: StopReason): Promise<FormRecord> {
    const failed = applyFormTrigger({ ...rec, reason }, 'error', new Date().toISOString())
    await attempt(failed.formId, () => saveFormRecord(cfg.dataDir, failed))
    await attempt(failed.formId, () => emit('form', formEventData(failed)))
    return pingRecord(failed)
  }

  const loaded = await loadFormRecords(cfg.dataDir)
  for (const formId of loaded.invalid) {
    handledInvalid.add(formId)
    await emitError(formId, new Error('the form record is missing or invalid, so the form counts as handled'))
  }
  for (const rec of loaded.records) {
    let record = rec
    if (!isTerminalFormState(rec.state)) {
      record = await failRecord(rec, rec.state === 'submitting' ? 'interrupted_submitting' : 'interrupted')
    } else if (rec.state === 'failed' && rec.pings.length === 0) {
      record = await pingRecord(rec) // it failed before its ping went out
    }
    entries.set(rec.formId, {
      record,
      running: false,
      runningTrusted: false,
      pending: null,
      blockedPinged: false,
      dead: false
    })
  }

  function release(): void {
    const next = waiting.shift()
    if (next === undefined) inFlight--
    else next() // the slot passes to the oldest waiting form
  }

  // One handler call. It never throws. A handler that throws kills the entry; a form that never got a record is
  // failed so that it has a record and a ping. Returns null after a throw.
  async function run(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<FormRecord | null> {
    try {
      const rec = await handle(f, { ...watched, previous, signal: abort.signal })
      entry.record = rec
      return rec
    } catch (error) {
      entry.dead = true
      await emitError(entry.record?.formId ?? formIdFor(f.finalUrl), error)
      if (entry.record === null) entry.record = await failRecord(newFormRecord(f, cfg.occurrenceId), 'unexpected_error')
      return null
    }
  }

  // Runs `f`, then any trusted sighting that arrived meanwhile if the run ended untrusted (unless form tabs got blocked
  // in the meantime: then that sighting is refused with one ping).
  async function drive(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<void> {
    let rec = await run(entry, f, previous)
    while (rec !== null && rec.state === 'untrusted' && entry.pending !== null) {
      const next = entry.pending
      entry.pending = null
      entry.runningTrusted = true
      if (tabsBlocked) {
        await refuse(entry, next, rec)
        break
      }
      rec = await run(entry, next, rec)
    }
    entry.pending = null
    entry.running = false
  }

  // With form tabs blocked a new form is failed unopened; an untrusted one a trusted sender posted gets a ping only.
  async function refuse(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<void> {
    if (previous === null) {
      entry.record = await failRecord(newFormRecord(f, cfg.occurrenceId), BLOCKED_REASON)
    } else if (!entry.blockedPinged) {
      const failed = { ...previous, state: 'failed' as const, reason: BLOCKED_REASON }
      await attempt(failed.formId, async () => {
        const ping = formPing(failed, pingOptions)
        if (ping !== null) await base.ping(ping)
        entry.blockedPinged = true
      })
    }
    entry.running = false
  }

  // Waits for a slot, then handles or refuses the form. Whatever happens, the entry settles and the slot is freed.
  async function execute(entry: Entry, f: ResolvedForm, previous: FormRecord | null): Promise<void> {
    // A free slot is taken at once, so the handler starts in the same tick as the offer.
    if (inFlight < MAX_FORMS_IN_FLIGHT) inFlight++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      if (tabsBlocked) await refuse(entry, f, previous)
      else await drive(entry, f, previous)
    } catch (error) {
      entry.dead = true
      await emitError(entry.record?.formId ?? formIdFor(f.finalUrl), error)
    } finally {
      entry.pending = null
      entry.running = false
      release()
    }
  }

  // The task never rejects, so close() can always await it.
  function track(task: Promise<void>): void {
    const tracked: Promise<void> = task.catch((error) => emitError(null, error)).finally(() => tasks.delete(tracked))
    tasks.add(tracked)
  }

  function start(entry: Entry, f: ResolvedForm, trusted: boolean, previous: FormRecord | null): void {
    entry.running = true
    entry.runningTrusted = trusted
    track(execute(entry, f, previous))
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
        blockedPinged: false,
        dead: false
      }
      entries.set(id, created)
      start(created, f, trusted, null)
    } else if (entry.dead) {
      track(emit('form', { formId: id, outcome: 'ignored', reason: 'handler_failed' }))
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
