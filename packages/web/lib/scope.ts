import { resolve, sep } from 'node:path'
import { symmetricDecrypt } from 'better-auth/crypto'
import { and, asc, eq, inArray, isNull, ne, notExists, sql, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { ACTIVE_STATES } from '@tm/core'
import { getDb, type Db } from '../db/index'
import { identityClashes, syncOccurrences } from '../db/occurrences'
import type { Queue } from '../db/queues'
import {
  artefacts,
  auth_account,
  auth_session,
  auth_user,
  MEMBER_OWNED,
  members,
  occurrences,
  pkOf,
  signinSessions,
  type MemberRole
} from '../db/schema'
import { authSecret } from './auth-secret'
import { ntfyUsername, NtfyAdminError, type NtfyAdmin } from './ntfy-admin'

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
  /** Takes a transaction-level advisory lock named `name` for this member. Throws outside `transaction`. */
  lock(name: string): Promise<void>
  artefactFile(occurrenceId: string, relPath: string): Promise<string | null>
  /** Brings this member's future scheduled occurrences in line with their timetable (see `syncOccurrences`). */
  syncOccurrences(queue: Queue, now: Date): Promise<{ created: number; removed: number }>
  /** Overlapping occurrences of one of this member's identities in `[from, to)`, winner first. */
  identityClashes(identityId: string, from: Date, to: Date): ReturnType<typeof identityClashes>
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

export function createScope(db: Db, memberId: string, inTransaction = false): MemberScope {
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
      return db.transaction((tx) => fn(createScope(tx, memberId, true)))
    },

    async lock(name) {
      if (!inTransaction) throw new Error('lock() is only valid inside scope.transaction()')
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name + ':' + memberId}, 0))`)
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
    },

    syncOccurrences(queue, now) {
      return syncOccurrences(db, queue, now, memberId)
    },

    identityClashes(identityId, from, to) {
      return identityClashes(db, identityId, from, to, memberId)
    }
  }
}

/** The scope of the member linked to a Better Auth user, or `null` when no member is linked. Uses `getDb()`. */
export async function scopeForAuthUser(authUserId: string): Promise<MemberScope | null> {
  const db = getDb()
  const [row] = await db.select({ id: members.id }).from(members).where(eq(members.authUserId, authUserId))
  return row ? createScope(db, row.id) : null
}

/**
 * What sign-in and the daily organisation check need to know about members and their Better Auth users. This is not a
 * `MemberScope`: it acts before a member is known (or across all of them), and it never reads member-owned rows.
 */
export interface AuthScope {
  /**
   * The GitHub access token stored for a Better Auth user, decrypted, or `null` when there is none. Throws when the
   * stored value can't be decrypted (another master key, or a token stored in plain text).
   */
  githubToken(authUserId: string): Promise<string | null>
  /** The member added for this GitHub user: matched on `github_id`, else on the lower-cased login while `github_id` is unset. */
  memberForGithub(githubId: number, login: string): Promise<{ id: string } | null>
  linkMember(memberId: string, githubId: number, authUserId: string): Promise<void>
  /** Members linked to a Better Auth user that has at least one session, for the daily check. */
  linkedMembers(): Promise<{ memberId: string; authUserId: string }[]>
  /** Deletes every session of a Better Auth user. */
  endSessions(authUserId: string): Promise<void>
  /**
   * Deletes a Better Auth user, and with it their account and GitHub token, unless a member is linked to it. Used when
   * sign-in is refused so that a stranger's token isn't kept.
   */
  discardUnlinkedUser(authUserId: string): Promise<void>
}

/**
 * `master` is the 32-byte master key: Better Auth seals OAuth tokens under a secret derived from it (`encryptOAuthTokens`),
 * and `githubToken` opens them with the same one.
 */
export function authScope(master: Buffer, db: Db = getDb()): AuthScope {
  const secret = authSecret(master)
  return {
    async githubToken(authUserId) {
      const [row] = await db
        .select({ token: auth_account.accessToken })
        .from(auth_account)
        .where(and(eq(auth_account.userId, authUserId), eq(auth_account.providerId, 'github')))
      return row?.token ? symmetricDecrypt({ key: secret, data: row.token }) : null
    },

    async memberForGithub(githubId, login) {
      const [byId] = await db.select({ id: members.id }).from(members).where(eq(members.githubId, githubId))
      if (byId) return byId
      const [byLogin] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.githubLogin, login.toLowerCase()), isNull(members.githubId)))
      return byLogin ?? null
    },

    async linkMember(memberId, githubId, authUserId) {
      await db.update(members).set({ githubId, authUserId }).where(eq(members.id, memberId))
    },

    async linkedMembers() {
      const rows = await db
        .selectDistinct({ memberId: members.id, authUserId: auth_session.userId })
        .from(members)
        .innerJoin(auth_session, eq(auth_session.userId, members.authUserId))
      return rows
    },

    async endSessions(authUserId) {
      await db.delete(auth_session).where(eq(auth_session.userId, authUserId))
    },

    async discardUnlinkedUser(authUserId) {
      await db
        .delete(auth_user)
        .where(
          and(
            eq(auth_user.id, authUserId),
            notExists(db.select({ id: members.id }).from(members).where(eq(members.authUserId, authUserId)))
          )
        )
    }
  }
}

export interface NewMember {
  githubLogin: string
  displayName: string
  timeZone?: string
  role?: 'member' | 'admin'
}

/** Adds a member by GitHub login (the admin's invitation). Throws when the login already exists. Used by `scripts/add-member.ts`. */
export async function addMember(input: NewMember, db: Db = getDb()): Promise<{ id: string }> {
  const [row] = await db
    .insert(members)
    .values({
      githubLogin: input.githubLogin.toLowerCase(),
      displayName: input.displayName,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      role: input.role ?? 'member'
    })
    .returning({ id: members.id })
  return row!
}

/** Refusal: the member has a meeting in progress or a sign-in that hasn't ended. The message is safe to show. */
export class MemberBusyError extends Error {
  constructor() {
    super('This member has a meeting or a sign-in in progress.')
    this.name = 'MemberBusyError'
  }
}

/** Refusal: the change would leave no admin. The message is safe to show. */
export class LastAdminError extends Error {
  constructor() {
    super('The last admin cannot be removed or made a member.')
    this.name = 'LastAdminError'
  }
}

export interface AdminMember {
  id: string
  githubLogin: string
  displayName: string
  role: MemberRole
  timeZone: string
  createdAt: Date
}

/**
 * What an admin may do. It reads and writes only the `members` row (login, name, zone, role) and the operational state
 * that decides whether a member can be removed. It never reads member-owned content: no meeting names, links,
 * transcripts, summaries, forms, details or keys. `test/admin.test.ts` proves no seeded content reaches its results.
 */
export interface AdminScope {
  listMembers(): Promise<AdminMember[]>
  addMember(input: { githubLogin: string; displayName: string; timeZone: string; role: MemberRole }): Promise<string>
  setRole(id: string, role: MemberRole): Promise<void>
  /**
   * Removes the member's ntfy user, then the member row (which cascades to their rows), then their Better Auth user (so
   * their GitHub token goes too). A missing ntfy user (404) counts as already removed. Any other ntfy failure throws and
   * leaves the member in place, so the call can be retried.
   */
  removeMember(id: string, ntfy: NtfyAdmin): Promise<void>
}

/**
 * The admin's scope, over the database. Admins are checked by `requireAdmin()` from the member row's role. Every change
 * runs in a transaction that locks the admin rows first, so two admins can't demote or remove each other at once.
 */
export function adminScope(db: Db = getDb()): AdminScope {
  const lockAdmins = (tx: Db) =>
    tx.select({ id: members.id }).from(members).where(eq(members.role, 'admin')).for('update')

  return {
    async listMembers() {
      return db
        .select({
          id: members.id,
          githubLogin: members.githubLogin,
          displayName: members.displayName,
          role: members.role,
          timeZone: members.timeZone,
          createdAt: members.createdAt
        })
        .from(members)
        .orderBy(asc(members.createdAt))
    },

    async addMember(input) {
      return (await addMember(input, db)).id
    },

    async setRole(id, role) {
      await db.transaction(async (tx) => {
        const admins = await lockAdmins(tx)
        if (role === 'member' && admins.length === 1 && admins[0]!.id === id) throw new LastAdminError()
        await tx.update(members).set({ role }).where(eq(members.id, id))
      })
    },

    async removeMember(id, ntfy) {
      await db.transaction(async (tx) => {
        const admins = await lockAdmins(tx)
        const [member] = await tx
          .select({ role: members.role, authUserId: members.authUserId })
          .from(members)
          .where(eq(members.id, id))
          .for('update')
        if (!member) throw new Error(`No member ${id}`)
        if (member.role === 'admin' && admins.length === 1) throw new LastAdminError()

        const active = await tx.$count(
          occurrences,
          and(eq(occurrences.memberId, id), inArray(occurrences.state, [...ACTIVE_STATES]))
        )
        const sessions = await tx.$count(
          signinSessions,
          and(eq(signinSessions.memberId, id), ne(signinSessions.state, 'ended'))
        )
        if (active > 0 || sessions > 0) throw new MemberBusyError()

        try {
          await ntfy.deleteUser(ntfyUsername(id))
        } catch (err) {
          if (!(err instanceof NtfyAdminError && err.status === 404)) throw err
        }
        await tx.delete(members).where(eq(members.id, id))
        if (member.authUserId) await tx.delete(auth_user).where(eq(auth_user.id, member.authUserId))
      })
    }
  }
}
