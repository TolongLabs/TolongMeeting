// The meetings the meeting-page specs open: a completed lecture with everything the page shows, a bot that is just
// uploading (it has already left), one stuck on a rejected AI key, and a pasted link for the running meeting.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { schema, type Db } from '../../db'
import { hashEventData } from '../../db/transitions'

const DAY = 24 * 3_600_000
const HOUR = 3_600_000

/** One pixel: the slide and screenshot files only have to be images. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

export const LINK_PASSCODE = 'LIVEPASS'
export const LIVE_ZOOM_ID = '11111111111'
export const UPLOADING_PASSCODE = 'UPLOADPASS'
export const UPLOADING_ZOOM_ID = '22222222222'

export const SUMMARY = `Algorithms, Lecture 5 (Sun 18 Oct, 14:00 to 16:00)

Do next: Submit problem set 3 by Fri 23 Oct, 23:59.

Attendance: submitted at 14:05 (Google Forms) ✓

To do
1. Problem set 3 (due Fri 23 Oct, 23:59)

What was covered
1. Merge sort, from [the course page](https://example.edu/algorithms)
2. A bad link [click here](javascript:alert(1)) and a <script>window.hacked = 1</script> tag and <b>raw bold</b>

Details: https://example.edu/meetings/5
`

const TRANSCRIPT = `# Algorithms: transcript

Sun 18 Oct 2026, 14:00 to 16:00 (Asia/Kuala_Lumpur). Live transcription; times are from the recording start, and names may be misheard.

## Transcript

**[00:00:05]** Today we cover Mergesort _(as heard: "merge sword")_ and its cost.

_[00:20:00] Recording gap of 2 minutes._

**[00:22:10]** Problem set three is due on Friday.
`

const CHAT = `# Algorithms: chat

2 messages from the meeting chat, in posting order. Meeting links are removed.

## Messages

**[14:03] Dr Lim (host):** Attendance form: see the QR code.

> **[14:04] Aina:** Thank you, <img src=x onerror=alert(1)>
`

export interface MeetingIds {
  completed: string
  uploading: string
  stuck: string
}

interface Seeds {
  db: Db
  dataRoot: string
  memberId: string
  identityId: string
  entryId: string
  now: number
}

/** Adds the meetings and their files under `dataRoot/occurrences/<id>/`. */
export async function seedMeetings({ db, dataRoot, memberId, identityId, entryId, now }: Seeds): Promise<MeetingIds> {
  const base = { memberId, entryId, identityId, entryType: 'lecture', transcription: 'live' } as const

  const start = new Date(now - 2 * DAY)
  const [completed] = await db
    .insert(schema.occurrences)
    .values({
      ...base,
      entryName: 'Algorithms',
      state: 'completed',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * HOUR),
      actualStart: new Date(start.getTime() + 60_000),
      actualEnd: new Date(start.getTime() + 2 * HOUR),
      participants: 23,
      recording: false,
      deleteAfter: new Date(now + 28 * DAY)
    })
    .returning()
  const occurrenceId = completed!.id
  const write = async (rel: string, bytes: string | Buffer, kind: (typeof schema.artefacts.$inferInsert)['kind']) => {
    const file = join(dataRoot, 'occurrences', occurrenceId, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    await db
      .insert(schema.artefacts)
      .values({ occurrenceId, memberId, kind, path: rel, bytes: Buffer.byteLength(bytes) })
  }
  await write('out/2026-10-18 1400 Algorithms.md', SUMMARY, 'summary')
  await write('out/transcript.md', TRANSCRIPT, 'transcript')
  await write('out/chat.md', CHAT, 'chat')
  await write(
    'slides/slides.json',
    JSON.stringify([
      { n: 1, file: 'slides/01.webp', atMs: 1000, title: 'Merge sort', text: 'Split, sort each half, merge.' },
      { n: 2, file: 'slides/02.webp', atMs: 60_000, title: '', text: '', failed: true }
    ]),
    'slides_json'
  )
  await write('slides/01.webp', PNG, 'slide_image')
  await write('slides/02.webp', PNG, 'slide_image')
  await write('recording/meeting.mp4', Buffer.alloc(2048), 'recording')

  const submitted = 'aaaaaaaaaaaaaaaa'
  await db.insert(schema.forms).values([
    {
      occurrenceId,
      memberId,
      formKey: submitted,
      url: 'https://docs.google.com/forms/d/e/attendance/viewform',
      source: 'qr',
      sender: null,
      trustReason: 'qr_on_screen',
      state: 'submitted',
      seenAt: new Date(start.getTime() + 5 * 60_000),
      fieldsFilled: ['full_name', 'student_id'],
      result: 'Confirmation page seen.'
    },
    {
      occurrenceId,
      memberId,
      formKey: 'bbbbbbbbbbbbbbbb',
      url: 'https://docs.google.com/forms/d/e/other/viewform',
      source: 'meeting_chat',
      sender: 'Someone',
      state: 'untrusted',
      seenAt: new Date(start.getTime() + 30 * 60_000)
    }
  ])
  await write(`forms/${submitted}/filled.png`, PNG, 'form_screenshot')
  await write(`forms/${submitted}/confirmation.png`, PNG, 'form_screenshot')

  const events = [
    { at: new Date(start.getTime() + 60_000), type: 'joined' as const, data: {} },
    { at: new Date(start.getTime() + 5 * 60_000), type: 'form' as const, data: { outcome: 'submitted' } },
    // Free text and a meeting link in event data must not reach the page.
    {
      at: new Date(start.getTime() + 6 * 60_000),
      type: 'error' as const,
      data: { where: 'chat watcher', message: 'Boom from https://example.zoom.us/j/99999999999?pwd=EVENTPASS' }
    },
    { at: new Date(start.getTime() + 2 * HOUR), type: 'state' as const, data: { state: 'completed' } }
  ]
  await db
    .insert(schema.events)
    .values(events.map((e) => ({ ...e, occurrenceId, memberId, attempt: 1, dataHash: hashEventData(e.data) })))

  // The bot has left and is saving the recording: a take over answers at once, with the full link.
  const [uploading] = await db
    .insert(schema.occurrences)
    .values({
      ...base,
      entryName: 'Wrapping up',
      entryType: 'work',
      state: 'uploading',
      scheduledStart: new Date(now - 3 * HOUR),
      scheduledEnd: new Date(now - 2 * HOUR),
      actualStart: new Date(now - 3 * HOUR),
      linkUsed: `https://example.zoom.us/j/${UPLOADING_ZOOM_ID}`,
      pastedLink: `https://example.zoom.us/j/${UPLOADING_ZOOM_ID}?pwd=${UPLOADING_PASSCODE}`,
      deleteAfter: new Date(now + 30 * DAY)
    })
    .returning()

  const [stuck] = await db
    .insert(schema.occurrences)
    .values({
      ...base,
      entryName: 'Stuck summary',
      state: 'post_processing',
      stateReason: 'ai_key_error',
      scheduledStart: new Date(now - 5 * DAY),
      scheduledEnd: new Date(now - 5 * DAY + HOUR),
      deleteAfter: new Date(now + 25 * DAY)
    })
    .returning()

  return { completed: occurrenceId, uploading: uploading!.id, stuck: stuck!.id }
}

/** The running meeting ("Live standup") gets a link the pages must never show. Returns its id. */
export async function giveLiveMeetingALink(db: Db): Promise<string> {
  const [live] = await db
    .update(schema.occurrences)
    .set({
      linkUsed: `https://example.zoom.us/j/${LIVE_ZOOM_ID}`,
      pastedLink: `https://example.zoom.us/j/${LIVE_ZOOM_ID}?pwd=${LINK_PASSCODE}`
    })
    .where(eq(schema.occurrences.entryName, 'Live standup'))
    .returning()
  return live!.id
}
