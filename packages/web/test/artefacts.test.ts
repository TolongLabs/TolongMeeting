import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { artefacts, occurrences, schema } from '../db'
import { registerArtefacts } from '../db/artefacts'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp('/home/user/.cache/tm-tmp/artefacts-')
})
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

const FORM = 'a1b2c3d4e5f60718'

async function artefactFixture(files: string[]) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  const start = new Date('2026-10-21T06:00:00Z')
  const [occ] = await db
    .insert(occurrences)
    .values({
      memberId,
      identityId,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 7_200_000),
      deleteAfter: new Date(start.getTime() + 30 * 86_400_000)
    })
    .returning()
  const dir = await mkdtemp(`${tmp}/occ-`)
  for (const file of files) {
    await mkdir(dirname(`${dir}/${file}`), { recursive: true })
    await writeFile(`${dir}/${file}`, 'x'.repeat(10))
  }
  return {
    db,
    dir,
    occ: { id: occ!.id, memberId },
    rows: () => db.select().from(artefacts).where(eq(artefacts.occurrenceId, occ!.id)),
    kinds: async () => {
      const counts: Record<string, number> = {}
      for (const r of await db.select().from(artefacts).where(eq(artefacts.occurrenceId, occ!.id))) {
        counts[r.kind] = (counts[r.kind] ?? 0) + 1
      }
      return counts
    }
  }
}

describe('registerArtefacts', () => {
  test('the data directory is classified once', async () => {
    const f = await artefactFixture([
      'recording/meeting.mp4',
      'out/2026-10-21 1400 Data Mining.md',
      'out/transcript.md',
      'out/slides.md',
      'out/chat.md',
      'slides/slides.json',
      'slides/01.webp',
      `forms/${FORM}/filled.png`,
      `forms/${FORM}/confirmation.png`,
      'frames/0001_140000.png',
      'chat.jsonl',
      'recording/meeting.mkv',
      'out/summary-pinged',
      `forms/${FORM}/record.json`,
      'forms/not-a-form-id/filled.png'
    ])
    expect(await registerArtefacts(f.db, f.occ, f.dir)).toBe(9)
    expect(await registerArtefacts(f.db, f.occ, f.dir)).toBe(9)
    expect(await f.kinds()).toEqual({
      chat: 1,
      form_screenshot: 2,
      recording: 1,
      slide_image: 1,
      slides: 1,
      slides_json: 1,
      summary: 1,
      transcript: 1
    })
    expect((await f.rows()).every((r) => r.bytes === 10 && r.memberId === f.occ.memberId)).toBe(true)
  })

  test('a second call updates the size of a file that grew', async () => {
    const f = await artefactFixture(['out/transcript.md'])
    await registerArtefacts(f.db, f.occ, f.dir)
    await writeFile(`${f.dir}/out/transcript.md`, 'y'.repeat(25))
    await registerArtefacts(f.db, f.occ, f.dir)
    expect((await f.rows()).map((r) => r.bytes)).toEqual([25])
  })

  test('a symlinked file is not registered, nor one inside a symlinked directory', async () => {
    const f = await artefactFixture(['out/chat.md'])
    const outside = await mkdtemp(`${tmp}/outside-`)
    await writeFile(`${outside}/secret.md`, 'secret')
    await mkdir(`${outside}/forms/${FORM}`, { recursive: true })
    await writeFile(`${outside}/forms/${FORM}/filled.png`, 'png')
    await mkdir(`${outside}/slides`)
    await writeFile(`${outside}/slides/01.webp`, 'webp')
    await symlink(`${outside}/secret.md`, `${f.dir}/out/transcript.md`)
    await symlink(`${outside}/forms`, `${f.dir}/forms`)
    await symlink(`${outside}/slides`, `${f.dir}/slides`)
    await mkdir(`${f.dir}/recording`)
    await symlink(`${f.dir}/out/chat.md`, `${f.dir}/recording/meeting.mp4`)
    expect(await registerArtefacts(f.db, f.occ, f.dir)).toBe(1)
    expect((await f.rows()).map((r) => r.path)).toEqual(['out/chat.md'])
  })

  test('a directory where a file belongs and a FIFO are not registered', async () => {
    const f = await artefactFixture([])
    await mkdir(`${f.dir}/out/transcript.md`, { recursive: true })
    await mkdir(`${f.dir}/recording`)
    Bun.spawnSync(['mkfifo', `${f.dir}/recording/meeting.mp4`])
    expect(await registerArtefacts(f.db, f.occ, f.dir)).toBe(0)
  })

  test('a directory that is itself a symlink to a real directory registers its real files', async () => {
    const f = await artefactFixture(['out/transcript.md'])
    const link = `${f.dir}-link`
    await symlink(f.dir, link)
    expect(await registerArtefacts(f.db, f.occ, link)).toBe(1)
  })

  test('a directory that does not exist registers nothing', async () => {
    const f = await artefactFixture([])
    expect(await registerArtefacts(f.db, f.occ, `${tmp}/missing`)).toBe(0)
  })

  test('rows of another occurrence are not touched', async () => {
    const f = await artefactFixture(['out/chat.md'])
    await registerArtefacts(f.db, f.occ, f.dir)
    const other = await db2(f)
    expect(await registerArtefacts(f.db, other, f.dir)).toBe(1)
    expect(
      await f.db
        .select()
        .from(artefacts)
        .where(and(eq(artefacts.path, 'out/chat.md')))
    ).toHaveLength(2)
  })
})

/** A second occurrence of the same member, in the fixture's database. */
async function db2(f: Awaited<ReturnType<typeof artefactFixture>>) {
  const start = new Date('2026-10-22T06:00:00Z')
  const [identity] = await f.db.select().from(schema.identities)
  const [occ] = await f.db
    .insert(occurrences)
    .values({
      memberId: f.occ.memberId,
      identityId: identity!.id,
      entryName: 'Other',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 7_200_000),
      deleteAfter: new Date(start.getTime() + 30 * 86_400_000)
    })
    .returning()
  return { id: occ!.id, memberId: f.occ.memberId }
}
