import { join } from 'node:path'
import { expect, test } from 'bun:test'

const webRoot = join(import.meta.dir, '..')

async function files(glob: string): Promise<{ file: string; text: string }[]> {
  const found = await Array.fromAsync(new Bun.Glob(glob).scan({ cwd: webRoot }))
  return await Promise.all(found.map(async (file) => ({ file, text: await Bun.file(join(webRoot, file)).text() })))
}

const startsWithDirective = (text: string, directive: string) =>
  new RegExp(String.raw`^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*['"]${directive}['"]`).test(text)

test('client components import nothing from the server side', async () => {
  const problems: string[] = []
  for (const { file, text } of await files('{app,components}/**/*.tsx')) {
    if (!startsWithDirective(text, 'use client')) continue
    for (const [, specifier] of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      // Allowed: React and Next client modules, other components, and the browser-side auth client.
      const ok =
        /^(?:react|react-dom|next\/(?:link|navigation))$/.test(specifier!) ||
        /(?:^|\/)components\//.test(specifier!) ||
        /(?:^|\/)lib\/auth-client$/.test(specifier!) ||
        /^\.\/[\w-]+$/.test(specifier!)
      if (!ok) problems.push(`${file}: imports ${specifier}`)
    }
  }
  expect(problems).toEqual([])
})

test('every page asks for the member on the server, except sign-in', async () => {
  const pages = await files('app/**/page.tsx')
  expect(pages.map((p) => p.file)).toContain('app/page.tsx')
  const problems = pages
    .filter(({ file, text }) => file !== 'app/sign-in/page.tsx' && !/\brequire(?:Member|Admin)\(\)/.test(text))
    .map(({ file }) => `${file}: never calls requireMember() or requireAdmin()`)
  expect(problems).toEqual([])
})

test('pages and components put no secrets, tokens or meeting links in the HTML they render', async () => {
  const problems: string[] = []
  for (const { file, text } of await files('{app,components}/**/*.tsx')) {
    if (startsWithDirective(text, 'use server')) continue
    if (/\b(?:linkUsed|link_used|passcode|controlTokenHash|tokenEnc|dashscopeKeyEnc)\b/.test(text)) problems.push(file)
  }
  expect(problems).toEqual([])
})
