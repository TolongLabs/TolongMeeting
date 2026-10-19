import { join } from 'node:path'
import { expect, test } from 'bun:test'

const webRoot = join(import.meta.dir, '..')

// Files allowed to open the database: the member scope, Better Auth and the token-authenticated control endpoints.
const ALLOWED = /^lib\/(scope|auth|control)\.tsx?$/
// A call to getDb, or an import of the database module itself (not its schema).
const OPENS_DB = /\bgetDb\s*\(|from ['"][^'"]*\bdb(?:\/(?:index|migrate|testing))?['"]/

test('only lib/scope.ts, lib/auth.ts and lib/control.ts open the database in packages/web', async () => {
  const files = await Array.fromAsync(new Bun.Glob('{app,lib}/**/*.{ts,tsx}').scan({ cwd: webRoot }))
  expect(files).toContain('lib/scope.ts')

  const offenders: string[] = []
  for (const file of files) {
    if (ALLOWED.test(file)) continue
    const text = await Bun.file(join(webRoot, file)).text()
    if (OPENS_DB.test(text)) offenders.push(file)
  }
  expect(offenders).toEqual([])
})
