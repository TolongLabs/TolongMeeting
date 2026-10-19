// Architecture: packages/core holds shared types, schemas, state machines and time helpers with no I/O, so every
// other package can import it anywhere (worker on Node, web on Bun) without pulling in a runtime.
import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { join } from 'node:path'
import ts from 'typescript'

const core = join(import.meta.dir, '..', 'packages', 'core')
/** Core may import only zod and its own files. */
const ALLOWED = /^(\.{1,2}\/|zod$)/

describe('core stays free of I/O', () => {
  test('source files import only zod and each other', async () => {
    const found: string[] = []
    for await (const file of new Glob('src/**/*.{ts,tsx}').scan({ cwd: core })) {
      const text = await Bun.file(join(core, file)).text()
      for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
        if (!ALLOWED.test(fileName)) found.push(`packages/core/${file} imports ${fileName}`)
      }
    }
    expect(found).toEqual([])
  })

  test('the manifest depends on nothing but zod', async () => {
    const manifest = await Bun.file(join(core, 'package.json')).json()
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(deps.filter((name) => name !== 'zod')).toEqual([])
  })
})
