import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Platform } from '@tm/core'
import type { z } from 'zod'

// Reads `<TM_SELECTORS_DIR>/<platform>.json` (default /app/config/selectors) and validates it. A missing file or a
// map that fails the schema throws: an adapter must not run on selectors it could not check.
export async function loadSelectors<T>(platform: Platform, schema: z.ZodType<T>): Promise<T> {
  const dir = process.env.TM_SELECTORS_DIR ?? '/app/config/selectors'
  const file = join(dir, `${platform}.json`)
  const raw = await readFile(file, 'utf8')
  const parsed = schema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`selector map ${file} is invalid: ${parsed.error.message}`)
  return parsed.data
}
