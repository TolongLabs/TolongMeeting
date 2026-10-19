import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { EventType, MeetingEvent, OccurrenceState } from '@tm/core'
import { and, eq } from 'drizzle-orm'
import { events, forms, occurrences, profiles } from '../db'
import { QUEUES } from '../db/queues'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { MAX_BODY_BYTES, handleHeartbeat, handleHeartbeatRequest } from '../lib/control'

afterAll(dropAllTestDbs, 60_000)

const sha256hex = (t: string) => createHash('sha256').update(t).digest('hex')
const NOW = new Date('2026-10-21T05:00:10.000Z')
const HOUR = 3_600_000

interface Options {
  state?: OccurrenceState
  attempt?: number
  token?: string
  pendingCommands?: string[]
  pastedLink?: string
}

async function controlFixture(o: Options = {}) {
  const db = await createTestDb()
  const queue = new FakeQueue()
  const make = async (opts: Options) => {
    const { memberId, identityId } = await seedMember(db, { full: false })
    const start = new Date('2026-10-21T04:00:00Z')
    const [occ] = await db
      .insert(occurrences)
      .values({
        memberId,
        identityId,
        entryName: 'Data Mining',
        entryType: 'lecture',
        transcription: 'live',
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * HOUR),
        deleteAfter: new Date(start.getTime() + 30 * 24 * HOUR),
        state: opts.state ?? 'starting',
        attempt: opts.attempt ?? 1,
        controlTokenHash: sha256hex(opts.token ?? '1.abc'),
        pendingCommands: opts.pendingCommands ?? [],
        pastedLink: opts.pastedLink ?? null,
        containerName: 'tm-worker'
      })
      .returning()
    return { id: occ!.id, memberId, identityId }
  }
  const a = await make(o)
  const one = async (id: string) => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!
  return {
    db,
    queue,
    deps: { db, queue, now: NOW },
    ...a,
    make,
    occurrence: () => one(a.id),
    other: one,
    events: (id = a.id) => db.select().from(events).where(eq(events.occurrenceId, id)).orderBy(events.id),
    eventCount: async (id = a.id) => (await db.select().from(events).where(eq(events.occurrenceId, id))).length,
    profile: async () => (await db.select().from(profiles).where(eq(profiles.identityId, a.identityId)))[0]!,
    form: async (key: string) =>
      (
        await db
          .select()
          .from(forms)
          .where(and(eq(forms.occurrenceId, a.id), eq(forms.formKey, key)))
      )[0],
    forms: () => db.select().from(forms).where(eq(forms.occurrenceId, a.id))
  }
}

const ev = (id: string, type: EventType, data: object, at = '2026-10-21T05:00:05.000Z'): MeetingEvent => ({
  occurrenceId: id,
  attempt: 1,
  at,
  type,
  data: data as Record<string, unknown>
})

const beat = (id: string, state: OccurrenceState, evs: MeetingEvent[] = [], extra: object = {}) => ({
  occurrenceId: id,
  attempt: 1,
  state,
  recording: false,
  participants: null,
  events: evs,
  ...extra
})

describe('idempotent heartbeats', () => {
  test('a heartbeat stores events once, drains commands and returns the pasted link', async () => {
    const f = await controlFixture({
      state: 'starting',
      pendingCommands: ['leave_now'],
      pastedLink: 'https://example.zoom.us/j/00000000000'
    })
    const hb = beat(f.id, 'verifying_accounts', [ev(f.id, 'state', { state: 'verifying_accounts' })])
    expect(await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)).toEqual({
      status: 200,
      body: { ackedEvents: 1, commands: ['leave_now'], link: 'https://example.zoom.us/j/00000000000' }
    })
    expect(await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)).toEqual({
      status: 200,
      body: { ackedEvents: 1, commands: [], link: 'https://example.zoom.us/j/00000000000' }
    })
    expect(await f.eventCount()).toBe(1)
    expect((await f.occurrence()).state).toBe('verifying_accounts')
    expect((await f.events()).filter((e) => e.type === 'error')).toEqual([])
  })

  test('a resend that repeats earlier state events and adds a new one applies only the new one', async () => {
    const f = await controlFixture({ state: 'starting' })
    const a = ev(f.id, 'state', { state: 'verifying_accounts' }, '2026-10-21T05:00:01.000Z')
    const b = ev(f.id, 'state', { state: 'watching_for_link' }, '2026-10-21T05:00:02.000Z')
    const c = ev(f.id, 'state', { state: 'joining' }, '2026-10-21T05:00:03.000Z')
    await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'watching_for_link', [a, b]))
    // The reply was lost, so the worker sends a and b again with the new event c.
    const res = await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'joining', [a, b, c]))
    expect(res).toMatchObject({ status: 200, body: { ackedEvents: 3 } })
    expect((await f.occurrence()).state).toBe('joining')
    expect(await f.eventCount()).toBe(3)
    expect((await f.events()).filter((e) => e.type === 'error')).toEqual([])
  })

  test('the same event twice in one heartbeat is stored once', async () => {
    const f = await controlFixture({ state: 'verifying_accounts' })
    const e = ev(f.id, 'alert', { kind: 'x' })
    const res = await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'verifying_accounts', [e, e]))
    expect(res).toMatchObject({ status: 200, body: { ackedEvents: 2 } })
    expect(await f.eventCount()).toBe(1)
  })

  test('state events are applied in order', async () => {
    const f = await controlFixture({ state: 'verifying_accounts' })
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'joining', [
        ev(f.id, 'state', { state: 'watching_for_link' }, '2026-10-21T05:00:01.000Z'),
        ev(f.id, 'state', { state: 'joining' }, '2026-10-21T05:00:02.000Z')
      ])
    )
    expect((await f.occurrence()).state).toBe('joining')
    expect((await f.events()).filter((e) => e.type === 'error')).toEqual([])
  })

  test('an illegal reported state is logged once, not applied', async () => {
    const f = await controlFixture({ state: 'verifying_accounts' })
    for (let i = 0; i < 3; i++) await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'completed'))
    expect((await f.occurrence()).state).toBe('verifying_accounts')
    const errors = (await f.events()).filter((e) => e.type === 'error')
    expect(errors.map((e) => e.data)).toEqual([
      { reason: 'illegal_transition', from: 'verifying_accounts', to: 'completed' }
    ])
  })

  test('an illegal state event is logged and the next legal one still applies', async () => {
    const f = await controlFixture({ state: 'verifying_accounts' })
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'watching_for_link', [
        ev(f.id, 'state', { state: 'in_meeting' }, '2026-10-21T05:00:01.000Z'),
        ev(f.id, 'state', { state: 'watching_for_link' }, '2026-10-21T05:00:02.000Z')
      ])
    )
    expect((await f.occurrence()).state).toBe('watching_for_link')
    expect((await f.events()).filter((e) => e.type === 'error')).toHaveLength(1)
  })

  test('reaching transcribing queues the pipeline once', async () => {
    const f = await controlFixture({ state: 'uploading' })
    const hb = beat(f.id, 'transcribing')
    await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)
    await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)
    expect(f.queue.sent.map((s) => [s.name, s.data])).toEqual([[QUEUES.pipeline, { occurrenceId: f.id }]])
  })

  test('entering in_meeting and leaving sets the actual times', async () => {
    const f = await controlFixture({ state: 'joining' })
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'leaving', [
        ev(f.id, 'state', { state: 'in_meeting' }, '2026-10-21T05:00:01.000Z'),
        ev(f.id, 'state', { state: 'leaving' }, '2026-10-21T05:00:04.000Z')
      ])
    )
    expect(await f.occurrence()).toMatchObject({
      state: 'leaving',
      actualStart: new Date('2026-10-21T05:00:01.000Z'),
      actualEnd: new Date('2026-10-21T05:00:04.000Z')
    })
  })

  test('the heartbeat updates last_heartbeat_at, recording and participants', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'in_meeting', [], { recording: true, participants: 30 }))
    expect(await f.occurrence()).toMatchObject({ lastHeartbeatAt: NOW, recording: true, participants: 30 })
  })

  test('NUL characters and lone surrogates in event data are stored cleaned', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const res = await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [ev(f.id, 'alert', { text: 'a\u0000b\ud800c' })])
    )
    expect(res.status).toBe(200)
    expect((await f.events())[0]!.data).toEqual({ text: 'ab�c' })
  })
})

describe('authentication', () => {
  test('a superseded attempt is told to stop and a wrong token is refused', async () => {
    const f = await controlFixture({ state: 'in_meeting', attempt: 2, token: '2.new' })
    const hb = beat(f.id, 'in_meeting', [], { recording: true, participants: 30 })
    expect(await handleHeartbeat(f.deps, 'Bearer 1.old', hb)).toEqual({
      status: 410,
      body: { ackedEvents: 0, commands: ['stop'], link: null }
    })
    expect(await handleHeartbeat(f.deps, 'Bearer 2.wrong', { ...hb, attempt: 2 })).toEqual({
      status: 401,
      body: { error: 'unauthorized' }
    })
    expect((await f.occurrence()).lastHeartbeatAt).toBeNull()
  })

  test('a missing, malformed or unknown token is refused with a fixed body that never echoes it', async () => {
    const f = await controlFixture()
    const hb = beat(f.id, 'starting')
    for (const header of [null, '', 'Basic 1.abc', 'Bearer abc', 'Bearer 1.', 'Bearer 1.ab c', 'bearer 1.abc']) {
      expect(await handleHeartbeat(f.deps, header, hb)).toEqual({ status: 401, body: { error: 'unauthorized' } })
    }
    const secret = '1.SECRET-token-value'
    const res = await handleHeartbeat(f.deps, `Bearer ${secret}`, hb)
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(JSON.stringify(res)).not.toContain('SECRET')
    expect(await f.eventCount()).toBe(0)
  })

  test('a token for an occurrence that does not exist is refused', async () => {
    const f = await controlFixture()
    const res = await handleHeartbeat(f.deps, 'Bearer 1.abc', beat('00000000-0000-4000-8000-000000000000', 'starting'))
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
  })

  test("member A's token cannot write member B's occurrence", async () => {
    const f = await controlFixture({ state: 'in_meeting', token: '1.alpha' })
    const b = await f.make({ state: 'in_meeting', token: '1.bravo' })
    const hb = beat(b.id, 'in_meeting', [ev(b.id, 'alert', { kind: 'planted' })], { recording: true })
    expect(await handleHeartbeat(f.deps, 'Bearer 1.alpha', hb)).toEqual({
      status: 401,
      body: { error: 'unauthorized' }
    })
    expect(await f.eventCount(b.id)).toBe(0)
    expect(await f.eventCount()).toBe(0)
    expect(await f.other(b.id)).toMatchObject({ lastHeartbeatAt: null, recording: false })
    // The same body with B's own token writes B and only B.
    expect((await handleHeartbeat(f.deps, 'Bearer 1.bravo', hb)).status).toBe(200)
    expect(await f.eventCount(b.id)).toBe(1)
    expect(await f.eventCount()).toBe(0)
  })

  test('a body attempt that differs from the token attempt is refused', async () => {
    const f = await controlFixture()
    expect((await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'starting', [], { attempt: 2 }))).status).toBe(400)
  })

  test('a deleted occurrence tells the worker to stop', async () => {
    const f = await controlFixture({ state: 'deleted' })
    expect((await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'starting'))).status).toBe(410)
    expect(await f.eventCount()).toBe(0)
  })
})

describe('body limits', () => {
  test('an unknown event type, an unknown state or too many events answer 400 with a fixed message', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const bad = [
      beat(f.id, 'in_meeting', [{ ...ev(f.id, 'alert', {}), type: 'surprise' as EventType }]),
      beat(f.id, 'nonsense' as OccurrenceState),
      beat(
        f.id,
        'in_meeting',
        Array.from({ length: 501 }, (_, i) => ev(f.id, 'alert', { i }))
      ),
      { ...beat(f.id, 'in_meeting'), events: 'x' },
      null,
      'text'
    ]
    for (const body of bad) {
      expect(await handleHeartbeat(f.deps, 'Bearer 1.abc', body)).toEqual({
        status: 400,
        body: { error: 'invalid request' }
      })
    }
    expect(await f.eventCount()).toBe(0)
  })

  test('500 events are accepted', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const evs = Array.from({ length: 500 }, (_, i) => ev(f.id, 'alert', { i }))
    expect(await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'in_meeting', evs))).toMatchObject({
      status: 200,
      body: { ackedEvents: 500 }
    })
    expect(await f.eventCount()).toBe(500)
  })

  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://tm.test/api/control/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer 1.abc', ...headers },
      body
    })

  test('a body over 1 MB is refused without being read further, and the answer never echoes it', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const big = JSON.stringify(beat(f.id, 'in_meeting', [ev(f.id, 'alert', { pad: 'x'.repeat(MAX_BODY_BYTES) })]))
    const res = await handleHeartbeatRequest(request(big), f.deps, NOW)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid request' })
    expect(await f.eventCount()).toBe(0)
    // A declared length over the cap is refused before the body is read.
    const declared = await handleHeartbeatRequest(
      request('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }),
      f.deps,
      NOW
    )
    expect(declared.status).toBe(400)
  })

  test('a valid request round-trips and invalid JSON is a 400', async () => {
    const f = await controlFixture({ state: 'starting' })
    const ok = await handleHeartbeatRequest(request(JSON.stringify(beat(f.id, 'verifying_accounts'))), f.deps, NOW)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.json()).toEqual({ ackedEvents: 0, commands: [], link: null })
    expect((await handleHeartbeatRequest(request('{not json'), f.deps, NOW)).status).toBe(400)
  })
})

describe('side effects of events', () => {
  test('account checks are recorded on the profile', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(f.id, 'state', { account: 'zoom', signedIn: false }),
        ev(f.id, 'state', { account: 'google', signedIn: true }, '2026-10-21T05:00:06.000Z')
      ])
    )
    expect((await f.profile()).accountStatus).toEqual({
      zoom: { verifiedAt: '2026-10-21T05:00:05.000Z', signedIn: false },
      google: { verifiedAt: '2026-10-21T05:00:06.000Z', signedIn: true }
    })
  })

  test('a form event with formId, url and seenAt is upserted with canonical URLs', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const base = {
      formId: 'f1',
      url: 'https://forms.gle/x?entry.1=secret',
      finalUrl: 'https://docs.google.com/forms/d/e/x/viewform?usp=pp_url&entry.1=secret',
      provider: 'google',
      source: 'qr',
      sender: null,
      senderRole: null,
      trustReason: 'qr_on_screen',
      reason: null,
      seenAt: '2026-10-21T06:30:00Z',
      submittedAt: null
    }
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(f.id, 'form', { ...base, state: 'filling', fieldsFilled: [] }, '2026-10-21T06:30:30.000Z')
      ])
    )
    expect(await f.form('f1')).toMatchObject({
      state: 'filling',
      source: 'qr',
      url: 'https://forms.gle/x',
      finalUrl: 'https://docs.google.com/forms/d/e/x/viewform',
      provider: 'google',
      trustReason: 'qr_on_screen',
      fieldsFilled: []
    })
    // A later event for the same form updates it; the first sight stays.
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(
          f.id,
          'form',
          {
            ...base,
            source: 'meeting_chat',
            seenAt: '2026-10-21T06:45:00Z',
            state: 'submitted',
            reason: 'deadline',
            submittedAt: '2026-10-21T06:31:00Z',
            fieldsFilled: ['full_name']
          },
          '2026-10-21T06:31:00.000Z'
        )
      ])
    )
    expect(await f.forms()).toHaveLength(1)
    expect(await f.form('f1')).toMatchObject({
      state: 'submitted',
      source: 'qr',
      seenAt: new Date('2026-10-21T06:30:00Z'),
      submittedAt: new Date('2026-10-21T06:31:00Z'),
      fieldsFilled: ['full_name'],
      result: 'deadline'
    })
  })

  test('form events of other shapes are stored as events and never upserted', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const shapes = [
      { formId: null, outcome: 'ignored', reason: 'not_a_url', host: 'example.com', source: 'meeting_chat' },
      { host: 'docs.google.com', path: '/forms/d/e/x/viewform', source: 'qr' },
      { formId: 'f2', outcome: 'ignored', reason: 'handler_failed' },
      { formId: 'f3', url: 'javascript:alert(1)', source: 'qr', state: 'detected', seenAt: '2026-10-21T06:30:00Z' },
      {
        formId: 'f4',
        url: 'https://forms.gle/x',
        source: 'carrier_pigeon',
        state: 'detected',
        seenAt: '2026-10-21T06:30:00Z'
      },
      {}
    ]
    const res = await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(
        f.id,
        'in_meeting',
        shapes.map((d, i) => ev(f.id, 'form', d, `2026-10-21T06:30:0${i}.000Z`))
      )
    )
    expect(res).toMatchObject({ status: 200, body: { ackedEvents: shapes.length } })
    expect(await f.eventCount()).toBe(shapes.length)
    expect(await f.forms()).toEqual([])
  })
})
