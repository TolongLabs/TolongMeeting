import { expect, mock, test } from 'bun:test'
import { once } from 'node:events'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formIdFor,
  newFormRecord,
  type FormRecord,
  type FormSource,
  type ResolvedForm,
  type SenderRole
} from '@tm/core'
import { sampleRecord } from '@tm/core/testing'
import type { Ping } from '@tm/notify'
import type { Page } from 'playwright'
import { MAX_FORMS_IN_FLIGHT, startFormDispatcher } from '../src/forms/dispatcher'
import { loadFormRecords, saveFormRecord } from '../src/forms/store'
import type { FormContext, FormContextBase } from '../src/forms/types'
import { testJob } from './forms/job'

const host = { name: 'Dr Example', role: 'host' as SenderRole }
const participant = { name: 'Classmate', role: 'participant' as SenderRole }

function formFor(name: string, source: FormSource, sender?: { name: string; role: SenderRole }): ResolvedForm {
  const url = `https://docs.google.com/forms/d/e/${name}/viewform`
  return {
    url,
    finalUrl: url,
    provider: 'google',
    source,
    sender: sender?.name ?? null,
    senderRole: sender?.role ?? null,
    seenAt: new Date().toISOString()
  }
}

function recFor(name: string, state: FormRecord['state']): FormRecord {
  const rec = newFormRecord(formFor(name, 'qr'), 'occ-test')
  return sampleRecord({ ...rec, state, history: [...rec.history, { state, at: rec.seenAt }] })
}

function fakeBase(dir: string) {
  const pings: Ping[] = []
  const events: Record<string, unknown>[] = []
  const base: FormContextBase = {
    cfg: testJob(dir),
    desk: {} as Page,
    links: { meetingPage: null, signIn: null },
    emitEvent: async (type, data) => {
      events.push({ type, ...data })
    },
    ping: async (p) => {
      pings.push(p)
    },
    matchLabels: async () => new Map(),
    waitForSignin: async () => true
  }
  return { base, pings, events }
}

const byName = (records: FormRecord[], name: string) =>
  records.find((r) => r.formId === formIdFor(formFor(name, 'qr').finalUrl))!
const tmp = () => mkdtemp(join(tmpdir(), 'tm-disp-'))
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

test('a restart fails unfinished forms once and never hands any loaded form out again', async () => {
  const dir = await tmp()
  for (const [n, s] of [
    ['A', 'submitted'],
    ['B', 'submitting'],
    ['C', 'filling']
  ] as const)
    await saveFormRecord(dir, recFor(n, s))
  await mkdir(join(dir, 'forms', formIdFor(formFor('D', 'qr').finalUrl)), { recursive: true }) // no readable record.json
  const handle = mock(async (_f: ResolvedForm) => recFor('X', 'submitted'))
  const { base, pings } = fakeBase(dir)
  const d = await startFormDispatcher(base, handle)
  const { records } = await loadFormRecords(dir)
  expect(byName(records, 'B')).toMatchObject({ state: 'failed', reason: 'interrupted_submitting' })
  expect(byName(records, 'C')).toMatchObject({ state: 'failed', reason: 'interrupted' })
  expect(byName(records, 'A').state).toBe('submitted')
  expect(pings.map((p) => p.title)).toEqual(['Form needs you', 'Form needs you'])
  for (const n of ['A', 'B', 'C', 'D']) d.offer(formFor(n, 'qr'))
  await d.close()
  expect(handle).not.toHaveBeenCalled()
})

test('the same form is handled once', async () => {
  const handle = mock(async (_f: ResolvedForm) => recFor('F', 'submitted'))
  const d = await startFormDispatcher(fakeBase(await tmp()).base, handle)
  d.offer(formFor('F', 'qr'))
  d.offer({ ...formFor('F', 'meeting_chat', host), finalUrl: formFor('F', 'qr').finalUrl + '?usp=sf_link' })
  await d.close()
  expect(handle).toHaveBeenCalledTimes(1)
})

test('a trusted sighting re-handles a form that ended untrusted', async () => {
  const handle = mock(async (_f: ResolvedForm, ctx: FormContext) =>
    recFor('F', ctx.previous ? 'submitted' : 'untrusted')
  )
  const d = await startFormDispatcher(fakeBase(await tmp()).base, handle)
  d.offer(formFor('F', 'meeting_chat', participant))
  await settle()
  d.offer(formFor('F', 'meeting_chat', participant)) // a second untrusted sighting is ignored
  d.offer(formFor('F', 'qr'))
  await d.close()
  expect(handle).toHaveBeenCalledTimes(2)
  expect(handle.mock.calls[1]![1].previous?.state).toBe('untrusted')
})

test('a trusted sighting during an untrusted run waits and runs if that run ends untrusted', async () => {
  const first = deferred<FormRecord>()
  const handle = mock((_f: ResolvedForm, ctx: FormContext) =>
    ctx.previous ? Promise.resolve(recFor('F', 'submitted')) : first.promise
  )
  const d = await startFormDispatcher(fakeBase(await tmp()).base, handle)
  d.offer(formFor('F', 'meeting_chat', participant))
  d.offer(formFor('F', 'qr'))
  expect(handle).toHaveBeenCalledTimes(1)
  first.resolve(recFor('F', 'untrusted'))
  expect((await d.close()).map((r) => r.state)).toContain('submitted')
  expect(handle).toHaveBeenCalledTimes(2)
})

test('a pending trusted sighting is dropped when the untrusted run ends in another state', async () => {
  const first = deferred<FormRecord>()
  const handle = mock((_f: ResolvedForm) => first.promise)
  const d = await startFormDispatcher(fakeBase(await tmp()).base, handle)
  d.offer(formFor('F', 'meeting_chat', participant))
  d.offer(formFor('F', 'qr'))
  first.resolve(recFor('F', 'not_attendance'))
  await d.close()
  expect(handle).toHaveBeenCalledTimes(1)
})

test('close aborts the signal handlers see', async () => {
  let seen: AbortSignal | null = null
  const d = await startFormDispatcher(fakeBase(await tmp()).base, async (_f, ctx) => {
    seen = ctx.signal
    await once(ctx.signal, 'abort')
    return recFor('F', 'failed')
  })
  d.offer(formFor('F', 'qr'))
  await d.close()
  expect(seen!.aborted).toBe(true)
})

test('an untrusted record from an earlier run can be upgraded, continuing from that record', async () => {
  const dir = await tmp()
  await saveFormRecord(dir, recFor('U', 'untrusted'))
  const handle = mock(async (_f: ResolvedForm, ctx: FormContext) => ({ ...ctx.previous!, state: 'submitted' as const }))
  const d = await startFormDispatcher(fakeBase(dir).base, handle)
  d.offer(formFor('U', 'qr'))
  await d.close()
  expect(handle).toHaveBeenCalledTimes(1)
  expect(handle.mock.calls[0]![1].previous?.formId).toBe(formIdFor(formFor('U', 'qr').finalUrl))
})

test('an untrusted record whose history contains submitting is never re-handled', async () => {
  const dir = await tmp()
  const rec = recFor('U', 'untrusted')
  await saveFormRecord(dir, { ...rec, history: [...rec.history, { state: 'submitting', at: rec.seenAt }] })
  const handle = mock(async (_f: ResolvedForm) => recFor('U', 'submitted'))
  const d = await startFormDispatcher(fakeBase(dir).base, handle)
  d.offer(formFor('U', 'qr'))
  await d.close()
  expect(handle).not.toHaveBeenCalled()
})

test('a candidate whose finalUrl is not a URL is reported and never handled', async () => {
  const handle = mock(async (_f: ResolvedForm) => recFor('F', 'submitted'))
  const { base, events } = fakeBase(await tmp())
  const d = await startFormDispatcher(base, handle)
  d.offer({ ...formFor('F', 'qr'), finalUrl: 'not a url' })
  await d.close()
  expect(handle).not.toHaveBeenCalled()
  expect(events).toEqual([expect.objectContaining({ type: 'error', where: 'form_dispatcher' })])
})

test('a handler that throws is reported with a redacted message and the form is not handled again', async () => {
  const { base, events } = fakeBase(await tmp())
  const handle = mock(async (_f: ResolvedForm): Promise<FormRecord> => {
    throw new Error('boom for Test Student')
  })
  const d = await startFormDispatcher(base, handle)
  d.offer(formFor('F', 'qr'))
  await settle()
  d.offer(formFor('F', 'qr'))
  await d.close()
  expect(handle).toHaveBeenCalledTimes(1)
  const errors = events.filter((e) => e.type === 'error')
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatchObject({ type: 'error', where: 'form_dispatcher', message: 'boom for [value]' })
})

test('after a form_tab_not_closed alert later forms are not opened and the member is pinged', async () => {
  const dir = await tmp()
  const { base, pings } = fakeBase(dir)
  const handle = mock(async (f: ResolvedForm, ctx: FormContext) => {
    await ctx.emitEvent('alert', { kind: 'form_tab_not_closed', formId: formIdFor(f.finalUrl), message: 'stuck' })
    return recFor('A', 'submitted')
  })
  const d = await startFormDispatcher(base, handle)
  d.offer(formFor('A', 'qr'))
  await settle()
  d.offer(formFor('B', 'qr'))
  await d.close()
  expect(handle).toHaveBeenCalledTimes(1)
  expect(byName((await loadFormRecords(dir)).records, 'B')).toMatchObject({ state: 'failed', reason: 'tab_stuck' })
  expect(pings.map((p) => p.title)).toEqual(['Form needs you'])
  expect(pings[0]!.message).toContain('an earlier form tab could not be closed')
})

// A first run that ends untrusted after a form_tab_not_closed alert.
const stuckThenUntrusted = (f: ResolvedForm, ctx: FormContext) =>
  ctx.previous
    ? Promise.resolve(recFor('F', 'submitted'))
    : ctx
        .emitEvent('alert', { kind: 'form_tab_not_closed', formId: formIdFor(f.finalUrl), message: 'stuck' })
        .then(() => recFor('F', 'untrusted'))

test('a queued trusted upgrade is refused with one ping when the first run left a tab open', async () => {
  const { base, pings } = fakeBase(await tmp())
  const handle = mock(stuckThenUntrusted)
  const d = await startFormDispatcher(base, handle)
  d.offer(formFor('F', 'meeting_chat', participant))
  d.offer(formFor('F', 'qr'))
  await settle()
  d.offer(formFor('F', 'qr')) // a later trusted sighting is refused without a second ping
  await d.close()
  expect(handle).toHaveBeenCalledTimes(1)
  expect(pings).toHaveLength(1)
  expect(pings[0]!.message).toContain('an earlier form tab could not be closed')
})

test('a handler that throws on an upgrade is never run again for that form', async () => {
  const { base, events } = fakeBase(await tmp())
  const handle = mock(async (_f: ResolvedForm, ctx: FormContext): Promise<FormRecord> => {
    if (ctx.previous) throw new Error('upgrade blew up')
    return recFor('F', 'untrusted')
  })
  const d = await startFormDispatcher(base, handle)
  d.offer(formFor('F', 'meeting_chat', participant))
  await settle()
  d.offer(formFor('F', 'qr'))
  await settle()
  d.offer(formFor('F', 'qr'))
  await d.close()
  expect(handle).toHaveBeenCalledTimes(2)
  expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
  expect(events).toContainEqual(expect.objectContaining({ type: 'form', outcome: 'ignored', reason: 'handler_failed' }))
})

test('a new form whose handler throws gets a failed record and a ping', async () => {
  const dir = await tmp()
  const { base, pings } = fakeBase(dir)
  const d = await startFormDispatcher(
    base,
    mock(async (_f: ResolvedForm): Promise<FormRecord> => {
      throw new Error('boom')
    })
  )
  d.offer(formFor('F', 'qr'))
  const records = await d.close()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ state: 'failed', reason: 'unexpected_error' })
  expect(byName((await loadFormRecords(dir)).records, 'F')).toMatchObject({
    state: 'failed',
    pings: [{ state: 'failed' }]
  })
  expect(pings.map((p) => p.title)).toEqual(['Form needs you'])
})

function failingPing(base: FormContextBase, failures: number) {
  let left = failures
  return {
    ...base,
    ping: async (p: Ping) => {
      if (left-- > 0) throw new Error('ntfy is down for Test Student')
      await base.ping(p)
    }
  }
}

test('a ping that fails at runtime is reported, the form settles and the dispatcher keeps working', async () => {
  const dir = await tmp()
  const { base, events, pings } = fakeBase(dir)
  const handle = mock(async (_f: ResolvedForm): Promise<FormRecord> => {
    throw new Error('boom')
  })
  const d = await startFormDispatcher(failingPing(base, 1), handle)
  d.offer(formFor('A', 'qr'))
  while (!events.some((e) => e.type === 'form')) await settle() // the record is saved before its form event
  expect(byName((await loadFormRecords(dir)).records, 'A')).toMatchObject({ state: 'failed', pings: [] })
  d.offer(formFor('B', 'qr'))
  expect((await d.close()).map((r) => r.state)).toEqual(['failed', 'failed'])
  expect(events.filter((e) => e.type === 'error' && e.message === 'ntfy is down for [value]')).toHaveLength(1)
  expect(pings).toHaveLength(1)
})

test('a ping that fails while refusing a blocked form does not escape', async () => {
  const { base, events } = fakeBase(await tmp())
  const handle = mock(stuckThenUntrusted)
  const d = await startFormDispatcher(failingPing(base, 2), handle)
  d.offer(formFor('F', 'meeting_chat', participant))
  d.offer(formFor('F', 'qr'))
  d.offer(formFor('G', 'qr')) // refused unopened: its ping fails too
  await settle()
  await d.close()
  expect(events.filter((e) => e.type === 'error')).toHaveLength(2)
})

test('the blocked-tab ping is retried until one goes out', async () => {
  const { base, pings } = fakeBase(await tmp())
  const d = await startFormDispatcher(failingPing(base, 1), mock(stuckThenUntrusted))
  d.offer(formFor('F', 'meeting_chat', participant))
  d.offer(formFor('F', 'qr')) // refused after the first run; its ping fails
  await settle()
  d.offer(formFor('F', 'qr')) // refused again; this ping goes out
  await settle()
  d.offer(formFor('F', 'qr')) // and now it is done
  await d.close()
  expect(pings).toHaveLength(1)
})

test('a ping that fails at start does not abort the dispatcher', async () => {
  const dir = await tmp()
  await saveFormRecord(dir, recFor('C', 'filling'))
  const { base, events } = fakeBase(dir)
  const d = await startFormDispatcher(
    failingPing(base, 1),
    mock(async () => recFor('X', 'submitted'))
  )
  expect(await d.close()).toHaveLength(1)
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'ntfy is down for [value]' }))
  expect(byName((await loadFormRecords(dir)).records, 'C')).toMatchObject({ state: 'failed', pings: [] })
})

test('at most three forms are handled at once, the rest wait their turn, and all are handled', async () => {
  const gates = ['A', 'B', 'C', 'D', 'E'].map(() => deferred<void>())
  let active = 0
  let peak = 0
  const order: string[] = []
  const handle = mock(async (f: ResolvedForm): Promise<FormRecord> => {
    const n = f.finalUrl.split('/')[6]!
    order.push(n)
    active++
    peak = Math.max(peak, active)
    await gates[order.length - 1]!.promise
    active--
    return recFor(n, 'submitted')
  })
  const d = await startFormDispatcher(fakeBase(await tmp()).base, handle)
  for (const n of ['A', 'B', 'C', 'D', 'E']) d.offer(formFor(n, 'qr'))
  await settle()
  expect(handle).toHaveBeenCalledTimes(MAX_FORMS_IN_FLIGHT)
  gates[0]!.resolve()
  await settle()
  expect(handle).toHaveBeenCalledTimes(4)
  for (const g of gates) g.resolve()
  await settle() // E gets its slot and runs before close
  expect((await d.close()).length).toBe(5)
  expect(order).toEqual(['A', 'B', 'C', 'D', 'E'])
  expect(peak).toBe(MAX_FORMS_IN_FLIGHT)
})

test('at start a failed record with no ping is pinged and an unreadable record is reported', async () => {
  const dir = await tmp()
  await saveFormRecord(dir, { ...recFor('F', 'failed'), reason: 'deadline', pings: [] })
  await saveFormRecord(dir, {
    ...recFor('G', 'failed'),
    reason: 'deadline',
    pings: [{ state: 'failed', at: new Date().toISOString() }]
  })
  await mkdir(join(dir, 'forms', formIdFor(formFor('D', 'qr').finalUrl)), { recursive: true })
  const { base, pings, events } = fakeBase(dir)
  const d = await startFormDispatcher(
    base,
    mock(async () => recFor('X', 'submitted'))
  )
  await d.close()
  expect(pings).toHaveLength(1)
  expect(byName((await loadFormRecords(dir)).records, 'F').pings).toHaveLength(1)
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'error', formId: formIdFor(formFor('D', 'qr').finalUrl) })
  )
})

test('at start a failed record whose pings log only a sign-in ping is pinged again', async () => {
  const dir = await tmp()
  await saveFormRecord(dir, {
    ...recFor('H', 'failed'),
    reason: 'deadline',
    pings: [{ state: 'awaiting_signin', at: new Date().toISOString() }]
  })
  const { base, pings } = fakeBase(dir)
  const d = await startFormDispatcher(
    base,
    mock(async () => recFor('X', 'submitted'))
  )
  await d.close()
  expect(pings).toHaveLength(1)
  expect(byName((await loadFormRecords(dir)).records, 'H').pings.map((p) => p.state)).toEqual([
    'awaiting_signin',
    'failed'
  ])
})

const gatedHandle = (gates: Map<string, ReturnType<typeof deferred<void>>>) =>
  mock(async (f: ResolvedForm): Promise<FormRecord> => {
    const n = f.finalUrl.split('/')[6]!
    await gates.get(n)!.promise
    return recFor(n, 'submitted')
  })

test('close fails the forms queued behind full slots as meeting_ended, without opening them', async () => {
  const dir = await tmp()
  const gates = new Map(['A', 'B', 'C'].map((n) => [n, deferred<void>()]))
  const handle = gatedHandle(gates)
  const { base, pings } = fakeBase(dir)
  const d = await startFormDispatcher(base, handle)
  for (const n of ['A', 'B', 'C', 'D', 'E']) d.offer(formFor(n, 'qr'))
  await settle()
  const closing = d.close()
  for (const n of ['A', 'B', 'C']) gates.get(n)!.resolve()
  const records = await closing
  expect(handle).toHaveBeenCalledTimes(MAX_FORMS_IN_FLIGHT)
  for (const n of ['D', 'E']) {
    expect(byName(records, n)).toMatchObject({ state: 'failed', reason: 'meeting_ended' })
    expect(byName((await loadFormRecords(dir)).records, n)).toMatchObject({
      state: 'failed',
      reason: 'meeting_ended',
      pings: [{ state: 'failed' }]
    })
  }
  expect(pings).toHaveLength(2)
})

test('a queued form whose deadline passed before its slot freed fails deadline, without opening it', async () => {
  const gates = new Map(['A', 'B', 'C'].map((n) => [n, deferred<void>()]))
  const handle = gatedHandle(gates)
  const d = await startFormDispatcher(fakeBase(await tmp()).base, handle)
  for (const n of ['A', 'B', 'C']) d.offer(formFor(n, 'qr'))
  d.offer({ ...formFor('D', 'qr'), seenAt: new Date(Date.now() - 130_000).toISOString() })
  await settle()
  gates.get('A')!.resolve()
  await settle()
  for (const n of ['B', 'C']) gates.get(n)!.resolve()
  const records = await d.close()
  expect(handle).toHaveBeenCalledTimes(MAX_FORMS_IN_FLIGHT)
  expect(byName(records, 'D')).toMatchObject({ state: 'failed', reason: 'deadline' })
})
