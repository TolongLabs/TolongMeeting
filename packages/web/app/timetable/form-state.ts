// Types shared by the entry form (a client component), its server actions and the pages. Nothing here touches the
// server, so the client component can import it.

export type ChatAppName = 'whatsapp' | 'discord' | 'teams'

/** What the entry form holds, as the text the member typed or chose. Never holds a stored meeting link. */
export interface EntryFormValues {
  id: string
  name: string
  type: 'lecture' | 'work'
  repeatKind: 'once' | 'weekly'
  /** The date of a one-off entry, or the first day of a weekly one (`YYYY-MM-DD`). */
  date: string
  /** ISO weekdays (`'1'` is Monday) of a weekly entry. */
  days: string[]
  start: string
  end: string
  identityId: string
  linkKind: 'keep' | 'fixed' | 'chat' | 'paste'
  url: string
  chatApp: ChatAppName
  chat: string
  trustedSenders: string
  courseCode: string
  section: string
  lecturer: string
  keywords: string
  transcription: 'live' | 'native'
}

export interface EntryFormClash {
  loser: string
  winner: string
  when: string
}

export type EntryFormState =
  | { status: 'idle' }
  | {
      status: 'error'
      /** A problem that belongs to no single field. */
      message?: string
      /** Where the member can fix `message`. */
      help?: { href: string; label: string }
      /** Field id to message. */
      fields: Record<string, string>
    }
  | { status: 'saved'; entryId: string; clashes: EntryFormClash[] }

export interface ChatOption {
  app: ChatAppName
  enabled: boolean
  note: string | null
}

export interface EntryFormCopy {
  recording: string
  employer: string
  banRisk: string
  teamsPresence: string
  trustedChatHint: string
  chat: Record<ChatAppName, { label: string; placeholder: string; hint: string }>
}

export interface EntryFormProps {
  initial: EntryFormValues
  editing: boolean
  timeZone: string
  identities: { id: string; name: string; where: string }[]
  /** The chat apps the form offers, by identity id. */
  chatOptions: Record<string, ChatOption[]>
  copy: EntryFormCopy
  /** The host and meeting id of the stored link (edit only), never the link. */
  currentLink: string | null
  mentionNames: string[]
}
