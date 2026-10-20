import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { loadSelectors, pattern, selector } from '../src/adapters/selectors'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-selectors-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const Schema = z
  .object({
    selectors: z.object({ joinButton: selector, leaveButton: selector }).strict(),
    texts: z.object({ lobby: pattern }).strict()
  })
  .strict()

test('a map that lacks a key fails and names the key', async () => {
  await writeFile(
    join(dir, 'example.json'),
    JSON.stringify({ selectors: { joinButton: 'button' }, texts: { lobby: 'waiting' } })
  )
  const load = loadSelectors('example', Schema, dir)
  await expect(load).rejects.toThrow('is invalid')
  await expect(load).rejects.toThrow('leaveButton')
})

test('a regex text that does not compile fails at load', async () => {
  await writeFile(
    join(dir, 'example.json'),
    JSON.stringify({
      selectors: { joinButton: 'button', leaveButton: 'a' },
      texts: { lobby: '(unclosed' }
    })
  )
  await expect(loadSelectors('example', Schema, dir)).rejects.toThrow('is invalid')
})

test('a valid map loads and returns the parsed selectors', async () => {
  const map = {
    selectors: { joinButton: 'button', leaveButton: 'a' },
    texts: { lobby: '^waiting' }
  }
  await writeFile(join(dir, 'example.json'), JSON.stringify(map))
  expect(await loadSelectors('example', Schema, dir)).toEqual(map)
})
