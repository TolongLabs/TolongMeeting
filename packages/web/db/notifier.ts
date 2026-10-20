import type { NtfyConfig } from '@tm/core'
import { sendPing, type Ping } from '@tm/notify'
import { eq } from 'drizzle-orm'
import { getDb, type Db } from './index'
import { members } from './schema'
import { loadMasterKey, openColumn } from './secrets'

export class NoSuchMemberError extends Error {
  constructor() {
    super('no such member')
    this.name = 'NoSuchMemberError'
  }
}

export class NoNtfyTopicError extends Error {
  constructor() {
    super('member has no ntfy topic')
    this.name = 'NoNtfyTopicError'
  }
}

/**
 * Sends a member's pings. It never throws: a ping that fails is logged by name and dropped (plan 01c, C19). It resolves
 * `true` only when the send resolved, so a caller can say whether the ping went out.
 */
export interface Notifier {
  notify(memberId: string, ping: Ping): Promise<boolean>
}

export type NtfySend = (cfg: NtfyConfig, ping: Ping) => Promise<void>

/** The notifier that sends to each member's own topic with their own sealed token. `send` defaults to `sendPing`. */
export function memberNotifier(db: Db, master: Buffer, ntfyUrl: string, send: NtfySend = sendPing): Notifier {
  return {
    async notify(memberId, ping) {
      try {
        const [row] = await db
          .select({ topic: members.ntfyTopic, tokenEnc: members.ntfyTokenEnc })
          .from(members)
          .where(eq(members.id, memberId))
        if (!row) throw new NoSuchMemberError()
        if (!row.topic || !row.tokenEnc) throw new NoNtfyTopicError()
        const token = openColumn(master, memberId, 'members.ntfy_token', row.tokenEnc)
        await send({ url: ntfyUrl, topic: row.topic, token }, ping)
        return true
      } catch (e) {
        // Only the error's name is logged: a message can carry the ntfy URL or the token.
        console.error(`ping failed: ${ping.title} (${e instanceof Error ? e.name : 'unknown'})`)
        return false
      }
    }
  }
}

/** The notifier the running app uses: `DATABASE_URL`, `TM_MASTER_KEY_FILE` and `NTFY_URL`. Throws when one is unset. */
export function appNotifier(): Notifier {
  const ntfyUrl = process.env.NTFY_URL
  if (!ntfyUrl) throw new Error('NTFY_URL is not set')
  return memberNotifier(getDb(), loadMasterKey(), ntfyUrl)
}

/** Records each ping instead of sending it. */
export class FakeNotifier implements Notifier {
  readonly sent: { memberId: string; ping: Ping }[] = []

  async notify(memberId: string, ping: Ping): Promise<boolean> {
    this.sent.push({ memberId, ping })
    return true
  }
}
