import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// docker/worker/openbox/rc.xml is what keeps the member on the desk during a sign-in: the remote view sends real X input, so
// every key chord, drag and menu the window manager binds is a way off the desk window (over the recorded stage, or away
// from it). The file must bind nothing but a click that focuses and raises.
const RC = join(import.meta.dir, '..', '..', '..', 'docker', 'worker', 'openbox', 'rc.xml')

type Tag = { name: string; attrs: Record<string, string>; closing: boolean }

// Every start and end tag of the file in order, comments removed.
async function tags(): Promise<Tag[]> {
  const xml = (await readFile(RC, 'utf8')).replace(/<!--[\s\S]*?-->/g, '')
  return [...xml.matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g)].map((m) => ({
    name: m[2]!,
    closing: m[1] === '/',
    attrs: Object.fromEntries([...m[3]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]))
  }))
}

test('the window manager binds no key', async () => {
  const all = await tags()
  expect(all.filter((t) => t.name === 'keybind')).toEqual([])
  expect(all.filter((t) => t.name === 'chainQuitKey')).toEqual([])
  expect(all.some((t) => t.name === 'keyboard')).toBe(true) // present and empty: openbox then adds no default
})

test('no mouse bind moves, resizes, opens a menu or switches desktops; only a click on a window focuses and raises', async () => {
  const all = await tags()
  const contexts = all.filter((t) => t.name === 'context' && !t.closing).map((t) => t.attrs.name)
  expect(contexts).toEqual(['Client'])
  const binds = all.filter((t) => t.name === 'mousebind' && !t.closing)
  expect(binds.length).toBeGreaterThan(0)
  for (const bind of binds) {
    // No modifier prefix (A-, C-, S-, W-) such as the Alt-drag move and resize binds of the default Frame context.
    expect(bind.attrs.button).toMatch(/^(Left|Middle|Right)$/)
    expect(bind.attrs.action).toBe('Press')
  }
  const actions = new Set(all.filter((t) => t.name === 'action' && !t.closing).map((t) => t.attrs.name))
  expect([...actions].sort()).toEqual(['Focus', 'Raise'])
})

test('the desk window has no decoration and a fixed place on the right half of the screen', async () => {
  const xml = (await readFile(RC, 'utf8')).replace(/<!--[\s\S]*?-->/g, '')
  const rule = /<application role="browser">([\s\S]*?)<\/application>/.exec(xml)?.[1]
  expect(rule).toBeDefined()
  expect(rule).toContain('<decor>no</decor>')
  expect(rule).toMatch(/<position force="yes">\s*<x>1920<\/x>\s*<y>0<\/y>\s*<\/position>/)
  expect(xml).toContain('<menu>\n  <hideDelay>200</hideDelay>\n</menu>') // no menu file to open
})
