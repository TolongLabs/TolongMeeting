import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-cli-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const run = (...args: string[]) => Bun.spawnSync(['bun', cli, ...args], { stdout: 'pipe', stderr: 'pipe' })
const job = async (content: string) => {
  const file = join(dir, 'job.json')
  await writeFile(file, content)
  return file
}

test('usage and invalid jobs never echo secrets', async () => {
  const a = run()
  expect(a.exitCode).toBe(64)
  expect(a.stderr.toString()).toContain('usage: tm-worker [--seed | --smoke] --job <path>')

  const b = run(
    '--job',
    await job(JSON.stringify({ ai: { apiKey: 'sk-secret-value' }, ntfy: { token: 'sk-secret-value' } }))
  )
  expect(b.exitCode).toBe(65)
  expect(b.stderr.toString()).toContain('invalid job:')
  expect(b.stderr.toString()).not.toContain('sk-secret-value')

  const c = run('--job', await job('{"ai": {"apiKey": sk-secret-value}'))
  expect(c.exitCode).toBe(65)
  expect(c.stderr.toString()).not.toContain('sk-secret-value')
})

test('unknown flags and a missing job file are refused', () => {
  expect(run('--job').exitCode).toBe(64)
  expect(run('--seed').exitCode).toBe(64)
  expect(run('--smoke').exitCode).toBe(64)
  expect(run('--seed', '--smoke', '--job', 'x').exitCode).toBe(64)
  expect(run('--bogus', '--job', 'x').exitCode).toBe(64)
  expect(run('--job', join(dir, 'missing.json')).exitCode).toBe(65)
  expect(run('--smoke', '--job', join(dir, 'missing.json')).exitCode).toBe(65)
})
