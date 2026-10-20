import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

const webRoot = join(import.meta.dir, '..')

// Files allowed to open the database: the member scope, Better Auth, the token-authenticated control endpoints and the
// companion's device-token endpoints.
const ALLOWED = /^lib\/(?:scope|auth|control|companion\/(?:scope|deps))\.[cm]?[jt]sx?$/
// Not scanned: the database layer itself, tests (they build their own databases) and generated or installed files.
const SKIPPED_DIRS = new Set(['db', 'test', 'node_modules', '.next'])
const SOURCE = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

// A module specifier: `from 'x'`, `import 'x'`, `import('x')` or `require('x')`, with any quote or a backtick.
const MODULE = String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"\`]`
// The database module (`db`, `db/index`, `db/migrate`, `db/testing`, with an optional extension), but not `db/schema`.
const DB_MODULE = String.raw`[^'"\`]*\bdb(?:\/(?:index|migrate|testing))?(?:\.[cm]?[jt]s)?['"\`]`
// A raw driver, which would bypass the scope without going through the db module.
const DRIVER_MODULE = String.raw`(?:drizzle-orm\/(?:node-postgres|postgres-js|bun-sql)|pg|postgres)(?:\/[^'"\`]*)?['"\`]`

/** True when `text` opens the database: `getDb()`, the db module, a raw driver, or Bun's built-in SQL client. */
const OPENS_DB = new RegExp(
  [
    String.raw`\bgetDb\s*\(`,
    MODULE + DB_MODULE,
    MODULE + DRIVER_MODULE,
    String.raw`\bBun\s*\.\s*(?:sql|SQL)\b`,
    String.raw`\bimport\s*\{[^}]*\b(?:sql|SQL)\b[^}]*\}\s*from\s*['"\`]bun['"\`]`
  ].join('|')
)

const BAD = [
  `import { getDb } from '../db'`,
  `const db = getDb ()`,
  `import { x } from "../db/index"`,
  `import { x } from '../db/index.ts'`,
  `import { x } from '../../db.js'`,
  `import { x } from '@tm/web/db'`,
  `import { runMigrations } from '@tm/web/db/migrate'`,
  `const { db } = await import('../db')`,
  `await import(\n  '../../db/index.js'\n)`,
  'await import(`../db`)',
  `const db = require('../db/index.cjs')`,
  `import '../db'`,
  `import { drizzle } from 'drizzle-orm/node-postgres'`,
  `import { drizzle } from "drizzle-orm/postgres-js"`,
  `import { migrate } from 'drizzle-orm/node-postgres/migrator'`,
  `const { drizzle } = await import('drizzle-orm/bun-sql')`,
  `import { Pool } from 'pg'`,
  `const { Client } = require('pg')`,
  `import postgres from 'postgres'`,
  `const rows = await Bun.sql\`select 1\``,
  `const sql = new Bun.SQL(url)`,
  `import { sql } from 'bun'`
]

const GOOD = [
  `import { identities } from '../db/schema'`,
  `import { identities } from '../../db/schema.ts'`,
  `import { eq, sql } from 'drizzle-orm'`,
  `import { createScope } from './scope'`,
  `import { cookies } from 'next/headers'`,
  `import { x } from './mydb'`,
  `import { x } from '../feedback'`,
  `import { x } from './db-utils'`,
  `const dialect = 'postgres'`,
  `import { x } from 'postgres-helpers'`,
  `const mod = await import('./page')`,
  `const getDbName = 1`,
  `const file = Bun.file('x')`,
  `import { file } from 'bun'`,
  `import { z } from 'zod'`
]

test('the matcher flags every way to open the database and nothing else', () => {
  expect(BAD.filter((text) => !OPENS_DB.test(text))).toEqual([])
  expect(GOOD.filter((text) => OPENS_DB.test(text))).toEqual([])
})

test('the allow-list names exactly those files', () => {
  const allowed = ['lib/scope.ts', 'lib/auth.ts', 'lib/control.ts', 'lib/companion/scope.ts', 'lib/companion/deps.ts']
  const refused = [
    'lib/companion/tokens.ts',
    'lib/companion/guard.ts',
    'proxy.ts',
    'lib/companion/scope.ts.bak',
    'lib/companion/x/deps.ts',
    'app/lib/scope.ts'
  ]
  expect(allowed.filter((file) => !ALLOWED.test(file))).toEqual([])
  expect(refused.filter((file) => ALLOWED.test(file))).toEqual([])
})

async function sourceFiles(): Promise<string[]> {
  const glob = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: webRoot }))
  const files = await glob(SOURCE)
  for (const entry of await readdir(webRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) files.push(...(await glob(`${entry.name}/**/${SOURCE}`)))
  }
  return files
}

test('only lib/{scope,auth,control}.ts and lib/companion/{scope,deps}.ts open the database in packages/web', async () => {
  const files = await sourceFiles()
  expect(files).toContain('lib/scope.ts')
  // The request gate runs on every request and must not be able to reach the database.
  expect(files).toContain('proxy.ts')
  expect(files).toContain('lib/companion/guard.ts')

  const offenders: string[] = []
  for (const file of files) {
    if (ALLOWED.test(file)) continue
    const text = await Bun.file(join(webRoot, file)).text()
    if (OPENS_DB.test(text)) offenders.push(file)
  }
  expect(offenders).toEqual([])
})
