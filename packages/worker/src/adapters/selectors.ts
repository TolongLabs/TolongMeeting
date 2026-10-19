import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FormProvider, Platform } from '@tm/core'
import type { z } from 'zod'

// Reads `<dir>/<name>.json` (`dir` defaults to TM_SELECTORS_DIR, then /app/config/selectors) and validates it. A
// missing file or a map that fails the schema throws: an adapter must not run on selectors it could not check.
export async function loadSelectors<T>(
  name: Platform | `${FormProvider}-forms`,
  schema: z.ZodType<T>,
  dir = process.env.TM_SELECTORS_DIR ?? '/app/config/selectors'
): Promise<T> {
  const file = join(dir, `${name}.json`)
  const raw = await readFile(file, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`selector map ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new Error(`selector map ${file} is invalid: ${parsed.error.message}`)
  return parsed.data
}
