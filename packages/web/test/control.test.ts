import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { EventType, MeetingEvent, OccurrenceState } from '@tm/core'
import { and, eq } from 'drizzle-orm'
import { events, forms, occurrences, profiles } from '../db'
import { QUEUES } from '../db/queues'
import { applyTrigger } from '../db/transitions'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import {
  MAX_BODY_BYTES,
  MAX_EVENTS_PER_OCCURRENCE,
  MAX_EVENT_DATA_BYTES,
  MAX_FORMS_PER_OCCURRENCE,
  handleHeartbeat,
  handleHeartbeatRequest
} from '../lib/control'

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
    // The job waits 20 s, so its first attempt normally finds the worker container gone.
    expect(f.queue.sent[0]!.opts!.startAfter).toEqual(new Date(f.deps.now.getTime() + 20_000))
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
      // The server's clock, not the worker's `at`.
      actualStart: NOW,
      actualEnd: NOW
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

  test('a missing or malformed Authorization header is refused before the body is read', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    for (const authorization of [undefined, 'Basic abc', 'Bearer nonsense', 'Bearer 1.']) {
      let read = false
      const body = new ReadableStream(
        {
          pull(controller) {
            read = true
            controller.enqueue(new TextEncoder().encode('{}'))
            controller.close()
          }
        },
        { highWaterMark: 0 }
      )
      const res = await handleHeartbeatRequest(
        new Request('http://tm.test/api/control/heartbeat', {
          method: 'POST',
          headers: authorization === undefined ? {} : { authorization },
          body,
          duplex: 'half'
        } as RequestInit),
        f.deps,
        NOW
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
      expect(read).toBe(false)
    }
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
      zoom: { verifiedAt: NOW.toISOString(), signedIn: false },
      google: { verifiedAt: NOW.toISOString(), signedIn: true }
    })
  })

  test('a form event with formId, url and seenAt is upserted with canonical URLs', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const base = {
      formId: 'f1',
      url: 'https://docs.google.com/forms/d/e/x/viewform?entry.1=secret',
      finalUrl: 'https://docs.google.com/forms/d/e/x/viewform?usp=pp_url&entry.1=secret',
      provider: 'google',
      source: 'qr',
      sender: null,
      senderRole: null,
      trustReason: 'qr_on_screen',
      reason: null,
      seenAt: '2026-10-21T04:30:00Z',
      submittedAt: null
    }
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(f.id, 'form', { ...base, state: 'filling', fieldsFilled: [] }, '2026-10-21T04:30:30.000Z')
      ])
    )
    expect(await f.form('f1')).toMatchObject({
      state: 'filling',
      source: 'qr',
      url: 'https://docs.google.com/forms/d/e/x/viewform',
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
            seenAt: '2026-10-21T04:45:00Z',
            state: 'submitted',
            reason: 'deadline',
            submittedAt: '2026-10-21T04:31:00Z',
            fieldsFilled: ['full_name']
          },
          '2026-10-21T04:31:00.000Z'
        )
      ])
    )
    expect(await f.forms()).toHaveLength(1)
    expect(await f.form('f1')).toMatchObject({
      state: 'submitted',
      source: 'qr',
      seenAt: new Date('2026-10-21T04:30:00Z'),
      submittedAt: new Date('2026-10-21T04:31:00Z'),
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
      { formId: 'f3', url: 'javascript:alert(1)', source: 'qr', state: 'detected', seenAt: '2026-10-21T04:30:00Z' },
      {
        formId: 'f5',
        url: 'https://example.com/forms/d/e/x/viewform',
        finalUrl: 'https://example.com/forms/d/e/x/viewform',
        source: 'qr',
        state: 'detected',
        seenAt: '2026-10-21T04:30:00Z'
      },
      {
        formId: 'f6',
        url: 'https://docs.google.com/forms/d/e/x/viewform',
        finalUrl: 'https://evil.example/login',
        source: 'qr',
        state: 'detected',
        seenAt: '2026-10-21T04:30:00Z'
      },
      {
        formId: 'f4',
        url: 'https://forms.gle/x',
        source: 'carrier_pigeon',
        state: 'detected',
        seenAt: '2026-10-21T04:30:00Z'
      },
      {}
    ]
    const res = await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(
        f.id,
        'in_meeting',
        shapes.map((d, i) => ev(f.id, 'form', d, `2026-10-21T05:00:0${i}.000Z`))
      )
    )
    expect(res).toMatchObject({ status: 200, body: { ackedEvents: shapes.length } })
    // A well-formed form that is refused leaves one error event; data that isn't a form at all leaves none.
    expect(await f.eventCount()).toBe(shapes.length + 3)
    expect(await f.forms()).toEqual([])
    expect(
      (await f.events())
        .filter((e) => e.type === 'error')
        .map((e) => e.data)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    ).toEqual([
      { reason: 'form_not_upserted', formId: 'f3' },
      { reason: 'form_not_upserted', formId: 'f5' },
      { reason: 'form_not_upserted', formId: 'f6' }
    ])
  })

  test('a short link is stored as posted when the page it led to is a form page', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const data = {
      formId: 'f7',
      url: 'https://forms.gle/AbCd?x=1',
      finalUrl: 'https://docs.google.com/forms/d/e/x/viewform?usp=sf_link',
      provider: 'google',
      source: 'meeting_chat',
      state: 'detected',
      seenAt: '2026-10-21T04:30:00Z'
    }
    await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'in_meeting', [ev(f.id, 'form', data)]))
    expect(await f.form('f7')).toMatchObject({
      url: 'https://forms.gle/AbCd?x=1',
      finalUrl: 'https://docs.google.com/forms/d/e/x/viewform'
    })
    expect((await f.events()).filter((e) => e.type === 'error')).toEqual([])
  })
})

describe('worker-reported moves', () => {
  const errors = async (f: Awaited<ReturnType<typeof controlFixture>>) =>
    (await f.events()).filter((e) => e.type === 'error').map((e) => e.data)

  test('the server-owned states are refused from every worker state', async () => {
    // Each of these has a trigger from some state the machine knows; the worker still can't pick it.
    const targets: OccurrenceState[] = [
      'deleted',
      'completed',
      'post_processing',
      'waiting_for_pc',
      'restarting',
      'transcribing'
    ]
    const f = await controlFixture({ state: 'in_meeting' })
    let minute = 10
    for (const from of ['in_meeting', 'uploading', 'restarting', 'in_lobby'] as const) {
      for (const to of targets) {
        const at = `2026-10-21T04:${minute++}:00.000Z`
        await f.db.update(occurrences).set({ state: from, resumeState: null }).where(eq(occurrences.id, f.id))
        await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, from, [ev(f.id, 'state', { state: to }, at)]))
        // `uploading` -> `transcribing` is the worker's "my part is done" marker, the one move to a server-owned state.
        const expected = from === 'uploading' && to === 'transcribing' ? 'transcribing' : from
        expect([from, to, (await f.occurrence()).state]).toEqual([from, to, expected])
      }
    }
  }, 30_000)

  test('a worker cannot crash its own occurrence or skip a start-up outcome', async () => {
    const g = await controlFixture({ state: 'in_meeting' })
    await handleHeartbeat(g.deps, 'Bearer 1.abc', beat(g.id, 'restarting'))
    expect((await g.occurrence()).state).toBe('in_meeting')
    expect(await errors(g)).toEqual([{ reason: 'illegal_transition', from: 'in_meeting', to: 'restarting' }])
    // `starting` has a trigger to each of these; the server alone decides them.
    const h = await controlFixture({ state: 'starting' })
    for (const to of ['skipped_capacity', 'skipped_identity_clash', 'skipped_pc_offline'] as const)
      await handleHeartbeat(h.deps, 'Bearer 1.abc', beat(h.id, to))
    expect((await h.occurrence()).state).toBe('starting')
    expect(await errors(h)).toHaveLength(3)
  })

  describe('a restarted attempt', () => {
    // The scheduler crashed attempt 1 and started attempt 2 (a new token); the row waits in `restarting`.
    async function restarted(from: OccurrenceState) {
      const f = await controlFixture({ state: from })
      await applyTrigger(f.db, f.id, 'crash')
      await f.db
        .update(occurrences)
        .set({ attempt: 2, controlTokenHash: sha256hex('2.def') })
        .where(eq(occurrences.id, f.id))
      return f
    }
    const errorsOf = async (f: Awaited<ReturnType<typeof controlFixture>>) =>
      (await f.events()).filter((e) => e.type === 'error').map((e) => e.data)

    test('leaves restarting when its heartbeat reports the state it resumes', async () => {
      const f = await restarted('in_meeting')
      expect(await f.occurrence()).toMatchObject({ state: 'restarting', resumeState: 'in_meeting', restarts: 1 })
      const res = await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'in_meeting', [], { attempt: 2 }))
      expect(res).toMatchObject({ status: 200 })
      expect(await f.occurrence()).toMatchObject({ state: 'in_meeting', resumeState: null, restarts: 1 })
      expect(await errorsOf(f)).toEqual([])
    })

    test('resumes through a state event as well', async () => {
      const f = await restarted('in_lobby')
      const e = { ...ev(f.id, 'state', { state: 'in_lobby' }), attempt: 2 }
      await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'in_lobby', [e], { attempt: 2 }))
      expect(await f.occurrence()).toMatchObject({ state: 'in_lobby', resumeState: null })
    })

    test('is refused any other state, and the old attempt is refused outright', async () => {
      const f = await restarted('in_meeting')
      await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'watching_for_link', [], { attempt: 2 }))
      expect(await f.occurrence()).toMatchObject({ state: 'restarting', resumeState: 'in_meeting' })
      expect(await errorsOf(f)).toEqual([{ reason: 'illegal_transition', from: 'restarting', to: 'watching_for_link' }])
      const old = await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'in_meeting'))
      expect(old).toMatchObject({ status: 410, body: { commands: ['stop'] } })
      expect(await f.occurrence()).toMatchObject({ state: 'restarting', resumeState: 'in_meeting' })
    })

    test('a lost acknowledgement: a state behind resume_state on the in-meeting path resumes it', async () => {
      // resume_state in_lobby; the worker, admitted straight in, reports joining and then in_meeting, never in_lobby.
      const f = await restarted('in_lobby')
      await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'joining', [], { attempt: 2 }))
      expect(await f.occurrence()).toMatchObject({ state: 'in_lobby', resumeState: null })
      // Its status still says joining until it moves: that echo is not an illegal move.
      await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'joining', [], { attempt: 2 }))
      const e = { ...ev(f.id, 'state', { state: 'in_meeting' }), attempt: 2 }
      await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'in_meeting', [e], { attempt: 2 }))
      expect(await f.occurrence()).toMatchObject({ state: 'in_meeting', resumeState: null, restarts: 1 })
      expect(await errorsOf(f)).toEqual([])
    })

    test('a lost acknowledgement: in_lobby behind in_meeting resumes in_meeting', async () => {
      const f = await restarted('in_meeting')
      await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, 'in_lobby', [], { attempt: 2 }))
      expect(await f.occurrence()).toMatchObject({ state: 'in_meeting', resumeState: null })
      expect(await errorsOf(f)).toEqual([])
    })

    test('a lost acknowledgement does not let a worker reach a state after the meeting', async () => {
      const f = await restarted('in_lobby')
      for (const to of ['leaving', 'uploading', 'transcribing', 'completed'] as const) {
        const e = { ...ev(f.id, 'state', { state: to }), attempt: 2 }
        await handleHeartbeat(f.deps, 'Bearer 2.def', beat(f.id, to, [e], { attempt: 2 }))
        expect([to, (await f.occurrence()).state]).toEqual([to, 'restarting'])
      }
      // The path rule needs both states on it: a resume_state before it takes only itself.
      const g = await restarted('verifying_accounts')
      await handleHeartbeat(g.deps, 'Bearer 2.def', beat(g.id, 'joining', [], { attempt: 2 }))
      expect(await g.occurrence()).toMatchObject({ state: 'restarting', resumeState: 'verifying_accounts' })
    })
  })

  test('nothing moves an occurrence that is past the worker: transcribing, post_processing, failed and the rest', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    for (const from of ['transcribing', 'post_processing', 'completed', 'failed', 'waiting_for_pc'] as const) {
      await f.db.update(occurrences).set({ state: from }).where(eq(occurrences.id, f.id))
      // `fail` and `delete` are triggers from these states; the worker can't use them.
      for (const to of ['failed', 'deleted', 'completed', 'post_processing'] as const)
        await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, to))
      expect([from, (await f.occurrence()).state]).toEqual([from, from])
    }
  }, 30_000)

  test('a worker can still report the moves it owns: lobby, denial, leaving the meeting', async () => {
    const f = await controlFixture({ state: 'joining' })
    await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'in_lobby'))
    await handleHeartbeat(f.deps, 'Bearer 1.abc', beat(f.id, 'denied'))
    expect((await f.occurrence()).state).toBe('denied')
    const g = await controlFixture({ state: 'in_meeting' })
    await handleHeartbeat(g.deps, 'Bearer 1.abc', beat(g.id, 'left_by_member'))
    expect((await g.occurrence()).state).toBe('left_by_member')
  })
})

describe('event times', () => {
  const droppedFor = async (f: Awaited<ReturnType<typeof controlFixture>>, at: string) => {
    const res = await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [ev(f.id, 'alert', { kind: 'x' }, at), ev(f.id, 'alert', { kind: 'fine' })])
    )
    expect(res).toMatchObject({ status: 200, body: { ackedEvents: 2 } })
    return (await f.events()).map((e) => [e.type, e.data])
  }

  test('an event more than 5 minutes ahead of the server, or from 1970 or year 0000, is dropped, not clamped', async () => {
    for (const at of ['2099-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z']) {
      const f = await controlFixture({ state: 'in_meeting' })
      expect(await droppedFor(f, at)).toEqual([
        ['alert', { kind: 'fine' }],
        ['error', { reason: 'event_out_of_range' }]
      ])
    }
  })

  test('the edges of the window are kept: 5 minutes ahead, 24 hours before the scheduled start', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const hb = beat(f.id, 'in_meeting', [
      ev(f.id, 'alert', { kind: 'ahead' }, new Date(NOW.getTime() + 5 * 60_000).toISOString()),
      ev(f.id, 'alert', { kind: 'before' }, '2026-10-20T04:00:00.000Z')
    ])
    await handleHeartbeat(f.deps, 'Bearer 1.abc', hb)
    expect((await f.events()).map((e) => e.data)).toEqual([{ kind: 'ahead' }, { kind: 'before' }])
  })

  test('a state event cannot rewrite the actual start, however it is stamped', async () => {
    const f = await controlFixture({ state: 'joining' })
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [ev(f.id, 'state', { state: 'in_meeting' }, '2026-10-20T05:00:00.000Z')])
    )
    expect((await f.occurrence()).actualStart).toEqual(NOW)
  })

  test('a form seen at year 0000 is stored as an event but not upserted, and answers 200', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const url = 'https://docs.google.com/forms/d/e/x/viewform'
    const data = { formId: 'f1', url, source: 'qr', state: 'detected', fieldsFilled: [] }
    const res = await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(f.id, 'form', { ...data, seenAt: '0000-01-01T00:00:00Z' }, '2026-10-21T05:00:01.000Z'),
        ev(f.id, 'form', { ...data, formId: 'f2', seenAt: '2026-10-21T04:30:00Z', submittedAt: '2099-01-01T00:00:00Z' })
      ])
    )
    expect(res.status).toBe(200)
    expect((await f.events()).map((e) => e.type)).toEqual(['form', 'form', 'error', 'error'])
    expect((await f.events()).flatMap((e) => (e.type === 'error' ? [e.data] : []))).toEqual([
      { reason: 'form_not_upserted', formId: 'f1' },
      { reason: 'form_not_upserted', formId: 'f2' }
    ])
    expect(await f.forms()).toEqual([])
  })
})

describe('event bounds', () => {
  test('event data over 16 KB, or nested deeper than 8 levels, is dropped with one error event', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    let deep: unknown = 'x'
    for (let i = 0; i < 9; i++) deep = { n: deep }
    let ok: unknown = 'x'
    for (let i = 0; i < 7; i++) ok = { n: ok }
    const big = { pad: 'x'.repeat(MAX_EVENT_DATA_BYTES) }
    const res = await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(f.id, 'alert', big, '2026-10-21T05:00:01.000Z'),
        ev(f.id, 'alert', deep as object, '2026-10-21T05:00:02.000Z'),
        ev(f.id, 'alert', ok as object, '2026-10-21T05:00:03.000Z'),
        ev(f.id, 'alert', { arr: [[[[[[[[[1]]]]]]]]] }, '2026-10-21T05:00:04.000Z')
      ])
    )
    expect(res).toMatchObject({ status: 200, body: { ackedEvents: 4 } })
    expect((await f.events()).map((e) => [e.type, e.data])).toEqual([
      ['alert', ok as Record<string, unknown>],
      ['error', { reason: 'event_too_large' }]
    ])
  })

  test('a 100,000-level nest (inside the 1 MB body) is a 200 with the event dropped, not a stack overflow', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const nest = '['.repeat(100_000) + ']'.repeat(100_000)
    const body = `{"occurrenceId":"${f.id}","attempt":1,"state":"in_meeting","recording":false,"participants":null,"events":[{"occurrenceId":"${f.id}","attempt":1,"at":"2026-10-21T05:00:01.000Z","type":"alert","data":{"a":${nest}}}]}`
    const res = await handleHeartbeatRequest(
      new Request('http://tm.test/api/control/heartbeat', {
        method: 'POST',
        headers: { authorization: 'Bearer 1.abc' },
        body
      }),
      f.deps,
      NOW
    )
    expect(res.status).toBe(200)
    expect((await f.events()).map((e) => e.data)).toEqual([{ reason: 'event_too_large' }])
  })

  test('past the per-occurrence event cap, new events are acknowledged and dropped with one error event', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const base = Date.parse('2026-10-21T04:10:00Z')
    for (let from = 0; from < MAX_EVENTS_PER_OCCURRENCE; from += 5000) {
      await f.db.insert(events).values(
        Array.from({ length: 5000 }, (_, i) => ({
          occurrenceId: f.id,
          memberId: f.memberId,
          attempt: 1,
          at: new Date(base + from + i),
          type: 'alert' as const,
          data: { i: from + i },
          dataHash: String(from + i)
        }))
      )
    }
    for (let i = 0; i < 2; i++) {
      const res = await handleHeartbeat(
        f.deps,
        'Bearer 1.abc',
        beat(f.id, 'in_meeting', [ev(f.id, 'alert', { n: i }), ev(f.id, 'alert', { n: i + 10 })])
      )
      expect(res).toMatchObject({ status: 200, body: { ackedEvents: 2 } })
    }
    expect(await f.eventCount()).toBe(MAX_EVENTS_PER_OCCURRENCE + 1)
    expect((await f.events()).filter((e) => e.type === 'error').map((e) => e.data)).toEqual([{ reason: 'event_cap' }])
  }, 30_000)

  test('past the per-occurrence form cap, a new form is not stored but a known one still updates', async () => {
    const f = await controlFixture({ state: 'in_meeting' })
    const url = 'https://docs.google.com/forms/d/e/x/viewform'
    await f.db.insert(forms).values(
      Array.from({ length: MAX_FORMS_PER_OCCURRENCE }, (_, i) => ({
        occurrenceId: f.id,
        memberId: f.memberId,
        formKey: `k${i}`,
        url,
        source: 'qr' as const,
        state: 'detected' as const,
        seenAt: new Date('2026-10-21T04:30:00Z')
      }))
    )
    const data = (formId: string, state: string) => ({
      formId,
      url,
      source: 'qr',
      state,
      seenAt: '2026-10-21T04:30:00Z',
      fieldsFilled: []
    })
    await handleHeartbeat(
      f.deps,
      'Bearer 1.abc',
      beat(f.id, 'in_meeting', [
        ev(f.id, 'form', data('new', 'detected'), '2026-10-21T05:00:01.000Z'),
        ev(f.id, 'form', data('k7', 'filling'), '2026-10-21T05:00:02.000Z')
      ])
    )
    expect(await f.forms()).toHaveLength(MAX_FORMS_PER_OCCURRENCE)
    expect(await f.form('new')).toBeUndefined()
    expect((await f.form('k7'))!.state).toBe('filling')
    expect((await f.events()).filter((e) => e.type === 'error').map((e) => e.data)).toEqual([{ reason: 'form_cap' }])
  })
})
