import { afterAll, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanionApi } from '../src/api'
import { showSummaryNotification, syncSummaries, windowsSafeFileName } from '../src/summaries'
import { StateStore } from '../src/state'

const dirs: string[] = []
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-summaries-'))
  dirs.push(dir)
  return dir
}
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

interface ServerSummary {
  occurrenceId: string
  fileName: string
  readyAt: string
  text: string
}

/** A fake `fetch` that answers the two summary routes the way the website does (strictly after, 50 per page). */
function serverFetch(items: ServerSummary[]): typeof fetch {
  const sorted = [...items].sort((a, b) => a.readyAt.localeCompare(b.readyAt))
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url)
      if (url.pathname === '/api/companion/summaries') {
        const after = Date.parse(url.searchParams.get('after') ?? '')
        const page = sorted.filter((s) => Date.parse(s.readyAt) > after).slice(0, 50)
        return Response.json({
          summaries: page.map(({ occurrenceId, fileName, readyAt }) => ({ occurrenceId, fileName, readyAt }))
        })
      }
      const found = sorted.find((s) => url.pathname === `/api/companion/summaries/${s.occurrenceId}`)
      if (!found) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
      return new Response(found.text, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    },
    { preconnect: () => {} }
  )
}

const apiFor = (items: ServerSummary[]) =>
  new CompanionApi({
    serverUrl: 'https://tm.example',
    token: async () => 'tmd_test',
    onRevoked: () => {},
    fetch: serverFetch(items)
  })

const START = '2026-10-21T00:00:00.000Z'

/** A state file in `base` (kept apart from the summaries folder), starting at `after`. */
async function stateIn(base: string, after: string | null = START): Promise<StateStore> {
  const file = join(base, 'state.json')
  await writeFile(file, JSON.stringify({ summariesAfter: after }))
  return new StateStore(file)
}

describe('windowsSafeFileName', () => {
  test('replaces characters Windows forbids and control characters', () => {
    expect(windowsSafeFileName('2026-10-21 1400 CS6013: AI/ML?.md')).toBe('2026-10-21 1400 CS6013- AI-ML-.md')
    expect(windowsSafeFileName('a<b>c"d|e*f\\g\u0007h.md')).toBe('a-b-c-d-e-f-g-h.md')
  })

  test('trims trailing dots and spaces from the stem', () => {
    expect(windowsSafeFileName('2026-10-21 1400 Week 3. .md')).toBe('2026-10-21 1400 Week 3.md')
    expect(windowsSafeFileName('Ends with space .md')).toBe('Ends with space.md')
  })

  test('prefixes reserved device names, with or without an extension, in any case', () => {
    for (const device of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'nul', 'Com3', 'COM\u00B9']) {
      expect(windowsSafeFileName(`${device}.md`)).toBe(`_${device}.md`)
      expect(windowsSafeFileName(device)).toBe(`_${device}`)
    }
    expect(windowsSafeFileName('NUL .md')).toBe('_NUL.md')
    expect(windowsSafeFileName('CON.tar.gz')).toBe('_CON.tar.gz')
  })

  test('leaves names that only start like a device name alone', () => {
    expect(windowsSafeFileName('CONSOLE.md')).toBe('CONSOLE.md')
    expect(windowsSafeFileName('COM10.md')).toBe('COM10.md')
    expect(windowsSafeFileName('LPT0.md')).toBe('LPT0.md')
    expect(windowsSafeFileName('NUL-x.md')).toBe('NUL-x.md')
  })

  test('never keeps a path separator or a dot run', () => {
    expect(windowsSafeFileName('../../escape.md')).toBe('----escape.md')
    expect(windowsSafeFileName('/etc/passwd')).toBe('-etc-passwd')
    expect(windowsSafeFileName('C:\\Windows\\win.ini')).toBe('C--Windows-win.ini')
  })

  test('falls back to Summary when nothing is left of the stem', () => {
    expect(windowsSafeFileName('   .md')).toBe('Summary.md')
  })

  test('caps the length at 200 and keeps the extension', () => {
    const out = windowsSafeFileName(`2026-10-21 1400 ${'x'.repeat(300)}.md`)
    expect(out.length).toBe(200)
    expect(out.endsWith('.md')).toBe(true)
  })

  test('never cuts a surrogate pair in half', () => {
    const out = windowsSafeFileName(`${'\u{1F600}'.repeat(250)}.md`)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('.md')).toBe(true)
    expect([...out].every((c) => !/^[\uD800-\uDFFF]$/.test(c))).toBe(true)
  })
})

describe('syncSummaries', () => {
  test('saves new summaries under safe names, in order, and advances the stored time', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const state = await stateIn(base)
    const api = apiFor([
      { occurrenceId: 'occ-a', fileName: '2026-10-20 0900 Old.md', readyAt: '2026-10-21T01:00:00.000Z', text: 'old' },
      {
        occurrenceId: 'occ-b',
        fileName: '2026-10-21 1400 CS6013: AI.md',
        readyAt: '2026-10-21T08:00:00.000Z',
        text: 'Do next: read ch. 3'
      }
    ])
    const written = await syncSummaries({ api, dir, state })
    const root = await realpath(dir)
    expect(written).toEqual([join(root, '2026-10-20 0900 Old.md'), join(root, '2026-10-21 1400 CS6013- AI.md')])
    expect(await readFile(join(dir, '2026-10-21 1400 CS6013- AI.md'), 'utf8')).toBe('Do next: read ch. 3')
    expect(state.get().summariesAfter).toBe('2026-10-21T08:00:00.000Z')
  })

  test('never overwrites a file the member already has', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    await mkdir(dir)
    await writeFile(join(dir, '2026-10-20 0900 Old.md'), 'my edits')
    const api = apiFor([
      { occurrenceId: 'occ-a', fileName: '2026-10-20 0900 Old.md', readyAt: '2026-10-21T01:00:00.000Z', text: 'server' }
    ])
    const state = await stateIn(base)
    expect(await syncSummaries({ api, dir, state })).toEqual([])
    expect(await readFile(join(dir, '2026-10-20 0900 Old.md'), 'utf8')).toBe('my edits')
    expect(state.get().summariesAfter).toBe('2026-10-21T01:00:00.000Z')
  })

  test('a repeat download writes nothing new and leaves the saved file as it was', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const api = apiFor([
      {
        occurrenceId: 'occ-b',
        fileName: '2026-10-21 1400 Data Mining.md',
        readyAt: '2026-10-21T08:00:00.000Z',
        text: 'one'
      }
    ])
    expect(await syncSummaries({ api, dir, state: await stateIn(base) })).toHaveLength(1)
    // The stored time is lost (for example, the state file was reset): the same summary comes again.
    expect(await syncSummaries({ api, dir, state: await stateIn(base) })).toEqual([])
    expect(await readdir(dir)).toEqual(['2026-10-21 1400 Data Mining.md'])
    expect(await readFile(join(dir, '2026-10-21 1400 Data Mining.md'), 'utf8')).toBe('one')
  })

  test('a symlinked target is refused: nothing is written through it', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    await mkdir(dir)
    const outside = join(base, 'outside.txt')
    await writeFile(outside, 'keep me')
    await symlink(outside, join(dir, '2026-10-21 1400 Link.md'))
    const api = apiFor([
      { occurrenceId: 'occ-c', fileName: '2026-10-21 1400 Link.md', readyAt: '2026-10-21T08:00:00.000Z', text: 'evil' }
    ])
    const state = await stateIn(base)
    expect(await syncSummaries({ api, dir, state })).toEqual([])
    expect(await readFile(outside, 'utf8')).toBe('keep me')
    expect((await lstat(join(dir, '2026-10-21 1400 Link.md'))).isSymbolicLink()).toBe(true)
    expect(state.get().summariesAfter).toBe('2026-10-21T08:00:00.000Z')
  })

  test('a server name with .. or an absolute path lands only inside the folder', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const api = apiFor([
      { occurrenceId: 'occ-d', fileName: '../../escape.md', readyAt: '2026-10-21T01:00:00.000Z', text: 'x' },
      { occurrenceId: 'occ-e', fileName: '/abs/path.md', readyAt: '2026-10-21T02:00:00.000Z', text: 'y' },
      { occurrenceId: 'occ-f', fileName: 'C:\\Users\\m\\win.md', readyAt: '2026-10-21T03:00:00.000Z', text: 'z' }
    ])
    const written = await syncSummaries({ api, dir, state: await stateIn(base) })
    expect(written).toHaveLength(3)
    const root = await realpath(dir)
    for (const path of written) expect(join(path, '..')).toBe(root)
    expect((await readdir(base)).sort()).toEqual(['Meeting summaries', 'state.json'])
  })

  test('pages through more than one server page', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const items = Array.from({ length: 120 }, (_, i) => ({
      occurrenceId: `occ-${i}`,
      fileName: `2026-10-21 0900 Lecture ${i}.md`,
      readyAt: new Date(Date.UTC(2026, 9, 21, 9) + i * 60_000).toISOString(),
      text: `summary ${i}`
    }))
    const state = await stateIn(base)
    const written = await syncSummaries({ api: apiFor(items), dir, state })
    expect(written).toHaveLength(120)
    expect(state.get().summariesAfter).toBe(items[119]!.readyAt)
  })

  test('refuses to start without a stored time', async () => {
    const base = await tmpDir()
    await expect(
      syncSummaries({ api: apiFor([]), dir: join(base, 's'), state: await stateIn(base, null) })
    ).rejects.toThrow('pair it again')
  })
})

describe('showSummaryNotification', () => {
  test('shows the notification without opening anything; a click opens the file', () => {
    const opened: string[] = []
    const shown: { title: string; body: string }[] = []
    let click = () => {}
    const d = {
      notifier: {
        show: (n: { title: string; body: string }, on: { click(): void }) => {
          shown.push(n)
          click = on.click
        }
      },
      openPath: async (p: string) => (opened.push(p), ''),
      exists: () => true
    }
    showSummaryNotification('C:\\S\\2026-10-21 1400 Data Mining.md', 'C:\\S', d)
    expect(opened).toEqual([])
    expect(shown[0]).toEqual(expect.objectContaining({ title: 'Summary ready', body: '2026-10-21 1400 Data Mining' }))
    click()
    expect(opened).toEqual(['C:\\S\\2026-10-21 1400 Data Mining.md'])
  })

  test('a click on a summary whose file was moved opens the folder', () => {
    const opened: string[] = []
    let click = () => {}
    showSummaryNotification('C:\\S\\gone.md', 'C:\\S', {
      notifier: {
        show: (_n, on) => {
          click = on.click
        }
      },
      openPath: async (p) => (opened.push(p), ''),
      exists: () => false
    })
    click()
    expect(opened).toEqual(['C:\\S'])
  })
})

describe('syncSummaries name clashes (N17)', () => {
  test('a different occurrence with the same name is saved as "<name> (2).md", never over the first', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const state = await stateIn(base)
    const name = '2026-10-21 1400 Data Mining.md'
    const api = apiFor([
      { occurrenceId: 'occ-a', fileName: name, readyAt: '2026-10-21T08:00:00.000Z', text: 'first' },
      { occurrenceId: 'occ-b', fileName: name, readyAt: '2026-10-21T08:00:30.000Z', text: 'second' },
      { occurrenceId: 'occ-c', fileName: name, readyAt: '2026-10-21T08:01:00.000Z', text: 'third' }
    ])
    const root = await realpath((await mkdir(dir, { recursive: true }), dir))
    expect(await syncSummaries({ api, dir, state })).toEqual([
      join(root, name),
      join(root, '2026-10-21 1400 Data Mining (2).md'),
      join(root, '2026-10-21 1400 Data Mining (3).md')
    ])
    expect(await readFile(join(dir, name), 'utf8')).toBe('first')
    expect(await readFile(join(dir, '2026-10-21 1400 Data Mining (2).md'), 'utf8')).toBe('second')
    expect(state.get().summaryFiles).toEqual({
      'occ-a': join(root, name),
      'occ-b': join(root, '2026-10-21 1400 Data Mining (2).md'),
      'occ-c': join(root, '2026-10-21 1400 Data Mining (3).md')
    })
  })

  test('a repeat download of a numbered summary writes nothing', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const name = '2026-10-21 1400 Data Mining.md'
    const api = apiFor([
      { occurrenceId: 'occ-a', fileName: name, readyAt: '2026-10-21T08:00:00.000Z', text: 'first' },
      { occurrenceId: 'occ-b', fileName: name, readyAt: '2026-10-21T08:00:30.000Z', text: 'second' }
    ])
    const state = await stateIn(base)
    expect(await syncSummaries({ api, dir, state })).toHaveLength(2)
    await state.update({ summariesAfter: START })
    expect(await syncSummaries({ api, dir, state })).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['2026-10-21 1400 Data Mining (2).md', name])
  })

  test('the numbered name keeps the 200 unit limit and the extension', async () => {
    const base = await tmpDir()
    const dir = join(base, 'Meeting summaries')
    const long = `${'x'.repeat(197)}.md`
    const api = apiFor([
      { occurrenceId: 'occ-a', fileName: long, readyAt: '2026-10-21T08:00:00.000Z', text: 'a' },
      { occurrenceId: 'occ-b', fileName: long, readyAt: '2026-10-21T08:00:30.000Z', text: 'b' }
    ])
    const written = await syncSummaries({ api, dir, state: await stateIn(base) })
    const second = written[1]!.slice(written[1]!.lastIndexOf('/') + 1)
    expect(second.length).toBe(200)
    expect(second.endsWith(' (2).md')).toBe(true)
  })
})
