import { chatJson } from '@tm/ai'
import { localParts, type ChatMessage, type JobConfig } from '@tm/core'
import { z } from 'zod'
import { orderChat, stripInviteLinks } from '../chat'
import type { Slide } from '../slides'

const Source = z.enum(['slide', 'lecturer_chat', 'speech'])

export const InventorySchema = z.object({
  sessionLabel: z.string().nullable(),
  nextAction: z.string().nullable(),
  items: z.array(
    z.object({
      kind: z.enum(['deadline', 'task', 'announcement', 'link']),
      text: z.string(),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
        .nullable(), // in the entry's time zone
      source: Source,
      ref: z.string().nullable(), // "slide 12", "chat 8:41 PM", "[00:41:03]"
      conflicts: z.array(
        z.object({
          source: Source,
          due: z.string().nullable(),
          text: z.string()
        })
      )
    })
  ),
  covered: z.array(z.string())
})

export type Inventory = z.infer<typeof InventorySchema>
export type InventoryItem = Inventory['items'][number]

const INVENTORY_TIMEOUT_MS = 180_000
const NONE = '_None._'

const SYSTEM_PROMPT = `You extract an inventory from one lecture. Reply with JSON for the given schema and nothing else.
- List every deadline, task, announcement and link from the slides, the chat and the transcript. Do not cap or merge the list.
- Sources rank: slide text first, then the lecturer's chat messages, then speech. Put the highest-ranked source in "source" and "due".
- When sources disagree on a date or detail, keep the item once and list each other version in "conflicts".
- Dates are "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the lecture's time zone, resolved against the lecture date <YYYY-MM-DD>. Use null when no date was given; never guess one.
- "covered": the main topics taught, most important first, one short line each.
- "nextAction": the single most urgent thing the student must do, or null.
- "sessionLabel": the session's week or title as shown on the slides, or null.
- Keep names as written on the slides. Do not add a preamble, a recap or advice.`

function slidesSection(slides: Slide[]): string {
  if (slides.length === 0) return NONE
  return slides
    .map((s) => {
      const head = `Slide ${String(s.n).padStart(2, '0')}${s.title === '' ? '' : `: ${s.title}`}`
      return s.text === '' ? head : `${head}\n${s.text}`
    })
    .join('\n\n')
}

function chatSection(messages: ChatMessage[]): string {
  if (messages.length === 0) return NONE
  return messages.map((m) => `[${m.time}] ${m.sender}: ${stripInviteLinks(m.text)}`).join('\n')
}

/**
 * One uncapped call that reads the slides, the chat and the transcript and lists every deadline, task,
 * announcement and link. Meeting links are cut from the chat before the model sees it.
 */
export async function buildInventory(
  cfg: JobConfig,
  src: { transcriptMd: string; slides: Slide[]; chat: ChatMessage[] }
): Promise<Inventory> {
  const trusted = new Set(cfg.entry.trustedSenders)
  const ordered = orderChat(src.chat)
  const isLecturer = (m: ChatMessage): boolean =>
    m.senderRole === 'host' || m.senderRole === 'co_host' || trusted.has(m.sender)
  const user = [
    `## Slides\n\n${slidesSection(src.slides)}`,
    `## Lecturer chat\n\n${chatSection(ordered.filter(isLecturer))}`,
    `## Other chat\n\n${chatSection(ordered.filter((m) => !isLecturer(m)))}`,
    `## Transcript\n\n${src.transcriptMd}`
  ].join('\n\n')
  const lectureDate = localParts(cfg.entry.start, cfg.entry.timeZone).date
  const system = SYSTEM_PROMPT.replace('<YYYY-MM-DD>', lectureDate)
  return chatJson(
    cfg.ai,
    cfg.ai.models.summary,
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    InventorySchema,
    INVENTORY_TIMEOUT_MS
  )
}
