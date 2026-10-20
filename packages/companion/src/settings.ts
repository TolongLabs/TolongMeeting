import { readFile } from 'node:fs/promises'
import { posix, win32, join } from 'node:path'
import { z } from 'zod'
import { isMissing, writeFileAtomic } from './atomic'

export interface Settings {
  serverUrl: string
  summariesDir: string
  whisper: { command: string; cwd: string | null; model: string }
}

const noControl = (s: string) => !/\p{Cc}/u.test(s)
const text = (max: number) => z.string().min(1).max(max).refine(noControl, 'control characters are not allowed')

/** The server address carries the device token, so it must be HTTPS (plain HTTP only for localhost). */
const ServerUrlSchema = z
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v)
    if (u.username || u.password) return false
    return (
      u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
    )
  }, 'the server URL must be https (http only for localhost) and carry no credentials')

const AbsolutePathSchema = text(1024).refine(
  (v) => posix.isAbsolute(v) || win32.isAbsolute(v),
  'the path must be absolute'
)

const WhisperSchema = z.strictObject({
  command: text(2048),
  cwd: AbsolutePathSchema.nullable(),
  model: text(64)
})

export const SettingsSchema = z.strictObject({
  serverUrl: ServerUrlSchema,
  summariesDir: AbsolutePathSchema,
  whisper: WhisperSchema
}) satisfies z.ZodType<Settings>

/** What a settings file may hold: any subset, so a newly added key falls back to its default. */
const SettingsFileSchema = z.strictObject({
  serverUrl: ServerUrlSchema.optional(),
  summariesDir: AbsolutePathSchema.optional(),
  whisper: WhisperSchema.partial().optional()
})

export function defaultSettings(documentsDir: string, serverUrl: string): Settings {
  return SettingsSchema.parse({
    serverUrl,
    summariesDir: join(documentsDir, 'Meeting summaries'),
    whisper: {
      command: 'uv run transcriber {audio} -m {model} -f txt,srt,json -o {outDir}',
      cwd: null,
      model: 'medium'
    }
  })
}

/** A missing file gives the defaults. A malformed file throws: the member fixes it rather than losing it. */
export async function loadSettings(file: string, documentsDir: string, serverUrl: string): Promise<Settings> {
  const defaults = defaultSettings(documentsDir, serverUrl)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if (isMissing(e)) return defaults
    throw e
  }
  const saved = SettingsFileSchema.parse(JSON.parse(raw))
  return SettingsSchema.parse({
    serverUrl: saved.serverUrl ?? defaults.serverUrl,
    summariesDir: saved.summariesDir ?? defaults.summariesDir,
    whisper: { ...defaults.whisper, ...saved.whisper }
  })
}

export async function saveSettings(file: string, s: Settings): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(SettingsSchema.parse(s), null, 2)}\n`, 0o600)
}
