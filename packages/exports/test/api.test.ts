import { expect, test } from 'bun:test'
import type { OccurrenceState } from '@tm/core'
import {
  buttonState,
  connectionsRequest,
  createExportRequest,
  downloadFileName,
  exportDownload,
  listExportsRequest,
  toExportView,
  type ApiDeps
} from '../src/api'
import type { ExportRow } from '../src/store-types'
import type { ConnectionSummary, ExportTargetId } from '../src/types'

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  occurrenceId: 'o1',
  memberId: 'm1',
  target: 'zip',
  status: 'succeeded',
  title: '2026-10-20 1400 Pengurusan Café',
  url: null,
  filePath: 'exports/11111111-1111-4111-8111-111111111111.zip',
  note: null,
  errorCode: null,
  error: null,
  createdAt: new Date('2026-10-20T06:00:00Z'),
  finishedAt: new Date('2026-10-20T06:01:00Z'),
  ...over
})

const summary = (kind: ConnectionSummary['kind'], status: ConnectionSummary['status'] = 'ok', ready = true) =>
  ({ kind, status, ready, label: 'acme/notes', detail: 'd' }) satisfies ConnectionSummary

/** Stores bound to one member, like the ones a `MemberScope` makes: `o1` is completed, `o2` deleted, `o3` processing. */
function deps(summaries: ConnectionSummary[] = [], rows: ExportRow[] = []): ApiDeps & { created: string[] } {
  const states: Record<string, OccurrenceState> = { o1: 'completed', o2: 'deleted', o3: 'post_processing' }
  const created: string[] = []
  return {
    created,
    occurrences: {
      async get(id) {
        const state = states[id]
        return state ? { id, memberId: 'm1', state, dataDir: `/data/${id}` } : null
      }
    },
    connections: { summaries: async () => summaries },
    exports: {
      async create(occurrenceId, target) {
        if (created.includes(target)) return { ok: false, code: 'already_running', message: 'stored text' }
        created.push(target)
        return { ok: true, row: row({ id: `x-${target}`, occurrenceId, target, status: 'queued' }) }
      },
      async get(id) {
        return rows.find((r) => r.id === id) ?? null
      },
      async listForOccurrence() {
        return rows
      }
    }
  }
}

const body = (target: unknown, extra: object = {}) => JSON.stringify({ target, ...extra })

test('creating an export maps each outcome to its status', async () => {
  const d = deps()
  expect(await createExportRequest('o1', body('zip'), d)).toEqual({ status: 202, body: { exportId: 'x-zip' } })
  expect(await createExportRequest('o1', body('zip'), d)).toEqual({
    status: 409,
    body: { error: 'already_running', message: 'This export is already running.' }
  })
  expect(await createExportRequest('o2', body('pdf'), d)).toEqual({ status: 404, body: { error: 'not_found' } })
  expect(await createExportRequest('nope', body('pdf'), d)).toEqual({ status: 404, body: { error: 'not_found' } })
  expect(await createExportRequest('o3', body('pdf'), d)).toMatchObject({ status: 409, body: { error: 'not_ready' } })
  expect(await createExportRequest('o1', body('github'), d)).toEqual({
    status: 422,
    body: { error: 'not_connected', message: 'Connect GitHub on the Connections page first.' }
  })
})

test('an export over the member cap answers 429 with a fixed message, never the stored text', async () => {
  const d = deps()
  const full: ApiDeps = {
    ...d,
    exports: { ...d.exports, create: async () => ({ ok: false, code: 'too_many', message: 'stored text' }) }
  }
  expect(await createExportRequest('o1', body('zip'), full)).toEqual({
    status: 429,
    body: { error: 'too_many_exports', message: 'You have too many exports running. Wait for one to finish.' }
  })
})

test('a download whose file a newer export replaced is shown as replaced, with no link', () => {
  const kept = toExportView(row())
  expect([kept.replaced, kept.downloadUrl]).toEqual([false, '/api/exports/11111111-1111-4111-8111-111111111111/file'])
  const gone = toExportView(row({ filePath: null, note: 'Replaced by a newer export.' }))
  expect([gone.replaced, gone.downloadUrl, gone.note]).toEqual([true, null, 'Replaced by a newer export.'])
  expect(toExportView(row({ target: 'github', filePath: null })).replaced).toBe(false)
  expect(toExportView(row({ status: 'queued', filePath: null })).replaced).toBe(false)
})

test('the body is strict', async () => {
  const d = deps()
  for (const raw of [
    body('dropbox'),
    body('zip', { extra: 1 }),
    '{}',
    '[]',
    'null',
    '{',
    '',
    body('zip', { p: 'x'.repeat(2000) })
  ])
    expect([raw.slice(0, 30), (await createExportRequest('o1', raw, d)).status]).toEqual([raw.slice(0, 30), 422])
  expect(d.created).toEqual([])
})

test('a Notion connection without a parent, or needing reconnect, is refused before the store is touched', async () => {
  const noParent = deps([summary('notion', 'ok', false)])
  expect(await createExportRequest('o1', body('notion'), noParent)).toEqual({
    status: 422,
    body: {
      error: 'invalid_settings',
      message: 'Pick a Notion page or database for exports on the Connections page.'
    }
  })
  const stale = deps([summary('google', 'reconnect_needed')])
  expect(await createExportRequest('o1', body('gdocs'), stale)).toMatchObject({
    status: 422,
    body: { error: 'reconnect_needed' }
  })
  expect(noParent.created.concat(stale.created)).toEqual([])
  const ok = deps([summary('github')])
  expect((await createExportRequest('o1', body('github'), ok)).status).toBe(202)
})

test('views hide server paths, titles and stored error text; links are https only', async () => {
  const rows = [
    row(),
    row({
      id: 'f',
      target: 'github',
      status: 'failed',
      errorCode: 'rate_limited',
      error: 'GitHub said: token ghp_abcdef is bad',
      filePath: null,
      url: 'javascript:alert(1)'
    }),
    row({ id: 'ok', target: 'github', url: 'https://github.com/acme/notes/tree/main/x', filePath: null })
  ]
  const { status, body: out } = await listExportsRequest('o1', deps([], rows))
  expect(status).toBe(200)
  const text = JSON.stringify(out)
  for (const leak of ['filePath', '.zip', 'Pengurusan', 'ghp_', 'javascript:']) expect(text).not.toContain(leak)
  const [zip, failed, github] = (out as { exports: ReturnType<typeof toExportView>[] }).exports
  expect(zip!.downloadUrl).toBe('/api/exports/11111111-1111-4111-8111-111111111111/file')
  expect(failed).toMatchObject({ url: null, downloadUrl: null, error: expect.stringContaining('slow down') })
  expect(github!.url).toBe('https://github.com/acme/notes/tree/main/x')
  expect((await listExportsRequest('o2', deps([], rows))).status).toBe(404)
  expect((await listExportsRequest('nope', deps([], rows))).status).toBe(404)
})

test('a download is only a finished zip or PDF at the exact path, named on the server', () => {
  expect(exportDownload(row())).toMatchObject({ path: 'exports/11111111-1111-4111-8111-111111111111.zip' })
  expect(
    exportDownload(row({ target: 'pdf', filePath: 'exports/11111111-1111-4111-8111-111111111111.pdf' }))
  ).toMatchObject({
    contentType: 'application/pdf'
  })
  for (const over of [
    { status: 'running' as const },
    { status: 'failed' as const },
    { target: 'github' as const },
    { filePath: null },
    { filePath: '../x.zip' },
    { filePath: 'exports/other.zip' },
    { filePath: '/etc/passwd' }
  ])
    expect(exportDownload(row(over))).toBeNull()
  expect(downloadFileName(row({ title: '"; evil\r\n' }))).toBe('tolongmeeting-2026-10-20-zip.zip')
})

test('connections carry no secrets', async () => {
  const d = deps([summary('github')])
  expect(await connectionsRequest(d)).toEqual({ status: 200, body: { connections: [summary('github')] } })
})

test('buttonState', () => {
  const view = (target: ExportTargetId, status: 'queued' | 'running' | 'succeeded') => ({ target, status })
  expect(buttonState('zip', [], [])).toEqual({ enabled: true, hint: null })
  expect(buttonState('github', [], [])).toEqual({ enabled: false, hint: 'Connect GitHub on the Connections page' })
  expect(buttonState('gdocs', [summary('google', 'reconnect_needed')], [])).toEqual({
    enabled: false,
    hint: 'Reconnect Google Docs on the Connections page'
  })
  expect(buttonState('notion', [summary('notion', 'ok', false)], [])).toEqual({
    enabled: false,
    hint: 'Pick a Notion page on the Connections page'
  })
  expect(buttonState('pdf', [], [view('pdf', 'running')])).toEqual({ enabled: false, hint: 'Exporting' })
  expect(buttonState('pdf', [], [view('zip', 'running'), view('pdf', 'succeeded')])).toEqual({
    enabled: true,
    hint: null
  })
  expect(buttonState('github', [summary('github')], [view('github', 'queued')])).toEqual({
    enabled: false,
    hint: 'Exporting'
  })
})
