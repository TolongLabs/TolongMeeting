import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { meetSelectors } from '../src/adapters/meet/selectors'

const SHIPPED = resolve(import.meta.dir, '../../../config/selectors')

const originalDir = process.env.TM_SELECTORS_DIR
beforeAll(() => {
  process.env.TM_SELECTORS_DIR = SHIPPED
})
afterAll(() => {
  if (originalDir === undefined) delete process.env.TM_SELECTORS_DIR
  else process.env.TM_SELECTORS_DIR = originalDir
})

// Writes a copy of the shipped meet.json, edited by `edit`, into a fresh directory.
type RawMap = { selectors: Record<string, unknown>; texts: Record<string, unknown> }

async function mapDir(edit: (map: RawMap) => void): Promise<string> {
  const map: RawMap = JSON.parse(await readFile(join(SHIPPED, 'meet.json'), 'utf8'))
  edit(map)
  const dir = await mkdtemp(join(tmpdir(), 'meet-sel-'))
  await writeFile(join(dir, 'meet.json'), JSON.stringify(map))
  return dir
}

test('the shipped meet.json loads with every key the adapter reads', async () => {
  const sel = await meetSelectors()
  expect(sel.joinButtons).toEqual(['Join now', 'Join here too', 'Ask to join'])
  expect(sel.noticeAllowlist).toEqual(['Got it', 'OK', 'Dismiss'])
  expect(sel.selectors.leaveButton).toBe("[aria-label='Leave call']")
  expect(sel.signInHosts).toContain('accounts.google.com')
  expect(new RegExp(sel.texts.blocked, 'i').test('You can’t join this video call')).toBe(true)
  expect(new RegExp(sel.texts.blocked, 'i').test("You can't join this video call")).toBe(true)
  expect(sel.texts.noticeDanger.map((danger) => danger.name)).toContain('allow')
})

test('a missing key fails loudly and names the key', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => delete map.selectors.leaveButton)
  await expect(meetSelectors()).rejects.toThrow(/leaveButton/)
})

test('a key the schema does not know fails loudly and names it', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.selectors.leaveButtn = '#typo'))
  await expect(meetSelectors()).rejects.toThrow(/leaveButtn/)
})

test('an invalid regular expression fails at load and names the text', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.texts.blocked = '([unclosed'))
  await expect(meetSelectors()).rejects.toThrow(/blocked/)
})

test('an invalid regular expression in a notice danger pattern fails at load', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.texts.noticeDanger = [{ name: 'join', source: '([bad' }]))
  await expect(meetSelectors()).rejects.toThrow(/noticeDanger/)
})

test('a changed TM_SELECTORS_DIR is picked up on the next call', async () => {
  process.env.TM_SELECTORS_DIR = SHIPPED
  expect((await meetSelectors()).selectors.leaveButton).toBe("[aria-label='Leave call']")
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.selectors.leaveButton = "[aria-label='Other']"))
  expect((await meetSelectors()).selectors.leaveButton).toBe("[aria-label='Other']")
})
