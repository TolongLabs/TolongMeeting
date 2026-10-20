import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEVICE_TOKEN_PREFIX, MAX_DEVICES_PER_MEMBER, PairResponseSchema } from '@tm/core'
import { deviceTokens, devicePairings, members, type Db } from '../db'
import { sealColumn } from '../db/secrets'
import { createTestDb, dropAllTestDbs, seedMember, TEST_MASTER } from '../db/testing'
import { ntfyConfigOf } from '../lib/companion/deps'
import {
  ATTEMPT_WINDOW_MS,
  AttemptLimiter,
  authenticateDevice,
  createPairingCode,
  DeviceLimitError,
  handlePairingCodeRequest,
  handlePairRequest,
  handleRevokeRequest,
  hashSecret,
  listDevices,
  MAX_CODES_PER_WINDOW,
  MAX_FAILURES_GLOBAL,
  MAX_FAILURES_PER_IP,
  MAX_FAILURES_PER_PREFIX,
  newDeviceToken,
  normalisePairingCode,
  NtfyNotSetUpError,
  redeemPairingCode,
  revokeDevice,
  TooManyCodesError,
  type PairDeps
} from '../lib/companion/tokens'
import { createScope, type MemberScope } from '../lib/scope'
import { expectNotLogged } from './no-log'

const t0 = new Date('2026-10-21T08:00:00Z')
const min = (n: number) => new Date(t0.getTime() + n * 60_000)
const NTFY_URL = 'https://ntfy.example'
const NTFY_TOKEN = 'tk_ntfy_secret_for_tests'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

const ntfyOf = (memberId: string) => ntfyConfigOf(db, TEST_MASTER, NTFY_URL, memberId)

/** A member with a ntfy topic and token, as `ensureNtfy` leaves them. */
async function member(withNtfy = true): Promise<{ scope: MemberScope; memberId: string; topic: string }> {
  const { memberId } = await seedMember(db, { full: false })
  const topic = `tm-${memberId.replaceAll('-', '').slice(0, 20)}`
  if (withNtfy)
    await db
      .update(members)
      .set({ ntfyTopic: topic, ntfyTokenEnc: sealColumn(TEST_MASTER, memberId, 'members.ntfy_token', NTFY_TOKEN) })
      .where(eq(members.id, memberId))
  return { scope: createScope(db, memberId), memberId, topic }
}

async function pair(scope: MemberScope, at: Date, deviceName = 'PC') {
  const { code } = await createPairingCode(scope, at)
  const res = await redeemPairingCode(db, { code, deviceName }, ntfyOf, at)
  if (!res) throw new Error('pairing failed')
  return res
}

describe('pairing codes', () => {
  test('a code works once, within 10 minutes, whatever the typing', async () => {
    const a = await member()
    const { code, expiresAt } = await createPairingCode(a.scope, t0)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    expect(expiresAt).toEqual(min(10))
    expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, min(11))).toBeNull()

    const { code: c2 } = await createPairingCode(a.scope, t0)
    const typed = c2.toLowerCase().replace('-', ' ').replaceAll('1', 'l').replaceAll('0', 'o')
    const res = await redeemPairingCode(db, { code: typed, deviceName: 'PC' }, ntfyOf, min(9))
    expect(res?.token).toStartWith(DEVICE_TOKEN_PREFIX)
    expect(res?.ntfy).toEqual({ url: NTFY_URL, topic: a.topic, token: NTFY_TOKEN })
    expect(res?.pairedAt).toBe(min(9).toISOString())
    expect(PairResponseSchema.safeParse(res).success).toBe(true)
  })

  test('a code that was used is refused the second time', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, min(1))).not.toBeNull()
    expect(await redeemPairingCode(db, { code, deviceName: 'Other PC' }, ntfyOf, min(1))).toBeNull()
    expect(await listDevices(a.scope)).toHaveLength(1)
  })

  test('two PCs that send the same code at once: one gets a token', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => redeemPairingCode(db, { code, deviceName: `PC ${i}` }, ntfyOf, min(1)))
    )
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(await listDevices(a.scope)).toHaveLength(1)
  })

  test('an expired code is refused, and so is one at the exact expiry instant', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, min(10))).toBeNull()
    expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, min(10.001))).toBeNull()
    expect(await listDevices(a.scope)).toEqual([])
  })

  test('a new code retires the earlier unused one', async () => {
    const a = await member()
    const { code: first } = await createPairingCode(a.scope, t0)
    const { code: second } = await createPairingCode(a.scope, min(1))
    expect(await redeemPairingCode(db, { code: first, deviceName: 'PC' }, ntfyOf, min(2))).toBeNull()
    expect(await redeemPairingCode(db, { code: second, deviceName: 'PC' }, ntfyOf, min(2))).not.toBeNull()
  })

  test('malformed codes and bad device names are refused without a token', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    for (const bad of ['', 'ABCD', 'ABCD-EFGH-J', "' OR 1=1 --", code.slice(0, 7)]) {
      expect(await redeemPairingCode(db, { code: bad, deviceName: 'PC' }, ntfyOf, min(1))).toBeNull()
    }
    for (const name of ['', '   ', 'x'.repeat(65), 'a\u0000b', 'a\nb']) {
      expect(await redeemPairingCode(db, { code, deviceName: name }, ntfyOf, min(1))).toBeNull()
    }
    // None of those used the code up.
    expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, min(1))).not.toBeNull()
  })

  test('only hashes are stored, for the code and for the token', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const res = (await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, t0))!
    const device = await db.query.deviceTokens.findFirst({ where: eq(deviceTokens.id, res.deviceId) })
    expect(device!.tokenHash).toBe(hashSecret(res.token))
    expect(JSON.stringify(device)).not.toContain(res.token)
    const pairing = await db.query.devicePairings.findFirst({ where: eq(devicePairings.memberId, a.memberId) })
    expect(pairing!.codeHash).toBe(hashSecret(normalisePairingCode(code)))
    expect(JSON.stringify(pairing)).not.toContain(normalisePairingCode(code))
    expect(pairing!.usedAt).toEqual(t0)
  })

  test('creating a code needs a ntfy topic, and is limited per member', async () => {
    const bare = await member(false)
    await expect(createPairingCode(bare.scope, t0)).rejects.toBeInstanceOf(NtfyNotSetUpError)

    const a = await member()
    for (let i = 0; i < MAX_CODES_PER_WINDOW; i++) await createPairingCode(a.scope, min(i / 10))
    await expect(createPairingCode(a.scope, min(1))).rejects.toBeInstanceOf(TooManyCodesError)
    // The window moves on: the first code was made at t0 and is older than 10 minutes at min(10.5).
    await expect(createPairingCode(a.scope, min(10.5))).resolves.toBeDefined()
    // Another member is not held back by this member's requests.
    const b = await member()
    await expect(createPairingCode(b.scope, min(1))).resolves.toBeDefined()
  })

  test('a member can have 10 devices, no more', async () => {
    const a = await member()
    for (let i = 0; i < MAX_DEVICES_PER_MEMBER; i++) await pair(a.scope, min(i * 11), `PC ${i}`)
    await expect(createPairingCode(a.scope, min(200))).rejects.toBeInstanceOf(DeviceLimitError)
    // A code made before the 10th device existed is refused too, and is not used up.
    const b = await member()
    const { code } = await createPairingCode(b.scope, min(300))
    for (let i = 0; i < MAX_DEVICES_PER_MEMBER; i++) await pair(b.scope, min(300 + i * 11 + 1), `PC ${i}`)
    expect(await redeemPairingCode(db, { code, deviceName: 'PC' }, ntfyOf, min(300 + 120))).toBeNull()
    const [freed] = await listDevices(b.scope)
    expect(await revokeDevice(b.scope, freed!.id, min(500))).toBe(true)
    await expect(createPairingCode(b.scope, min(501))).resolves.toBeDefined()
  })
})

describe('device tokens', () => {
  test('a token has 256 random bits and the tmd_ prefix', () => {
    const { token, hash } = newDeviceToken()
    expect(token).toMatch(/^tmd_[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token.slice(4), 'base64url')).toHaveLength(32)
    expect(hash).toBe(hashSecret(token))
    expect(newDeviceToken().token).not.toBe(token)
  })

  test('normalisePairingCode folds what people type', () => {
    expect(normalisePairingCode('ab1o-ilzz')).toBe('AB10-11ZZ'.replace('-', ''))
    expect(normalisePairingCode(' a b-c d ')).toBe('ABCD')
  })

  test('authenticateDevice accepts the bearer token and records last_used_at', async () => {
    const a = await member()
    const res = await pair(a.scope, t0)
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(1))).toEqual({
      deviceId: res.deviceId,
      memberId: a.memberId
    })
    expect((await listDevices(a.scope))[0]!.lastUsedAt).toEqual(min(1))
    expect(await authenticateDevice(db, `Bearer ${newDeviceToken().token}`, min(1))).toBeNull()
    expect(await authenticateDevice(db, 'Bearer tmd_wrong', min(1))).toBeNull()
    expect(await authenticateDevice(db, null, min(1))).toBeNull()
    expect(await authenticateDevice(db, res.token, min(1))).toBeNull()
    expect(await authenticateDevice(db, `bearer ${res.token}`, min(1))).toBeNull()
    expect(await authenticateDevice(db, `Bearer ${res.token} `, min(1))).toBeNull()
    expect(await authenticateDevice(db, `Bearer ${res.token.toUpperCase()}`, min(1))).toBeNull()
    // A failed attempt leaves last_used_at alone.
    expect((await listDevices(a.scope))[0]!.lastUsedAt).toEqual(min(1))
  })

  test('a revoked token is refused on the very next call', async () => {
    const a = await member()
    const res = await pair(a.scope, t0)
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(1))).not.toBeNull()
    expect(await revokeDevice(a.scope, res.deviceId, min(2))).toBe(true)
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(2))).toBeNull()
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(3))).toBeNull()
    const [row] = await listDevices(a.scope)
    expect(row!.revokedAt).toEqual(min(2))
    // The refused call did not count as use.
    expect(row!.lastUsedAt).toEqual(min(1))
    // Revoking twice changes nothing.
    expect(await revokeDevice(a.scope, res.deviceId, min(4))).toBe(false)
  })

  test("another member can't revoke a device, or even see it", async () => {
    const a = await member()
    const b = await member()
    const res = await pair(a.scope, t0)
    expect(await revokeDevice(b.scope, res.deviceId, min(1))).toBe(false)
    expect(await revokeDevice(b.scope, 'not-a-uuid', min(1))).toBe(false)
    expect(await revokeDevice(b.scope, '00000000-0000-4000-8000-000000000000', min(1))).toBe(false)
    expect(await listDevices(b.scope)).toEqual([])
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(2))).toEqual({
      deviceId: res.deviceId,
      memberId: a.memberId
    })
    expect(await revokeDevice(a.scope, res.deviceId, min(3))).toBe(true)
  })

  test('listDevices shows name, dates and revoked state, oldest first', async () => {
    const a = await member()
    const one = await pair(a.scope, t0, 'DESKTOP-ABC')
    await pair(a.scope, min(11), 'LAPTOP-A')
    await revokeDevice(a.scope, one.deviceId, min(12))
    const rows = await listDevices(a.scope)
    expect(rows.map((r) => r.name)).toEqual(['DESKTOP-ABC', 'LAPTOP-A'])
    expect(rows.map((r) => r.revokedAt)).toEqual([min(12), null])
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'revokedAt'])
  })
})

describe('POST /api/companion/pair', () => {
  function deps(overrides: Partial<PairDeps> = {}): PairDeps & { clock: { at: Date } } {
    const clock = { at: t0 }
    return {
      db,
      ntfyOf,
      ipLimiter: new AttemptLimiter(MAX_FAILURES_PER_IP, ATTEMPT_WINDOW_MS),
      prefixLimiter: new AttemptLimiter(MAX_FAILURES_PER_PREFIX, ATTEMPT_WINDOW_MS),
      globalLimiter: new AttemptLimiter(MAX_FAILURES_GLOBAL, ATTEMPT_WINDOW_MS),
      now: () => clock.at,
      ...overrides,
      clock
    }
  }
  const post = (body: unknown, ip = '203.0.113.7') =>
    new Request('https://tm.example/api/companion/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  test('pairs with a good code and answers the PairResponse', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const res = await handlePairRequest(post({ code, deviceName: 'DESKTOP-ABC' }), deps())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = PairResponseSchema.parse(await res.json())
    expect(await authenticateDevice(db, `Bearer ${body.token}`, t0)).toEqual({
      deviceId: body.deviceId,
      memberId: a.memberId
    })
  })

  test('every failure is the same 400', async () => {
    const a = await member()
    const { code: used } = await createPairingCode(a.scope, t0)
    await handlePairRequest(post({ code: used, deviceName: 'PC' }), deps())
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    const bodies = [
      { code: 'ZZZZZ-ZZZZZ', deviceName: 'PC' },
      { code: used, deviceName: 'PC' },
      { code, deviceName: '' },
      { code, deviceName: 'PC', extra: 1 },
      { code: 42, deviceName: 'PC' },
      '{not json',
      'x'.repeat(5000),
      '[]',
      'null'
    ]
    const seen = new Set<string>()
    for (const [i, body] of bodies.entries()) {
      const res = await handlePairRequest(post(body, `198.51.100.${i + 1}`), d)
      seen.add(`${res.status} ${await res.text()}`)
    }
    expect([...seen]).toEqual(['400 {"error":"invalid_code"}'])
    // None of that used the live code.
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }), d)).status).toBe(200)
  })

  test('a wrong code too many times locks the address out, even for the right code', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      expect((await handlePairRequest(post({ code: '00000-00000', deviceName: 'PC' }), d)).status).toBe(400)
    }
    d.clock.at = min(1)
    const locked = await handlePairRequest(post({ code, deviceName: 'PC' }), d)
    expect(locked.status).toBe(400)
    expect(await locked.json()).toEqual({ error: 'invalid_code' })
    // Another address is not locked, and the code is still unused.
    d.clock.at = min(2)
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }, '203.0.113.99'), d)).status).toBe(200)
  })

  test('the lock-out ends after 15 minutes', async () => {
    const a = await member()
    const d = deps()
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) await handlePairRequest(post('nope'), d)
    d.clock.at = min(16)
    const { code } = await createPairingCode(a.scope, min(16))
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }), d)).status).toBe(200)
  })

  test('many addresses guessing together hit the global limit', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    // Junk bodies fail before the database, so 5000 of them stay quick; they come from 2560 hosts, none near its own cap.
    for (let i = 0; i < MAX_FAILURES_GLOBAL; i++) {
      await handlePairRequest(post('nope', `198.${18 + (i % 2)}.${Math.floor(i / 10) % 256}.${(i % 10) + 1}`), d)
    }
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }, '192.0.2.1'), d)).status).toBe(400)
    d.clock.at = min(16)
    const { code: later } = await createPairingCode(a.scope, min(16))
    expect((await handlePairRequest(post({ code: later, deviceName: 'PC' }, '192.0.2.1'), d)).status).toBe(200)
  })

  test('130 /64s inside one /48 hit the /48 tier and do not lock out another /48', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    for (let i = 1; i <= 130; i++) await handlePairRequest(post('nope', `2001:db8:1:${i.toString(16)}::1`), d)
    expect(d.prefixLimiter.locked('v6/48:2001:0db8:0001', t0)).toBe(true)
    expect(d.globalLimiter.locked('all', t0)).toBe(false)
    // A /64 of that /48 that has not tried yet is refused, even with the real code.
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }, '2001:db8:1:ffff::1'), d)).status).toBe(400)
    // The refusals were not counted against the address buckets that had no attempt.
    expect(d.ipLimiter.locked('v6:2001:0db8:0001:ffff', t0)).toBe(false)
    // Another /48, an IPv4 address and the same code: all pair (the code is still unused).
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }, '2001:db8:2::1'), d)).status).toBe(200)
    const { code: second } = await createPairingCode(a.scope, t0)
    expect((await handlePairRequest(post({ code: second, deviceName: 'PC2' }, '203.0.113.50'), d)).status).toBe(200)
  })

  test('parallel wrong codes from one address are counted before they reach the database', async () => {
    let transactions = 0
    const counting = Object.create(db) as Db
    counting.transaction = ((...args: Parameters<Db['transaction']>) => {
      transactions++
      return db.transaction(...args)
    }) as Db['transaction']
    const d = deps({ db: counting })
    const results = await Promise.all(
      Array.from({ length: 20 }, () => handlePairRequest(post({ code: '23456-789AB', deviceName: 'PC' }), d))
    )
    expect(results.map((r) => r.status)).toEqual(Array<number>(20).fill(400))
    expect(transactions).toBeLessThanOrEqual(MAX_FAILURES_PER_IP)
  })

  test('a paired attempt is given back, so pairing again from the same address is never locked by it', async () => {
    const a = await member()
    const d = deps()
    for (let i = 0; i < MAX_FAILURES_PER_IP + 2; i++) {
      const { code } = await createPairingCode(a.scope, t0)
      expect((await handlePairRequest(post({ code, deviceName: `PC${i}` }), d)).status).toBe(200)
      await db.delete(deviceTokens).where(eq(deviceTokens.memberId, a.memberId))
      await db.delete(devicePairings).where(eq(devicePairings.memberId, a.memberId))
    }
  })

  test('an IPv6 /64 is one address; another /64 and an IPv4-mapped address are told apart', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await handlePairRequest(post('nope', `2001:db8:1:2:${i}::${i + 1}`), d)
    }
    expect(d.ipLimiter.locked('v6:2001:0db8:0001:0002', t0)).toBe(true)
    for (const ip of ['2001:db8:1:2::1', '2001:DB8:1:2:ffff:ffff:ffff:ffff']) {
      expect((await handlePairRequest(post({ code, deviceName: 'PC' }, ip), d)).status).toBe(400)
    }
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) await handlePairRequest(post('nope', '::ffff:203.0.113.8'), d)
    expect(d.ipLimiter.locked('203.0.113.8', t0)).toBe(true)
    // The code was never used by those refusals; another /64 pairs.
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }, '2001:db8:1:3::1'), d)).status).toBe(200)
  })

  test('12 hosts with 5 junk tries each do not lock a real code out', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    for (let host = 1; host <= 12; host++) {
      for (let i = 0; i < 5; i++) await handlePairRequest(post('nope', `198.51.100.${host}`), d)
    }
    expect((await handlePairRequest(post({ code, deviceName: 'PC' }, '192.0.2.1'), d)).status).toBe(200)
  })

  test('an address comes from the last X-Forwarded-For entry, never from what a client wrote first', async () => {
    const d = deps()
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await handlePairRequest(post('nope', `10.0.0.${i + 1}, 203.0.113.7`), d)
    }
    expect(d.ipLimiter.locked('203.0.113.7', t0)).toBe(true)
    expect(d.ipLimiter.locked('10.0.0.1', t0)).toBe(false)
  })

  test('the code and the token are never logged', async () => {
    const a = await member()
    const { code } = await createPairingCode(a.scope, t0)
    const d = deps()
    let token = ''
    await expectNotLogged(normalisePairingCode(code), async () => {
      await handlePairRequest(post({ code: '00000-00000', deviceName: 'PC' }), d)
      const ok = await handlePairRequest(post({ code, deviceName: 'PC' }), d)
      token = ((await ok.json()) as { token: string }).token
    })
    expect(token).toStartWith(DEVICE_TOKEN_PREFIX)
    await expectNotLogged(token, async () => {
      await authenticateDevice(db, `Bearer ${token}`, t0)
      await authenticateDevice(db, `Bearer ${token}x`, t0)
    })
  })
})

describe('member routes', () => {
  const req = (init: RequestInit = {}) => new Request('https://tm.example/api/devices/x', { method: 'POST', ...init })

  test('pairing-code answers the code and its expiry', async () => {
    const a = await member()
    const res = await handlePairingCodeRequest(req(), a.scope, t0)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { code: string; expiresAt: string }
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    expect(body.expiresAt).toBe(min(10).toISOString())
  })

  test('pairing-code answers 409 without a ntfy topic and 429 after five codes, with fixed bodies', async () => {
    const bare = await member(false)
    const none = await handlePairingCodeRequest(req(), bare.scope, t0)
    expect([none.status, await none.json()]).toEqual([409, { error: 'ntfy_not_set_up' }])

    const a = await member()
    for (let i = 0; i < MAX_CODES_PER_WINDOW; i++) await handlePairingCodeRequest(req(), a.scope, t0)
    const many = await handlePairingCodeRequest(req(), a.scope, t0)
    expect([many.status, await many.json()]).toEqual([429, { error: 'too_many_codes' }])
  })

  test('revoke removes the device; the same 404 for someone else’s, a missing one and a malformed id', async () => {
    const a = await member()
    const b = await member()
    const res = await pair(a.scope, t0)
    const theirs = await handleRevokeRequest(req(), b.scope, res.deviceId, min(1))
    const missing = await handleRevokeRequest(req(), b.scope, '00000000-0000-4000-8000-000000000000', min(1))
    const malformed = await handleRevokeRequest(req(), b.scope, '../../x', min(1))
    for (const r of [theirs, missing, malformed])
      expect([r.status, await r.json()]).toEqual([404, { error: 'not_found' }])
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(2))).not.toBeNull()

    const done = await handleRevokeRequest(req(), a.scope, res.deviceId, min(3))
    expect([done.status, await done.json()]).toEqual([200, { ok: true }])
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(4))).toBeNull()
  })

  test('a request another site made in the member’s browser is refused and changes nothing', async () => {
    const a = await member()
    const res = await pair(a.scope, t0)
    const cross = req({ headers: { 'sec-fetch-site': 'cross-site' } })
    expect((await handleRevokeRequest(cross, a.scope, res.deviceId, min(1))).status).toBe(403)
    expect((await handlePairingCodeRequest(cross, a.scope, min(1))).status).toBe(403)
    expect(await authenticateDevice(db, `Bearer ${res.token}`, min(2))).not.toBeNull()
    const same = req({ headers: { 'sec-fetch-site': 'same-origin' } })
    expect((await handlePairingCodeRequest(same, a.scope, min(2))).status).toBe(200)
  })
})
