import { watchGateFromEnv } from '@tm/core'
import { loadDetails } from '../../lib/details'
import {
  BAN_RISK_NOTICE,
  CHAT_FIELD_COPY,
  chatAppOptions,
  TEAMS_PRESENCE_NOTE,
  TRUSTED_SENDERS_CHAT_HINT
} from '../../lib/link-notices'
import type { MemberScope } from '../../lib/scope'
import { RECORDING_NOTICE, EMPLOYER_NOTICE } from '../../lib/timetable'
import { todayIn, type EntryRow, type IdentityRow } from '../../lib/timetable-view'
import { describeWhere, entryFormValues, currentLinkText } from './entry-form-data'
import { EntryForm } from './entry-form'

/** The entry form for the new and edit pages, filled from `entry` (an edit) or with the defaults (a new entry). */
export async function EntryFormFor(props: { scope: MemberScope; entry: EntryRow | null; identities: IdentityRow[] }) {
  const { scope, entry, identities } = props
  const [me, { mentionNames }] = await Promise.all([scope.me(), loadDetails(scope)])
  const gate = watchGateFromEnv(process.env)
  return (
    <EntryForm
      editing={entry !== null}
      initial={entryFormValues(entry, { identityId: identities[0]!.id, today: todayIn(me.timeZone, new Date()) })}
      timeZone={me.timeZone}
      identities={identities.map((i) => ({ id: i.id, name: i.name, where: describeWhere(i.runLocation) }))}
      chatOptions={Object.fromEntries(identities.map((i) => [i.id, chatAppOptions(i.runLocation, gate)]))}
      copy={{
        recording: RECORDING_NOTICE,
        employer: EMPLOYER_NOTICE,
        banRisk: BAN_RISK_NOTICE,
        teamsPresence: TEAMS_PRESENCE_NOTE,
        trustedChatHint: TRUSTED_SENDERS_CHAT_HINT,
        chat: CHAT_FIELD_COPY
      }}
      currentLink={entry ? currentLinkText(entry) : null}
      mentionNames={mentionNames}
    />
  )
}
