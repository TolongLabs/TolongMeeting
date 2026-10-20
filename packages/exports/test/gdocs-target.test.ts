import { afterEach, expect, test } from 'bun:test'
import { loadBundle } from '../src/bundle'
import { DOC_MIME, REVOKED_MESSAGE } from '../src/connections/google'
import { buildTargets } from '../src/registry'
import { runExport } from '../src/runner'
import { createGdocsTarget } from '../src/targets/gdocs'
import { removeTestContexts, testContext } from './context'
import { copyFixture, fixture, removeCopies } from './fixture'
import {
  ACCESS2,
  client,
  DOC,
  expectSafeCalls,
  FOLDER,
  google,
  googleConn,
  liveFolder,
  LOCATION,
  NEW_FOLDER,
  REFRESH,
  type GoogleOptions
} from './google-fake'
import { memoryStores } from './memory-stores'

afterEach(async () => {
  await removeCopies()
  await removeTestContexts()
})

const target = createGdocsTarget(client)
const run = async (o: GoogleOptions, conn = googleConn(), over = {}) => {
  const f = google(o)
  const ctx = testContext({ http: f.fetch, connection: conn, ...over })
  const bundle = await loadBundle(fixture)
  return { f, ctx, result: target.run(bundle, ctx), bundle }
}

test('uploads one Word file that Drive converts to a Google Doc in the folder, marked as ours', async () => {
  const { f, ctx, result, bundle } = await run({})
  expect(await result).toEqual({ url: `https://docs.google.com/document/d/${DOC}/edit`, filePath: null, note: null })

  const start = f.call('POST', 'https://www.googleapis.com/upload/drive/v3/files')
  const meta = JSON.parse(start.body)
  expect(meta).toMatchObject({ name: bundle.title, mimeType: DOC_MIME, parents: [FOLDER] })
  expect(Object.keys(meta.appProperties)).toEqual(['tmMeeting'])
  const url = new URL(start.url)
  expect(url.searchParams.get('uploadType')).toBe('resumable')
  expect(start.headers['x-upload-content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  const put = f.call('PUT', 'https://www.googleapis.com/upload/drive/v3/files')
  expect(put.url).toBe(LOCATION)
  expect(put.body.startsWith('PK')).toBe(true) // a .docx is a zip
  expect(Number(start.headers['x-upload-content-length'])).toBeGreaterThan(1000)
  expect(f.calls.filter((c) => c.method === 'DELETE')).toEqual([])
  expect(ctx.saved).toEqual([])
  expectSafeCalls(f)
  // Only the access token (fresh from the refresh grant) is in a Drive request header.
  expect(
    f.calls.filter((c) => c.url.includes('/drive/')).every((c) => c.headers.authorization === `Bearer ${ACCESS2}`)
  ).toBe(true)
})

test('a re-export updates the Doc it made and never creates or deletes another', async () => {
  const first = await run({})
  await first.result
  const mark = JSON.parse(first.f.call('POST', 'https://www.googleapis.com/upload/drive/v3/files').body).appProperties
    .tmMeeting as string

  const ours = { id: DOC, mimeType: DOC_MIME, trashed: false, ownedByMe: true, appProperties: { tmMeeting: mark } }
  const { f, result } = await run({ docs: [ours] })
  expect((await result).url).toBe(`https://docs.google.com/document/d/${DOC}/edit`)

  const search = new URL(f.calls.find((c) => c.method === 'GET' && c.url.includes('appProperties'))!.url)
  expect(search.searchParams.get('q')).toContain(`appProperties has { key='tmMeeting' and value='${mark}' }`)
  const patch = f.call('PATCH', new RegExp(`/upload/drive/v3/files/${DOC}\\?`))
  expect(JSON.parse(patch.body)).toEqual({ name: expect.any(String), mimeType: DOC_MIME })
  expect(f.count('POST', 'https://www.googleapis.com/upload/drive/v3/files')).toBe(0)
  expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false)
  expectSafeCalls(f)
})

test('a file that is not ours, not a Doc, in the bin or not owned is never updated', async () => {
  const mark = 'x'.repeat(64)
  const base = { id: DOC, mimeType: DOC_MIME, trashed: false, ownedByMe: true, appProperties: { tmMeeting: mark } }
  const foreign = [
    { ...base, appProperties: {} },
    { ...base, appProperties: { tmMeeting: 'someone-else' } },
    { ...base, mimeType: 'application/pdf' },
    { ...base, trashed: true },
    { ...base, ownedByMe: false },
    { ...base, id: '../../etc' }
  ]
  const { f, result } = await run({ docs: foreign })
  await result
  expect(f.count('POST', 'https://www.googleapis.com/upload/drive/v3/files')).toBe(1)
  expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false)
})

test('a gone default folder is made again and saved; a gone picked folder asks the member to pick another', async () => {
  const gone = { files: { [FOLDER]: { status: 404, body: {} } } }
  const { f, ctx, result } = await run(gone)
  await result
  expect(ctx.saved).toEqual([googleConn({ folderId: NEW_FOLDER })])
  expect(JSON.parse(f.call('POST', 'https://www.googleapis.com/upload/drive/v3/files').body).parents).toEqual([
    NEW_FOLDER
  ])

  const trashed = await run({ files: { [FOLDER]: { body: { ...liveFolder(FOLDER).body, trashed: true } } } })
  await trashed.result
  expect(trashed.ctx.saved).toHaveLength(1)

  const picked = await run(gone, googleConn({ folderIsDefault: false }))
  await expect(picked.result).rejects.toMatchObject({
    code: 'not_found',
    message: 'The Drive folder you picked for exports is gone. Pick another on the Connections page.'
  })
  expect(picked.ctx.saved).toEqual([])
  expect(picked.f.calls.some((c) => c.url.includes('/upload/'))).toBe(false)
})

test('a stored folder id that is not an id is never put in a URL', async () => {
  const { f, result } = await run({}, googleConn({ folderId: '../../about', folderIsDefault: false }))
  await expect(result).rejects.toMatchObject({ code: 'not_found' })
  expect(f.calls.filter((c) => c.url.includes('about'))).toEqual([])
})

test('revoked access, a full Drive, limits and strange answers are told plainly', async () => {
  const revoked = await run({ revoked: true })
  await expect(revoked.result).rejects.toMatchObject({ code: 'reconnect_needed', message: REVOKED_MESSAGE })

  const full = await run({ init: { status: 403, body: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } } })
  await expect(full.result).rejects.toMatchObject({
    code: 'failed',
    message: "Your Google Drive is full, so the document wasn't created."
  })
  const full2 = await run({ put: { status: 403, body: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } } })
  await expect(full2.result).rejects.toMatchObject({ code: 'failed' })

  const limited = await run({
    init: { status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }
  })
  await expect(limited.result).rejects.toMatchObject({ code: 'rate_limited' })
  const limited2 = await run({ init: { status: 429 } })
  await expect(limited2.result).rejects.toMatchObject({ code: 'rate_limited' })

  const notDoc = await run({
    put: {
      status: 200,
      body: { id: DOC, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    }
  })
  await expect(notDoc.result).rejects.toMatchObject({ code: 'failed' })
})

test('the upload address must stay on Google, so the bytes and token never go elsewhere', async () => {
  for (const location of [
    'https://evil.example/upload/drive/v3/files?upload_id=1',
    'https://www.googleapis.com/drive/v3/about',
    'http://www.googleapis.com/upload/drive/v3/files?upload_id=1',
    null
  ]) {
    const { f, result } = await run({ init: { status: 200, location } })
    await expect(result).rejects.toMatchObject({ code: 'failed' })
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false)
  }
})

test('without a Google connection the target says so', async () => {
  const ctx = testContext({ connection: null })
  await expect(target.run(await loadBundle(fixture), ctx)).rejects.toMatchObject({ code: 'not_connected' })
})

test('the runner stores Google text with the tokens removed and marks a revoked grant', async () => {
  const stores = memoryStores({
    occurrences: [{ id: 'o1', memberId: 'm1', state: 'completed', dataDir: await copyFixture() }],
    connections: [{ memberId: 'm1', connection: googleConn() }]
  })
  const f = google({
    init: { status: 500, body: { error: { message: `boom ${REFRESH} and ${ACCESS2} and ${client.clientSecret}` } } }
  })
  const row = await stores.exports.create('m1', 'o1', 'gdocs')
  const claimed = (await stores.store.claimNext())!
  expect(claimed.id).toBe(row.id)
  await runExport(claimed, {
    store: stores.store,
    connections: stores.connections,
    occurrences: stores.occurrences,
    targets: buildTargets({ google: client, notion: null }),
    ping: async () => true,
    publicUrl: 'https://tm.example',
    http: f.fetch,
    sleep: async () => undefined,
    log: () => undefined
  })
  const done = (await stores.exports.get('m1', row.id))!
  expect(done.status).toBe('failed')
  for (const secret of [REFRESH, ACCESS2, client.clientSecret]) expect(done.error).not.toContain(secret)
  expect(done.error).toContain('Google answered 500')

  const revoked = await stores.exports.create('m1', 'o1', 'gdocs')
  await runExport((await stores.store.claimNext())!, {
    store: stores.store,
    connections: stores.connections,
    occurrences: stores.occurrences,
    targets: buildTargets({ google: client, notion: null }),
    ping: async () => true,
    publicUrl: 'https://tm.example',
    http: google({ revoked: true }).fetch,
    sleep: async () => undefined,
    log: () => undefined
  })
  expect((await stores.exports.get('m1', revoked.id))?.errorCode).toBe('reconnect_needed')
  expect(stores.markedReconnect).toEqual(['google'])
})

test('the registry has gdocs only when the Google client is configured', () => {
  expect(Object.keys(buildTargets({ google: null, notion: null })).sort()).not.toContain('gdocs')
  expect(Object.keys(buildTargets({ google: client, notion: null }))).toContain('gdocs')
})
