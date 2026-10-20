import { z } from 'zod'
import type { FolderKind, PairingInput, SettingsForm } from './api'

// What the main process accepts from a page: strict shapes with fixed limits, checked on every call.

export const PairingInputSchema = z.strictObject({
  serverUrl: z.string().max(2048),
  code: z.string().max(64)
}) satisfies z.ZodType<PairingInput>

export const SettingsFormSchema = z.strictObject({
  summariesDir: z.string().max(1024),
  whisperCommand: z.string().max(2048),
  whisperCwd: z.string().max(1024),
  whisperModel: z.string().max(64)
}) satisfies z.ZodType<SettingsForm>

export const FolderKindSchema = z.enum(['summaries', 'whisper']) satisfies z.ZodType<FolderKind>
