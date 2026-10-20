import { join } from 'node:path'
import { expect, test } from 'bun:test'

const webRoot = join(import.meta.dir, '..')

// The website may import the narrow entry `@tm/exports/api` only. The root entry reaches the renderers (sharp, pdfmake,
// docx), which `next build` cannot load while collecting page data and the website never needs.
const ROOT_ENTRY = /['"`]@tm\/exports(?:\/(?!api['"`])[^'"`]*)?['"`]/
const SCANNED = ['app', 'lib', 'db']

test('the matcher flags the root entry and deep imports, and passes the api entry', () => {
  for (const text of [
    `import { x } from '@tm/exports'`,
    `import type { x } from "@tm/exports"`,
    `await import('@tm/exports')`,
    `import { runnerStore } from '@tm/exports/src/store'`,
    `import { x } from '@tm/exports/src/registry'`
  ])
    expect(ROOT_ENTRY.test(text)).toBe(true)
  for (const text of [`import { x } from '@tm/exports/api'`, `import { x } from '@tm/exportsish'`, `from '@tm/core'`])
    expect(ROOT_ENTRY.test(text)).toBe(false)
})

test('web app/, lib/ and db/ import only @tm/exports/api', async () => {
  const offenders: string[] = []
  let scanned = 0
  for (const dir of SCANNED) {
    for (const file of await Array.fromAsync(
      new Bun.Glob(`${dir}/**/*.{ts,tsx,mts,js,jsx,mjs}`).scan({ cwd: webRoot })
    )) {
      scanned++
      if (ROOT_ENTRY.test(await Bun.file(join(webRoot, file)).text())) offenders.push(file)
    }
  }
  expect(scanned).toBeGreaterThan(50)
  expect(offenders).toEqual([])
})
