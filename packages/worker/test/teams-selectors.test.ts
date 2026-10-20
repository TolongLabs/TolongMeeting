import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { teamsSelectors } from '../src/adapters/teams/selectors'

const SHIPPED = resolve(import.meta.dir, '../../../config/selectors')

const made: string[] = []
const originalDir = process.env.TM_SELECTORS_DIR
beforeAll(() => {
  process.env.TM_SELECTORS_DIR = SHIPPED
})
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
  if (originalDir === undefined) delete process.env.TM_SELECTORS_DIR
  else process.env.TM_SELECTORS_DIR = originalDir
})

// Writes a copy of the shipped teams.json, edited by `edit`, into a fresh directory.
type RawMap = { selectors: Record<string, string>; texts: Record<string, string>; noticeDanger: unknown }

async function mapDir(edit: (map: RawMap) => void): Promise<string> {
  const map: RawMap = JSON.parse(await readFile(join(SHIPPED, 'teams.json'), 'utf8'))
  edit(map)
  const dir = await mkdtemp(join(tmpdir(), 'teams-sel-'))
  made.push(dir)
  await writeFile(join(dir, 'teams.json'), JSON.stringify(map))
  return dir
}

test('the shipped teams.json loads with every key the adapter reads', async () => {
  const sel = await teamsSelectors()
  expect(sel.noticeAllowlist).toEqual(['Got it', 'OK', 'Dismiss'])
  expect(sel.selectors.hangupButton).toBe('#hangup-button')
  expect(sel.signInHosts).toContain('login.microsoftonline.com')
  expect(new RegExp(sel.texts.removed, 'i').test("You've been removed from this meeting")).toBe(true)
})

test('a missing key fails loudly and names the key', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => delete map.selectors.hangupButton)
  await expect(teamsSelectors()).rejects.toThrow(/hangupButton/)
})

test('a key the schema does not know fails loudly and names it', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.selectors.hangupButtn = '#typo'))
  await expect(teamsSelectors()).rejects.toThrow(/hangupButtn/)
})

test('an invalid regular expression fails at load and names the text', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.texts.removed = '([unclosed'))
  await expect(teamsSelectors()).rejects.toThrow(/removed/)
})

test('a notice danger pattern that is not a regular expression fails at load', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.noticeDanger = [{ name: 'join', source: '([bad' }]))
  await expect(teamsSelectors()).rejects.toThrow(/noticeDanger/)
})

test('a notice danger item with a key the schema does not know fails at load', async () => {
  process.env.TM_SELECTORS_DIR = await mapDir(
    (map) => (map.noticeDanger = [{ name: 'join', source: '\\bjoin\\b', sourse: 'typo' }])
  )
  await expect(teamsSelectors()).rejects.toThrow(/sourse/)
})

test('a changed TM_SELECTORS_DIR is picked up on the next call', async () => {
  process.env.TM_SELECTORS_DIR = SHIPPED
  expect((await teamsSelectors()).selectors.hangupButton).toBe('#hangup-button')
  process.env.TM_SELECTORS_DIR = await mapDir((map) => (map.selectors.hangupButton = '#other-hangup'))
  expect((await teamsSelectors()).selectors.hangupButton).toBe('#other-hangup')
})
