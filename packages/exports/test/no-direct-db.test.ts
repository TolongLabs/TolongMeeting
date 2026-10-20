import { join } from 'node:path'
import { expect, test } from 'bun:test'

const src = join(import.meta.dir, '..', 'src')
const webRoot = join(import.meta.dir, '..', '..', 'web')
const SOURCE = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

// Opening the database from the exports package: the web db module (`@tm/web/db`, `@tm/web/db/errors`, ...) or `getDb`.
const OPENS_DB = /@tm\/web\/db\b|\bgetDb\s*\(/
// Only the runner's store and the runner entry may. Everything else gets a store from its caller.
const ALLOWED = /^(?:store|main)\.ts$/
// How server code of the web package could reach the cross-member store.
const RUNNER_STORE = /\brunnerStore\b|@tm\/exports\/src\/store(?![\w-])/

const scan = (cwd: string) => Array.fromAsync(new Bun.Glob(SOURCE).scan({ cwd }))

test('the matchers flag what they should', () => {
  for (const text of [
    `import { exports } from '@tm/web/db'`,
    `import { safeDbError } from '@tm/web/db/errors'`,
    `const db = getDb ()`
  ])
    expect(OPENS_DB.test(text)).toBe(true)
  for (const text of [
    `import { x } from '@tm/web/lib/scope'`,
    `const getDbName = 1`,
    `import type { Db } from './db-types'`
  ])
    expect(OPENS_DB.test(text)).toBe(false)
  expect(RUNNER_STORE.test(`import { runnerStore } from '@tm/exports/src/store'`)).toBe(true)
  expect(RUNNER_STORE.test(`import { x } from '@tm/exports/src/store-types'`)).toBe(false)
  expect(ALLOWED.test('store.ts') && ALLOWED.test('main.ts')).toBe(true)
  expect(['store-types.ts', 'render/store.ts', 'api.ts'].filter((f) => ALLOWED.test(f))).toEqual([])
})

test('only store.ts and the runner entry open the database in packages/exports/src', async () => {
  const files = await scan(src)
  expect(files).toContain('store.ts')
  const offenders: string[] = []
  for (const file of files) {
    if (ALLOWED.test(file)) continue
    if (OPENS_DB.test(await Bun.file(join(src, file)).text())) offenders.push(file)
  }
  expect(offenders).toEqual([])
})

test('the package index does not export the runner store', async () => {
  expect(RUNNER_STORE.test(await Bun.file(join(src, 'index.ts')).text())).toBe(false)
  expect(Object.keys(await import('../src'))).not.toContain('runnerStore')
})

test('no web app or lib file imports the runner store', async () => {
  const offenders: string[] = []
  for (const dir of ['app', 'lib']) {
    const cwd = join(webRoot, dir)
    for (const file of await scan(cwd)) {
      if (RUNNER_STORE.test(await Bun.file(join(cwd, file)).text())) offenders.push(`${dir}/${file}`)
    }
  }
  expect(offenders).toEqual([])
})
