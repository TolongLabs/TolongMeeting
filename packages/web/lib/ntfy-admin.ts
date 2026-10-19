import { randomBytes } from 'node:crypto'
import { pings, type Ping } from '@tm/notify'
import { sealColumn } from '../db/secrets'
import type { Notifier } from '../db/notifier'
import type { MemberScope } from './scope'

// The ntfy admin API. Only this module and the scope-taking helpers below hold the admin token; a member's publish
// token is the only credential that leaves the server, and it is never logged or returned to the client.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface NtfyAdmin {
  addUser(username: string, password: string): Promise<void>
  allow(username: string, topic: string): Promise<void>
  createToken(username: string, password: string): Promise<string>
  deleteUser(username: string): Promise<void>
}

/** A refused ntfy admin call. The message carries the status only, never the URL, the token or ntfy's reply. */
export class NtfyAdminError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`ntfy admin request failed (HTTP ${status})`)
    this.name = 'NtfyAdminError'
    this.status = status
  }
}

const TIMEOUT_MS = 10_000
const TOPIC_CHARS = 'abcdefghijklmnopqrstuvwxyz234567'

export function ntfyUsername(memberId: string): string {
  return `tm-${memberId}`
}

/** The ntfy admin client for `url`. `fetchFn` defaults to the global fetch; tests pass a fake. */
export function ntfyAdmin(url: string, adminToken: string, fetchFn: FetchFn = fetch): NtfyAdmin {
  async function call(method: string, path: string, auth: string, body: unknown): Promise<Response> {
    const res = await fetchFn(`${url}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new NtfyAdminError(res.status)
    }
    return res
  }

  const bearer = `Bearer ${adminToken}`
  return {
    async addUser(username, password) {
      await (await call('POST', '/v1/users', bearer, { username, password })).body?.cancel()
    },

    async allow(username, topic) {
      await (
        await call('PUT', '/v1/users/access', bearer, { username, topic, permission: 'read-write' })
      ).body?.cancel()
    },

    async createToken(username, password) {
      const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      const res = await call('POST', '/v1/account/token', basic, { label: 'TolongMeeting', expires: 0 })
      const json = (await res.json()) as { token?: unknown }
      if (typeof json.token !== 'string' || json.token === '') throw new Error('ntfy returned no token')
      return json.token
    },

    async deleteUser(username) {
      await (await call('DELETE', '/v1/users', bearer, { username })).body?.cancel()
    }
  }
}

/** The admin client built from `NTFY_URL` and `NTFY_ADMIN_TOKEN`. Throws when either is unset. */
export function ntfyAdminFromEnv(): NtfyAdmin {
  const url = process.env.NTFY_URL
  const token = process.env.NTFY_ADMIN_TOKEN
  if (!url) throw new Error('NTFY_URL is not set')
  if (!token) throw new Error('NTFY_ADMIN_TOKEN is not set')
  return ntfyAdmin(url, token)
}

/**
 * Gives the member their ntfy user, topic and token, once. A member who has a topic gets it back. Otherwise: a user
 * with a random password that is never stored, read-write on a new `tm-` topic, and a token that never expires, sealed
 * into `members.ntfy_token`.
 */
export async function ensureNtfy(scope: MemberScope, admin: NtfyAdmin, master: Buffer): Promise<{ topic: string }> {
  const me = await scope.me()
  if (me.ntfyTopic) return { topic: me.ntfyTopic }

  const username = ntfyUsername(scope.memberId)
  const password = randomBytes(32).toString('hex')
  const topic = `tm-${Array.from(randomBytes(24), (b) => TOPIC_CHARS[b % 32]).join('')}`
  await admin.addUser(username, password)
  await admin.allow(username, topic)
  const token = await admin.createToken(username, password)
  await scope.updateMe({
    ntfyTopic: topic,
    ntfyTokenEnc: sealColumn(master, scope.memberId, 'members.ntfy_token', token)
  })
  return { topic }
}

/** Sends the member's test ping through `notifier`. */
export async function sendTestPing(scope: MemberScope, notifier: Notifier): Promise<void> {
  const ping: Ping = pings.notificationsTest()
  await notifier.notify(scope.memberId, ping)
}
