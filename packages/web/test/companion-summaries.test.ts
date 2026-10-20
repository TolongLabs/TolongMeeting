import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OccurrenceState } from '@tm/core'
import { artefacts, occurrences, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { listSummaries, readSummary } from '../lib/companion/summaries'
import { MAX_ARTEFACT_BYTES } from '../lib/meeting'

let db: Db
let work: string
let dataRoot: string
let previousRoot: string | undefined

beforeAll(async () => {
  db = await createTestDb()
  work = await mkdtemp(join(tmpdir(), 'tm-summaries-'))
  dataRoot = join(work, 'data')
  previousRoot = process.env.TM_DATA_ROOT
  process.env.TM_DATA_ROOT = dataRoot
}, 30_000)

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.TM_DATA_ROOT
  else process.env.TM_DATA_ROOT = previousRoot
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 30_000)

const START = new Date('2026-10-21T06:00:00Z')
const T1 = new Date('2026-10-21T08:00:00Z')
const T2 = new Date('2026-10-21T09:00:00Z')
const EPOCH = new Date(0)

/** A fresh member with an identity; each test uses its own, so their rows never mix. */
async function member(): Promise<{ memberId: string; identityId: string }> {
  return seedMember(db, { full: false })
}

async function occurrence(m: { memberId: string; identityId: string }, state: OccurrenceState): Promise<string> {
  const [row] = await db
    .insert(occurrences)
    .values({
      memberId: m.memberId,
      identityId: m.identityId,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: 'live',
      state,
      scheduledStart: START,
      scheduledEnd: new Date(START.getTime() + 7_200_000),
      deleteAfter: new Date(START.getTime() + 30 * 86_400_000)
    })
    .returning({ id: occurrences.id })
  return row!.id
}

/** A summary row for `occ` (no file on disk). */
async function summaryRow(m: { memberId: string }, occ: string, path: string, createdAt: Date): Promise<void> {
  await db
    .insert(artefacts)
    .values({ occurrenceId: occ, memberId: m.memberId, kind: 'summary', path, bytes: 10, createdAt })
}

/** A summary row whose file is written under the data root. */
async function summaryFile(
  m: { memberId: string },
  occ: string,
  name: string,
  createdAt: Date,
  text = 'Summary text'
): Promise<void> {
  const path = join(dataRoot, 'occurrences', occ, 'out', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  await summaryRow(m, occ, `out/${name}`, createdAt)
}

test('listSummaries returns the member summaries after a time, oldest first, as name, occurrence and time only', async () => {
  const m = await member()
  const first = await occurrence(m, 'completed')
  const second = await occurrence(m, 'completed')
  await summaryFile(m, first, '2026-10-21 1400 Data Mining.md', T1)
  await summaryFile(m, second, '2026-10-21 1500 Other.md', T2)

  expect(await listSummaries(db, m.memberId, new Date('2026-10-21T07:00:00Z'))).toEqual([
    { occurrenceId: first, fileName: '2026-10-21 1400 Data Mining.md', readyAt: '2026-10-21T08:00:00.000Z' },
    { occurrenceId: second, fileName: '2026-10-21 1500 Other.md', readyAt: '2026-10-21T09:00:00.000Z' }
  ])
  // The watermark is strict: the summary at exactly `after` is not listed again.
  expect(await listSummaries(db, m.memberId, T1)).toEqual([
    { occurrenceId: second, fileName: '2026-10-21 1500 Other.md', readyAt: '2026-10-21T09:00:00.000Z' }
  ])
  expect(await listSummaries(db, m.memberId, T2)).toEqual([])
})

test("another member's summary is never listed or returned", async () => {
  const mine = await member()
  const theirs = await member()
  const myOcc = await occurrence(mine, 'completed')
  const theirOcc = await occurrence(theirs, 'completed')
  await summaryFile(mine, myOcc, 'mine.md', T1)
  await summaryFile(theirs, theirOcc, 'theirs.md', T1, 'Their summary')

  const listed = await listSummaries(db, mine.memberId, EPOCH)
  expect(listed.map((item) => item.occurrenceId)).toEqual([myOcc])
  expect(await readSummary(db, mine.memberId, theirOcc)).toBeNull()
  expect(await readSummary(db, theirs.memberId, theirOcc)).toEqual({ fileName: 'theirs.md', text: 'Their summary' })
})

test('a symlinked summary is refused', async () => {
  const m = await member()
  const linked = await occurrence(m, 'completed')
  const plain = await occurrence(m, 'completed')
  const target = join(work, 'elsewhere.md')
  await writeFile(target, 'Not this member')
  await mkdir(join(dataRoot, 'occurrences', linked, 'out'), { recursive: true })
  await symlink(target, join(dataRoot, 'occurrences', linked, 'out', 'linked.md'))
  await summaryRow(m, linked, 'out/linked.md', T1)
  await summaryFile(m, plain, 'plain.md', T1, 'Plain summary')

  expect(await readSummary(db, m.memberId, linked)).toBeNull()
  expect(await readSummary(db, m.memberId, plain)).toEqual({ fileName: 'plain.md', text: 'Plain summary' })
})

test('an unfinished occurrence is not listed', async () => {
  const m = await member()
  const running = await occurrence(m, 'post_processing')
  const done = await occurrence(m, 'completed')
  await summaryFile(m, running, 'running.md', T1)
  await summaryFile(m, done, 'done.md', T2)

  expect((await listSummaries(db, m.memberId, EPOCH)).map((item) => item.occurrenceId)).toEqual([done])
  expect(await readSummary(db, m.memberId, running)).toBeNull()
})

test('a summary over the size cap is refused', async () => {
  const m = await member()
  const occ = await occurrence(m, 'completed')
  await summaryFile(m, occ, 'huge.md', T1)
  await truncate(join(dataRoot, 'occurrences', occ, 'out', 'huge.md'), MAX_ARTEFACT_BYTES + 1)

  expect(await readSummary(db, m.memberId, occ)).toBeNull()
})

test('a page never ends inside a group of summaries that share a timestamp', async () => {
  const m = await member()
  const occ = await occurrence(m, 'completed')
  const rows = [
    ...Array.from({ length: 49 }, (_, i) => ({ name: `a-${i}.md`, at: T1 })),
    ...Array.from({ length: 3 }, (_, i) => ({ name: `b-${i}.md`, at: T2 }))
  ]
  await db.insert(artefacts).values(
    rows.map((row) => ({
      occurrenceId: occ,
      memberId: m.memberId,
      kind: 'summary' as const,
      path: `out/${row.name}`,
      bytes: 10,
      createdAt: row.at
    }))
  )

  // The first page holds the 49 at T1 and not the first of the 3 at T2, which would otherwise be skipped later.
  const first = await listSummaries(db, m.memberId, EPOCH)
  expect(first).toHaveLength(49)
  expect(new Set(first.map((item) => item.readyAt))).toEqual(new Set(['2026-10-21T08:00:00.000Z']))

  // Walking the pages by the last `readyAt` returns every summary exactly once.
  const seen: string[] = []
  let after = EPOCH
  for (;;) {
    const page = await listSummaries(db, m.memberId, after)
    if (page.length === 0) break
    seen.push(...page.map((item) => item.fileName))
    after = new Date(page.at(-1)!.readyAt)
  }
  expect(seen.sort()).toEqual(rows.map((row) => row.name).sort())
})

test('a group of summaries that share a timestamp and fill a page is returned whole', async () => {
  const m = await member()
  const occ = await occurrence(m, 'completed')
  await db.insert(artefacts).values(
    Array.from({ length: 51 }, (_, i) => ({
      occurrenceId: occ,
      memberId: m.memberId,
      kind: 'summary' as const,
      path: `out/same-${i}.md`,
      bytes: 10,
      createdAt: T1
    }))
  )

  expect(await listSummaries(db, m.memberId, EPOCH)).toHaveLength(51)
})
