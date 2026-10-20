import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { connections, exports as exportsTable, occurrences, type Db } from '../db'
import { memberExportStores, type MemberExportStores } from '../db/exports'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { exportFileResponse } from '../lib/export-files'
import { connectionsResponse, createExportResponse, listExportsResponse } from '../lib/exports'
import { createScope } from '../lib/scope'
import { assertSameOrigin } from '../lib/same-origin'

let db: Db
let work: string
let master: Buffer
let previousRoot: string | undefined
let previousUrl: string | undefined

beforeAll(async () => {
  db = await createTestDb()
  master = randomBytes(32)
  work = await mkdtemp(join(tmpdir(), 'tm-export-routes-'))
  previousRoot = process.env.TM_DATA_ROOT
  previousUrl = process.env.TM_PUBLIC_URL
  process.env.TM_DATA_ROOT = join(work, 'data')
  process.env.TM_PUBLIC_URL = 'https://tm.example/'
}, 30_000)

afterAll(async () => {
  for (const [name, value] of [
    ['TM_DATA_ROOT', previousRoot],
    ['TM_PUBLIC_URL', previousUrl]
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 30_000)

interface Fixture {
  occurrenceId: string
  dir: string
  mine: MemberExportStores
  theirs: MemberExportStores
}

/** Two members; the first owns a completed meeting whose directory exists. */
async function fixture(state: 'completed' | 'deleted' | 'post_processing' = 'completed'): Promise<Fixture> {
  const a = await seedMember(db)
  const b = await seedMember(db)
  const occurrenceId = a.ids.occurrences
  await db.update(occurrences).set({ state }).where(eq(occurrences.id, occurrenceId))
  // The seed adds an export and connections of its own; these tests start from none.
  for (const m of [a.memberId, b.memberId]) {
    await db.delete(exportsTable).where(eq(exportsTable.memberId, m))
    await db.delete(connections).where(eq(connections.memberId, m))
  }
  const dir = join(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)
  await mkdir(join(dir, 'exports'), { recursive: true })
  const forMember = (id: string) => memberExportStores(createScope(db, id), master, process.env.TM_DATA_ROOT!)
  return { occurrenceId, dir, mine: forMember(a.memberId), theirs: forMember(b.memberId) }
}

const post = (body: unknown) => new Request('https://tm.example/x', { method: 'POST', body: JSON.stringify(body) })
const get = () => new Request('https://tm.example/x')

async function queue(f: Fixture, target: 'zip' | 'pdf' | 'github' | 'notion' = 'zip'): Promise<string> {
  const res = await createExportResponse(f.mine, f.occurrenceId, post({ target }))
  expect(res.status).toBe(202)
  return ((await res.json()) as { exportId: string }).exportId
}

/** Marks the export done the way the runner does, with the title the bundle gave it. */
async function finish(id: string, filePath: string | null, title = 'Pengurusan Café') {
  await db
    .update(exportsTable)
    .set({ status: 'succeeded', filePath, title, finishedAt: new Date() })
    .where(eq(exportsTable.id, id))
}

describe('create and list', () => {
  test('a queued export shows in the list without a path or a title', async () => {
    const f = await fixture()
    const id = await queue(f, 'pdf')
    const res = await listExportsResponse(f.mine, f.occurrenceId)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { exports: Record<string, unknown>[] }
    expect(body.exports).toMatchObject([{ id, target: 'pdf', label: 'PDF', status: 'queued', downloadUrl: null }])
    expect(JSON.stringify(body)).not.toMatch(/filePath|file_path|memberId|title/)
  })

  test('another member, a deleted meeting and an unknown id all get the same 404', async () => {
    const f = await fixture()
    const gone = await fixture('deleted')
    const unknown = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
    const answers = await Promise.all([
      createExportResponse(f.theirs, f.occurrenceId, post({ target: 'zip' })),
      listExportsResponse(f.theirs, f.occurrenceId),
      createExportResponse(gone.mine, gone.occurrenceId, post({ target: 'zip' })),
      listExportsResponse(gone.mine, gone.occurrenceId),
      createExportResponse(f.mine, unknown, post({ target: 'zip' })),
      createExportResponse(f.mine, 'not-a-uuid', post({ target: 'zip' }))
    ])
    for (const res of answers) expect([res.status, await res.text()]).toEqual([404, '{"error":"not_found"}'])
  })

  test('the body is strict, and store refusals map to 409', async () => {
    const f = await fixture()
    for (const body of [{ target: 'dropbox' }, { target: 'zip', extra: 1 }, {}, 'zip', null]) {
      const res = await createExportResponse(f.mine, f.occurrenceId, post(body))
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([422, 'invalid_target'])
    }
    const bad = await createExportResponse(
      f.mine,
      f.occurrenceId,
      new Request('https://tm.example/x', { method: 'POST', body: '{' })
    )
    expect(bad.status).toBe(422)
    const huge = await createExportResponse(f.mine, f.occurrenceId, post({ target: 'zip', pad: 'x'.repeat(2000) }))
    expect(huge.status).toBe(422)

    await queue(f, 'zip')
    const again = await createExportResponse(f.mine, f.occurrenceId, post({ target: 'zip' }))
    expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([409, 'already_running'])

    const busy = await fixture('post_processing')
    const early = await createExportResponse(busy.mine, busy.occurrenceId, post({ target: 'zip' }))
    expect([early.status, ((await early.json()) as { error: string }).error]).toEqual([409, 'not_ready'])
  })

  test('a fourth queued or running export of a member is refused with 429 and a fixed message', async () => {
    const f = await fixture()
    const [row] = await db.select().from(occurrences).where(eq(occurrences.id, f.occurrenceId))
    const memberId = row!.memberId
    await db
      .insert(exportsTable)
      .values(
        (['github', 'gdocs', 'notion'] as const).map((target) => ({ occurrenceId: f.occurrenceId, memberId, target }))
      )
    const res = await createExportResponse(f.mine, f.occurrenceId, post({ target: 'zip' }))
    expect([res.status, await res.json()]).toEqual([
      429,
      { error: 'too_many_exports', message: 'You have too many exports running. Wait for one to finish.' }
    ])
    const other = await createExportResponse(f.theirs, f.occurrenceId, post({ target: 'zip' }))
    expect(other.status).toBe(404)
  })

  test('a remote target needs a connection that is connected, not marked for reconnect, and has its settings', async () => {
    const f = await fixture()
    const refusal = async (target: string) => {
      const res = await createExportResponse(f.mine, f.occurrenceId, post({ target }))
      return [res.status, ((await res.json()) as { error: string }).error]
    }
    expect(await refusal('github')).toEqual([422, 'not_connected'])
    await f.mine.connections.save({
      kind: 'notion',
      accessToken: 'ntn_secret_value',
      refreshToken: null,
      workspace: 'Notes',
      parent: null
    })
    expect(await refusal('notion')).toEqual([422, 'invalid_settings'])
    await f.mine.connections.save({
      kind: 'github',
      token: 'github_pat_secret_value',
      owner: 'acme',
      repo: 'notes',
      branch: 'main',
      folder: 'meetings'
    })
    await f.mine.connections.markReconnect('github')
    expect(await refusal('github')).toEqual([422, 'reconnect_needed'])
    await f.mine.connections.save({
      kind: 'github',
      token: 'github_pat_secret_value',
      owner: 'acme',
      repo: 'notes',
      branch: 'main',
      folder: 'meetings'
    })
    expect((await createExportResponse(f.mine, f.occurrenceId, post({ target: 'github' }))).status).toBe(202)
  })

  test('a failed export shows a fixed sentence, never the stored text', async () => {
    const f = await fixture()
    const id = await queue(f, 'pdf')
    await db
      .update(exportsTable)
      .set({ status: 'failed', errorCode: 'failed', error: 'Something went wrong: GitHub said ghp_LEAK token x' })
      .where(eq(exportsTable.id, id))
    const text = await (await listExportsResponse(f.mine, f.occurrenceId)).text()
    expect(text).not.toContain('ghp_LEAK')
    expect(text).toContain('The export failed. Try again.')
  })
})

describe('connections', () => {
  test('the list is a masked status for the member only', async () => {
    const f = await fixture()
    await f.mine.connections.save({
      kind: 'github',
      token: 'github_pat_abc123SECRET',
      owner: 'acme',
      repo: 'notes',
      branch: 'main',
      folder: ''
    })
    const mine = await (await connectionsResponse(f.mine)).text()
    expect(mine).not.toContain('github_pat_')
    expect(mine).not.toContain('SECRET')
    expect(JSON.parse(mine)).toEqual({
      connections: [{ kind: 'github', status: 'ok', ready: true, label: 'acme/notes', detail: 'branch main, folder /' }]
    })
    expect(await (await connectionsResponse(f.theirs)).json()).toEqual({ connections: [] })
  })
})

describe('the file route', () => {
  async function done(f: Fixture, target: 'zip' | 'pdf' = 'zip', bytes = 'PK-fake-zip'): Promise<string> {
    const id = await queue(f, target)
    await writeFile(join(f.dir, 'exports', `${id}.${target}`), bytes)
    await finish(id, `exports/${id}.${target}`, 'x"; filename="evil.html\r\nX-Evil: 1')
    return id
  }

  test('serves a finished zip to its owner with a fixed type, name and safe headers', async () => {
    const f = await fixture()
    const id = await done(f)
    const res = await exportFileResponse(f.mine, id, get())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const disposition = res.headers.get('content-disposition')!
    expect(disposition).toMatch(/^attachment; filename="tolongmeeting-\d{4}-\d{2}-\d{2}-zip\.zip"; filename\*=UTF-8''/)
    expect(disposition).not.toMatch(/evil|Caf/)
    expect(res.headers.get('x-evil')).toBeNull()
    expect(await res.text()).toBe('PK-fake-zip')
    const list = (await (await listExportsResponse(f.mine, f.occurrenceId)).json()) as {
      exports: { downloadUrl: string }[]
    }
    expect(list.exports[0]!.downloadUrl).toBe(`/api/exports/${id}/file`)

    const pdf = await exportFileResponse(f.mine, await done(f, 'pdf', '%PDF'), get())
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
  })

  test('another member, an unknown id, a deleted meeting and an unfinished export are the same 404', async () => {
    const f = await fixture()
    const id = await done(f)
    const queued = await queue(f, 'pdf')
    const gone = await fixture()
    const goneId = await done(gone)
    await db.update(occurrences).set({ state: 'deleted' }).where(eq(occurrences.id, gone.occurrenceId))
    const answers = await Promise.all([
      exportFileResponse(f.theirs, id, get()),
      exportFileResponse(f.mine, '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', get()),
      exportFileResponse(f.mine, 'nope', get()),
      exportFileResponse(gone.mine, goneId, get()),
      exportFileResponse(f.mine, queued, get())
    ])
    for (const res of answers) {
      expect([res.status, await res.text(), res.headers.get('x-content-type-options')]).toEqual([
        404,
        'Not found',
        'nosniff'
      ])
    }
  })

  test('a failed export, a missing file and a tampered path give 404', async () => {
    const f = await fixture()
    const failed = await queue(f, 'zip')
    await writeFile(join(f.dir, 'exports', `${failed}.zip`), 'x')
    await db
      .update(exportsTable)
      .set({ status: 'failed', errorCode: 'failed', filePath: `exports/${failed}.zip` })
      .where(eq(exportsTable.id, failed))
    const missing = await queue(f, 'pdf')
    await finish(missing, `exports/${missing}.pdf`)
    await db.update(exportsTable).set({ status: 'failed', errorCode: 'failed' }).where(eq(exportsTable.target, 'zip'))
    const other = await fixture()
    const tampered = await queue(other, 'zip')
    await writeFile(join(other.dir, 'secret.txt'), 'secret')
    await finish(tampered, '../secret.txt')
    const wrongName = await fixture()
    const wrong = await queue(wrongName, 'zip')
    await writeFile(join(wrongName.dir, 'exports', 'other.zip'), 'x')
    await finish(wrong, 'exports/other.zip')
    for (const [stores, id] of [
      [f.mine, failed],
      [f.mine, missing],
      [other.mine, tampered],
      [wrongName.mine, wrong]
    ] as const)
      expect((await exportFileResponse(stores, id, get())).status).toBe(404)
  })

  test('a symlinked file, a symlinked exports directory and a directory are refused', async () => {
    const f = await fixture()
    const secret = join(work, 'secret.txt')
    await writeFile(secret, 'not yours')
    const link = await queue(f, 'zip')
    await symlink(secret, join(f.dir, 'exports', `${link}.zip`))
    await finish(link, `exports/${link}.zip`)
    expect((await exportFileResponse(f.mine, link, get())).status).toBe(404)

    const dir = await queue(f, 'pdf')
    await mkdir(join(f.dir, 'exports', `${dir}.pdf`))
    await finish(dir, `exports/${dir}.pdf`)
    expect((await exportFileResponse(f.mine, dir, get())).status).toBe(404)

    const swapped = await fixture()
    const outside = join(work, 'outside')
    await mkdir(outside)
    const id = await queue(swapped, 'zip')
    await writeFile(join(outside, `${id}.zip`), 'not yours')
    await rm(join(swapped.dir, 'exports'), { recursive: true })
    await symlink(outside, join(swapped.dir, 'exports'))
    await finish(id, `exports/${id}.zip`)
    expect((await exportFileResponse(swapped.mine, id, get())).status).toBe(404)
  })
})

describe('same-origin check', () => {
  test('only the site itself may change things', () => {
    const from = (origin: string | null) =>
      assertSameOrigin(new Request('https://tm.example/x', { method: 'POST', headers: origin ? { origin } : {} }))
    expect(from('https://tm.example')).toBeNull()
    for (const origin of ['https://evil.example', 'http://tm.example', 'https://tm.example.evil.example', 'null', null])
      expect([origin, from(origin)?.status]).toEqual([origin, 403])
  })
})

describe('the route files', () => {
  const root = join(import.meta.dir, '..', 'app', 'api')
  const routes = ['meetings/[id]/exports/route.ts', 'exports/[exportId]/file/route.ts', 'connections/route.ts']

  test('each one gets the member from the session and never opens the database', async () => {
    for (const route of routes) {
      const text = await Bun.file(join(root, route)).text()
      expect([route, text.includes('requireMember()')]).toEqual([route, true])
      expect([route, /getDb|\.\.\/db\b/.test(text)]).toEqual([route, false])
    }
  })

  test('the POST handler checks the origin before it reads the member', async () => {
    const text = await Bun.file(join(root, 'meetings/[id]/exports/route.ts')).text()
    const post = text.slice(text.indexOf('export async function POST'))
    expect(post.indexOf('assertSameOrigin(')).toBeGreaterThan(-1)
    expect(post.indexOf('assertSameOrigin(')).toBeLessThan(post.indexOf('requireMember()'))
    for (const route of routes.slice(1))
      expect(await Bun.file(join(root, route)).text()).not.toMatch(/export async function (POST|PUT|DELETE)/)
  })
})
