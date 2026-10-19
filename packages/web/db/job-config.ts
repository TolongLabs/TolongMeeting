import { parseJob, localParts, type AiConfig, type FormProvider, type JobConfig, type SpecEnv } from '@tm/core'
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from './index'
import { aiKeys, details, identities, members, mentionNames, occurrences, profiles, timetableEntries } from './schema'
import { openColumn } from './secrets'

/** The models the AI calls use. Summary, vision, form matching and live speech. */
export const DEFAULT_MODELS = {
  summary: 'qwen3.7-plus',
  vision: 'qwen3-vl-plus',
  formMatch: 'qwen-flash',
  asr: 'qwen3-asr-flash-realtime'
}

/** A Workspace ID is a plain identifier, so it can't change the host a key is sent to. */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9-]{3,64}$/

const INTERNATIONAL_HOST = 'dashscope-intl.aliyuncs.com'

/**
 * The DashScope config for one member. Without a Workspace ID it uses the Singapore (international) endpoints; with
 * one, the workspace endpoints in the same region.
 */
export function aiConfigFor(k: { dashscopeKey: string; workspaceId: string | null }): AiConfig {
  if (k.workspaceId !== null && !WORKSPACE_ID_PATTERN.test(k.workspaceId)) {
    throw new Error('Workspace ID is not a plain identifier')
  }
  const host = k.workspaceId ? `${k.workspaceId}.ap-southeast-1.maas.aliyuncs.com` : INTERNATIONAL_HOST
  return {
    baseUrl: `https://${host}/compatible-mode/v1`,
    apiKey: k.dashscopeKey,
    asrUrl: `wss://${host}/api-ws/v1/realtime`,
    models: DEFAULT_MODELS
  }
}

/** `2026-10-21T14:00:00+08:00`: the instant `d` as wall-clock time in `timeZone`, with that zone's offset. */
function isoWithOffset(d: Date, timeZone: string): string {
  const { date, hhmmss } = localParts(d, timeZone)
  const time = `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4)}`
  const wallAsUtc = Date.parse(`${date}T${time}Z`)
  const offsetMin = Math.round((wallAsUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000)
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * The `entry` of a job config for one occurrence: its timetable entry, with `start` and `end` as ISO strings in the
 * member's time zone and the offset, and `link` replaced by `{ kind: 'fixed', url }` when the member pasted a link.
 */
export async function buildEntrySnapshot(db: Db, occurrenceId: string): Promise<JobConfig['entry']> {
  const [row] = await db
    .select({ occurrence: occurrences, entry: timetableEntries, timeZone: members.timeZone })
    .from(occurrences)
    .innerJoin(members, eq(members.id, occurrences.memberId))
    .leftJoin(
      timetableEntries,
      and(eq(timetableEntries.id, occurrences.entryId), eq(timetableEntries.memberId, occurrences.memberId))
    )
    .where(eq(occurrences.id, occurrenceId))
  if (!row) throw new Error(`No occurrence ${occurrenceId}`)
  const { occurrence, entry, timeZone } = row
  if (!entry) throw new Error(`Occurrence ${occurrenceId} has no timetable entry`)
  return {
    name: entry.name,
    type: entry.type,
    start: isoWithOffset(occurrence.scheduledStart, timeZone),
    end: isoWithOffset(occurrence.scheduledEnd, timeZone),
    timeZone,
    link: occurrence.pastedLink ? { kind: 'fixed', url: occurrence.pastedLink } : entry.link,
    trustedSenders: entry.trustedSenders,
    transcription: entry.transcription,
    formDetails: entry.formDetails,
    attendanceKeywords: entry.attendanceKeywords
  }
}

const FORM_PROVIDERS: FormProvider[] = ['google', 'microsoft']

/**
 * The job config for one attempt of an occurrence, from its stored `entry_snapshot`. The identity must belong to the
 * occurrence's member. The DashScope key and the ntfy token are opened here and exist only in the result.
 */
export async function loadJobConfig(
  db: Db,
  master: Buffer,
  occurrenceId: string,
  opts: { attempt: number; control: { url: string; token: string } | null; env: SpecEnv }
): Promise<JobConfig> {
  const [occurrence] = await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId))
  if (!occurrence) throw new Error(`No occurrence ${occurrenceId}`)
  if (!occurrence.entrySnapshot) throw new Error(`Occurrence ${occurrenceId} has no entry snapshot`)
  const memberId = occurrence.memberId

  const [identity] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.id, occurrence.identityId), eq(identities.memberId, memberId)))
  if (!identity) throw new Error(`Occurrence ${occurrenceId} names an identity that is not its member's`)
  if ((identity.orgName === null) !== (identity.orgEmailDomain === null)) {
    throw new Error(`Identity ${identity.id} has only one of org_name and org_email_domain`)
  }
  const [profile] = await db
    .select({ accountStatus: profiles.accountStatus })
    .from(profiles)
    .where(and(eq(profiles.identityId, identity.id), eq(profiles.memberId, memberId)))
  if (!profile) throw new Error(`Identity ${identity.id} has no profile`)

  const [member] = await db.select().from(members).where(eq(members.id, memberId))
  if (!member) throw new Error(`No member ${memberId}`)
  const [keys] = await db.select().from(aiKeys).where(eq(aiKeys.memberId, memberId))
  if (!keys) throw new Error(`Member ${memberId} has no AI key`)
  if (!member.ntfyTopic || !member.ntfyTokenEnc) throw new Error(`Member ${memberId} has no ntfy topic`)

  const savedDetails = await db
    .select()
    .from(details)
    .where(eq(details.memberId, memberId))
    .orderBy(asc(details.position), asc(details.key))
  const mentions = await db
    .select({ name: mentionNames.name })
    .from(mentionNames)
    .where(eq(mentionNames.memberId, memberId))
    .orderBy(asc(mentionNames.id))

  return parseJob({
    occurrenceId,
    attempt: opts.attempt,
    entry: occurrence.entrySnapshot,
    identity: {
      id: identity.id,
      name: identity.name,
      zoomGuestName: identity.zoomGuestName,
      formProviders: FORM_PROVIDERS.filter((p) => profile.accountStatus[p]?.signedIn === true),
      organisation:
        identity.orgName !== null && identity.orgEmailDomain !== null
          ? { name: identity.orgName, emailDomain: identity.orgEmailDomain }
          : null
    },
    member: {
      id: memberId,
      displayName: member.displayName,
      mentionNames: mentions.map((m) => m.name),
      details: savedDetails.map((d) => ({ key: d.key, value: d.value, labels: d.labels }))
    },
    ai: aiConfigFor({
      dashscopeKey: openColumn(master, memberId, 'ai_keys.dashscope_key', keys.dashscopeKeyEnc),
      workspaceId: keys.workspaceId
    }),
    ntfy: {
      url: opts.env.ntfyUrl,
      topic: member.ntfyTopic,
      token: openColumn(master, memberId, 'members.ntfy_token', member.ntfyTokenEnc)
    },
    dataDir: `${opts.env.dataRoot}/occurrences/${occurrenceId}`,
    profileDir: `${opts.env.profileRoot}/${identity.id}/work`,
    control: opts.control
  })
}
