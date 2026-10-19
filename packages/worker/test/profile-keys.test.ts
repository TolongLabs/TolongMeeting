import { afterEach, beforeEach, expect, test } from 'bun:test'
import { hkdfSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveProfileKey, hostnameFor, machineIdFor, readMasterKey } from '../src/profile/keys'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-keys-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('derived keys are 32 bytes, stable and per identity', () => {
  const m = Buffer.alloc(32, 7)
  expect(deriveProfileKey(m, 'a').length).toBe(32)
  expect(deriveProfileKey(m, 'a').equals(deriveProfileKey(m, 'a'))).toBe(true)
  expect(deriveProfileKey(m, 'a').equals(deriveProfileKey(m, 'b'))).toBe(false)
  expect(machineIdFor('a')).toMatch(/^[0-9a-f]{32}$/)
  expect(hostnameFor('university-identity-123456')).toBe('tm-university-identity-')
})

test('derived key uses the tolongmeeting/v1 salt shared with core profileKey', () => {
  const m = randomBytes(32)
  const expected = Buffer.from(hkdfSync('sha256', m, 'tolongmeeting/v1', 'profile:id-9', 32))
  expect(deriveProfileKey(m, 'id-9').equals(expected)).toBe(true)
})

test('master key file must hold 32 bytes of base64', async () => {
  const good = join(dir, 'good')
  await writeFile(good, `${randomBytes(32).toString('base64')}\n`)
  expect((await readMasterKey(good)).length).toBe(32)

  const short = join(dir, 'short')
  await writeFile(short, randomBytes(31).toString('base64'))
  await expect(readMasterKey(short)).rejects.toThrow('TM_MASTER_KEY_FILE must hold 32 bytes, base64')

  const notBase64 = join(dir, 'raw')
  await writeFile(notBase64, 'not base64 at all!')
  await expect(readMasterKey(notBase64)).rejects.toThrow('TM_MASTER_KEY_FILE must hold 32 bytes, base64')
})
