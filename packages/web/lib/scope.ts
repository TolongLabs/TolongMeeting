import { resolve, sep } from 'node:path'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { getDb, type Db } from '../db/index'
import { artefacts, MEMBER_OWNED, members, pkOf } from '../db/schema'

/** Every table with a `memberId` column. */
export type MemberOwnedTable = (typeof MEMBER_OWNED)[keyof typeof MEMBER_OWNED]
export type MemberRow = typeof members.$inferSelect

/**
 * The only way member-facing code reads or writes member-owned rows. Every call is limited to one member: reads and
 * deletes add `member_id = memberId` to their `where`, inserts store `memberId`, and updates can't change it.
 */
export interface MemberScope {
  readonly memberId: string
  me(): Promise<MemberRow>
  updateMe(set: Partial<Pick<MemberRow, 'displayName' | 'timeZone' | 'ntfyTopic' | 'ntfyTokenEnc'>>): Promise<void>
  select<T extends MemberOwnedTable>(table: T, where?: SQL): Promise<T['$inferSelect'][]>
  insert<T extends MemberOwnedTable>(table: T, values: Omit<T['$inferInsert'], 'memberId'>): Promise<T['$inferSelect']>
  update<T extends MemberOwnedTable>(table: T, set: Partial<T['$inferInsert']>, where: SQL): Promise<number>
  remove<T extends MemberOwnedTable>(table: T, where: SQL): Promise<number>
  transaction<R>(fn: (s: MemberScope) => Promise<R>): Promise<R>
  artefactFile(occurrenceId: string, relPath: string): Promise<string | null>
}

function ownedBy(table: MemberOwnedTable, memberId: string, where?: SQL): SQL {
  const mine = eq(table.memberId, memberId)
  // The caller's `where` is parenthesised so a bare `or` (`a or b`) can't escape the member filter.
  return where ? and(mine, sql`(${where})`)! : mine
}

const ME_KEYS = ['displayName', 'timeZone', 'ntfyTopic', 'ntfyTokenEnc'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function withoutMemberId<T extends object>(values: T): Omit<T, 'memberId'> {
  const copy: Record<string, unknown> = { ...(values as Record<string, unknown>) }
  delete copy.memberId
  return copy as Omit<T, 'memberId'>
}

export function createScope(db: Db, memberId: string): MemberScope {
  return {
    memberId,

    async me() {
      const [row] = await db.select().from(members).where(eq(members.id, memberId))
      if (!row) throw new Error(`No member ${memberId}`)
      return row
    },

    async updateMe(set) {
      // A runtime whitelist: a caller that casts past the type can't set `role`, `githubLogin` or any other column.
      const unknown = Object.keys(set).filter((key) => !(ME_KEYS as readonly string[]).includes(key))
      if (unknown.length > 0) throw new Error(`updateMe: not a member setting: ${unknown.join(', ')}`)
      const allowed: Partial<MemberRow> = {}
      for (const key of ME_KEYS) if (set[key] !== undefined) Object.assign(allowed, { [key]: set[key] })
      if (Object.keys(allowed).length === 0) return
      await db.update(members).set(allowed).where(eq(members.id, memberId))
    },

    async select(table, where) {
      // Drizzle can't infer a select over the union of table types, so the table is widened here and the rows typed below.
      return (await db
        .select()
        .from(table as PgTable)
        .where(ownedBy(table, memberId, where))) as never
    },

    async insert(table, values) {
      const [row] = await db
        .insert(table)
        .values({ ...values, memberId } as never)
        .returning()
      return row as never
    },

    async update(table, set, where) {
      const rows = await db
        .update(table)
        .set(withoutMemberId(set) as never)
        .where(ownedBy(table, memberId, where))
        .returning({ id: pkOf(table) })
      return rows.length
    },

    async remove(table, where) {
      const rows = await db
        .delete(table)
        .where(ownedBy(table, memberId, where))
        .returning({ id: pkOf(table) })
      return rows.length
    },

    transaction(fn) {
      return db.transaction((tx) => fn(createScope(tx, memberId)))
    },

    async artefactFile(occurrenceId, relPath) {
      if (!UUID.test(occurrenceId)) return null
      const root = process.env.TM_DATA_ROOT
      if (!root) throw new Error('TM_DATA_ROOT is not set')
      const dir = resolve(root, 'occurrences', occurrenceId)
      const file = resolve(dir, relPath)
      // Lexical containment only. The serving route must also `realpath` the file and check it is still inside `dir`,
      // because a symlink inside the occurrence directory passes this check.
      if (!file.startsWith(dir + sep)) return null
      const [row] = await db
        .select({ id: artefacts.id })
        .from(artefacts)
        .where(
          and(eq(artefacts.memberId, memberId), eq(artefacts.occurrenceId, occurrenceId), eq(artefacts.path, relPath))
        )
      return row ? file : null
    }
  }
}

/** The scope of the member linked to a Better Auth user, or `null` when no member is linked. Uses `getDb()`. */
export async function scopeForAuthUser(authUserId: string): Promise<MemberScope | null> {
  const db = getDb()
  const [row] = await db.select({ id: members.id }).from(members).where(eq(members.authUserId, authUserId))
  return row ? createScope(db, row.id) : null
}
