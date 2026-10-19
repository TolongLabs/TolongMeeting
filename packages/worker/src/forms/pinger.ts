import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
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
import { localParts, nextFormState } from '@tm/core'
import { formNotSubmittedPing, formToSubmitPing, linkUncheckedPing, type Ping } from '@tm/notify'
import { LinkResolveError, normaliseFormUrl, resolveFormLink } from './links'
import { checkTrust } from './trust'

export interface FormPingerDeps {
  cfg: JobConfig
  send: (p: Ping) => Promise<void>
  emit: (type: EventType, data: Record<string, unknown>) => Promise<void>
  resolve?: typeof resolveFormLink
  now?: () => Date
}

export interface FormPinger {
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

// One id per form per meeting: the first 12 hex characters of SHA-256 of the duplicate key.
function formIdOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

export function createFormPinger(deps: FormPingerDeps): FormPinger {
  const { cfg, send, emit } = deps
  const resolve = deps.resolve ?? resolveFormLink
  const now = deps.now ?? (() => new Date())
  const offered = new Set<string>() // raw URLs seen in flight or done
  const formKeys = new Set<string>() // normalised final URLs: one ping per form
  const tasks = new Set<Promise<void>>()

  // Times in pings are wall-clock HH:MM in the entry's zone.
  function clockOf(at: string): string {
    const { hhmm } = localParts(at, cfg.entry.timeZone)
    return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
  }

  async function writeRecord(rec: FormPingRecord): Promise<void> {
    const dir = join(cfg.dataDir, 'forms', rec.formId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'record.json'), `${JSON.stringify(rec, null, 2)}\n`)
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

  async function reportUnresolved(c: FormCandidate, err: LinkResolveError): Promise<void> {
    if (checkTrust(c, cfg.entry.trustedSenders).trusted) {
      await send(linkUncheckedPing(cfg.entry.name, c, clockOf(c.seenAt)))
    }
    await emit('form', { outcome: 'unresolved', reason: err.reason, ...locate(c.url) })
  }

  async function run(c: FormCandidate): Promise<void> {
    const raw = locate(c.url)
    let state: FormState = nextFormState('detected', 'resolve')
    let location = raw
    let rec: FormPingRecord | null = null
    try {
      await emit('form', { formId: null, state, source: c.source, trustReason: null, ...raw })

      let form: ResolvedForm | null
      try {
        form = await resolve(c)
      } catch (err) {
        if (!(err instanceof LinkResolveError)) throw err
        await reportUnresolved(c, err)
        return
      }
      if (form === null) {
        await emit('form', { outcome: 'ignored', ...raw })
        return
      }

      // Checked and claimed with no await in between, so two candidates for one form cannot both ping.
      const key = normaliseFormUrl(form.finalUrl)
      if (formKeys.has(key)) return
      formKeys.add(key)

      location = locate(form.finalUrl)
      state = nextFormState(state, 'resolved')
      rec = {
        formId: formIdOf(key),
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

      // The ping goes out before the state moves, so a failed send leaves the form in a state that can still fail.
      const decision = checkTrust(form, cfg.entry.trustedSenders)
      if (decision.reason !== null) {
        await send(formToSubmitPing(cfg.entry.name, form, decision.reason, clockOf(c.seenAt)))
        state = nextFormState(state, 'manual_only')
      } else {
        await send(formNotSubmittedPing(cfg.entry.name, form, clockOf(c.seenAt)))
        state = nextFormState(state, 'untrusted')
      }
      rec = { ...rec, state, trustReason: decision.reason, pingedAt: now().toISOString() }
      await commit(rec, location)
    } catch (err) {
      state = nextFormState(state, 'fail')
      if (rec !== null) {
        rec = { ...rec, state }
        await writeRecord(rec)
      }
      const message = err instanceof Error ? err.message : String(err)
      await emit('error', { where: 'form', formId: rec?.formId ?? null, state, ...location, message })
    }
  }

  return {
    async offer(c) {
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
