import { randomBytes } from 'node:crypto'
import { pings } from '@tm/notify'
import type { Notifier } from '../db/notifier'
import { openColumn, sealColumn } from '../db/secrets'
import type { MemberScope } from './scope'

// The ntfy admin API. Only this module and the scope-taking helpers below hold the admin token. A member's publish
// token is never logged, and it leaves the server only in the reply to that member's own "Show token" request.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface NtfyAdmin {
  addUser(username: string, password: string): Promise<void>
  allow(username: string, topic: string): Promise<void>
  createToken(username: string, password: string): Promise<string>
  deleteUser(username: string): Promise<void>
}

/**
 * A refused or unreadable ntfy admin call. The message carries the status and a fixed phrase, never the URL, the token
 * or ntfy's reply.
 */
export class NtfyAdminError extends Error {
  readonly status: number

  constructor(status: number, detail = 'request failed') {
    super(`ntfy admin ${detail} (HTTP ${status})`)
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
      // A redirect would replay the Authorization header to another host, so it is an error instead.
      redirect: 'error',
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
      // A reply that isn't JSON is reported without its text: the parser's message can echo the reply.
      let reply: unknown
      try {
        reply = await res.json()
      } catch {
        throw new NtfyAdminError(res.status, 'reply was not JSON')
      }
      const token = typeof reply === 'object' && reply !== null && 'token' in reply ? reply.token : undefined
      if (typeof token !== 'string' || token === '') throw new NtfyAdminError(res.status, 'reply had no token')
      return token
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
 * Gives the member their ntfy user, topic and token, once. A member who has a topic and a token gets the topic back
 * with no ntfy call. Otherwise, under a per-member advisory lock: a user with a random password that is never stored,
 * read-write on a new `tm-` topic, and a token that never expires, sealed into `members.ntfy_token`. If anything fails
 * after the user exists, the user is deleted again, so the next call starts clean. The lock is held until the
 * transaction ends, so two calls for one member can't both create a user.
 */
export async function ensureNtfy(scope: MemberScope, admin: NtfyAdmin, master: Buffer): Promise<{ topic: string }> {
  return scope.transaction(async (s) => {
    await s.lock('ntfy')
    const me = await s.me()
    if (me.ntfyTopic && me.ntfyTokenEnc) return { topic: me.ntfyTopic }

    const username = ntfyUsername(scope.memberId)
    const password = randomBytes(32).toString('hex')
    const topic = `tm-${Array.from(randomBytes(24), (b) => TOPIC_CHARS[b % 32]).join('')}`
    await addUser(admin, username, password, me.ntfyTokenEnc === null)
    try {
      await admin.allow(username, topic)
      const token = await admin.createToken(username, password)
      await s.updateMe({
        ntfyTopic: topic,
        ntfyTokenEnc: sealColumn(master, scope.memberId, 'members.ntfy_token', token)
      })
    } catch (err) {
      await deleteUserQuietly(admin, username)
      throw err
    }
    return { topic }
  })
}

/**
 * Creates the ntfy user. With the lock held and no token stored, a 409 means an earlier run left the user behind
 * without saving its token (the user is stranded), so it is replaced. A 409 with a token stored is rethrown. `ensureNtfy`
 * never stores a token without its topic (both go in one `updateMe` call), so a token with a null topic comes only from
 * a row written some other way, and its 409 is an error, not a stranded user.
 */
async function addUser(admin: NtfyAdmin, username: string, password: string, noToken: boolean): Promise<void> {
  try {
    await admin.addUser(username, password)
  } catch (err) {
    if (!noToken || !(err instanceof NtfyAdminError) || err.status !== 409) throw err
    await admin.deleteUser(username)
    await admin.addUser(username, password)
  }
}

/** Deletes a user after a later step failed. The caller rethrows the original error; only a cleanup failure's name is logged. */
async function deleteUserQuietly(admin: NtfyAdmin, username: string): Promise<void> {
  try {
    await admin.deleteUser(username)
  } catch (err) {
    console.error(`ntfy user cleanup failed (${err instanceof Error ? err.name : 'unknown'})`)
  }
}

/** Sends the member's test ping through `notifier`. Resolves `true` only when the ping was sent. */
export async function sendTestPing(scope: MemberScope, notifier: Notifier): Promise<boolean> {
  return notifier.notify(scope.memberId, pings.notificationsTest())
}

/** The member's own publish token, opened for the "Show token" button. Resolves `null` when no token is saved yet. */
export async function revealNtfyToken(scope: MemberScope, master: Buffer): Promise<string | null> {
  const me = await scope.me()
  if (!me.ntfyTokenEnc) return null
  return openColumn(master, scope.memberId, 'members.ntfy_token', me.ntfyTokenEnc)
}
