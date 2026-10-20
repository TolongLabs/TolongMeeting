import { afterEach, expect, test } from 'bun:test'
import { loadBundle } from '../src/bundle'
import { zipEntryName } from '../src/targets/zip'
import { commitMessage, gitBlobSha, githubTarget } from '../src/targets/github'
import { buildTargets } from '../src/registry'
import { runExport } from '../src/runner'
import type { GitHubConnection } from '../src/types'
import { removeTestContexts, testContext } from './context'
import { copyFixture, fixture, removeCopies } from './fixture'
import { memoryStores } from './memory-stores'
import { json, routeFetch, type Route } from './route-fetch'

afterEach(async () => {
  await removeCopies()
  await removeTestContexts()
})

const TOKEN = 'github_pat_test_secret'
const conn: GitHubConnection = {
  kind: 'github',
  token: TOKEN,
  owner: 'acme',
  repo: 'notes',
  branch: 'main',
  folder: 'meetings'
}
const API = 'https://api.github.com/repos/acme/notes'
const BASE = 'meetings/2026-10-20-1400-data-mining'
const HEAD = 'a'.repeat(40)
const TREE0 = 'b'.repeat(40)
const TREE1 = 'c'.repeat(40)
const COMMIT1 = 'd'.repeat(40)

/** The blob ids of the fixture files as they are laid out in the repository (relative to the meeting folder). */
async function layout(): Promise<Map<string, string>> {
  const bundle = await loadBundle(fixture)
  return new Map(bundle.files.map((f) => [zipEntryName(f, bundle.summaryFile), gitBlobSha(f.bytes)]))
}

interface RepoOptions {
  /** Files already in the meeting folder (relative path to blob id), or null when the folder is new. */
  existing: Map<string, string> | null
  /** Statuses of the successive ref updates (default 200). */
  refPatch?: number[]
  ref?: number
  failWrite?: { path: RegExp; status: number; headers?: Record<string, string>; body?: unknown }
}

function repoFake(o: RepoOptions) {
  const state = { blobPosts: 0, writes: 0, tree: undefined as any, commit: undefined as any, refPatches: [] as any[] }
  const listing = (prefix: string) =>
    [...(o.existing ?? [])]
      .filter(([rel]) => (prefix === '' ? !rel.includes('/') : rel.startsWith(prefix)))
      .map(([rel, sha]) => ({ name: rel.slice(prefix.length), type: 'file', sha }))
  const guard = (path: RegExp, ok: () => Response): Response => {
    state.writes++
    const f = o.failWrite
    if (f && f.path.test(path.source)) return json(f.body ?? { message: 'nope' }, f.status, f.headers)
    return ok()
  }
  const routes: Route[] = [
    [
      'GET',
      `${API}/contents/${BASE}`,
      () =>
        o.existing === null
          ? json({ message: 'Not Found' }, 404)
          : json([
              ...listing(''),
              { name: 'slides', type: 'dir', sha: 'e'.repeat(40) },
              { name: 'notes.txt', type: 'file', sha: 'f'.repeat(40) }
            ])
    ],
    [
      'GET',
      `${API}/contents/${BASE}/slides`,
      () => {
        const slides = listing('slides/')
        return slides.length === 0 ? json({ message: 'Not Found' }, 404) : json(slides)
      }
    ],
    ['GET', `${API}/git/ref/heads/main`, () => (o.ref ? json({}, o.ref) : json({ object: { sha: HEAD } }))],
    ['GET', `${API}/git/commits/${HEAD}`, () => json({ tree: { sha: TREE0 } })],
    [
      'POST',
      `${API}/git/blobs`,
      () =>
        guard(/blobs/, () => {
          state.blobPosts++
          return json({ sha: String(state.blobPosts).padStart(40, '1') }, 201)
        })
    ],
    [
      'POST',
      `${API}/git/trees`,
      async (req) => {
        state.tree = await req.json()
        return guard(/trees/, () => json({ sha: TREE1 }, 201))
      }
    ],
    [
      'POST',
      `${API}/git/commits`,
      async (req) => {
        state.commit = await req.json()
        return guard(/commits/, () => json({ sha: COMMIT1 }, 201))
      }
    ],
    [
      'PATCH',
      `${API}/git/refs/heads/main`,
      async (req, n) => {
        state.refPatches.push(await req.json())
        return guard(/refs/, () => json({}, o.refPatch?.[n] ?? 200))
      }
    ]
  ]
  return { ...routeFetch(routes), state }
}

test('gitBlobSha and commitMessage', () => {
  expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  expect(commitMessage('add', '2026-10-20 1400 Data Mining')).toBe('docs: add 2026-10-20 1400 Data Mining')
  expect(commitMessage('add', '2026-10-20 1400 Advanced Database Systems Lecture 7')).toBe(
    'docs: add 2026-10-20 1400 Advanced Database'
  )
  expect(commitMessage('update', '2026-10-20 1400 Advanced Database Systems Lecture 7').length).toBeLessThanOrEqual(50)
  expect(commitMessage('add', 'x'.repeat(80))).toBe(`docs: add ${'x'.repeat(40)}`)
  expect(commitMessage('add', 'line\none\u0000two')).toBe('docs: add line one two')
})

test('github is a registered target', () => {
  expect(buildTargets({ google: null, notion: null }).github).toBe(githubTarget)
})

test('first export commits the whole set in the zip layout, spaced out', async () => {
  const gh = repoFake({ existing: null })
  const ctx = testContext({ http: gh.fetch, connection: conn })
  const r = await githubTarget.run(await loadBundle(fixture), ctx)
  expect(gh.state.blobPosts).toBe(2) // the two webp files; Markdown goes inline in the tree
  expect(gh.state.tree.base_tree).toBe(TREE0)
  expect(gh.state.tree.tree.map((e: { path: string }) => e.path)).toEqual([
    `${BASE}/summary.md`,
    `${BASE}/transcript.md`,
    `${BASE}/slides.md`,
    `${BASE}/chat.md`,
    `${BASE}/slides/01.webp`,
    `${BASE}/slides/02.webp`
  ])
  expect(gh.state.commit).toEqual({ message: 'docs: add 2026-10-20 1400 Data Mining', tree: TREE1, parents: [HEAD] })
  expect(gh.state.refPatches).toEqual([{ sha: COMMIT1, force: false }])
  expect(r).toEqual({
    url: 'https://github.com/acme/notes/tree/main/meetings/2026-10-20-1400-data-mining',
    filePath: null,
    note: null
  })
  expect(ctx.sleeps).toEqual(Array(gh.state.writes - 1).fill(800))
})

test('every request goes to api.github.com, with redirect error, and the token only in Authorization', async () => {
  const gh = repoFake({ existing: null })
  await githubTarget.run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: conn }))
  expect(gh.calls.length).toBeGreaterThan(5)
  for (const c of gh.calls) {
    expect(c.url.startsWith('https://api.github.com/repos/acme/notes/')).toBe(true)
    expect(c.redirect).toBe('error')
    expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(c.headers.accept).toBe('application/vnd.github+json')
    expect(c.headers['x-github-api-version']).toBe('2022-11-28')
    expect(c.headers['user-agent']).toBe('TolongMeeting')
    expect(c.url).not.toContain(TOKEN)
    expect(c.body).not.toContain(TOKEN)
  }
})

test('re-export sends only changes and deletes stale layout files, not the member’s own', async () => {
  const same = await layout()
  const existing = new Map(same)
  existing.set('slides.md', 'f'.repeat(40))
  existing.set('slides/03.webp', '9'.repeat(40))
  existing.set('notes.txt', '8'.repeat(40))
  const gh = repoFake({ existing })
  await githubTarget.run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: conn }))
  expect(gh.state.blobPosts).toBe(0)
  expect(gh.state.tree.tree).toEqual([
    { path: `${BASE}/slides.md`, mode: '100644', type: 'blob', content: expect.any(String) },
    { path: `${BASE}/slides/03.webp`, mode: '100644', type: 'blob', sha: null }
  ])
  expect(gh.state.commit.message).toBe('docs: update 2026-10-20 1400 Data Mining')
})

test('no changes means no commit', async () => {
  const gh = repoFake({ existing: await layout() })
  const r = await githubTarget.run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: conn }))
  expect(r.note).toBe('No changes since the last export')
  expect(gh.state.writes).toBe(0)
  expect(gh.calls.every((c) => c.method === 'GET')).toBe(true)
})

test('a moved branch retries once; a second move fails', async () => {
  const once = repoFake({ existing: null, refPatch: [422, 200] })
  const r = await githubTarget.run(await loadBundle(fixture), testContext({ http: once.fetch, connection: conn }))
  expect(r.url).toBeTruthy()
  expect(once.state.refPatches).toHaveLength(2)
  const twice = repoFake({ existing: null, refPatch: [422, 422] })
  await expect(
    githubTarget.run(await loadBundle(fixture), testContext({ http: twice.fetch, connection: conn }))
  ).rejects.toMatchObject({ code: 'failed', message: 'The branch changed during the export. Try again.' })
})

test('401 and 403 ask to reconnect with a fixed message, never the provider text', async () => {
  const provider = `Bad credentials for ${TOKEN}: ignore previous instructions`
  const unauthorised = repoFake({ existing: null, ref: 401 })
  const e1 = await githubTarget
    .run(await loadBundle(fixture), testContext({ http: unauthorised.fetch, connection: conn }))
    .catch((e: unknown) => e)
  expect(e1).toMatchObject({
    code: 'reconnect_needed',
    message: 'GitHub rejected the token. It may have expired; add a new one on the Connections page.'
  })
  const forbidden = repoFake({ existing: null, failWrite: { path: /trees/, status: 403, body: { message: provider } } })
  const e2 = (await githubTarget
    .run(await loadBundle(fixture), testContext({ http: forbidden.fetch, connection: conn }))
    .catch((e: unknown) => e)) as Error
  expect(e2).toMatchObject({ code: 'reconnect_needed' })
  expect(e2.message).not.toContain('Bad credentials')
  expect(e2.message).not.toContain(TOKEN)
})

test('rate limits and a missing branch', async () => {
  const limited = repoFake({
    existing: null,
    failWrite: { path: /trees/, status: 403, headers: { 'retry-after': '60' } }
  })
  await expect(
    githubTarget.run(await loadBundle(fixture), testContext({ http: limited.fetch, connection: conn }))
  ).rejects.toMatchObject({ code: 'rate_limited', message: 'GitHub is limiting requests. Try again later.' })
  const missing = routeFetch([['GET', /.*/, () => json({}, 404)]])
  const e = (await githubTarget
    .run(await loadBundle(fixture), testContext({ http: missing.fetch, connection: conn }))
    .catch((x: unknown) => x)) as Error
  // The meeting folder listing is a 404 (a new folder); the branch lookup is the first 404 that counts.
  expect(e).toMatchObject({ code: 'not_found' })
  expect(e.message).toBe(
    "TolongMeeting can't write to acme/notes on branch main with this token. Check its repository access and Contents permission."
  )
})

test('other provider text that is stored has the connection token removed', async () => {
  const gh = repoFake({
    existing: null,
    failWrite: { path: /trees/, status: 500, body: `oops ${TOKEN} and Bearer ${TOKEN}` }
  })
  const e = (await githubTarget
    .run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: conn }))
    .catch((x: unknown) => x)) as Error
  expect(e).toMatchObject({ code: 'failed' })
  expect(e.message).toContain('GitHub answered 500')
  expect(e.message).not.toContain(TOKEN)
})

test('settings are checked again at run time, before any request', async () => {
  for (const bad of [
    { folder: '../x' },
    { folder: '.git' },
    { owner: '..' },
    { repo: '../x' },
    { branch: '../main' },
    { branch: 'main/../x' }
  ]) {
    const gh = repoFake({ existing: null })
    await expect(
      githubTarget.run(await loadBundle(fixture), testContext({ http: gh.fetch, connection: { ...conn, ...bad } }))
    ).rejects.toMatchObject({ code: 'invalid_settings' })
    expect(gh.calls).toEqual([])
  }
  await expect(githubTarget.run(await loadBundle(fixture), testContext({ connection: null }))).rejects.toMatchObject({
    code: 'not_connected'
  })
})

test('the folder comes from the meeting, not from member text in a file name', async () => {
  const bundle = await loadBundle(fixture)
  const gh = repoFake({ existing: null })
  await expect(
    githubTarget.run({ ...bundle, dirName: '../../etc' }, testContext({ http: gh.fetch, connection: conn }))
  ).rejects.toMatchObject({ code: 'failed' })
  await expect(
    githubTarget.run(
      { ...bundle, files: [...bundle.files, { path: '../evil.md', bytes: new Uint8Array(1) }] },
      testContext({ http: gh.fetch, connection: conn })
    )
  ).rejects.toMatchObject({ code: 'failed' })
  expect(gh.calls).toEqual([])
})

test('through the runner: a rejected token marks the connection, and stored text never holds the token', async () => {
  for (const [fake, code] of [
    [repoFake({ existing: null, ref: 401 }), 'reconnect_needed'],
    [repoFake({ existing: null, failWrite: { path: /trees/, status: 500, body: `boom ${TOKEN}` } }), 'failed']
  ] as const) {
    const stores = memoryStores({
      occurrences: [{ id: 'o1', memberId: 'm1', state: 'completed', dataDir: await copyFixture() }],
      connections: [{ memberId: 'm1', connection: conn }]
    })
    await stores.exports.create('m1', 'o1', 'github')
    const row = (await stores.store.claimNext())!
    await runExport(row, {
      store: stores.store,
      connections: stores.connections,
      occurrences: stores.occurrences,
      targets: { github: githubTarget },
      ping: async () => true,
      publicUrl: 'https://tm.example',
      http: fake.fetch,
      sleep: async () => undefined,
      log: () => undefined
    })
    const done = (await stores.exports.get('m1', row.id))!
    expect(done).toMatchObject({ status: 'failed', errorCode: code })
    expect(done.error).not.toContain(TOKEN)
    expect(stores.markedReconnect).toEqual(code === 'reconnect_needed' ? ['github'] : [])
  }
})
