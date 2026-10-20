import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startFakeAi, startFakeNtfy, type FakeAi, type FakeNtfy } from './fakes'
import { liveLine, makeOccurrence, removeOccurrence, writeAttempts, writeLines, type Occurrence } from './helpers'

const CLI = join(import.meta.dir, '../src/cli.ts')

let occ: Occurrence
let ai: FakeAi
let ntfy: FakeNtfy
beforeAll(async () => {
  occ = await makeOccurrence()
  ai = startFakeAi()
  ntfy = startFakeNtfy()
  await Bun.write(join(occ.dataDir, 'events.jsonl'), '')
  await writeAttempts(occ.dataDir, [{ startMs: 0, stopMs: null }])
  await writeLines(join(occ.dataDir, 'transcript', 'live.jsonl'), [liveLine(0, 1000, 'Hello.')])
})
afterAll(async () => {
  ai.stop()
  ntfy.stop()
  await removeOccurrence(occ.root)
})

// Async, so the fake servers in this process can answer while the CLI runs.
async function run(...args: string[]) {
  const child = Bun.spawn(['bun', CLI, ...args], { env: { ...process.env, TZ: 'UTC' }, stdout: 'pipe', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  return { exitCode, stderr }
}

async function jobFile(name: string, job: unknown): Promise<string> {
  const path = join(occ.root, name)
  await Bun.write(path, typeof job === 'string' ? job : JSON.stringify(job))
  return path
}

const job = () => ({
  ...occ.cfg,
  ai: { ...occ.cfg.ai, baseUrl: ai.url },
  ntfy: { ...occ.cfg.ntfy, url: ntfy.url }
})

test('usage errors exit 64', async () => {
  for (const args of [[], ['--job'], ['--other', 'x'], ['--job', 'a', 'b']]) {
    const r = await run(...args)
    expect(r.exitCode).toBe(64)
    expect(r.stderr).toContain('usage: tm-pipeline --job <path>')
  }
})

test('an invalid job exits 65 and never echoes a secret', async () => {
  const bad = await jobFile('bad.json', { ...job(), ai: { ...job().ai, apiKey: 'sk-secret-value', baseUrl: 'nope' } })
  const r = await run('--job', bad)
  expect(r.exitCode).toBe(65)
  expect(r.stderr).toContain('ai.baseUrl')
  expect(r.stderr).not.toContain('sk-secret-value')
  const notJson = await jobFile('notjson.json', '{"ai": {"apiKey": "sk-secret-value"')
  const r2 = await run('--job', notJson)
  expect(r2.exitCode).toBe(65)
  expect(r2.stderr).not.toContain('sk-secret-value')
  expect((await run('--job', join(occ.root, 'missing.json'))).exitCode).toBe(65)
})

test('exit 0 on success, 2 on a rejected key, 1 on any other error', async () => {
  const path = await jobFile('job.json', job())
  ai.reply({ sessionLabel: null, nextAction: null, items: [], covered: [] })
  expect((await run('--job', path)).exitCode).toBe(0)
  ai.fail(401)
  const keyed = await run('--job', path)
  expect(keyed.exitCode).toBe(2)
  expect(keyed.stderr).toContain('401')
  expect(keyed.stderr).not.toContain('test-key')
  ai.fail(500)
  expect((await run('--job', path)).exitCode).toBe(1)
})

test('a failed ping prints the error name and status, never the ntfy URL or token', async () => {
  ai.reply({ sessionLabel: null, nextAction: null, items: [], covered: [] })
  const secretNtfy = { url: ntfy.url, topic: 'topic', token: 'tok-secret-123' }
  const marker = join(occ.dataDir, 'out', 'summary-pinged')
  await rm(marker, { force: true })
  ntfy.fail(500)
  const down = await run('--job', await jobFile('down.json', { ...job(), ntfy: secretNtfy }))
  expect(down.exitCode).toBe(1)
  expect(down.stderr).toContain('PingError (ntfy answered 500)')
  ntfy.fail(null)
  await rm(marker, { force: true })
  // Nothing listens on port 1: the fetch error behind the ping error names the URL.
  const gone = await run(
    '--job',
    await jobFile('gone.json', { ...job(), dataDir: occ.dataDir, ntfy: { ...secretNtfy, url: 'http://127.0.0.1:1' } })
  )
  expect(gone.exitCode).toBe(1)
  expect(gone.stderr).toContain('PingError')
  for (const text of [down.stderr, gone.stderr]) {
    expect(text).not.toContain('tok-secret-123')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain(ntfy.url)
  }
}, 30_000)
