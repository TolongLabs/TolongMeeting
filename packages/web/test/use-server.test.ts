import { join } from 'node:path'
import { expect, test } from 'bun:test'

const webRoot = join(import.meta.dir, '..')

/** Files in `app/` that start with the `'use server'` directive. */
async function serverActionFiles(): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob('app/**/*.{ts,tsx}').scan({ cwd: webRoot }))
  const found: string[] = []
  for (const file of files) {
    const text = await Bun.file(join(webRoot, file)).text()
    if (/^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(text)) found.push(file)
  }
  return found
}

test('server action files export only async functions that get the member from the session', async () => {
  const files = await serverActionFiles()
  expect(files).toContain('app/ai-keys/actions.ts')
  expect(files).toContain('app/accounts/actions.ts')
  expect(files).toContain('app/details/actions.ts')

  const problems: string[] = []
  for (const file of files) {
    const text = await Bun.file(join(webRoot, file)).text()
    for (const line of text.split('\n').filter((l) => /^export\s/.test(l))) {
      if (/^export\s+type\s/.test(line)) continue
      if (!/^export\s+async\s+function\s/.test(line)) problems.push(`${file}: ${line}`)
      if (/\bscope\b|MemberScope/.test(line)) problems.push(`${file}: takes a scope: ${line}`)
    }
    // Admin actions call requireAdmin() instead, which takes the member from the session first (see the rule below).
    if (!file.startsWith('app/admin/') && !text.includes('requireMember()'))
      problems.push(`${file}: never calls requireMember()`)
  }
  expect(problems).toEqual([])
})

test('admin server actions call requireAdmin() before adminScope()', async () => {
  // app/admin/ has no server actions yet, so this passes over no files. It sets the rule for the first one.
  const files = await Array.fromAsync(new Bun.Glob('app/admin/**/*.{ts,tsx}').scan({ cwd: webRoot }))
  const problems: string[] = []
  for (const file of files) {
    const text = await Bun.file(join(webRoot, file)).text()
    if (!/^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(text)) continue
    // Each export is checked on its own: the text before the first export is the directive and imports.
    const [, ...exports] = text.split(/^(?=export\s+async\s+function\s)/m)
    for (const body of exports) {
      const name = /^export\s+async\s+function\s+(\w+)/.exec(body)?.[1] ?? '?'
      const guard = body.indexOf('requireAdmin()')
      if (guard === -1) problems.push(`${file}: ${name} never calls requireAdmin()`)
      else if (body.includes('adminScope(') && body.indexOf('adminScope(') < guard) {
        problems.push(`${file}: ${name} calls adminScope() before requireAdmin()`)
      }
    }
  }
  expect(problems).toEqual([])
})
