import { afterEach, expect, test } from 'bun:test'
import { loadBundle } from '../src/bundle'
import { buildTargets } from '../src/registry'
import { runExport, type RunnerDeps } from '../src/runner'
import { createNotionTarget } from '../src/targets/notion'
import type { ExportBundle, NotionConnection, NotionParent } from '../src/types'
import { removeTestContexts, testContext } from './context'
import { fixture } from './fixture'
import { memoryStores } from './memory-stores'
import {
  ACCESS,
  DS_ID,
  dsParent,
  notionConn,
  notionFake,
  oauth,
  PAGE_ID,
  pageObject,
  pageParent,
  pageUrl,
  PARENT_ID,
  uuid
} from './notion-fake'
import { json, type FakeCall, type Route } from './route-fetch'

afterEach(removeTestContexts)

const TITLE = '2026-10-20 1400 Data Mining'
const target = createNotionTarget(oauth)

function run(
  f: ReturnType<typeof notionFake>,
  over: {
    parent?: NotionParent | null
    bundle?: ExportBundle
    previousUrl?: string | null
    conn?: Partial<NotionConnection>
  } = {}
) {
  const ctx = testContext({
    http: f.fetch,
    connection: notionConn({ parent: over.parent === undefined ? pageParent : over.parent, ...over.conn }),
    previousUrl: over.previousUrl ?? null
  })
  return {
    ctx,
    result: (async () => target.run(over.bundle ?? (await loadBundle(fixture)), ctx))()
  }
}

const bodies = (calls: FakeCall[]) => calls.map((c) => (c.body && c.body.startsWith('{') ? JSON.parse(c.body) : null))
const appends = (f: ReturnType<typeof notionFake>) =>
  f.calls.filter((c) => c.method === 'PATCH' && c.url.includes('/children'))

test('one page with uploaded slides, appended in chunks', async () => {
  const f = notionFake()
  const { result } = run(f)
  expect(await result).toEqual({ url: pageUrl(PAGE_ID), filePath: null, note: null })
  expect(JSON.parse(f.call('POST', '/v1/pages').body)).toEqual({
    parent: { type: 'page_id', page_id: PARENT_ID },
    properties: { title: { title: [{ text: { content: TITLE } }] } }
  })
  expect(f.count('POST', '/v1/file_uploads')).toBe(2)
  expect(JSON.parse(f.call('POST', '/v1/file_uploads').body)).toEqual({
    filename: 'slide-01.jpg',
    content_type: 'image/jpeg'
  })
  expect(appends(f).length).toBeGreaterThanOrEqual(1)
  expect(appends(f)[0]!.url).toBe(`https://api.notion.com/v1/blocks/${PAGE_ID}/children`)
})

test('every call goes to api.notion.com with the version, no redirects and the token only in Authorization', async () => {
  const f = notionFake()
  await run(f).result
  expect(f.calls.length).toBeGreaterThan(5)
  for (const call of f.calls) {
    expect(new URL(call.url).origin).toBe('https://api.notion.com')
    expect(call.headers['notion-version']).toBe('2026-03-11')
    expect(call.redirect).toBe('error')
    expect(call.headers.authorization).toBe(`Bearer ${ACCESS}`)
    expect(call.url).not.toContain(ACCESS)
    expect(call.body).not.toContain(ACCESS)
  }
})

test('slides are uploaded from the re-encoded JPEG bytes and the page never links to our server', async () => {
  const uploaded: Uint8Array[] = []
  const f = notionFake({
    routes: [
      [
        'POST',
        /\/send$/,
        async (req) => {
          const file = (await req.formData()).get('file') as File
          expect(file.type).toBe('image/jpeg')
          uploaded.push(new Uint8Array(await file.arrayBuffer()))
          return json({ status: 'uploaded' })
        }
      ]
    ]
  })
  await run(f).result
  expect(uploaded).toHaveLength(2)
  for (const bytes of uploaded) {
    // The source slides are WebP ("RIFF"); what Notion gets is a JPEG made from them.
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 12))).not.toContain('RIFF')
  }
  const sent = JSON.stringify(appends(f).map((c) => JSON.parse(c.body)))
  expect(sent).toContain('"type":"file_upload"')
  expect(sent).not.toContain('"external"')
  expect(sent).not.toContain('tm.example')
  expect(sent).not.toContain('.webp')
})

test('a database parent uses its title property', async () => {
  const f = notionFake()
  await run(f, { parent: dsParent }).result
  expect(JSON.parse(f.call('POST', '/v1/pages').body)).toMatchObject({
    parent: { type: 'data_source_id', data_source_id: DS_ID },
    properties: { Name: { title: [{ text: { content: TITLE } }] } }
  })
})

/** A meeting with 150 paragraphs of 5,000 characters and 150 slides (the fixture's two images, repeated). */
async function bigBundle(): Promise<ExportBundle> {
  const bundle = await loadBundle(fixture)
  const image = bundle.files.find((f) => f.path === 'slides/01.webp')!.bytes
  const enc = new TextEncoder()
  const slides = Array.from(
    { length: 150 },
    (_, i) => `## Slide ${i + 1}\n\n![Slide ${i + 1}](slides/${String(i + 1).padStart(3, '0')}.webp)\n`
  ).join('\n')
  const long = Array.from({ length: 150 }, (_, i) => `${i} ${'word '.repeat(1000)}`).join('\n\n')
  return {
    ...bundle,
    files: [
      { path: bundle.summaryFile, bytes: enc.encode(`# Summary\n\n${long}\n`) },
      { path: 'slides.md', bytes: enc.encode(slides) },
      ...Array.from({ length: 150 }, (_, i) => ({
        path: `slides/${String(i + 1).padStart(3, '0')}.webp`,
        bytes: image
      }))
    ]
  }
}

test('a big meeting is appended whole, within 100 blocks, 500 KB and 2,000 characters a request', async () => {
  const f = notionFake()
  await run(f, { bundle: await bigBundle() }).result
  const calls = appends(f)
  expect(calls.length).toBeGreaterThan(3)
  let blocks = 0
  let images = 0
  for (const call of calls) {
    const { children } = JSON.parse(call.body) as { children: { type: string; [k: string]: any }[] }
    expect(children.length).toBeLessThanOrEqual(100)
    expect(new TextEncoder().encode(call.body).length).toBeLessThan(500_000)
    blocks += children.length
    images += children.filter((c) => c.type === 'image').length
    for (const text of JSON.stringify(children).matchAll(/"content":"((?:[^"\\]|\\.)*)"/g))
      expect(text[1]!.length).toBeLessThanOrEqual(2000 * 2)
  }
  expect(images).toBe(150)
  expect(blocks).toBeGreaterThan(300)
  expect(f.count('POST', '/v1/file_uploads')).toBe(150)
})

test('a 429 in the middle waits Retry-After and the export still finishes', async () => {
  const f = notionFake({
    routes: [
      ['PATCH', /\/children$/, (_r, n) => (n === 0 ? json({}, 429, { 'retry-after': '3' }) : json({ results: [] }))]
    ]
  })
  const { ctx, result } = run(f)
  await result
  expect(ctx.sleeps).toContain(3000)
  expect(ctx.sleeps.filter((s) => s === 340).length).toBeGreaterThan(3)
  // The 429 call and its retry carry the same blocks.
  const [first, second] = appends(f)
  expect(first!.body).toBe(second!.body)
})

test('failures: no parent, bad parent id, lost parent', async () => {
  await expect(run(notionFake(), { parent: null }).result).rejects.toMatchObject({
    code: 'invalid_settings',
    message: 'Pick a Notion page or database for exports on the Connections page.'
  })
  const bad = notionFake()
  await expect(run(bad, { parent: { ...pageParent, id: '../users/me' } }).result).rejects.toMatchObject({
    code: 'invalid_settings'
  })
  expect(bad.calls).toHaveLength(0)
  await expect(target.run(await loadBundle(fixture), testContext({ connection: null }))).rejects.toMatchObject({
    code: 'not_connected'
  })

  for (const status of [403, 404]) {
    const lost = notionFake({ routes: [['POST', '/v1/pages', () => json({ message: 'gone' }, status)]] })
    await expect(run(lost).result).rejects.toMatchObject({
      code: 'not_found',
      message: `TolongMeeting can't reach the Notion page "Lecture notes" any more. Share it with the TolongLabs integration again, or pick another on the Connections page.`
    })
    expect(lost.count('POST', '/v1/file_uploads')).toBe(0)
  }
})

test('a failure after the page exists trashes it, and the error shows no token', async () => {
  const f = notionFake({
    routes: [['PATCH', /\/children$/, () => json({ message: `Bearer ${ACCESS} was refused` }, 400)]]
  })
  const error = await run(f).result.catch((e: Error) => e)
  expect((error as Error).message).toStartWith('Notion answered 400')
  expect((error as Error).message).not.toContain(ACCESS)
  expect(JSON.parse(f.call('PATCH', `/v1/pages/${PAGE_ID}`).body)).toEqual({ in_trash: true })

  // A failing cleanup does not hide the first error.
  const g = notionFake({
    routes: [
      ['PATCH', /\/children$/, () => json({}, 400)],
      ['PATCH', /\/v1\/pages\//, () => json({}, 500)]
    ]
  })
  await expect(run(g).result).rejects.toThrow('Notion answered 400')
})

// ---- a re-export updates the page it created -------------------------------------------------------------------

const OLD = [uuid(0x501), uuid(0x502), uuid(0x503)]
const earlier = pageUrl(PAGE_ID, 'Data-Mining')
const ownPage = (over: Record<string, unknown> = {}): Route => [
  'GET',
  `/v1/pages/${PAGE_ID}`,
  () => json(pageObject(PAGE_ID, pageParent, over))
]

test('a re-export updates the page it made: new blocks first, then the old ones go', async () => {
  const f = notionFake({
    routes: [ownPage()],
    children: [
      { id: OLD[0]!, type: 'paragraph' },
      { id: uuid(0x777), type: 'child_page' },
      { id: OLD[1]!, type: 'image' },
      { id: OLD[2]!, type: 'heading_2' }
    ]
  })
  const { result } = run(f, { previousUrl: earlier })
  expect(await result).toEqual({ url: pageUrl(PAGE_ID), filePath: null, note: null })
  expect(f.count('POST', '/v1/pages')).toBe(0)
  const order = f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)
  const lastAppend = order.findLastIndex((c) => c.endsWith('/children') && c.startsWith('PATCH'))
  const deletes = order.flatMap((c, i) => (c.startsWith('DELETE') ? [i] : []))
  expect(order.filter((c) => c.startsWith('DELETE'))).toEqual(OLD.map((id) => `DELETE /v1/blocks/${id}`))
  expect(Math.min(...deletes)).toBeGreaterThan(lastAppend)
  // Only this page's blocks were touched, and the sub-page the member added stays.
  expect(order.join('\n')).not.toContain(uuid(0x777))
  for (const c of f.calls)
    if (c.method !== 'GET') expect(c.url).toMatch(new RegExp(`/(${PAGE_ID}|${OLD.join('|')}|file_uploads)`))
})

test('a page that is gone, trashed, under another parent or not from this member is never updated', async () => {
  const cases: [string, string | null, Route[]][] = [
    ['gone', earlier, [['GET', `/v1/pages/${PAGE_ID}`, () => json({ message: 'x' }, 404)]]],
    ['trashed', earlier, [ownPage({ in_trash: true })]],
    [
      'other parent',
      earlier,
      [['GET', `/v1/pages/${PAGE_ID}`, () => json(pageObject(PAGE_ID, { ...pageParent, id: uuid(0xbb) }))]]
    ],
    ['other parent type', earlier, [['GET', `/v1/pages/${PAGE_ID}`, () => json(pageObject(PAGE_ID, dsParent))]]],
    [
      'answer for a different page',
      earlier,
      [['GET', `/v1/pages/${PAGE_ID}`, () => json(pageObject(uuid(0xcc), pageParent))]]
    ],
    ['no earlier url', null, []],
    ['not a Notion address', `https://evil.example/Data-${PAGE_ID.replaceAll('-', '')}`, []],
    ['http address', `http://www.notion.so/Data-${PAGE_ID.replaceAll('-', '')}`, []],
    ['no id in the address', 'https://www.notion.so/Data-Mining', []]
  ]
  for (const [name, previousUrl, routes] of cases) {
    const f = notionFake({ routes })
    const { result } = run(f, { previousUrl })
    expect([name, (await result).url]).toEqual([name, pageUrl(PAGE_ID)])
    expect([name, f.count('POST', '/v1/pages')]).toEqual([name, 1])
    expect([name, f.count('DELETE', /\/v1\/blocks\//)]).toEqual([name, 0])
  }
})

test('a failed update removes only what it added and leaves the old page whole', async () => {
  const f = notionFake({
    routes: [
      ownPage(),
      ['PATCH', /\/children$/, (_r, n) => (n === 0 ? json({ results: [{ id: uuid(0x901) }] }) : json({}, 400))]
    ],
    children: OLD.map((id) => ({ id, type: 'paragraph' }))
  })
  // Enough blocks for two appends: the big meeting.
  await expect(run(f, { previousUrl: earlier, bundle: await bigBundle() }).result).rejects.toThrow(
    'Notion answered 400'
  )
  const deleted = f.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname)
  expect(deleted).toEqual([`/v1/blocks/${uuid(0x901)}`])
  expect(f.count('PATCH', `/v1/pages/${PAGE_ID}`)).toBe(0)
})

// ---- wiring ----------------------------------------------------------------------------------------------------

test('the registry has a Notion target when the Notion client is configured', () => {
  expect(Object.keys(buildTargets({ google: null, notion: null }))).not.toContain('notion')
  const targets = buildTargets({ google: null, notion: oauth })
  expect(targets.notion?.id).toBe('notion')
})

test('the runner gives a target the address of the member’s earlier export, and redacts a failure', async () => {
  const seen: (string | null | undefined)[] = []
  const stores = memoryStores({
    occurrences: [{ id: 'o1', memberId: 'm1', state: 'completed', dataDir: fixture }],
    connections: [{ memberId: 'm1', connection: notionConn({ parent: pageParent }) }]
  })
  const deps: RunnerDeps = {
    store: stores.store,
    connections: stores.connections,
    occurrences: stores.occurrences,
    targets: {
      notion: {
        id: 'notion',
        async run(_bundle, ctx) {
          seen.push(ctx.previousUrl)
          if (seen.length === 2) throw new Error(`Notion said Bearer ${ACCESS} is bad`)
          return { url: earlier, filePath: null, note: null }
        }
      }
    },
    ping: async () => true,
    publicUrl: 'https://tm.example',
    http: (async () => new Response()) as unknown as typeof fetch,
    sleep: async () => {},
    log: () => {}
  }
  const ids: string[] = []
  for (let i = 0; i < 2; i++) {
    ids.push((await stores.exports.create('m1', 'o1', 'notion')).id)
    await runExport((await stores.store.claimNext())!, deps)
  }
  expect(seen).toEqual([null, earlier])
  const failed = (await stores.exports.get('m1', ids[1]!))!
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('Something went wrong')
  expect(failed.error).not.toContain(ACCESS)
})
