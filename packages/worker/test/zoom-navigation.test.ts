import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright'
import { loadSelectors, ZoomSelectorsSchema, zoomAdapter } from '../src/adapters'
import { MAX_CONSECUTIVE_RACES, navigationGuard } from '../src/adapters/zoom/root'
import { zoomJoin } from '../src/adapters/zoom/join'

const SELECTORS_DIR = resolve(import.meta.dir, '../../../config/selectors')
const RACE = 'page.evaluate: Execution context was destroyed, most likely because of a navigation'

const originalDir = process.env.TM_SELECTORS_DIR
beforeAll(() => {
  process.env.TM_SELECTORS_DIR = SELECTORS_DIR
})
afterAll(() => {
  if (originalDir === undefined) delete process.env.TM_SELECTORS_DIR
  else process.env.TM_SELECTORS_DIR = originalDir
})

let info: ReturnType<typeof spyOn<Console, 'info'>> | null = null
afterEach(() => info?.mockRestore())

function quietLog() {
  info = spyOn(console, 'info').mockImplementation(() => {})
  return info
}

test('a navigation race is swallowed and logged, then the step succeeds', async () => {
  const log = quietLog()
  const guard = navigationGuard('probe')
  let calls = 0
  const step = async () => {
    calls += 1
    if (calls <= 2) throw new Error(RACE)
    return 'done'
  }
  expect(await guard.run(step)).toBeUndefined()
  expect(await guard.run(step)).toBeUndefined()
  expect(await guard.run(step)).toBe('done')
  expect(guard.lastRace).toBe(RACE)
  const lines = log.mock.calls.map((c) => String(c[0]))
  expect(lines).toEqual([
    'zoom: navigation race in probe (context-destroyed), 1 in a row',
    'zoom: navigation race in probe (context-destroyed), 2 in a row'
  ])
})

test('races in a row past the limit rethrow the original error', async () => {
  quietLog()
  const guard = navigationGuard('probe')
  const original = new Error(RACE)
  const step = async () => {
    throw original
  }
  for (let i = 0; i < MAX_CONSECUTIVE_RACES; i++) expect(await guard.run(step)).toBeUndefined()
  await expect(guard.run(step)).rejects.toBe(original)
})

test('a step that succeeds resets the count', async () => {
  quietLog()
  const guard = navigationGuard('probe')
  const race = async () => {
    throw new Error(RACE)
  }
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < MAX_CONSECUTIVE_RACES; i++) expect(await guard.run(race)).toBeUndefined()
    expect(await guard.run(async () => 'ok')).toBe('ok')
  }
})

test('an error that is not a navigation race is thrown at once', async () => {
  const log = quietLog()
  const guard = navigationGuard('probe')
  const other = new Error('Element is not attached to the DOM')
  await expect(
    guard.run(async () => {
      throw other
    })
  ).rejects.toBe(other)
  expect(log).not.toHaveBeenCalled()
})

// A stand-in for Playwright's Page whose root lookup fails the way a replaced page does.
function racingPage(failures: number): Page {
  let calls = 0
  const quiet = {
    filter: () => quiet,
    first: () => quiet,
    isVisible: async () => false,
    innerText: async () => ''
  }
  const frame = { locator: () => quiet }
  return {
    locator: () => ({
      elementHandles: async () => {
        calls += 1
        if (calls <= failures) throw new Error(RACE)
        return []
      }
    }),
    mainFrame: () => frame,
    url: () => 'http://localhost/wc/join/1'
  } as unknown as Page
}

test('join rethrows a page that never stops navigating instead of timing out', async () => {
  quietLog()
  await expect(zoomAdapter.join(racingPage(Infinity), { guestName: 'G' })).rejects.toThrow(
    'Execution context was destroyed'
  )
})

test('the join timeout names the last navigation race', async () => {
  quietLog()
  const result = await zoomJoin(racingPage(2), { guestName: 'G', timeoutMs: 1_800 })
  expect(result).toEqual({ kind: 'failed', reason: `prejoin_timeout (last navigation race: ${RACE})` })
})

async function selectorsIn(files: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-selectors-'))
  await mkdir(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body)
  process.env.TM_SELECTORS_DIR = dir
}

test('a regular expression that does not compile fails when the selector map loads', async () => {
  const map = JSON.parse(await readFile(join(SELECTORS_DIR, 'zoom.json'), 'utf8'))
  map.texts.lobby = 'host will (let you in'
  await selectorsIn({ 'zoom.json': JSON.stringify(map) })
  await expect(loadSelectors('zoom', ZoomSelectorsSchema)).rejects.toThrow(/zoom\.json is invalid[\s\S]*lobby/)
})

test('a notice danger pattern that does not compile fails when the selector map loads', async () => {
  const map = JSON.parse(await readFile(join(SELECTORS_DIR, 'zoom.json'), 'utf8'))
  map.texts.noticeDanger[1].source = 'start (my video'
  await selectorsIn({ 'zoom.json': JSON.stringify(map) })
  await expect(loadSelectors('zoom', ZoomSelectorsSchema)).rejects.toThrow(/zoom\.json is invalid[\s\S]*noticeDanger/)
})

test('a selector map that is not JSON names its file', async () => {
  await selectorsIn({ 'zoom.json': '{ "rootIframe": ' })
  await expect(loadSelectors('zoom', ZoomSelectorsSchema)).rejects.toThrow(/zoom\.json is not valid JSON/)
})

test('the shipped selector map loads', async () => {
  process.env.TM_SELECTORS_DIR = SELECTORS_DIR
  expect((await loadSelectors('zoom', ZoomSelectorsSchema)).rootIframe).toBe('iframe#webclient')
})
