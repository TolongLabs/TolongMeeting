import { afterEach, beforeEach, expect, test } from 'bun:test'
import { profileKey } from '@tm/core'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfileKey } from '../src/profile/key'
import { deriveProfileKey } from '../src/profile/keys'

let dir: string
const saved = { profile: process.env.TM_PROFILE_KEY_FILE, master: process.env.TM_MASTER_KEY_FILE }

function restore(name: 'TM_PROFILE_KEY_FILE' | 'TM_MASTER_KEY_FILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-profile-key-'))
  delete process.env.TM_PROFILE_KEY_FILE
  delete process.env.TM_MASTER_KEY_FILE
})

afterEach(async () => {
  restore('TM_PROFILE_KEY_FILE', saved.profile)
  restore('TM_MASTER_KEY_FILE', saved.master)
  await rm(dir, { recursive: true, force: true })
})

test('loadProfileKey prefers TM_PROFILE_KEY_FILE over deriving from the master key', async () => {
  const key = Buffer.alloc(32, 7)
  const f = join(dir, 'profile.key')
  await writeFile(f, key.toString('base64'))
  process.env.TM_PROFILE_KEY_FILE = f
  const m = join(dir, 'master.key')
  await writeFile(m, Buffer.alloc(32).toString('base64'))
  process.env.TM_MASTER_KEY_FILE = m
  expect(loadProfileKey('i1').equals(key)).toBe(true)
  delete process.env.TM_PROFILE_KEY_FILE
  expect(loadProfileKey('i1').equals(profileKey(Buffer.alloc(32), 'i1'))).toBe(true)
})

test('the worker derives the same key as core profileKey (pinned vector)', () => {
  const id = '00000000-0000-0000-0000-000000000001'
  const expected = 'e2ca8b1047006e313ae1b906af0d4ee3bfc7aadd6de5804f6c613baa3051f7c7'
  expect(deriveProfileKey(Buffer.alloc(32), id).toString('hex')).toBe(expected)
  expect(profileKey(Buffer.alloc(32), id).toString('hex')).toBe(expected)
})

test('a key file that is not 32 bytes of base64 is refused without echoing it', async () => {
  const f = join(dir, 'short.key')
  await writeFile(f, 'c2hvcnQ=')
  process.env.TM_PROFILE_KEY_FILE = f
  expect(() => loadProfileKey('i1')).toThrow('TM_PROFILE_KEY_FILE must hold 32 bytes, base64')
  delete process.env.TM_PROFILE_KEY_FILE
  process.env.TM_MASTER_KEY_FILE = f
  expect(() => loadProfileKey('i1')).toThrow('TM_MASTER_KEY_FILE must hold 32 bytes, base64')
  try {
    loadProfileKey('i1')
  } catch (e) {
    expect(String(e)).not.toContain('c2hvcnQ')
  }
})

test('with neither variable set loadProfileKey throws', () => {
  expect(() => loadProfileKey('i1')).toThrow('Set TM_PROFILE_KEY_FILE or TM_MASTER_KEY_FILE')
})
