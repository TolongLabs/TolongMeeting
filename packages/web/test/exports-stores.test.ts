import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { connections, exports as exportsTable, occurrences, type Db } from '../db'
import { memberExportStores, type MemberExportStores } from '../db/exports'
import { sealColumn } from '../db/secrets'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { createScope } from '../lib/scope'

let db: Db
let master: Buffer
let m1: string
let m2: string
let o1: string
let s1: MemberExportStores
let s2: MemberExportStores

const forMember = (id: string) => memberExportStores(createScope(db, id), master, '/data')

beforeAll(async () => {
  db = await createTestDb()
  master = randomBytes(32)
  const a = await seedMember(db)
  const b = await seedMember(db)
  m1 = a.memberId
  m2 = b.memberId
  o1 = a.ids.occurrences
  // Only a finished meeting can be exported.
  await db.update(occurrences).set({ state: 'completed' }).where(eq(occurrences.id, o1))
  s1 = forMember(m1)
  s2 = forMember(m2)
})
afterAll(() => dropAllTestDbs(), 60_000)
beforeEach(async () => {
  await db.delete(exportsTable)
  await db.delete(connections)
})

const GITHUB = {
  kind: 'github',
  token: 'github_pat_TESTTOKEN123',
  owner: 'acme',
  repo: 'notes',
  branch: 'main',
  folder: 'meetings'
} as const

describe('exports', () => {
  test('one active export per occurrence and target', async () => {
    const first = await s1.exports.create(o1, 'zip')
    expect(first).toMatchObject({ ok: true, row: { status: 'queued', memberId: m1, occurrenceId: o1, target: 'zip' } })
    expect(await s1.exports.create(o1, 'zip')).toEqual({
      ok: false,
      code: 'already_running',
      message: 'This export is already running.'
    })
    expect((await s1.exports.create(o1, 'pdf')).ok).toBe(true)

    await db.update(exportsTable).set({ status: 'running' }).where(eq(exportsTable.target, 'zip'))
    expect(await s1.exports.create(o1, 'zip')).toMatchObject({ ok: false, code: 'already_running' })

    await db.update(exportsTable).set({ status: 'succeeded' }).where(eq(exportsTable.target, 'zip'))
    expect(await s1.exports.create(o1, 'zip')).toMatchObject({ ok: true, row: { status: 'queued' } })
  })

  test('a member has at most 3 exports queued or running, and finishing one frees a place', async () => {
    const active = (target: 'github' | 'gdocs' | 'notion', status: 'queued' | 'running') =>
      db.insert(exportsTable).values({ occurrenceId: o1, memberId: m1, target, status })
    await active('github', 'queued')
    await active('gdocs', 'running')
    expect((await s1.exports.create(o1, 'zip')).ok).toBe(true)
    expect(await s1.exports.create(o1, 'pdf')).toEqual({
      ok: false,
      code: 'too_many',
      message: 'You have too many exports running. Wait for one to finish.'
    })
    // Another member counts on their own.
    expect(await db.$count(exportsTable, eq(exportsTable.memberId, m2))).toBe(0)
    await db.update(exportsTable).set({ status: 'succeeded' }).where(eq(exportsTable.target, 'github'))
    expect((await s1.exports.create(o1, 'pdf')).ok).toBe(true)
  })

  test('two requests at once cannot pass the cap together', async () => {
    await db.insert(exportsTable).values([
      { occurrenceId: o1, memberId: m1, target: 'github' as const },
      { occurrenceId: o1, memberId: m1, target: 'gdocs' as const }
    ])
    const answers = await Promise.all([s1.exports.create(o1, 'zip'), s1.exports.create(o1, 'pdf')])
    expect(answers.filter((a) => a.ok)).toHaveLength(1)
    expect(await db.$count(exportsTable, eq(exportsTable.memberId, m1))).toBe(3)
  })

  test("a member cannot export, read or list another member's meeting", async () => {
    const made = await s1.exports.create(o1, 'zip')
    if (!made.ok) throw new Error('create failed')
    expect(await s2.exports.create(o1, 'zip')).toMatchObject({ ok: false, code: 'not_found' })
    expect(await s2.exports.get(made.row.id)).toBeNull()
    expect(await s2.exports.listForOccurrence(o1)).toEqual([])
    expect(await s1.exports.get(made.row.id)).toMatchObject({ id: made.row.id })
    expect(await s1.exports.get('not-a-uuid')).toBeNull()
  })

  test('listForOccurrence is newest first', async () => {
    const zip = await s1.exports.create(o1, 'zip')
    await Bun.sleep(5)
    const pdf = await s1.exports.create(o1, 'pdf')
    if (!zip.ok || !pdf.ok) throw new Error('create failed')
    expect((await s1.exports.listForOccurrence(o1)).map((r) => r.id)).toEqual([pdf.row.id, zip.row.id])
  })

  test('a deleted meeting is not found and an unfinished one is not ready', async () => {
    const [first] = await db.select().from(occurrences).where(eq(occurrences.id, o1))
    const { id: _id, ...rest } = first!
    const spare = async (state: 'deleted' | 'scheduled' | 'transcribing', hour: number) => {
      const [row] = await db
        .insert(occurrences)
        .values({
          ...rest,
          state,
          scheduledStart: new Date(`2026-11-0${hour}T06:00:00Z`),
          scheduledEnd: new Date(`2026-11-0${hour}T08:00:00Z`)
        })
        .returning()
      return row!.id
    }
    expect(await s1.exports.create(await spare('deleted', 1), 'zip')).toMatchObject({ ok: false, code: 'not_found' })
    for (const [state, hour] of [
      ['scheduled', 2],
      ['transcribing', 3]
    ] as const)
      expect(await s1.exports.create(await spare(state, hour), 'zip')).toEqual({
        ok: false,
        code: 'not_ready',
        message: 'This meeting has no finished summary to export.'
      })
    expect(await db.$count(exportsTable)).toBe(0)
  })

  test('listForOccurrence returns the newest 50', async () => {
    const base = Date.parse('2026-10-20T00:00:00Z')
    await db.insert(exportsTable).values(
      Array.from({ length: 60 }, (_, i) => ({
        occurrenceId: o1,
        memberId: m1,
        target: 'zip' as const,
        status: 'succeeded' as const,
        createdAt: new Date(base + i * 1000)
      }))
    )
    const list = await s1.exports.listForOccurrence(o1)
    expect(list).toHaveLength(50)
    expect(list[0]!.createdAt.getTime()).toBe(base + 59_000)
    expect(list[49]!.createdAt.getTime()).toBe(base + 10_000)
  })

  test('occurrences resolve only for their owner, with the data directory', async () => {
    expect(await s2.occurrences.get(o1)).toBeNull()
    expect(await s1.occurrences.get(o1)).toMatchObject({
      id: o1,
      memberId: m1,
      state: 'completed',
      dataDir: `/data/occurrences/${o1}`
    })
    expect(await s1.occurrences.get('nope')).toBeNull()
    const [row] = await db.select({ id: occurrences.id }).from(occurrences).where(eq(occurrences.id, o1))
    expect(row).toBeDefined()
  })
})

describe('connections', () => {
  test('tokens are sealed in the database and summaries hold none', async () => {
    await s1.connections.save(GITHUB)
    const stored = JSON.stringify(await db.select().from(connections))
    expect(stored).not.toContain('TESTTOKEN')
    expect(stored).toContain('acme')
    expect((await s1.connections.get('github'))?.connection).toEqual(GITHUB)
    const summaries = await s1.connections.summaries()
    expect(summaries).toEqual([
      { kind: 'github', status: 'ok', ready: true, label: 'acme/notes', detail: 'branch main, folder meetings' }
    ])
    expect(JSON.stringify(summaries)).not.toContain('TESTTOKEN')
  })

  test('save replaces the connection, resets the status and keeps one row', async () => {
    await s1.connections.save(GITHUB)
    await s1.connections.markReconnect('github')
    expect((await s1.connections.get('github'))?.status).toBe('reconnect_needed')
    await s1.connections.save({ ...GITHUB, token: 'github_pat_SECOND456', folder: '' })
    expect(await s1.connections.get('github')).toMatchObject({
      status: 'ok',
      connection: { token: 'github_pat_SECOND456' }
    })
    expect(await db.$count(connections)).toBe(1)
    expect((await s1.connections.summaries())[0]!.detail).toBe('branch main, folder /')
  })

  test('concurrent first saves leave one row', async () => {
    await Promise.all([s1.connections.save(GITHUB), s1.connections.save({ ...GITHUB, repo: 'other' })])
    expect(await db.$count(connections)).toBe(1)
  })

  test('members see and change only their own connections', async () => {
    await s1.connections.save(GITHUB)
    expect(await s2.connections.get('github')).toBeNull()
    expect(await s2.connections.summaries()).toEqual([])
    await s2.connections.markReconnect('github')
    await s2.connections.remove('github')
    expect(await s1.connections.get('github')).toMatchObject({ status: 'ok' })
    await s1.connections.remove('github')
    expect(await s1.connections.get('github')).toBeNull()
  })

  test('google and notion summaries; notion is not ready until a page is chosen', async () => {
    await s1.connections.save({
      kind: 'google',
      refreshToken: '1//0gREFRESH',
      account: 'me@example.com',
      folderId: 'f1',
      folderName: 'Tolong Meeting',
      folderIsDefault: true
    })
    await s1.connections.save({
      kind: 'notion',
      accessToken: 'ntn_ACCESS',
      refreshToken: null,
      workspace: 'Acme',
      parent: null
    })
    expect(await s1.connections.summaries()).toEqual([
      { kind: 'google', status: 'ok', ready: true, label: 'me@example.com', detail: 'Tolong Meeting' },
      { kind: 'notion', status: 'ok', ready: false, label: 'Acme', detail: 'No page chosen yet' }
    ])
    const parent = { type: 'page_id', id: 'p1', name: 'Lectures', titleProperty: 'title' } as const
    await s1.connections.save({
      kind: 'notion',
      accessToken: 'ntn_ACCESS',
      refreshToken: 'ntn_R',
      workspace: 'Acme',
      parent
    })
    expect((await s1.connections.summaries())[1]).toMatchObject({ ready: true, detail: 'Lectures' })
    expect((await s1.connections.get('notion'))?.connection).toMatchObject({ refreshToken: 'ntn_R', parent })
  })

  test('a sealed value moved to another member, column or kind does not open', async () => {
    await s1.connections.save(GITHUB)
    const [row] = await db.select().from(connections)
    // Another member: the AAD names the member.
    await db
      .insert(connections)
      .values({ memberId: m2, kind: 'github', tokenEnc: row!.tokenEnc, settings: row!.settings })
    await expect(s2.connections.get('github')).rejects.toThrow()
    // Another kind: the sealed JSON names its kind.
    const wrongKind = sealColumn(master, m2, 'connections.token', JSON.stringify({ kind: 'google', refreshToken: 'x' }))
    await db.update(connections).set({ tokenEnc: wrongKind }).where(eq(connections.memberId, m2))
    await expect(s2.connections.get('github')).rejects.toThrow()
    // Another column.
    const wrongColumn = sealColumn(master, m2, 'members.ntfy_token', JSON.stringify({ kind: 'github', token: 'x' }))
    await db.update(connections).set({ tokenEnc: wrongColumn }).where(eq(connections.memberId, m2))
    await expect(s2.connections.get('github')).rejects.toThrow()
  })

  test('summaries skips a row whose settings fail their schema and logs only its id', async () => {
    await s1.connections.save(GITHUB)
    await s1.connections.save({
      kind: 'google',
      refreshToken: '1//0gREFRESH',
      account: 'me@example.com',
      folderId: 'f1',
      folderName: 'Tolong Meeting',
      folderIsDefault: true
    })
    await db
      .update(connections)
      .set({ settings: { owner: 'LEAKY-OWNER' } })
      .where(eq(connections.kind, 'github'))
    const [bad] = await db.select().from(connections).where(eq(connections.kind, 'github'))
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(' '))
    try {
      expect(await s1.connections.summaries()).toEqual([
        { kind: 'google', status: 'ok', ready: true, label: 'me@example.com', detail: 'Tolong Meeting' }
      ])
    } finally {
      console.error = original
    }
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(bad!.id)
    expect(logged[0]).not.toContain('LEAKY-OWNER')
  })

  test('a failed read does not put the token in the error', async () => {
    await s1.connections.save(GITHUB)
    await db.update(connections).set({ settings: { owner: 1 } })
    const err = await s1.connections.get('github').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain('TESTTOKEN')
  })
})
