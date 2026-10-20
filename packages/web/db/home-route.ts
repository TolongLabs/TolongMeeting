import { eq } from 'drizzle-orm'
import { safeDbError } from './errors'
import { homeExitNodes, type Db } from './index'
import type { MemberScope } from '../lib/scope'

/** A member's stored home exit node: the device found ready by the last check. No auth key is ever kept. */
export interface HomeNode {
  nodeId: string
  hostname: string
  ipv4: string
  checkedAt: Date
}

/** Reads and writes one member's `home_exit_nodes` row. */
export interface HomeNodeStore {
  get(): Promise<HomeNode | null>
  /** Stores the node, replacing the member's earlier one. */
  save(node: HomeNode): Promise<void>
  clear(): Promise<void>
}

const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (e) {
    throw safeDbError(e)
  }
}

const toNode = (row: typeof homeExitNodes.$inferSelect): HomeNode => ({
  nodeId: row.nodeId,
  hostname: row.hostname,
  ipv4: row.ipv4,
  checkedAt: row.checkedAt
})

/** The store for member-facing code: every call goes through the member's scope. */
export function scopeHomeNodeStore(scope: MemberScope): HomeNodeStore {
  return {
    async get() {
      const [row] = await guarded(() => scope.select(homeExitNodes))
      return row ? toNode(row) : null
    },
    save: (node) =>
      guarded(() =>
        scope.transaction(async (s) => {
          await s.lock('home-route')
          if ((await s.update(homeExitNodes, node, eq(homeExitNodes.memberId, s.memberId))) === 0)
            await s.insert(homeExitNodes, node)
        })
      ),
    async clear() {
      await guarded(() => scope.remove(homeExitNodes, eq(homeExitNodes.memberId, scope.memberId)))
    }
  }
}

/** The store for the scheduler, which acts for a member it has no session for (a job names the member). */
export function dbHomeNodeStore(db: Db, memberId: string): HomeNodeStore {
  return {
    async get() {
      const [row] = await guarded(() => db.select().from(homeExitNodes).where(eq(homeExitNodes.memberId, memberId)))
      return row ? toNode(row) : null
    },
    save: (node) =>
      guarded(async () => {
        await db
          .insert(homeExitNodes)
          .values({ memberId, ...node })
          .onConflictDoUpdate({ target: homeExitNodes.memberId, set: node })
      }),
    async clear() {
      await guarded(() => db.delete(homeExitNodes).where(eq(homeExitNodes.memberId, memberId)))
    }
  }
}
