import { PairRequestSchema, PairResponseSchema, type PairRequest, type PairResponse } from '@tm/core'
import { z } from 'zod'
import { CompanionApiError, InvalidResponseError, readJson, serverOrigin } from './api'
import type { DesktopNotifier } from './notifier'
import type { SecretStore } from './secrets'
import type { StateStore } from './state'

// TODO(figma-gate): `renderer/pairing.html` (fields "Website address" and "Pairing code", prefilled from `Settings.serverUrl`),
// the pairing window, and the `main/index.ts` wiring (`completePairing` on first run, `handleRevoked` from `onRevoked`)
// wait for the Figma design approval (docs/DESIGN.md). Errors shown there are the fixed sentences thrown below.

const PairRefusal = z.strictObject({ error: z.literal('invalid_code') })
const PAIR_TIMEOUT_MS = 30_000

/** The website did not accept the code: it is wrong, used, expired, or too many tries came from this address. */
export class PairingRefusedError extends Error {
  constructor() {
    super('The pairing code was not accepted. Make a new code on the Devices page and try again.')
    this.name = 'PairingRefusedError'
  }
}

/** What the member typed is not a pairing code or a device name the website could take. */
export class PairingInputError extends Error {
  constructor() {
    super('Enter the pairing code from the Devices page')
    this.name = 'PairingInputError'
  }
}

/**
 * Trades a pairing code for this PC's device token. Sends no credentials. The answer carries the token, so the caller
 * stores it at once and does not keep the object.
 */
export async function pairDevice(serverUrl: string, req: PairRequest, f: typeof fetch = fetch): Promise<PairResponse> {
  const origin = serverOrigin(serverUrl)
  const body = PairRequestSchema.safeParse(req)
  if (!body.success) throw new PairingInputError()
  const res = await f(
    new Request(new URL('/api/companion/pair', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.data),
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
    })
  )
  if (res.status === 400) {
    await readJson(res, PairRefusal)
    throw new PairingRefusedError()
  }
  if (res.status !== 200) {
    await res.body?.cancel()
    throw new CompanionApiError(res.status)
  }
  const paired = await readJson(res, PairResponseSchema)
  // The ntfy stream carries the ntfy token, so it follows the same rule as the website address.
  if (!safeNtfyUrl(paired.ntfy.url)) throw new InvalidResponseError()
  return paired
}

function safeNtfyUrl(raw: string): boolean {
  const u = new URL(raw)
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  const schemeOk = u.protocol === 'https:' || (u.protocol === 'http:' && local)
  return schemeOk && u.username === '' && u.password === '' && u.search === '' && u.hash === ''
}

export interface PairingDeps {
  serverUrl: string
  code: string
  deviceName: string
  secrets: SecretStore
  state: StateStore
  saveServerUrl(url: string): Promise<void>
  fetch?: typeof fetch
}

/**
 * Pairs this PC. Both tokens go straight into the `SecretStore` (encrypted by the OS); the ntfy address and topic go
 * into `state.json`; summaries start from the moment of pairing. The website address is saved only after all of it worked.
 */
export async function completePairing(d: PairingDeps): Promise<void> {
  const origin = serverOrigin(d.serverUrl)
  const paired = await pairDevice(origin, { code: d.code, deviceName: d.deviceName }, d.fetch)
  await d.secrets.set('deviceToken', paired.token)
  await d.secrets.set('ntfyToken', paired.ntfy.token)
  await d.state.update({
    summariesAfter: paired.pairedAt,
    ntfyLastId: null,
    ntfy: { url: paired.ntfy.url, topic: paired.ntfy.topic }
  })
  await d.saveServerUrl(origin)
}

export interface RevokedDeps {
  secrets: SecretStore
  stopAll(): void
  notifier: DesktopNotifier
  openPairing(): void
}

/** The website unpaired this PC: forget the tokens, stop every loop, and say so. A click on the note opens pairing. */
export async function handleRevoked(d: RevokedDeps): Promise<void> {
  await d.secrets.clear()
  d.stopAll()
  d.notifier.show(
    {
      title: 'TolongMeeting is unpaired',
      body: 'This PC was removed from your account. Click to pair it again.',
      sticky: true,
      buttons: []
    },
    { click: () => d.openPairing(), action: () => {} }
  )
}
