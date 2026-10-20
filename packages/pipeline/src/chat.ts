import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChatMessage, JobConfig } from '@tm/core'
import { scrub } from './scrub'

const DEDUP_TEXT_CHARS = 200

// Meeting links, passcodes and meeting IDs are cut (see scrub).
export function stripInviteLinks(text: string): string {
  return scrub(text)
}

function seenMs(message: ChatMessage): number {
  const ms = Date.parse(message.seenAt)
  if (Number.isNaN(ms)) throw new Error(`chat message ${message.key} has an invalid seenAt`)
  return ms
}

// De-duplicates (keeping the first seen), keeps posting order, and places each reply right after its parent
// and the parent's earlier replies. Replies to a removed duplicate point at the kept message.
export function orderChat(msgs: ChatMessage[]): ChatMessage[] {
  const posted = msgs
    .map((message, index) => ({ message, index, at: seenMs(message) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.message)

  const keptKeys = new Set<string>()
  const keptByContent = new Map<string, string>()
  const aliases = new Map<string, string>()
  const kept: ChatMessage[] = []
  for (const message of posted) {
    const content = `${message.sender}|${message.time}|${message.text.slice(0, DEDUP_TEXT_CHARS)}`
    const duplicateOf = keptByContent.get(content) ?? (keptKeys.has(message.key) ? message.key : null)
    if (duplicateOf !== null) {
      aliases.set(message.key, duplicateOf)
      continue
    }
    keptKeys.add(message.key)
    keptByContent.set(content, message.key)
    kept.push(message)
  }

  const normalised = kept.map((message) => ({
    ...message,
    replyTo: message.replyTo === null ? null : (aliases.get(message.replyTo) ?? message.replyTo)
  }))
  const keys = new Set(normalised.map((message) => message.key))
  const children = new Map<string, ChatMessage[]>()
  const roots: ChatMessage[] = []
  for (const message of normalised) {
    if (message.replyTo !== null && keys.has(message.replyTo)) {
      children.set(message.replyTo, [...(children.get(message.replyTo) ?? []), message])
    } else {
      roots.push(message)
    }
  }

  const ordered: ChatMessage[] = []
  const visit = (message: ChatMessage): void => {
    ordered.push(message)
    for (const reply of children.get(message.key) ?? []) visit(reply)
  }
  for (const root of roots) visit(root)
  if (ordered.length !== normalised.length) throw new Error('chat replies form a loop')
  return ordered
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return (
    typeof m.key === 'string' &&
    typeof m.sender === 'string' &&
    typeof m.senderRole === 'string' &&
    typeof m.time === 'string' &&
    typeof m.seenAt === 'string' &&
    typeof m.text === 'string' &&
    Array.isArray(m.links) &&
    (m.replyTo === null || typeof m.replyTo === 'string')
  )
}

async function readChat(path: string): Promise<ChatMessage[]> {
  const lines = (await Bun.file(path).text()).split('\n').filter((raw) => raw.trim() !== '')
  return lines.map((raw, index) => {
    const value: unknown = JSON.parse(raw)
    if (!isChatMessage(value)) throw new Error(`${path} line ${index + 1}: not a chat message`)
    return value
  })
}

// The captured messages in file order; a missing chat.jsonl means none were captured.
export async function loadChat(cfg: JobConfig): Promise<ChatMessage[]> {
  const source = join(cfg.dataDir, 'chat.jsonl')
  return (await Bun.file(source).exists()) ? readChat(source) : []
}

function roleLabel(role: ChatMessage['senderRole']): string {
  if (role === 'host') return ' (host)'
  if (role === 'co_host') return ' (co-host)'
  return ''
}

const LINK_REMOVED = '[meeting link removed]'
const MARKDOWN_CONTROL = /[\\`*_[\]()#+\-!>|~]/g

/** A participant's text as literal Markdown: no character can start emphasis, a link, a heading or a list. */
function escapeChatText(text: string): string {
  return text.replace(MARKDOWN_CONTROL, (character) => `\\${character}`)
}

/** The scrub adds `LINK_REMOVED` itself; it stays clean while the participant's own text is escaped. */
function renderText(text: string): string {
  return stripInviteLinks(text).split(LINK_REMOVED).map(escapeChatText).join(LINK_REMOVED)
}

function renderLine(message: ChatMessage): string {
  return `**[${message.time}] ${message.sender}${roleLabel(message.senderRole)}:** ${renderText(message.text)}`
}

function depthOf(message: ChatMessage, byKey: Map<string, ChatMessage>): number {
  let depth = 0
  let parentKey = message.replyTo
  while (parentKey !== null) {
    const parent = byKey.get(parentKey)
    if (parent === undefined) break
    depth++
    parentKey = parent.replyTo
  }
  return depth
}

function quote(text: string, depth: number): string {
  if (depth === 0) return text
  const mark = Array(depth).fill('>').join(' ')
  return text
    .split('\n')
    .map((line) => (line === '' ? mark : `${mark} ${line}`))
    .join('\n')
}

function renderMessages(messages: ChatMessage[]): string {
  if (messages.length === 0) return '_No messages in the meeting chat._'
  const byKey = new Map(messages.map((message) => [message.key, message]))
  return messages.map((message) => quote(renderLine(message), depthOf(message, byKey))).join('\n\n')
}

// Writes out/chat.md and returns its path. A missing chat.jsonl means the meeting's chat was not captured.
export async function buildChat(cfg: JobConfig): Promise<string> {
  const source = join(cfg.dataDir, 'chat.jsonl')
  const captured = await Bun.file(source).exists()
  const ordered = orderChat(captured ? await readChat(source) : [])
  const count = `${ordered.length} ${ordered.length === 1 ? 'message' : 'messages'}`
  const body = captured ? renderMessages(ordered) : '_No chat was captured for this meeting._'
  const md =
    `# ${cfg.entry.name}: chat\n\n` +
    `${count} from the meeting chat, in posting order. Meeting links are removed.\n\n` +
    `## Messages\n\n${body}\n`
  const outPath = join(cfg.dataDir, 'out', 'chat.md')
  await mkdir(dirname(outPath), { recursive: true })
  await Bun.write(outPath, md)
  return outPath
}
