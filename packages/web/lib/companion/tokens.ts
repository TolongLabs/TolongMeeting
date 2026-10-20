import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import {
  DEVICE_TOKEN_PREFIX,
  MAX_DEVICES_PER_MEMBER,
  PAIRING_CODE_TTL_MS,
  PairRequestSchema,
  type DeviceAuth,
  type NtfyConfig,
  type PairResponse
} from '@tm/core'
import { and, count, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { safeDbError } from '../../db/errors'
import { companionJobs, deviceTokens, devicePairings, identities } from '../../db/schema'
import type { createScope, MemberScope } from '../scope'

/** The database (or a transaction) the pairing functions that act for no member work on. */
export type Db = Parameters<typeof createScope>[0]

// Pairing codes and device tokens are bearer secrets. Only their SHA-256 hashes are stored, they are compared in
// constant time, and they never appear in a log line, an error message or a response other than the one that mints them.

/** The characters of a pairing code: Crockford base32, which has no I, L, O or U. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const NORMAL_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/
/** `tmd_` and 32 random bytes in base64url. */
const BEARER = /^Bearer (tmd_[A-Za-z0-9_-]{43})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A member may ask for this many codes in one code lifetime. */
export const MAX_CODES_PER_WINDOW = 5
/** Wrong or malformed pairing attempts allowed from one address, and from everyone, in `ATTEMPT_WINDOW_MS`. */
export const MAX_FAILURES_PER_IP = 5
export const MAX_FAILURES_GLOBAL = 60
export const ATTEMPT_WINDOW_MS = 15 * 60_000
const MAX_PAIR_BODY_BYTES = 2048
const PRUNE_AFTER_MS = 24 * 3_600_000

const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (e) {
    throw safeDbError(e)
  }
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Compares two hex digests in constant time. */
function sameHash(stored: string, given: string): boolean {
  const a = Buffer.from(stored)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A token of 256 random bits, and the hash that is stored in its place. */
export function newDeviceToken(): { token: string; hash: string } {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashSecret(token) }
}

/** What a member types, folded to the stored form: upper case, no dashes or spaces, I and L as 1, O as 0. */
export function normalisePairingCode(input: string): string {
  return input.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
}

function newCode(): string {
  const chars = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

export class NtfyNotSetUpError extends Error {
  constructor() {
    super('The member has no ntfy topic yet.')
    this.name = 'NtfyNotSetUpError'
  }
}
export class TooManyCodesError extends Error {
  constructor() {
    super('Too many pairing codes were requested.')
    this.name = 'TooManyCodesError'
  }
}
export class DeviceLimitError extends Error {
  constructor() {
    super('The member has the most devices allowed.')
    this.name = 'DeviceLimitError'
  }
}

async function activeDevices(db: Db, memberId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.memberId, memberId), isNull(deviceTokens.revokedAt)))
  return row!.n
}

// The advisory lock that `scope.lock('pairing')` takes, so creating and redeeming codes for one member never overlap.
const lockPairing = (db: Db, memberId: string) =>
  db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'pairing:' + memberId}, 0))`)

/**
 * A new code for the member, valid for 10 minutes. It retires the member's earlier unused codes, so one code is live
 * at a time. Throws `NtfyNotSetUpError` without a ntfy topic (the PC needs one), `DeviceLimitError` at 10 devices and
 * `TooManyCodesError` after 5 requests in 10 minutes.
 */
export async function createPairingCode(
  scope: MemberScope,
  now: Date = new Date()
): Promise<{ code: string; expiresAt: Date }> {
  const code = newCode()
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS)
  await guarded(() =>
    scope.transaction(async (s) => {
      await s.lock('pairing')
      const me = await s.me()
      if (!me.ntfyTopic || !me.ntfyTokenEnc) throw new NtfyNotSetUpError()
      const recent = await s.select(
        devicePairings,
        gt(devicePairings.createdAt, new Date(now.getTime() - PAIRING_CODE_TTL_MS))
      )
      if (recent.length >= MAX_CODES_PER_WINDOW) throw new TooManyCodesError()
      const devices = await s.select(deviceTokens, isNull(deviceTokens.revokedAt))
      if (devices.length >= MAX_DEVICES_PER_MEMBER) throw new DeviceLimitError()
      await s.update(
        devicePairings,
        { expiresAt: now },
        and(isNull(devicePairings.usedAt), gt(devicePairings.expiresAt, now))!
      )
      await s.remove(devicePairings, lt(devicePairings.expiresAt, new Date(now.getTime() - PRUNE_AFTER_MS)))
      await s.insert(devicePairings, { codeHash: hashSecret(normalisePairingCode(code)), expiresAt, createdAt: now })
    })
  )
  return { code, expiresAt }
}

/**
 * Trades a pairing code for a device token, once. `null` for every refusal (unknown, used, expired or malformed code,
 * a bad device name, a member at the device limit, a member with no ntfy topic): the caller can't tell them apart. The
 * code is marked used and the device row is inserted in one transaction. The token is returned here and nowhere else.
 */
export async function redeemPairingCode(
  db: Db,
  req: { code: string; deviceName: string },
  ntfyOf: (memberId: string) => Promise<NtfyConfig | null>,
  now: Date = new Date()
): Promise<PairResponse | null> {
  const code = normalisePairingCode(req.code)
  const name = PairRequestSchema.shape.deviceName.safeParse(req.deviceName)
  if (!NORMAL_CODE.test(code) || !name.success) return null
  const codeHash = hashSecret(code)
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: devicePairings.id, memberId: devicePairings.memberId, codeHash: devicePairings.codeHash })
        .from(devicePairings)
        .where(
          and(eq(devicePairings.codeHash, codeHash), isNull(devicePairings.usedAt), gt(devicePairings.expiresAt, now))
        )
      // The lookup is by the hash of a high-entropy secret; this re-check is the constant-time comparison.
      if (!row || !sameHash(row.codeHash, codeHash)) return null
      const ntfy = await ntfyOf(row.memberId)
      if (!ntfy) return null
      await lockPairing(tx, row.memberId)
      if ((await activeDevices(tx, row.memberId)) >= MAX_DEVICES_PER_MEMBER) return null
      // A second redeem of the same code loses here: the row is already used when its update re-reads it.
      const claimed = await tx
        .update(devicePairings)
        .set({ usedAt: now })
        .where(and(eq(devicePairings.id, row.id), isNull(devicePairings.usedAt), gt(devicePairings.expiresAt, now)))
        .returning({ id: devicePairings.id })
      if (claimed.length === 0) return null
      const { token, hash } = newDeviceToken()
      const [device] = await tx
        .insert(deviceTokens)
        .values({ memberId: row.memberId, name: name.data, tokenHash: hash, createdAt: now })
        .returning({ id: deviceTokens.id })
      return { deviceId: device!.id, token, ntfy, pairedAt: now.toISOString() }
    })
  )
}

/**
 * The device behind `Authorization: Bearer tmd_...`, or `null` for a missing, malformed, unknown or revoked token. It
 * reads the row on every call (nothing is cached), so a revoke is effective on the very next request, and records
 * `last_used_at` in the same statement.
 */
export async function authenticateDevice(
  db: Db,
  authorization: string | null,
  now: Date = new Date()
): Promise<DeviceAuth | null> {
  const token = authorization === null ? null : BEARER.exec(authorization)?.[1]
  if (!token) return null
  const hash = hashSecret(token)
  const [row] = await guarded(() =>
    db
      .update(deviceTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(deviceTokens.tokenHash, hash), isNull(deviceTokens.revokedAt)))
      .returning({ id: deviceTokens.id, memberId: deviceTokens.memberId, tokenHash: deviceTokens.tokenHash })
  )
  if (!row || !sameHash(row.tokenHash, hash)) return null
  return { deviceId: row.id, memberId: row.memberId }
}

export interface DeviceSummary {
  id: string
  name: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

/** The member's devices, oldest first, revoked ones included. */
export async function listDevices(scope: MemberScope): Promise<DeviceSummary[]> {
  const rows = await guarded(() => scope.select(deviceTokens))
  return rows
    .map(({ id, name, createdAt, lastUsedAt, revokedAt }) => ({ id, name, createdAt, lastUsedAt, revokedAt }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/**
 * Revokes one of the member's devices. `false` when it is not theirs, does not exist or is revoked already. In the same
 * transaction the identities bound to it lose the binding (`local_device_id` is null; they stay on My PC, so they never
 * quietly run on the server: at T-60 they are skipped with a "no PC is paired" ping) and its unfinished `local_run`
 * jobs are cancelled, so no job aimed at it can be claimed afterwards.
 */
export async function revokeDevice(scope: MemberScope, deviceId: string, now: Date = new Date()): Promise<boolean> {
  if (!UUID.test(deviceId)) return false
  return guarded(() =>
    scope.transaction(async (s) => {
      const changed = await s.update(
        deviceTokens,
        { revokedAt: now },
        and(eq(deviceTokens.id, deviceId), isNull(deviceTokens.revokedAt))!
      )
      if (changed === 0) return false
      await s.update(identities, { localDeviceId: null }, eq(identities.localDeviceId, deviceId))
      await s.update(
        companionJobs,
        { state: 'cancelled', leaseUntil: null, updatedAt: now },
        and(
          eq(companionJobs.targetDeviceId, deviceId),
          eq(companionJobs.kind, 'local_run'),
          inArray(companionJobs.state, ['pending', 'claimed'])
        )!
      )
      return true
    })
  )
}

/** Failures per key in a sliding window. A key with `max` failures in the window is locked until the oldest ages out. */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  locked(key: string, now: Date): boolean {
    return this.recent(key, now).length >= this.max
  }

  fail(key: string, now: Date): void {
    const list = this.recent(key, now)
    list.push(now.getTime())
    if (list.length > this.max) list.shift()
    this.failures.set(key, list)
    if (this.failures.size > this.maxKeys) this.evict(now)
  }

  private recent(key: string, now: Date): number[] {
    const cutoff = now.getTime() - this.windowMs
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length === 0) this.failures.delete(key)
    return list
  }

  private evict(now: Date): void {
    for (const key of [...this.failures.keys()]) this.recent(key, now)
    // Still full: drop the oldest keys. The global limiter still bounds a flood from many addresses.
    for (const key of this.failures.keys()) {
      if (this.failures.size <= this.maxKeys) break
      this.failures.delete(key)
    }
  }
}

export interface PairDeps {
  db: Db
  /** The member's ntfy settings for the PC, or `null` when the member has none. */
  ntfyOf(memberId: string): Promise<NtfyConfig | null>
  ipLimiter: AttemptLimiter
  globalLimiter: AttemptLimiter
  now(): Date
}

const NO_STORE = { 'cache-control': 'no-store' }

/** The address Caddy saw (it keeps only its own `X-Forwarded-For` entry), or one shared bucket without a valid one. */
function clientKey(request: Request): string {
  const last = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() ?? ''
  return isIP(last) ? last : 'unknown'
}

/** The body as text, or `null` when it is longer than `max` bytes. The stream is cut off at the cap. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (!request.body || declared > max) return request.body ? null : ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `POST /api/companion/pair`: the PC trades a code for its token. No session. Every failure is the same 400 with the same
 * body, and after 5 failures from one address (or 60 from anyone) in 15 minutes all attempts are refused the same way.
 */
export async function handlePairRequest(request: Request, deps: PairDeps): Promise<Response> {
  const refuse = () => Response.json({ error: 'invalid_code' }, { status: 400, headers: NO_STORE })
  const now = deps.now()
  const ip = clientKey(request)
  if (deps.ipLimiter.locked(ip, now) || deps.globalLimiter.locked('all', now)) return refuse()

  const raw = await readCapped(request, MAX_PAIR_BODY_BYTES)
  const body = raw === null ? null : parseJson(raw)
  const parsed = PairRequestSchema.safeParse(body)
  const paired = parsed.success ? await redeemPairingCode(deps.db, parsed.data, deps.ntfyOf, now) : null
  if (!paired) {
    deps.ipLimiter.fail(ip, now)
    deps.globalLimiter.fail('all', now)
    return refuse()
  }
  return Response.json(paired, { headers: NO_STORE })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    if (e instanceof SyntaxError) return null
    throw e
  }
}

/** Browsers say where a request came from; a member route accepts only the site's own pages (and non-browser clients). */
const crossSite = (request: Request): boolean => {
  const site = request.headers.get('sec-fetch-site')
  return site !== null && site !== 'same-origin'
}
const forbidden = () => Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE })

/** `POST /api/devices/pairing-code` for the signed-in member. 409 without a ntfy topic or at 10 devices, 429 after 5 codes. */
export async function handlePairingCodeRequest(
  request: Request,
  scope: MemberScope,
  now: Date = new Date()
): Promise<Response> {
  if (crossSite(request)) return forbidden()
  try {
    const { code, expiresAt } = await createPairingCode(scope, now)
    return Response.json({ code, expiresAt: expiresAt.toISOString() }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof NtfyNotSetUpError)
      return Response.json({ error: 'ntfy_not_set_up' }, { status: 409, headers: NO_STORE })
    if (e instanceof DeviceLimitError)
      return Response.json({ error: 'device_limit' }, { status: 409, headers: NO_STORE })
    if (e instanceof TooManyCodesError)
      return Response.json({ error: 'too_many_codes' }, { status: 429, headers: NO_STORE })
    throw e
  }
}

/** `POST /api/devices/<id>/revoke` for the signed-in member. The same 404 for a device that is not theirs. */
export async function handleRevokeRequest(
  request: Request,
  scope: MemberScope,
  deviceId: string,
  now: Date = new Date()
): Promise<Response> {
  if (crossSite(request)) return forbidden()
  if (!(await revokeDevice(scope, deviceId, now)))
    return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE })
  return Response.json({ ok: true }, { headers: NO_STORE })
}
