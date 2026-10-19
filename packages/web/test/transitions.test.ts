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
    to: 'starting'
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
  expect(await applyTrigger(db, a.ids.occurrences, 'knock_again')).toEqual({ from: 'in_lobby', to: 'in_lobby' })
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
