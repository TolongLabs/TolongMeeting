import { expect, test } from 'bun:test'
import { memberKey, openSecret, profileKey, SecretError, sealSecret } from '@tm/core'

const master = Buffer.alloc(32)
const id = '00000000-0000-0000-0000-000000000001'

// First character of the base64url tag (the last dot-separated part), changed to another valid character.
function flipFirstTagChar(sealed: string): string {
  const cut = sealed.lastIndexOf('.') + 1
  return sealed.slice(0, cut) + (sealed[cut] === 'A' ? 'B' : 'A') + sealed.slice(cut + 1)
}

test('keys are HKDF-SHA256 of the master key', () => {
  expect(profileKey(master, id).toString('hex')).toBe(
    'e2ca8b1047006e313ae1b906af0d4ee3bfc7aadd6de5804f6c613baa3051f7c7'
  )
  expect(memberKey(master, id).toString('hex')).toBe('a346d0e1646a9feab8a63dbc7a2592db49d0c456080a22a7bae8ae5cb3b903ad')
})

test('a master key that is not 32 bytes is refused', () => {
  expect(() => memberKey(Buffer.alloc(31), id)).toThrow(SecretError)
})

test('sealed secrets round-trip and never repeat', () => {
  const k = memberKey(master, id)
  const aad = `ai_keys.dashscope_key:${id}`
  const a = sealSecret(k, 'sk-test', aad)
  expect(a).toMatch(/^v1\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/)
  expect(a).not.toContain('sk-test')
  expect(sealSecret(k, 'sk-test', aad)).not.toBe(a)
  expect(openSecret(k, a, aad)).toBe('sk-test')
})

test('an empty and a non-ASCII secret round-trip', () => {
  const k = memberKey(master, id)
  expect(openSecret(k, sealSecret(k, '', 'x'), 'x')).toBe('')
  expect(openSecret(k, sealSecret(k, 'pässwörd-日本', 'x'), 'x')).toBe('pässwörd-日本')
})

test('a wrong key, a wrong AAD or a changed byte throws SecretError', () => {
  const k = memberKey(master, id)
  const a = sealSecret(k, 'sk-test', 'x')
  expect(() => openSecret(k, a, 'y')).toThrow(SecretError)
  expect(() => openSecret(profileKey(master, id), a, 'x')).toThrow(SecretError)
  expect(() => openSecret(k, flipFirstTagChar(a), 'x')).toThrow(SecretError)
})

test('plaintext and malformed input throw SecretError without echoing the input', () => {
  const k = memberKey(master, id)
  for (const bad of ['sk-test-plain', '', 'v1.a.b', 'v1.AAAA.AAAA.AAAA', 'v2.a.b.c']) {
    let message = ''
    try {
      openSecret(k, bad, 'x')
    } catch (e) {
      expect(e).toBeInstanceOf(SecretError)
      message = String(e)
    }
    expect(message).not.toBe('')
    if (bad.length > 8) expect(message).not.toContain(bad)
  }
})
