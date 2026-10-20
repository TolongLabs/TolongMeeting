import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { LOCAL_PAGE_CSP } from '../src/ui/security'

// The pages, icons and installer settings as they sit in the package.

const root = join(import.meta.dir, '..')
const PAGES = ['pairing', 'settings', 'signin']
const html = (page: string) => readFile(join(root, 'src/renderer', `${page}.html`), 'utf8')

describe('renderer pages', () => {
  test('there is a page, a script and a preload for each window, and nothing else', async () => {
    const files = (await readdir(join(root, 'src/renderer'))).sort()
    expect(files).toEqual([
      'pairing.html',
      'pairing.ts',
      'settings.html',
      'settings.ts',
      'signin.html',
      'signin.ts',
      'ui.css'
    ])
    expect((await readdir(join(root, 'src/preload'))).sort()).toEqual(['pairing.ts', 'settings.ts', 'signin.ts'])
  })

  test.each(PAGES)('%s carries the strict CSP and loads only its own files', async (page) => {
    const text = await html(page)
    expect(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(text)?.[1]).toBe(LOCAL_PAGE_CSP)
    expect(text).not.toMatch(/<script(?![^>]*\ssrc=)/i) // no inline script
    expect(text).not.toMatch(/<style|\sstyle=/i) // no inline style
    expect(text).not.toMatch(/\son[a-z]+\s*=/i) // no inline handler
    expect(text).not.toMatch(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i) // no remote address
    const sources = [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    expect(sources.sort()).toEqual([`${page}.js`, 'ui.css'].sort())
  })

  test.each(PAGES)('%s is plain, accessible HTML', async (page) => {
    const text = await html(page)
    expect(text).toMatch(/<html lang="en">/)
    expect(text).toMatch(/<title>[^<]+<\/title>/)
    expect(text).toContain('<meta name="color-scheme" content="light dark" />')
    for (const [, id] of text.matchAll(/<input\b[^>]*\sid="([^"]+)"/g)) {
      expect(text).toContain(`<label for="${id}">`)
    }
    for (const [, attrs, inner] of text.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
      expect(inner!.trim().length > 0 || /aria-label=/.test(attrs!)).toBe(true)
    }
    if (page !== 'signin') {
      expect(text).toContain('<h1>')
      expect(text).toContain('<main>')
    }
  })

  test('the pairing page has the two fields the design names, in focus order', async () => {
    const text = await html('pairing')
    expect(text).toContain('<label for="server-url">Website address</label>')
    expect(text).toContain('<label for="code">Pairing code</label>')
    expect(text.indexOf('server-url')).toBeLessThan(text.indexOf('id="code"'))
    expect(text.indexOf('id="code"')).toBeLessThan(text.indexOf('id="pair"'))
    expect(text).toContain('role="alert"')
  })

  test('the settings page has the summaries folder and the three whisper fields', async () => {
    const text = await html('settings')
    for (const label of ['Summaries folder', 'Whisper command', 'Whisper folder', 'Whisper model']) {
      expect(text).toContain(`>${label}</label>`)
    }
    expect(text).not.toMatch(/server/i)
  })

  test('the sign-in page is a toolbar with one Done button and no address', async () => {
    const text = await html('signin')
    expect([...text.matchAll(/<button\b/g)]).toHaveLength(1)
    expect(text).toContain('>Done</button>')
    expect(text).not.toMatch(/127\.0\.0\.1|vnc/i)
  })

  test('the stylesheet is layout only and follows the system colour scheme', async () => {
    const css = await readFile(join(root, 'src/renderer/ui.css'), 'utf8')
    expect(css).toContain('color-scheme: light dark')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|url\(|@import/i)
  })
})

function decodePng(file: Buffer): { width: number; height: number; rgba: Buffer } {
  expect([...file.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const width = file.readUInt32BE(16)
  const height = file.readUInt32BE(20)
  expect(file[24]).toBe(8)
  expect(file[25]).toBe(6)
  const idat: Buffer[] = []
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at)
    if (file.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(file.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const rows = inflateSync(Buffer.concat(idat))
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width * 4 + 1)]).toBe(0) // filter: none
    rows.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))
  }
  return { width, height, rgba }
}

describe('icons', () => {
  test.each([
    ['tray-white.png', 16, 255],
    ['tray-white@2x.png', 32, 255],
    ['tray-black.png', 16, 0],
    ['tray-black@2x.png', 32, 0]
  ])('%s is a single-colour glyph on a transparent background', async (name, size, tone) => {
    const { width, height, rgba } = decodePng(Buffer.from(await readFile(join(root, 'assets', name))))
    expect([width, height]).toEqual([size, size])
    let ink = 0
    let clear = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) clear++
      else {
        ink++
        expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([tone, tone, tone])
      }
    }
    expect(ink).toBeGreaterThan(size)
    expect(clear).toBeGreaterThan(size)
  })

  test('icon.ico holds PNG images of 16, 32, 48 and 256 pixels', async () => {
    const ico = Buffer.from(await readFile(join(root, 'assets/icon.ico')))
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 4])
    const sizes: number[] = []
    for (let i = 0; i < 4; i++) {
      const entry = 6 + i * 16
      const declared = ico[entry] === 0 ? 256 : ico[entry]!
      const image = ico.subarray(
        ico.readUInt32LE(entry + 12),
        ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8)
      )
      const { width, height } = decodePng(image)
      expect([width, height]).toEqual([declared, declared])
      sizes.push(declared)
    }
    expect(sizes).toEqual([16, 32, 48, 256])
  })
})

describe('installer settings', () => {
  test('Electron fuses close the ways to run the app as something else', async () => {
    const pkg = await Bun.file(join(root, 'package.json')).json()
    expect(pkg.build.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    })
    expect(pkg.build.electronFuses.grantFileProtocolExtraPrivileges).toBeUndefined()
    expect(pkg.build.asar).toBe(true)
  })

  test('the installer ships the build output and the icons, and uses the icon file', async () => {
    const pkg = await Bun.file(join(root, 'package.json')).json()
    expect(pkg.build.files).toEqual(['dist/**', 'assets/**'])
    expect(pkg.build.win.icon).toBe('assets/icon.ico')
    expect(await Bun.file(join(root, pkg.build.win.icon)).exists()).toBe(true)
  })
})
