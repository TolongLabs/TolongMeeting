// Test fixture for the companion tables. Import from tests only, never from app code.
import { randomBytes } from 'node:crypto'
import type { DeviceAuth } from '@tm/core'
import { deviceTokens, occurrences, timetableEntries, type Db } from './index'
import { seedMember } from './testing'

const hour = 3_600_000

async function seedDevice(db: Db, memberId: string, name: string): Promise<DeviceAuth> {
  // The hash is random: no real token exists for a fixture device.
  const [device] = await db
    .insert(deviceTokens)
    .values({ memberId, name, tokenHash: randomBytes(16).toString('hex') })
    .returning({ id: deviceTokens.id })
  return { deviceId: device!.id, memberId }
}

async function seedOccurrence(db: Db, memberId: string, identityId: string): Promise<string> {
  const [entry] = await db
    .insert(timetableEntries)
    .values({
      memberId,
      identityId,
      name: 'Data Mining',
      type: 'lecture',
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '14:00',
      endTime: '15:30',
      link: { kind: 'paste' },
      transcription: 'native'
    })
    .returning({ id: timetableEntries.id })
  const start = new Date('2026-10-21T06:00:00Z')
  const [occurrence] = await db
    .insert(occurrences)
    .values({
      memberId,
      entryId: entry!.id,
      identityId,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: 'native',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 1.5 * hour),
      deleteAfter: new Date(start.getTime() + 30 * 24 * hour)
    })
    .returning({ id: occurrences.id })
  return occurrence!.id
}

/**
 * Two members. Member A has devices `DESKTOP-ABC` (`a1`) and `LAPTOP-A` (`a2`) and occurrence `occA`; member B has one
 * device (`b1`) and `occB`. No device has been seen yet (`last_used_at` is null) and no job or event exists.
 */
export async function seedCompanionFixture(db: Db): Promise<{
  a1: DeviceAuth
  a2: DeviceAuth
  b1: DeviceAuth
  occA: string
  occB: string
}> {
  const a = await seedMember(db, { full: false })
  const b = await seedMember(db, { full: false })
  return {
    a1: await seedDevice(db, a.memberId, 'DESKTOP-ABC'),
    a2: await seedDevice(db, a.memberId, 'LAPTOP-A'),
    b1: await seedDevice(db, b.memberId, 'DESKTOP-B'),
    occA: await seedOccurrence(db, a.memberId, a.identityId),
    occB: await seedOccurrence(db, b.memberId, b.identityId)
  }
}
