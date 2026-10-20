import { afterEach, beforeEach, expect, test } from 'bun:test'
import { IllegalTransition, type OccurrenceState } from '@tm/core'
import { desc, eq } from 'drizzle-orm'
import { events, occurrences, type Db } from '../db'
import { applyTrigger } from '../db/transitions'
import { createTestDb, dropTestDb, seedMember } from '../db/testing'

let db: Db

beforeEach(async () => {
  db = await createTestDb()
})

afterEach(async () => {
  await dropTestDb(db)
})

test('a transition writes the state and a state event', async () => {
  const a = await seedMember(db)
  expect(await applyTrigger(db, a.ids.occurrences, 'launch')).toEqual({
    from: 'scheduled',
    to: 'starting',
    restarts: 0,
    knocks: 0
  })
  // seedMember already wrote one state event; the transition's event is the newest
  const [ev] = await db.select().from(events).where(eq(events.occurrenceId, a.ids.occurrences)).orderBy(desc(events.id))
  expect(ev.data).toEqual({
    from: 'scheduled',
    to: 'starting',
    trigger: 'launch'
  })
})

test('leaving the active states strips passcodes', async () => {
  const a = await seedMember(db)
  await db
    .update(occurrences)
    .set({
      state: 'uploading',
      linkUsed: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
    })
    .where(eq(occurrences.id, a.ids.occurrences))
  await applyTrigger(db, a.ids.occurrences, 'uploaded')
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(o.linkUsed).toBe('https://example.zoom.us/j/00000000000')
})

test('entering a non-active state strips the pasted link and the snapshot link too', async () => {
  const a = await seedMember(db)
  await db
    .update(occurrences)
    .set({
      state: 'in_meeting',
      pastedLink: 'https://teams.microsoft.com/meet/00000000?p=PASSCODE',
      entrySnapshot: {
        name: 'Seed lecture',
        type: 'lecture',
        start: '2026-10-21T14:00:00+08:00',
        end: '2026-10-21T16:00:00+08:00',
        timeZone: 'Asia/Kuala_Lumpur',
        link: { kind: 'fixed', url: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE' },
        trustedSenders: [],
        transcription: 'live',
        formDetails: {},
        attendanceKeywords: []
      }
    })
    .where(eq(occurrences.id, a.ids.occurrences))
  await applyTrigger(db, a.ids.occurrences, 'meeting_over', { reason: 'host ended it' })
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(o.state).toBe('leaving')
  expect(o.stateReason).toBe('host ended it')
  // leaving is an active state: nothing is stripped on entering it
  expect(o.pastedLink).toBe('https://teams.microsoft.com/meet/00000000?p=PASSCODE')

  await applyTrigger(db, a.ids.occurrences, 'left')
  await applyTrigger(db, a.ids.occurrences, 'uploaded')
  const [after] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(after.state).toBe('transcribing')
  expect(after.pastedLink).toBe('https://teams.microsoft.com/meet/00000000')
  expect(after.entrySnapshot?.link).toEqual({ kind: 'fixed', url: 'https://example.zoom.us/j/00000000000' })
})

test('an illegal trigger changes nothing', async () => {
  const a = await seedMember(db)
  await expect(applyTrigger(db, a.ids.occurrences, 'admitted')).rejects.toThrow(IllegalTransition)
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(o.state).toBe('scheduled')
})

test('a trigger that leaves the state where it is writes no event', async () => {
  const a = await seedMember(db)
  await db.update(occurrences).set({ state: 'in_lobby' }).where(eq(occurrences.id, a.ids.occurrences))
  const before = await db.select().from(events).where(eq(events.occurrenceId, a.ids.occurrences))
  expect(await applyTrigger(db, a.ids.occurrences, 'knock_again')).toMatchObject({ from: 'in_lobby', to: 'in_lobby' })
  const after = await db.select().from(events).where(eq(events.occurrenceId, a.ids.occurrences))
  expect(after.length).toBe(before.length)
})

test('concurrent callers: one wins the row lock, the other sees the new state', async () => {
  const a = await seedMember(db)
  const results = await Promise.allSettled([
    applyTrigger(db, a.ids.occurrences, 'launch'),
    applyTrigger(db, a.ids.occurrences, 'launch')
  ])
  const won = results.filter((r) => r.status === 'fulfilled')
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  expect(won.length).toBe(1)
  expect(lost.length).toBe(1)
  expect(lost[0]!.reason).toBeInstanceOf(IllegalTransition)
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
  expect(o.state).toBe<OccurrenceState>('starting')
  const launches = await db.select().from(events).where(eq(events.occurrenceId, a.ids.occurrences))
  expect(launches.filter((e) => e.data.trigger === 'launch').length).toBe(1)
})

const stateEvents = async (occurrenceId: string) =>
  (await db.select().from(events).where(eq(events.occurrenceId, occurrenceId))).filter((e) => e.type === 'state')

const readOccurrence = async (occurrenceId: string) =>
  (await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId)))[0]!

test('a crash stores the state to resume, and only that state may resume', async () => {
  const a = await seedMember(db)
  const id = a.ids.occurrences
  await db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, id))
  expect(await applyTrigger(db, id, 'crash')).toEqual({ from: 'in_meeting', to: 'restarting', restarts: 1, knocks: 0 })
  expect((await readOccurrence(id)).resumeState).toBe('in_meeting')

  await expect(applyTrigger(db, id, 'resume:starting')).rejects.toThrow(IllegalTransition)
  const stuck = await readOccurrence(id)
  expect(stuck.state).toBe('restarting')
  expect(stuck.resumeState).toBe('in_meeting')

  expect(await applyTrigger(db, id, 'resume:in_meeting')).toMatchObject({ from: 'restarting', to: 'in_meeting' })
  const resumed = await readOccurrence(id)
  expect(resumed.state).toBe('in_meeting')
  expect(resumed.resumeState).toBeNull()
  expect(resumed.restarts).toBe(1)
})

test('a resume with nothing stored is illegal', async () => {
  const a = await seedMember(db)
  await db.update(occurrences).set({ state: 'restarting' }).where(eq(occurrences.id, a.ids.occurrences))
  await expect(applyTrigger(db, a.ids.occurrences, 'resume:in_meeting')).rejects.toThrow(IllegalTransition)
})

test('crashes count up, including a crash while restarting, which adds no state event', async () => {
  const a = await seedMember(db)
  const id = a.ids.occurrences
  await db.update(occurrences).set({ state: 'in_lobby' }).where(eq(occurrences.id, id))
  const counts: number[] = []
  counts.push((await applyTrigger(db, id, 'crash')).restarts)
  const afterFirst = (await stateEvents(id)).length
  for (let i = 0; i < 3; i++) counts.push((await applyTrigger(db, id, 'crash')).restarts)
  expect(counts).toEqual([1, 2, 3, 4])
  expect((await stateEvents(id)).length).toBe(afterFirst)
  const o = await readOccurrence(id)
  expect(o.restarts).toBe(4)
  expect(o.state).toBe('restarting')
  // the repeated crashes keep the state from before the first one
  expect(o.resumeState).toBe('in_lobby')
  expect(await applyTrigger(db, id, 'resume:in_lobby')).toMatchObject({ to: 'in_lobby', restarts: 4 })
})

test('knock_again counts knocks, records no event, and the count survives a fresh read', async () => {
  const a = await seedMember(db)
  const id = a.ids.occurrences
  await db.update(occurrences).set({ state: 'in_lobby' }).where(eq(occurrences.id, id))
  const before = (await stateEvents(id)).length
  expect(await applyTrigger(db, id, 'knock_again')).toEqual({
    from: 'in_lobby',
    to: 'in_lobby',
    restarts: 0,
    knocks: 1
  })
  expect((await applyTrigger(db, id, 'knock_again')).knocks).toBe(2)
  expect((await stateEvents(id)).length).toBe(before)
  const o = await readOccurrence(id)
  expect(o.knocks).toBe(2)
  expect(o.state).toBe('in_lobby')
})

test('leaving restarting by another route clears the stored resume state', async () => {
  const a = await seedMember(db)
  const id = a.ids.occurrences
  await db.update(occurrences).set({ state: 'joining' }).where(eq(occurrences.id, id))
  await applyTrigger(db, id, 'crash')
  await applyTrigger(db, id, 'fail', { reason: 'too many restarts' })
  const o = await readOccurrence(id)
  expect(o.state).toBe('failed')
  expect(o.resumeState).toBeNull()
})
