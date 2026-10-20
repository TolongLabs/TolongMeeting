import { join } from 'node:path'
import { expect, test } from 'bun:test'

const webRoot = join(import.meta.dir, '..')
const repoRoot = join(webRoot, '..', '..')

async function files(glob: string): Promise<{ file: string; text: string }[]> {
  const found = await Array.fromAsync(new Bun.Glob(glob).scan({ cwd: webRoot }))
  return await Promise.all(found.map(async (file) => ({ file, text: await Bun.file(join(webRoot, file)).text() })))
}

const startsWithDirective = (text: string, directive: string) =>
  new RegExp(String.raw`^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*['"]${directive}['"]`).test(text)

/** Code without comments: a comment may name a secret without rendering it. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Imports that survive the build. `import type` is erased, so it cannot pull server code into the browser. */
const runtimeImports = (text: string) => text.replace(/^\s*import\s+type\s+[^;]*?\sfrom\s+['"][^'"]+['"]\s*;?/gm, '')

/** True when any source file of `@tm/core` imports a Node built-in. A browser component may then not import it. */
async function coreImportsNode(): Promise<boolean> {
  const found = await Array.fromAsync(new Bun.Glob('packages/core/src/**/*.ts').scan({ cwd: repoRoot }))
  for (const file of found) {
    const text = await Bun.file(join(repoRoot, file)).text()
    if (/\bfrom\s+['"]node:/.test(text)) return true
  }
  return false
}

/** True when the file, or a component it imports from a local `.tsx` file, calls `requireMember()` or `requireAdmin()`. */
async function asksForMember(file: string, text: string, seen = new Set<string>()): Promise<boolean> {
  if (/\brequire(?:Member|Admin)\(\)/.test(text)) return true
  if (seen.has(file)) return false
  seen.add(file)
  const imports = text.matchAll(/^\s*import\s+[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)
  for (const [, specifier] of imports) {
    if (!specifier!.startsWith('.')) continue
    const candidate = join(webRoot, file, '..', `${specifier!}.tsx`)
    if (!(await Bun.file(candidate).exists())) continue
    if (await asksForMember(candidate, await Bun.file(candidate).text(), seen)) return true
  }
  return false
}

test('client components import nothing from the server side', async () => {
  const problems: string[] = []
  const coreAllowed = !(await coreImportsNode())
  for (const { file, text } of await files('{app,components}/**/*.tsx')) {
    if (!startsWithDirective(text, 'use client')) continue
    for (const [, specifier] of runtimeImports(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      // Allowed: React and Next client modules, other components, the browser-side auth client, and these modules,
      // which only use browser APIs (checked below and by their tests). `@tm/core` is allowed only while it is
      // browser-safe; today it imports `node:crypto`, so a value import of it fails.
      const ok =
        /^(?:react|react-dom|next\/(?:link|navigation))$/.test(specifier!) ||
        /(?:^|\/)components\//.test(specifier!) ||
        /(?:^|\/)lib\/auth-client$/.test(specifier!) ||
        /(?:^|\/)lib\/(?:meeting-control|export-buttons)$/.test(specifier!) ||
        (coreAllowed && specifier === '@tm/core') ||
        /^\.\/[\w-]+$/.test(specifier!)
      if (!ok) problems.push(`${file}: imports ${specifier}`)
    }
  }
  expect(problems).toEqual([])
})

test('every page asks for the member on the server, except sign-in', async () => {
  const pages = await files('app/**/page.tsx')
  expect(pages.map((p) => p.file)).toContain('app/page.tsx')
  const problems: string[] = []
  for (const { file, text } of pages) {
    if (file === 'app/sign-in/page.tsx') continue
    if (!(await asksForMember(file, text))) problems.push(`${file}: never calls requireMember() or requireAdmin()`)
  }
  expect(problems).toEqual([])
})

test('pages and components put no secrets, tokens or meeting links in the HTML they render', async () => {
  const problems: string[] = []
  for (const { file, text } of await files('{app,components}/**/*.tsx')) {
    if (startsWithDirective(text, 'use server')) continue
    // Names that hold a secret, not words such as `passcodeFromChat` that merely mention one. Comments are not rendered.
    if (/\b(?:linkUsed|link_used|passcode|controlTokenHash|tokenEnc|dashscopeKeyEnc)\b/.test(withoutComments(text))) {
      problems.push(file)
    }
  }
  expect(problems).toEqual([])
})

test('search-parameter maps are only read with Object.hasOwn', async () => {
  const problems: string[] = []
  for (const { file, text } of await files('app/**/*.tsx')) {
    for (const line of text.split('\n')) {
      if (/\b(?:NOTICES|PROBLEMS)\s*\[/.test(line) && !/\bObject\.hasOwn\(/.test(line)) {
        problems.push(`${file}: ${line.trim()}`)
      }
    }
  }
  expect(problems).toEqual([])
})

test('the key form keeps a typed Workspace ID after a failed save', async () => {
  const text = await Bun.file(join(webRoot, 'app/ai-keys/key-form.tsx')).text()
  expect(text).toContain('value={workspaceId}')
  expect(text).toContain('onChange=')
  expect(text).not.toContain('defaultValue={props.workspaceId')
})

test('the timetable actions answer with a typed code, which the form switches on', async () => {
  const actions = await Bun.file(join(webRoot, 'app/timetable/actions.ts')).text()
  expect(actions).toMatch(/code:\s*TimetableErrorCode/)
  const formActions = await Bun.file(join(webRoot, 'app/timetable/form-actions.ts')).text()
  expect(formActions).toContain('result.code')
  expect(formActions).not.toContain('result.error ===')
  expect(formActions).not.toContain('.test(result.error)')
  expect(formActions).not.toContain('startsWith(')
})

test('a key shows its last four characters only when it is long enough', async () => {
  const { keySuffix } = await import('../lib/ai-keys')
  expect(keySuffix('12345678')).toBe('')
  expect(keySuffix('sk-1234567890123456789')).toBe('')
  expect(keySuffix('sk-dashscope-secret-1234')).toBe('1234')
  expect(keySuffix('sk-a-much-longer-key-value-5678')).toBe('5678')
})
