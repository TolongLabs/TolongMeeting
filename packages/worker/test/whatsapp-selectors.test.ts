import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadSelectors } from '../src/adapters/selectors'
import { WhatsAppSelectorsSchema } from '../src/watchers/selectors'

const shipped = resolve(import.meta.dir, '../../../config/selectors')
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-whatsapp-selectors-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('the shipped WhatsApp map loads', async () => {
  const map = await loadSelectors('whatsapp', WhatsAppSelectorsSchema, shipped)
  expect(map.prePlain).toBe('.copyable-text[data-pre-plain-text]')
})

test('a map that lacks a key fails and names the key', async () => {
  const { headerTitle: _headerTitle, ...rest } = JSON.parse(await readFile(join(shipped, 'whatsapp.json'), 'utf8'))
  await writeFile(join(dir, 'whatsapp.json'), JSON.stringify(rest))
  const load = loadSelectors('whatsapp', WhatsAppSelectorsSchema, dir)
  await expect(load).rejects.toThrow('is invalid')
  await expect(load).rejects.toThrow('headerTitle')
})

test('a key the reader does not use fails too', async () => {
  const map = JSON.parse(await readFile(join(shipped, 'whatsapp.json'), 'utf8'))
  await writeFile(join(dir, 'whatsapp.json'), JSON.stringify({ ...map, sendButton: 'button' }))
  await expect(loadSelectors('whatsapp', WhatsAppSelectorsSchema, dir)).rejects.toThrow('sendButton')
})
