import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ACCOUNT_KINDS, type AccountKind } from '@tm/core/control'
import { identities, profiles, RUN_LOCATIONS, timetableEntries } from '../db/schema'
import type { MemberScope } from './scope'

export type IdentityRow = typeof identities.$inferSelect

/** A refused change: the message is safe to show the member. */
export class InUseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InUseError'
  }
}

/** Input that failed validation. The message is safe to show the member and names no values. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

const ACCOUNT_LABELS: Record<AccountKind, string> = {
  zoom: 'Zoom',
  microsoft: 'Microsoft',
  google: 'Google',
  whatsapp: 'WhatsApp Web',
  discord: 'Discord',
  teams: 'Teams'
}

// A blank form field means "not given", not an invalid value.
const blankAsAbsent = (value: unknown) => (value === '' ? undefined : value)
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const IdentityInputSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    runLocation: z.enum(RUN_LOCATIONS).refine((value) => value === 'server', {
      message: 'Only "Server" is available until run locations are added.'
    }),
    zoomGuestName: z.string().trim().min(1).max(64),
    orgName: z.preprocess(blankAsAbsent, z.string().trim().min(1).max(100).optional()),
    orgEmailDomain: z.preprocess(
      blankAsAbsent,
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(DOMAIN, { message: 'Enter a bare domain such as uni.edu.my, with no @ or web address.' })
        .optional()
    )
  })
  .refine((value) => (value.orgName === undefined) === (value.orgEmailDomain === undefined), {
    message: 'Give both the organisation name and its email domain, or neither.',
    path: ['orgEmailDomain']
  })

function parseInput(input: unknown): z.infer<typeof IdentityInputSchema> {
  const parsed = IdentityInputSchema.safeParse(input)
  if (!parsed.success) throw new InputError(parsed.error.issues[0]!.message)
  return parsed.data
}

function settings(value: z.infer<typeof IdentityInputSchema>) {
  return {
    name: value.name,
    runLocation: value.runLocation,
    zoomGuestName: value.zoomGuestName,
    orgName: value.orgName ?? null,
    orgEmailDomain: value.orgEmailDomain ?? null
  }
}

/** Refuses a name the member already uses for another identity (the unique constraint would fail with a raw error). */
async function assertNameFree(scope: MemberScope, name: string, exceptId?: string): Promise<void> {
  const taken = (await scope.select(identities)).some((row) => row.name === name && row.id !== exceptId)
  if (taken) throw new InputError(`You already have an identity called "${name}".`)
}

/** Creates an identity for the member and its profile. */
export async function createIdentity(scope: MemberScope, input: unknown): Promise<IdentityRow> {
  const value = parseInput(input)
  return scope.transaction(async (s) => {
    await assertNameFree(s, value.name)
    const identity = await s.insert(identities, settings(value))
    await s.insert(profiles, { identityId: identity.id })
    return identity
  })
}

/** The member's identities, oldest first. */
export async function listIdentities(scope: MemberScope): Promise<IdentityRow[]> {
  const rows = await scope.select(identities)
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/** Replaces an identity's settings. Only the member's own identities can be changed. */
export async function updateIdentity(scope: MemberScope, id: string, input: unknown): Promise<void> {
  const value = parseInput(input)
  await scope.transaction(async (s) => {
    await assertNameFree(s, value.name, id)
    const changed = await s.update(identities, settings(value), eq(identities.id, id))
    if (changed === 0) throw new Error('No such identity.')
  })
}

/**
 * Deletes an identity. Timetable entries that use it block the delete (the `restrict` foreign key is the backstop), and so
 * does a profile that a meeting or sign-in holds.
 */
export async function deleteIdentity(scope: MemberScope, id: string): Promise<void> {
  await scope.transaction(async (s) => {
    const [profile] = await s.select(profiles, eq(profiles.identityId, id))
    if (!profile) throw new Error('No such identity.')
    const [entry] = await s.select(timetableEntries, eq(timetableEntries.identityId, id))
    if (entry) throw new InUseError('This identity has timetable entries.')
    if (profile.heldBy !== null) throw new InUseError('This identity is in use by a meeting or a sign-in.')
    await s.remove(identities, eq(identities.id, id))
  })
}

/** Each account the identity can use, in `ACCOUNT_KINDS` order. `null` means never verified or never signed in. */
export async function accountStatus(
  scope: MemberScope,
  identityId: string
): Promise<{ kind: AccountKind; label: string; verifiedAt: string | null; signedIn: boolean | null }[]> {
  const [profile] = await scope.select(profiles, eq(profiles.identityId, identityId))
  if (!profile) throw new Error('No such identity.')
  return ACCOUNT_KINDS.map((kind) => {
    const status = profile.accountStatus[kind]
    return {
      kind,
      label: ACCOUNT_LABELS[kind],
      verifiedAt: status?.verifiedAt ?? null,
      signedIn: status?.signedIn ?? null
    }
  })
}
