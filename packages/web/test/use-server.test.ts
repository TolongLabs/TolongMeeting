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
    if (!text.includes('requireMember()')) problems.push(`${file}: never calls requireMember()`)
  }
  expect(problems).toEqual([])
})
