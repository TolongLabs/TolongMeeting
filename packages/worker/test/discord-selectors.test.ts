import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadSelectors } from '../src/adapters/selectors'
import { DiscordSelectorsSchema } from '../src/watchers/selectors'

const shipped = resolve(import.meta.dir, '../../../config/selectors')
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-discord-selectors-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('the shipped Discord map loads', async () => {
  const map = await loadSelectors('discord', DiscordSelectorsSchema, shipped)
  expect(map.message).toBe('li[id^="chat-messages-"]')
})

test('a map that lacks a key fails and names the key', async () => {
  const { time: _time, ...rest } = JSON.parse(await readFile(join(shipped, 'discord.json'), 'utf8'))
  await writeFile(join(dir, 'discord.json'), JSON.stringify(rest))
  const load = loadSelectors('discord', DiscordSelectorsSchema, dir)
  await expect(load).rejects.toThrow('is invalid')
  await expect(load).rejects.toThrow('time')
})

test('a key the reader does not use fails too', async () => {
  const map = JSON.parse(await readFile(join(shipped, 'discord.json'), 'utf8'))
  await writeFile(join(dir, 'discord.json'), JSON.stringify({ ...map, sendButton: 'button' }))
  await expect(loadSelectors('discord', DiscordSelectorsSchema, dir)).rejects.toThrow('sendButton')
})
