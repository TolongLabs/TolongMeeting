import { readFile } from 'node:fs/promises'
import { and, eq, gte, inArray, lte, ne, notInArray } from 'drizzle-orm'
import { ACCOUNT_KINDS, ACTIVE_STATES, formatWhen, type AccountKind, type OccurrenceState } from '@tm/core'
import { aiKeys, artefacts, identities, occurrences, profiles } from '../db/schema'
import type { MemberScope } from './scope'

const DAY = 24 * 3_600_000
/** Occurrences the home page lists as upcoming, and how far ahead they are looked for. */
const UPCOMING_LIMIT = 10
const UPCOMING_DAYS = 14
const RECENT_LIMIT = 5
/** States after the worker has left the meeting: the pipeline is still running. */
const AFTER_MEETING: OccurrenceState[] = ['transcribing', 'waiting_for_pc', 'post_processing']
const DELETING_SOON_DAYS = 3

export interface OccurrenceCard {
  id: string
  name: string
  when: string
  state: OccurrenceState
}

export interface HomeWarning {
  kind: 'no_ai_key' | 'ai_key_failing' | 'ntfy_not_set_up' | 'account_signed_out'
  identity?: string
  account?: AccountKind
}

export interface HomeData {
  upcoming: OccurrenceCard[]
  inProgress: OccurrenceCard[]
  recent: (OccurrenceCard & { doNext: string | null })[]
  warnings: HomeWarning[]
  deletingSoon: OccurrenceCard[]
}

const DO_NEXT = 'Do next:'

/** The first line of the member's summary that starts with `Do next:`, or `null` when there is none. */
async function doNextOf(scope: MemberScope, occurrenceId: string): Promise<{ found: boolean; doNext: string | null }> {
  const [summary] = await scope.select(
    artefacts,
    and(eq(artefacts.occurrenceId, occurrenceId), eq(artefacts.kind, 'summary'))
  )
  if (!summary) return { found: false, doNext: null }
  const file = await scope.artefactFile(occurrenceId, summary.path)
  if (!file) throw new Error(`Summary artefact ${summary.id} is outside its occurrence directory`)
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
  return { found: true, doNext: lines.find((line) => line.startsWith(DO_NEXT)) ?? null }
}

/**
 * What the member's home page shows, read only through `scope`. `now` decides the windows: upcoming meetings within 14
 * days, and occurrences whose data is deleted within 3 days. Times are in the member's own time zone.
 */
export async function homeData(scope: MemberScope, now: Date): Promise<HomeData> {
  const me = await scope.me()
  const card = (o: {
    id: string
    entryName: string
    scheduledStart: Date
    state: OccurrenceState
  }): OccurrenceCard => ({
    id: o.id,
    name: o.entryName,
    when: formatWhen(o.scheduledStart, me.timeZone),
    state: o.state
  })
  const byStart = (a: { scheduledStart: Date }, b: { scheduledStart: Date }) =>
    a.scheduledStart.getTime() - b.scheduledStart.getTime()

  const upcoming = (
    await scope.select(
      occurrences,
      and(
        eq(occurrences.state, 'scheduled'),
        gte(occurrences.scheduledStart, now),
        lte(occurrences.scheduledStart, new Date(now.getTime() + UPCOMING_DAYS * DAY))
      )
    )
  )
    .sort(byStart)
    .slice(0, UPCOMING_LIMIT)
    .map(card)

  const inProgress = (await scope.select(occurrences, inArray(occurrences.state, [...ACTIVE_STATES, ...AFTER_MEETING])))
    .sort(byStart)
    .map(card)

  const recent: HomeData['recent'] = []
  const completed = (await scope.select(occurrences, eq(occurrences.state, 'completed'))).sort((a, b) => byStart(b, a))
  for (const o of completed) {
    if (recent.length === RECENT_LIMIT) break
    const { found, doNext } = await doNextOf(scope, o.id)
    if (found) recent.push({ ...card(o), doNext })
  }

  const deletingSoon = (
    await scope.select(
      occurrences,
      and(
        ne(occurrences.state, 'deleted'),
        notInArray(occurrences.state, [...ACTIVE_STATES]),
        lte(occurrences.deleteAfter, new Date(now.getTime() + DELETING_SOON_DAYS * DAY))
      )
    )
  )
    .sort((a, b) => a.deleteAfter.getTime() - b.deleteAfter.getTime())
    .map(card)

  const warnings: HomeWarning[] = []
  const [key] = await scope.select(aiKeys)
  if (!key) warnings.push({ kind: 'no_ai_key' })
  else if (!key.testOk) warnings.push({ kind: 'ai_key_failing' })
  if (!me.ntfyTopic || !me.ntfyTokenEnc) warnings.push({ kind: 'ntfy_not_set_up' })

  const names = new Map((await scope.select(identities)).map((i) => [i.id, i.name]))
  for (const profile of await scope.select(profiles)) {
    for (const account of ACCOUNT_KINDS) {
      if (profile.accountStatus[account]?.signedIn === false) {
        warnings.push({ kind: 'account_signed_out', identity: names.get(profile.identityId), account })
      }
    }
  }

  return { upcoming, inProgress, recent, warnings, deletingSoon }
}
