import { NtfyConfigSchema, type NtfyConfig } from '@tm/core'
import { eq } from 'drizzle-orm'
import { getDb, members, type Db } from '../../db'
import { loadMasterKey, openColumn } from '../../db/secrets'
import { ATTEMPT_WINDOW_MS, AttemptLimiter, MAX_FAILURES_GLOBAL, MAX_FAILURES_PER_IP, type PairDeps } from './tokens'

/** The member's ntfy settings for a PC: the public ntfy URL, their topic and their token. `null` without a topic. */
export async function ntfyConfigOf(
  db: Db,
  master: Buffer,
  ntfyUrl: string,
  memberId: string
): Promise<NtfyConfig | null> {
  const [row] = await db
    .select({ topic: members.ntfyTopic, tokenEnc: members.ntfyTokenEnc })
    .from(members)
    .where(eq(members.id, memberId))
  if (!row?.topic || !row.tokenEnc) return null
  const token = openColumn(master, memberId, 'members.ntfy_token', row.tokenEnc)
  return NtfyConfigSchema.parse({ url: ntfyUrl, topic: row.topic, token })
}

// One pair of limiters per process; Next.js reloads modules in development.
const globalForLimiters = globalThis as typeof globalThis & {
  __tmPairLimiters?: Pick<PairDeps, 'ipLimiter' | 'globalLimiter'>
}

/** What `POST /api/companion/pair` runs on: `DATABASE_URL`, `TM_MASTER_KEY_FILE` and `NTFY_URL`. Throws when one is unset. */
export function pairDeps(): PairDeps {
  const ntfyUrl = process.env.NTFY_URL
  if (!ntfyUrl) throw new Error('NTFY_URL is not set')
  const db = getDb()
  const master = loadMasterKey()
  globalForLimiters.__tmPairLimiters ??= {
    ipLimiter: new AttemptLimiter(MAX_FAILURES_PER_IP, ATTEMPT_WINDOW_MS),
    globalLimiter: new AttemptLimiter(MAX_FAILURES_GLOBAL, ATTEMPT_WINDOW_MS)
  }
  return {
    db,
    ntfyOf: (memberId) => ntfyConfigOf(db, master, ntfyUrl, memberId),
    ...globalForLimiters.__tmPairLimiters,
    now: () => new Date()
  }
}
