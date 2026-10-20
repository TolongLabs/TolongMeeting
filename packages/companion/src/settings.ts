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

export function validateFolderPath(v: string): { ok: true; path: string } | { ok: false; error: string } {
  if (
    v.startsWith('\\\\') ||
    v.startsWith('//') ||
    v.startsWith('\\\\?\\') ||
    v.startsWith('\\\\.\\') ||
    v.startsWith('//?/') ||
    v.startsWith('//./') ||
    /^[\\/]{1,2}(\?|\.)[\\/]/.test(v)
  ) {
    return { ok: false, error: 'UNC and device paths are not allowed' }
  }

  const isPosix = v.startsWith('/')
  const isWin = /^[a-zA-Z]:[\\/]/.test(v)
  if (!isPosix && !isWin) {
    return { ok: false, error: 'the path must be absolute' }
  }

  const normalized = isWin ? win32.normalize(v) : posix.normalize(v)

  if (normalized.split(/[\\/]/).includes('..')) {
    return { ok: false, error: 'the path must be absolute' }
  }

  // Refuse drive roots and filesystem roots
  if (isPosix && normalized === '/') {
    return { ok: false, error: 'drive and filesystem roots are not allowed' }
  }
  if (isWin && /^[a-zA-Z]:[\\/]*$/.test(normalized)) {
    return { ok: false, error: 'drive and filesystem roots are not allowed' }
  }

  // Refuse system folders
  if (isPosix) {
    const POSIX_SYSTEM = ['/etc', '/bin', '/sbin', '/usr', '/var', '/proc', '/sys', '/dev', '/boot']
    for (const sys of POSIX_SYSTEM) {
      if (normalized === sys || normalized.startsWith(sys + '/')) {
        return { ok: false, error: 'system folders are not allowed' }
      }
    }
  }

  if (isWin) {
    const normLower = normalized.toLowerCase()
    if (/^[a-zA-Z]:\\(windows|program files|program files \(x86\)|programdata)($|\\)/i.test(normalized)) {
      return { ok: false, error: 'system folders are not allowed' }
    }
    const envSysRoots = [
      process.env.SystemRoot,
      process.env.SYSTEMROOT,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramData
    ].filter(Boolean) as string[]

    for (const envPath of envSysRoots) {
      const normEnv = win32.normalize(envPath).toLowerCase()
      if (normLower === normEnv || normLower.startsWith(normEnv + '\\')) {
        return { ok: false, error: 'system folders are not allowed' }
      }
    }
  }

  return { ok: true, path: normalized }
}

export function isValidSettingsFolder(path: unknown): boolean {
  return typeof path === 'string' && validateFolderPath(path).ok
}

const FolderPathSchema = text(1024).superRefine((v, ctx) => {
  const res = validateFolderPath(v)
  if (!res.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: res.error
    })
  }
})

const WhisperSchema = z.strictObject({
  command: text(2048),
  cwd: FolderPathSchema.nullable(),
  model: text(64)
})

export const SettingsSchema = z.strictObject({
  serverUrl: ServerUrlSchema,
  summariesDir: FolderPathSchema,
  whisper: WhisperSchema
}) satisfies z.ZodType<Settings>

/** What a settings file may hold: any subset, so a newly added key falls back to its default. */
const SettingsFileSchema = z.strictObject({
  serverUrl: ServerUrlSchema.optional(),
  summariesDir: FolderPathSchema.optional(),
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
