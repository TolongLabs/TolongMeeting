import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ping } from '@tm/notify'
import type { OccurrenceState } from '@tm/core'
import type { ExportRow } from '../src/store-types'
import { CONNECTION_REMOVED_MESSAGE, exportPing, runExport, runLoop, type RunnerDeps } from '../src/runner'
import { zipTarget } from '../src/targets/zip'
import {
  ExportError,
  type Connection,
  type ExportResult,
  type ExportTarget,
  type ExportTargetId,
  type GitHubConnection
} from '../src/types'
import { removeTestContexts } from './context'
import { copyFixture, removeCopies } from './fixture'
import { memoryStores, type MemoryStores } from './memory-stores'

afterEach(async () => {
  await removeCopies()
  await removeTestContexts()
})

const TITLE = '2026-10-20 1400 Data Mining'
const PAGE = 'https://tm.example/meetings/o1'

/** A target that counts its runs and throws `error` or answers `result`. */
function fakeTarget(id: ExportTargetId, error?: unknown, result?: ExportResult): ExportTarget & { runs: number } {
  const target = {
    id,
    runs: 0,
    async run() {
      target.runs++
      if (error !== undefined) throw error
      return result ?? { url: `https://example.test/${id}`, filePath: null, note: null }
    }
  }
  return target
}

/** Queues an export and claims it (the only one queued), as the loop does before it calls `runExport`. */
async function queueAndClaim(stores: MemoryStores, target: ExportTargetId): Promise<ExportRow> {
  await stores.exports.create('m1', 'o1', target)
  return (await stores.store.claimNext())!
}

const githubConn = (token: string): { memberId: string; connection: Connection } => ({
  memberId: 'm1',
  connection: { kind: 'github', token, owner: 'o', repo: 'r', branch: 'main', folder: '' } satisfies GitHubConnection
})

async function setup(
  over: {
    state?: OccurrenceState
    targets?: RunnerDeps['targets']
    connections?: NonNullable<Parameters<typeof memoryStores>[0]>['connections']
    log?: (line: string) => void
    ping?: RunnerDeps['ping']
    timeoutMs?: number
    maxOutputBytes?: number
    dataDir?: string
  } = {}
) {
  const dataDir = over.dataDir ?? (await copyFixture())
  const stores = memoryStores({
    occurrences: [{ id: 'o1', memberId: 'm1', state: over.state ?? 'completed', dataDir }],
    connections: over.connections
  })
  const pings: Ping[] = []
  const deps: RunnerDeps = {
    store: stores.store,
    connections: stores.connections,
    occurrences: stores.occurrences,
    targets: over.targets ?? { zip: zipTarget },
    ping:
      over.ping ??
      (async (_m, p) => {
        pings.push(p)
        return true
      }),
    publicUrl: 'https://tm.example',
    http: (async () => {
      throw new Error('no network in tests')
    }) as unknown as typeof fetch,
    sleep: (ms) => Bun.sleep(ms),
    log: over.log ?? (() => undefined),
    timeoutMs: over.timeoutMs,
    maxOutputBytes: over.maxOutputBytes
  }
  return { deps, pings, stores, dataDir }
}

test('zip success records the file and pings', async () => {
  const { deps, pings, stores, dataDir } = await setup()
  const row = await queueAndClaim(stores, 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'succeeded',
    title: TITLE,
    filePath: `exports/${row.id}.zip`
  })
  expect(existsSync(join(dataDir, 'exports', `${row.id}.zip`))).toBe(true)
  expect(pings).toEqual([
    {
      title: 'Export finished',
      message: `"${TITLE}" is ready to download.`,
      priority: 'default',
      actions: [{ label: 'Open meeting page', url: PAGE }]
    }
  ])
})

test('a remote target without a connection fails and offers Reconnect', async () => {
  const github = fakeTarget('github')
  const { deps, pings, stores } = await setup({ targets: { github } })
  const row = await queueAndClaim(stores, 'github')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'failed',
    errorCode: 'not_connected',
    error: 'Connect GitHub on the Connections page first.'
  })
  expect(github.runs).toBe(0)
  expect(pings[0]!.actions?.[0]).toEqual({ label: 'Reconnect', url: 'https://tm.example/connections' })
})

test('a connection that needs reconnecting is not used', async () => {
  const github = fakeTarget('github')
  const { deps, stores } = await setup({
    targets: { github },
    connections: [{ ...githubConn('github_pat_abc123'), status: 'reconnect_needed' }]
  })
  const row = await queueAndClaim(stores, 'github')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    errorCode: 'not_connected',
    error: 'GitHub needs you to connect again on the Connections page.'
  })
  expect(github.runs).toBe(0)
})

test('reconnect_needed is redacted, flags the connection and never logs the token', async () => {
  const lines: string[] = []
  const { deps, stores, pings } = await setup({
    log: (l) => lines.push(l),
    connections: [githubConn('github_pat_abc123')],
    targets: {
      github: fakeTarget('github', new ExportError('reconnect_needed', 'GitHub rejected github_pat_abc123'))
    }
  })
  const row = await queueAndClaim(stores, 'github')
  await runExport(row, deps)
  expect((await stores.exports.get('m1', row.id))?.error).toBe('GitHub rejected [redacted]')
  expect(stores.markedReconnect).toEqual(['github'])
  expect(lines.join('\n')).not.toContain('github_pat_')
  expect(JSON.stringify(pings)).not.toContain('github_pat_')
  expect(lines).toEqual([`export ${row.id} github failed reconnect_needed`])
})

test('a target that is not built fails without running anything', async () => {
  const { deps, stores } = await setup({ targets: {} })
  const row = await queueAndClaim(stores, 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    errorCode: 'failed',
    error: "This export isn't available yet."
  })
})

test('deleted, unfinished and broken meetings', async () => {
  for (const [state, code, error] of [
    ['deleted', 'meeting_deleted', 'This meeting has been deleted from TolongMeeting.'],
    ['transcribing', 'not_ready', 'This meeting is still being processed.']
  ] as const) {
    const zip = fakeTarget('zip')
    const { deps, stores } = await setup({ state, targets: { zip } })
    const row = await queueAndClaim(stores, 'zip')
    await runExport(row, deps)
    expect(await stores.exports.get('m1', row.id)).toMatchObject({ errorCode: code, error })
    expect(zip.runs).toBe(0)
  }
  const { deps, stores } = await setup({ targets: { zip: fakeTarget('zip', new Error('boom')) } })
  const row = await queueAndClaim(stores, 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    errorCode: 'failed',
    error: 'Something went wrong: boom. Try again.'
  })
})

test('an unexpected error is never stored raw: the connection tokens come out, and the log holds name and code only', async () => {
  const lines: string[] = []
  const boom = Object.assign(new TypeError('fetch to https://api.example/?token=abc failed for ghp_secretsecret1 '), {
    code: 'ECONNRESET'
  })
  const { deps, stores } = await setup({
    log: (l) => lines.push(l),
    connections: [githubConn('tokenvalue-1234')],
    targets: { github: fakeTarget('github', new Error(`GitHub said tokenvalue-1234 and ${boom.message}`)) }
  })
  const row = await queueAndClaim(stores, 'github')
  await runExport(row, deps)
  const error = (await stores.exports.get('m1', row.id))?.error ?? ''
  expect(error).toStartWith('Something went wrong: GitHub said [redacted] and ')
  for (const secret of ['tokenvalue-1234', 'ghp_secretsecret1', 'token=abc']) expect(error).not.toContain(secret)
  expect(lines).toEqual([`export ${row.id} github failed failed (Error)`])
})

test('a rotated token is a secret too', async () => {
  const rotating: ExportTarget = {
    id: 'github',
    async run(_bundle, ctx) {
      await ctx.saveConnection({ ...(ctx.connection as GitHubConnection), token: 'rotated-token-9999' })
      throw new Error('then it broke at rotated-token-9999')
    }
  }
  const { deps, stores } = await setup({ connections: [githubConn('first-token-1234')], targets: { github: rotating } })
  const row = await queueAndClaim(stores, 'github')
  await runExport(row, deps)
  expect(stores.saved).toHaveLength(1)
  expect((await stores.exports.get('m1', row.id))?.error).toBe(
    'Something went wrong: then it broke at [redacted]. Try again.'
  )
})

test('removing the connection while an export runs stops it before the next call and the next save', async () => {
  const sent: string[] = []
  const first = githubConn('removed-token-1234')
  for (const stage of ['request', 'save'] as const) {
    sent.length = 0
    const target: ExportTarget = {
      id: 'github',
      async run(_bundle, ctx) {
        await ctx.http('https://api.example.test/one', {})
        await removeNow()
        if (stage === 'request') await ctx.http('https://api.example.test/two', {})
        else await ctx.saveConnection({ ...(ctx.connection as GitHubConnection), token: 'rotated-token-9999' })
        return { url: 'https://example.test/done', filePath: null, note: null }
      }
    }
    const { deps, stores, pings } = await setup({ connections: [first], targets: { github: target } })
    const removeNow = () => stores.connections.remove('m1', 'github')
    deps.http = (async (input: RequestInfo | URL) => {
      sent.push(String(input))
      return new Response('{}')
    }) as typeof fetch
    const row = await queueAndClaim(stores, 'github')
    await runExport(row, deps)
    expect(await stores.exports.get('m1', row.id)).toMatchObject({
      status: 'failed',
      errorCode: 'not_connected',
      error: CONNECTION_REMOVED_MESSAGE
    })
    expect(sent).toEqual(['https://api.example.test/one'])
    expect(stores.saved).toEqual([])
    expect(await stores.connections.get('m1', 'github')).toBeNull()
    expect(pings[0]!.actions?.[0]).toEqual({ label: 'Reconnect', url: 'https://tm.example/connections' })
  }
})

test('an export that runs too long fails and its network calls are aborted', async () => {
  let aborted = false
  const slow: ExportTarget = {
    id: 'zip',
    run: (_bundle, ctx) =>
      new Promise((_resolve, reject) => {
        void ctx.http('https://example.test/never', {}).catch(() => {
          aborted = true
          reject(new Error('aborted call'))
        })
      })
  }
  const { deps, stores } = await setup({ targets: { zip: slow }, timeoutMs: 30 })
  deps.http = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('abort')))
    )) as unknown as typeof fetch
  const row = await queueAndClaim(stores, 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'failed',
    errorCode: 'failed',
    error: 'The export took too long. Try again.'
  })
  await Bun.sleep(10)
  expect(aborted).toBe(true)
})

test('a file over the size cap fails the export and is removed', async () => {
  const { deps, stores, dataDir } = await setup({ maxOutputBytes: 100 })
  const row = await queueAndClaim(stores, 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({ status: 'failed', errorCode: 'failed' })
  expect((await stores.exports.get('m1', row.id))?.error).toBe('The export file is larger than 0 MB.')
  expect(existsSync(join(dataDir, 'exports', `${row.id}.zip`))).toBe(false)
})

test('a target that names a file of its own is refused', async () => {
  const sneaky = fakeTarget('zip', undefined, { url: null, filePath: 'out/transcript.md', note: null })
  const { deps, stores } = await setup({ targets: { zip: sneaky } })
  const row = await queueAndClaim(stores, 'zip')
  await runExport(row, deps)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'failed',
    error: 'The export file is in the wrong place.'
  })
})

test('an exports folder that is a symlink is refused and nothing is written through it', async () => {
  const { deps, stores, dataDir } = await setup()
  const elsewhere = await mkdtemp(join(tmpdir(), 'tm-exports-elsewhere-'))
  try {
    await symlink(elsewhere, join(dataDir, 'exports'))
    const row = await queueAndClaim(stores, 'zip')
    await runExport(row, deps)
    expect(await stores.exports.get('m1', row.id)).toMatchObject({
      status: 'failed',
      error: 'The export folder is not a folder.'
    })
    expect(await readdir(elsewhere)).toEqual([])
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('a ping that fails or is not sent leaves the row alone and is logged', async () => {
  for (const ping of [
    async () => false,
    async () => {
      throw new Error('ntfy down https://ntfy.example/secret-topic')
    }
  ]) {
    const lines: string[] = []
    const { deps, stores } = await setup({ ping, log: (l) => lines.push(l) })
    const row = await queueAndClaim(stores, 'zip')
    await runExport(row, deps)
    expect((await stores.exports.get('m1', row.id))?.status).toBe('succeeded')
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toContain('secret-topic')
  }
})

test('runLoop fails interrupted rows, then runs queued ones in order', async () => {
  const { deps, stores, pings } = await setup({ targets: { zip: zipTarget, pdf: fakeTarget('pdf', new Error('x')) } })
  const stale = await stores.exports.create('m1', 'o1', 'pdf')
  await stores.store.claimNext()
  await stores.exports.create('m1', 'o1', 'zip')
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 150)
  await runLoop(deps, ac.signal, 5)
  expect(await stores.exports.get('m1', stale.id)).toMatchObject({ errorCode: 'interrupted' })
  expect(pings.map((p) => p.title)).toEqual(['Export failed', 'Export finished'])
})

test('runLoop stops when its signal aborts, even while idle', async () => {
  const { deps } = await setup()
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 20)
  const started = Date.now()
  await runLoop(deps, ac.signal, 60_000)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('runLoop purges the rows of deleted meetings and goes on after a failing pass', async () => {
  const lines: string[] = []
  const { deps, stores } = await setup({ log: (l) => lines.push(l) })
  let claims = 0
  const real = deps.store.claimNext
  deps.store.claimNext = async () => {
    if (claims++ === 0)
      throw Object.assign(new Error('connection to postgres://u:pw@db failed'), { code: 'ECONNREFUSED' })
    return real()
  }
  const row = await stores.exports.create('m1', 'o1', 'zip')
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 150)
  await runLoop(deps, ac.signal, 5)
  expect((await stores.exports.get('m1', row.id))?.status).toBe('succeeded')
  expect(lines).toContain('export loop error (Error ECONNREFUSED)')
  expect(lines.join('\n')).not.toContain('postgres://')
})

test('a failing runExport does not leave the row running', async () => {
  const { deps, stores } = await setup()
  const row = await stores.exports.create('m1', 'o1', 'zip')
  deps.store.succeed = async () => {
    throw new Error('database gone')
  }
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  await runLoop(deps, ac.signal, 5)
  expect(await stores.exports.get('m1', row.id)).toMatchObject({
    status: 'failed',
    error: 'The export did not finish. Try again.'
  })
})

test('ping copy for remote results and failures', async () => {
  const { stores } = await setup()
  const row = await queueAndClaim(stores, 'notion')
  const url = 'https://notion.example/page'
  expect(exportPing(row, 'T', { ok: true, result: { url, filePath: null, note: null } }, 'https://tm.example')).toEqual(
    {
      title: 'Export finished',
      message: '"T" is in Notion.',
      priority: 'default',
      actions: [
        { label: 'Open', url },
        { label: 'Open meeting page', url: 'https://tm.example/meetings/o1' }
      ]
    }
  )
  expect(
    exportPing(row, 'T', { ok: true, result: { url, filePath: null, note: 'unchanged' } }, 'https://tm.example').message
  ).toBe('"T" was already up to date in Notion.')
  expect(exportPing(row, null, { ok: false, code: 'rate_limited', message: 'Wait.' }, 'https://tm.example')).toEqual({
    title: 'Export failed',
    message: '"This meeting" to Notion: Wait.',
    priority: 'default',
    actions: [{ label: 'Open meeting page', url: 'https://tm.example/meetings/o1' }]
  })
  // Reconnect only for a remote target.
  const zip = await queueAndClaim(stores, 'zip')
  expect(
    exportPing(zip, null, { ok: false, code: 'not_found', message: 'x' }, 'https://tm.example').actions
  ).toHaveLength(1)
})
