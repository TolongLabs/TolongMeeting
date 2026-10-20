import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '../../web/db'
import { dropAllTestDbs, TEST_MASTER, withNtfy } from '../../web/db/testing'
import { ntfyConfigOf } from '../../web/lib/companion/deps'
import {
  ATTEMPT_WINDOW_MS,
  AttemptLimiter,
  authenticateDevice,
  createPairingCode,
  handlePairRequest,
  MAX_FAILURES_GLOBAL,
  MAX_FAILURES_PER_IP,
  MAX_FAILURES_PER_PREFIX,
  revokeDevice,
  type PairDeps
} from '../../web/lib/companion/tokens'
import { createScope } from '../../web/lib/scope'
import { CompanionApi, CompanionApiError, DeviceRevokedError } from '../src/api'
import { completePairing, PairingRefusedError } from '../src/pairing'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { StateStore } from '../src/state'

// The real pairing route handler and a device-token check, served over real HTTP with Bun.serve on the test database.

const NTFY_URL = 'https://ntfy.example'
const NTFY_TOKEN = 'tk_ntfy_secret_for_tests'
const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8').reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString('utf8')
}

let db: Db
let memberId: string
let topic: string
let dir: string
let server: ReturnType<typeof Bun.serve> | undefined
let landing: ReturnType<typeof Bun.serve> | undefined
const landed: Request[] = []
let base: string

const hasDb = Boolean(process.env.TEST_DATABASE_URL)
if (!hasDb) {
  console.warn('pairing-http.test.ts skipped: TEST_DATABASE_URL is not set')
}

describe.skipIf(!hasDb)('pairing over real HTTP', () => {
  beforeAll(async () => {
    ;({ db, memberId, topic } = await withNtfy(NTFY_TOKEN, TEST_MASTER))
    dir = await mkdtemp(join(tmpdir(), 'tm-pair-http-'))
    const deps: PairDeps = {
      db,
      ntfyOf: (memberId) => ntfyConfigOf(db, TEST_MASTER, NTFY_URL, memberId),
      ipLimiter: new AttemptLimiter(MAX_FAILURES_PER_IP, ATTEMPT_WINDOW_MS),
      prefixLimiter: new AttemptLimiter(MAX_FAILURES_PER_PREFIX, ATTEMPT_WINDOW_MS),
      globalLimiter: new AttemptLimiter(MAX_FAILURES_GLOBAL, ATTEMPT_WINDOW_MS),
      now: () => new Date()
    }
    landing = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        landed.push(req)
        return Response.json({ jobs: [] })
      }
    })
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/api/companion/pair') return handlePairRequest(req, deps)
        if (path === '/api/companion/jobs') {
          const device = await authenticateDevice(db, req.headers.get('authorization'))
          return device
            ? Response.json({ jobs: [] })
            : Response.json({ error: 'device_revoked_or_unknown' }, { status: 401 })
        }
        if (path === '/api/companion/events') return Response.redirect(`http://127.0.0.1:${landing!.port}/stolen`, 302)
        return new Response('', { status: 404 })
      }
    })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    if (server) await server.stop(true)
    if (landing) await landing.stop(true)
    if (dir) await rm(dir, { recursive: true, force: true })
    if (hasDb) await dropAllTestDbs()
  })
  test('pairs with a real code, calls the API with the token, and is unpaired when revoked', async () => {
    const { code } = await createPairingCode(createScope(db, memberId), new Date())

    const secrets = new SecretStore(join(dir, 'secrets.json'), safe)
    const state = new StateStore(join(dir, 'state.json'))
    const saved: string[] = []
    await completePairing({
      serverUrl: base,
      code: code.toLowerCase().replace('-', ' '),
      deviceName: 'DESKTOP-TEST',
      secrets,
      state,
      saveServerUrl: async (u) => void saved.push(u)
    })
    expect(await secrets.get('deviceToken')).toStartWith('tmd_')
    expect(await secrets.get('ntfyToken')).toBe(NTFY_TOKEN)
    expect(state.get().ntfy).toEqual({ url: NTFY_URL, topic })
    expect(state.get().summariesAfter).not.toBeNull()
    expect(saved).toEqual([base])

    let revoked = 0
    const api = new CompanionApi({
      serverUrl: base,
      token: () => secrets.get('deviceToken'),
      onRevoked: () => revoked++
    })
    expect(await api.jobs()).toEqual([])

    const wrong = new CompanionApi({
      serverUrl: base,
      token: async () => 'tmd_not_a_real_token',
      onRevoked: () => revoked++
    })
    await expect(wrong.jobs()).rejects.toBeInstanceOf(DeviceRevokedError)
    expect(revoked).toBe(1)

    const device = await authenticateDevice(db, `Bearer ${await secrets.get('deviceToken')}`)
    expect(device).not.toBeNull()
    expect(await revokeDevice(createScope(db, memberId), device!.deviceId)).toBe(true)
    await expect(api.jobs()).rejects.toBeInstanceOf(DeviceRevokedError)
    expect(revoked).toBe(2)
  })

  test('a code the website refuses gives the fixed error and stores nothing', async () => {
    const secrets = new SecretStore(join(dir, 'secrets-2.json'), safe)
    await expect(
      completePairing({
        serverUrl: base,
        code: 'ZZZZ-ZZZZ',
        deviceName: 'PC',
        secrets,
        state: new StateStore(join(dir, 'state-2.json')),
        saveServerUrl: async () => {}
      })
    ).rejects.toBeInstanceOf(PairingRefusedError)
    expect(await secrets.get('deviceToken')).toBeNull()
  })

  test('a redirect is not followed, so the token never reaches the other address', async () => {
    const api = new CompanionApi({ serverUrl: base, token: async () => 'tmd_x', onRevoked: () => {} })
    const err = await api.events(0, new AbortController().signal).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CompanionApiError)
    expect(landed).toEqual([])
  })
})
