import { afterAll, beforeEach, expect, test } from 'bun:test'
import { LocalSecretsSchema, type DeviceAuth, type SpecEnv } from '@tm/core'
import { eq, sql } from 'drizzle-orm'
import { aiKeys, details, identities, members, occurrences, type Db } from '../db'
import {
  claimJob,
  createCompanionJob,
  getJob,
  releaseExpiredLeases,
  releaseJob,
  type DeviceAuth as Device
} from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { buildEntrySnapshot } from '../db/job-config'
import { sealColumn } from '../db/secrets'
import { createTestDb, dropAllTestDbs } from '../db/testing'
import { handleReleaseRequest, handleSecretsRequest, localSecrets, type LocalDeps } from '../lib/companion/local'
import { createDeviceScope } from '../lib/companion/scope'

afterAll(dropAllTestDbs, 60_000)

const MASTER = Buffer.alloc(32, 5)
const env: SpecEnv = {
  dataRoot: '/data',
  profileRoot: '/profiles',
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.example'
}
/** 21 October 2026 in Kuala Lumpur. The fixture meeting is 14:00 to 15:30. */
const at = (hhmmss: string) => new Date(`2026-10-21T${hhmmss}+08:00`)

let db: Db
let deps: LocalDeps
let f: Awaited<ReturnType<typeof seedCompanionFixture>>

beforeEach(async () => {
  db = await createTestDb()
  deps = { db, master: MASTER, env }
  f = await seedCompanionFixture(db)
  const memberId = f.a1.memberId
  await db
    .update(members)
    .set({ ntfyTopic: 'tm-topic', ntfyTokenEnc: sealColumn(MASTER, memberId, 'members.ntfy_token', 'ntfy-secret') })
    .where(eq(members.id, memberId))
  await db
    .update(aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(MASTER, memberId, 'ai_keys.dashscope_key', 'sk-member-a') })
    .where(eq(aiKeys.memberId, memberId))
  await db.insert(details).values({ memberId, key: 'full_name', value: 'Alice Tan', labels: ['name'] })
  await db
    .update(occurrences)
    .set({ entrySnapshot: await buildEntrySnapshot(db, f.occA) })
    .where(eq(occurrences.id, f.occA))
  const [identity] = await db.select({ id: identities.id }).from(identities).where(eq(identities.memberId, memberId))
  await db
    .update(identities)
    .set({ runLocation: 'local', localDeviceId: f.a1.deviceId })
    .where(eq(identities.id, identity!.id))
}, 60_000)

async function payloadFor(occurrenceId: string, memberId: string) {
  const [identity] = await db.select().from(identities).where(eq(identities.memberId, memberId))
  const snapshot = await buildEntrySnapshot(db, occurrenceId)
  return {
    occurrenceId,
    identityId: identity!.id,
    identityName: identity!.name,
    image: 'ghcr.io/org/worker:1',
    job: {
      occurrenceId,
      attempt: 1,
      entry: snapshot,
      identity: { id: identity!.id, name: identity!.name, zoomGuestName: 'A', formProviders: [], organisation: null },
      member: { id: memberId, displayName: 'A', mentionNames: [] },
      ai: {
        baseUrl: 'https://ai.example/v1',
        asrUrl: 'wss://ai.example/asr',
        models: { summary: 'a', vision: 'b', formMatch: 'c', asr: 'd' }
      },
      ntfy: { url: 'https://ntfy.example', topic: 't' },
      dataDir: '/data/o',
      profileDir: '/profiles/i'
    }
  }
}

async function claimedLocalRun(device: DeviceAuth, claimAt = at('13:00')): Promise<string> {
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'local_run',
    payload: await payloadFor(f.occA, f.a1.memberId),
    targetDeviceId: f.a1.deviceId
  })
  // The PC was seen a moment ago.
  await db.execute(sql`update device_tokens set last_used_at = ${claimAt} where id = ${device.deviceId}`)
  expect(await claimJob(db, device, id, claimAt)).toMatchObject({ state: 'claimed' })
  return id
}

test('secrets go only to the PC holding an active local run, and only near the meeting', async () => {
  const id = await claimedLocalRun(f.a1)
  expect(await localSecrets(deps, f.a1, id, at('12:49'))).toBeNull() // before start - 70 min
  const secrets = await localSecrets(deps, f.a1, id, at('13:00'))
  expect(LocalSecretsSchema.parse(secrets)).toEqual({
    apiKey: 'sk-member-a',
    details: [{ key: 'full_name', value: 'Alice Tan', labels: ['name'] }]
  })
  expect(await localSecrets(deps, f.a1, id, at('15:59'))).not.toBeNull() // the meeting ends at 15:30
  expect(await localSecrets(deps, f.a1, id, at('16:00:01'))).toBeNull() // end + 30 min
  expect(await localSecrets(deps, f.a2, id, at('13:00'))).toBeNull()
  expect(await localSecrets(deps, f.b1, id, at('13:00'))).toBeNull()
  expect(await localSecrets(deps, f.a1, 'not-a-uuid', at('13:00'))).toBeNull()
})

test('the secrets route answers 200 with no-store, and 404 for any other job or device', async () => {
  const id = await claimedLocalRun(f.a1)
  const own = await handleSecretsRequest(createDeviceScope(db, f.a1), deps, id, at('13:00'))
  expect(own.status).toBe(200)
  expect(own.headers.get('cache-control')).toBe('no-store')
  expect(LocalSecretsSchema.parse(await own.json()).apiKey).toBe('sk-member-a')

  const other = await handleSecretsRequest(createDeviceScope(db, f.a2), deps, id, at('13:00'))
  expect(other.status).toBe(404)
  expect(JSON.stringify(await other.json())).not.toContain('sk-member-a')
  const native = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: {
      occurrenceId: f.occA,
      entryName: 'Data Mining',
      start: '2026-10-21T14:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      durationSec: 5400,
      flacBytes: 1000
    }
  })
  await claimJob(db, f.a1, native, at('13:00'))
  expect((await handleSecretsRequest(createDeviceScope(db, f.a1), deps, native, at('13:00'))).status).toBe(404)
})

test('a revoked PC gets no secrets', async () => {
  const id = await claimedLocalRun(f.a1)
  await db.execute(sql`update device_tokens set revoked_at = now() where id = ${f.a1.deviceId}`)
  expect(await localSecrets(deps, f.a1, id, at('13:00'))).toBeNull()
})

test('local runs keep their claim when the lease lapses; release keeps the attempt count', async () => {
  const id = await claimedLocalRun(f.a1)
  expect(await releaseExpiredLeases(db, at('18:00'))).not.toContain(id)
  expect((await getJob(db, id))?.state).toBe('claimed')

  // A native job is claimable only while its meeting waits for the transcript.
  await db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, f.occA))
  const native = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'native_transcription',
    payload: {
      occurrenceId: f.occA,
      entryName: 'Data Mining',
      start: '2026-10-21T14:00:00+08:00',
      timeZone: 'Asia/Kuala_Lumpur',
      durationSec: 5400,
      flacBytes: 1000
    }
  })
  expect(await claimJob(db, f.a1, native, at('13:00'))).not.toBeNull()
  expect(await releaseJob(db, f.a1, native)).toBe(true)
  expect(await getJob(db, native)).toMatchObject({ state: 'pending', attempts: 0 })
})

test('release is only for the holding device', async () => {
  const id = await claimedLocalRun(f.a1)
  const auth = (d: Device) => createDeviceScope(db, d)
  expect(await releaseJob(db, f.a2, id)).toBe(false)
  expect(await releaseJob(db, f.b1, id)).toBe(false)
  expect((await handleReleaseRequest(auth(f.a2), deps, id)).status).toBe(404)
  expect((await handleReleaseRequest(auth(f.a1), deps, 'nope')).status).toBe(404)
  expect((await getJob(db, id))?.state).toBe('claimed')
  const res = await handleReleaseRequest(auth(f.a1), deps, id)
  expect(res.status).toBe(204)
  expect((await getJob(db, id))?.state).toBe('pending')
  // Released: the holder no longer holds it.
  expect(await releaseJob(db, f.a1, id)).toBe(false)
})
