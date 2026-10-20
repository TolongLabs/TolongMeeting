import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { identities, members, occurrences, profiles, schema } from '../db'
import { aiConfigFor, buildEntrySnapshot, DEFAULT_MODELS, loadJobConfig } from '../db/job-config'
import { sealColumn } from '../db/secrets'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'

afterAll(dropAllTestDbs, 60_000)

const MASTER = Buffer.alloc(32, 5)
const env = {
  dataRoot: '/srv/tm/data',
  profileRoot: '/srv/tm/profiles',
  publicUrl: 'https://tm.example',
  ntfyUrl: 'https://ntfy.tm.example'
}

test('AI config uses the Singapore endpoints', () => {
  expect(aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: null })).toEqual({
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-test',
    asrUrl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
    models: DEFAULT_MODELS
  })
  expect(aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: 'ws-abc123' })).toMatchObject({
    baseUrl: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    asrUrl: 'wss://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime'
  })
})

test('AI config refuses a Workspace ID that could change the host', () => {
  expect(() => aiConfigFor({ dashscopeKey: 'sk-test', workspaceId: 'evil.example/x' })).toThrow(
    'Workspace ID is not a plain identifier'
  )
})

// The seeded occurrence is Wednesday 14:00 to 16:00 in Asia/Kuala_Lumpur.
async function scheduledOccurrence() {
  const db = await createTestDb()
  const seeded = await seedMember(db)
  return { db, ...seeded, occurrenceId: seeded.ids.occurrences }
}

test('the entry snapshot carries local start and end times with the offset', async () => {
  const { db, occurrenceId } = await scheduledOccurrence()
  expect(await buildEntrySnapshot(db, occurrenceId)).toMatchObject({
    start: '2026-10-21T14:00:00+08:00',
    end: '2026-10-21T16:00:00+08:00',
    timeZone: 'Asia/Kuala_Lumpur'
  })
})

test('the snapshot uses the member time zone, including a negative offset', async () => {
  const { db, memberId, occurrenceId } = await scheduledOccurrence()
  await db.update(members).set({ timeZone: 'America/St_Johns' }).where(eq(members.id, memberId))
  expect(await buildEntrySnapshot(db, occurrenceId)).toMatchObject({
    start: '2026-10-21T03:30:00-02:30',
    end: '2026-10-21T05:30:00-02:30',
    timeZone: 'America/St_Johns'
  })
})

test('a pasted link replaces the entry link in the snapshot', async () => {
  const { db, occurrenceId } = await scheduledOccurrence()
  expect((await buildEntrySnapshot(db, occurrenceId)).link).toEqual({ kind: 'paste' })
  await db
    .update(occurrences)
    .set({ pastedLink: 'https://example.zoom.us/j/1?pwd=x' })
    .where(eq(occurrences.id, occurrenceId))
  expect((await buildEntrySnapshot(db, occurrenceId)).link).toEqual({
    kind: 'fixed',
    url: 'https://example.zoom.us/j/1?pwd=x'
  })
})

async function launchable() {
  const f = await scheduledOccurrence()
  const { db, memberId, identityId, occurrenceId } = f
  await db
    .update(members)
    .set({ ntfyTopic: 'tm-topic', ntfyTokenEnc: sealColumn(MASTER, memberId, 'members.ntfy_token', 'ntfy-secret') })
    .where(eq(members.id, memberId))
  await db
    .update(schema.aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(MASTER, memberId, 'ai_keys.dashscope_key', 'sk-dash-secret') })
    .where(eq(schema.aiKeys.memberId, memberId))
  await db
    .update(occurrences)
    .set({ entrySnapshot: await buildEntrySnapshot(db, occurrenceId) })
    .where(eq(occurrences.id, occurrenceId))
  return { ...f, load: () => loadJobConfig(db, MASTER, occurrenceId, { attempt: 1, control: null, env }), identityId }
}

test('the job config maps the organisation and the signed-in form providers', async () => {
  const { db, identityId, load } = await launchable()
  expect(await load()).toMatchObject({ identity: { organisation: null, formProviders: [] } })
  await db
    .update(identities)
    .set({ orgName: 'Example University', orgEmailDomain: 'example.edu.my' })
    .where(eq(identities.id, identityId))
  await db
    .update(profiles)
    .set({
      accountStatus: {
        google: { verifiedAt: '2026-10-20T00:00:00Z', signedIn: true },
        microsoft: { verifiedAt: '2026-10-20T00:00:00Z', signedIn: false },
        zoom: { verifiedAt: '2026-10-20T00:00:00Z', signedIn: true }
      }
    })
    .where(eq(profiles.identityId, identityId))
  const job = await load()
  expect(job.identity).toMatchObject({
    organisation: { name: 'Example University', emailDomain: 'example.edu.my' },
    formProviders: ['google']
  })
  expect(job).toMatchObject({
    ai: { apiKey: 'sk-dash-secret' },
    ntfy: { url: 'https://ntfy.tm.example', topic: 'tm-topic', token: 'ntfy-secret' },
    member: { mentionNames: ['Seed'], details: [{ key: 'full_name', value: 'Seed Member', labels: [] }] },
    dataDir: `/srv/tm/data/occurrences/${job.occurrenceId}`,
    profileDir: `/srv/tm/profiles/${identityId}/work`,
    control: null
  })
})

test('half an organisation is refused', async () => {
  const { db, identityId, load } = await launchable()
  await db.update(identities).set({ orgName: 'Example University' }).where(eq(identities.id, identityId))
  await expect(load()).rejects.toThrow('only one of org_name and org_email_domain')
})
